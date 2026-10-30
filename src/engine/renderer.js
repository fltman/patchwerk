// Runs the patch every frame: control nodes on the CPU, then one fullscreen
// pass per image node into its own framebuffer, then the Output to the canvas.
import { composeFragment } from './compose.js';
import { VERTEX } from './prelude.js';
import { createContext, createProgram, createTarget, deleteTarget, createDataTexture, createQuad, hexToRgb } from './gl.js';
import { isImage, isFloatParam, isPatchable } from '../nodes/index.js';

export const DEFAULT_DEPTH = 0.5;

const BLIT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D t;
void main() { o = vec4(clamp(texture(t, v_uv).rgb, 0.0, 1.0), 1.0); }`;

export class Renderer {
  constructor(canvas, graph) {
    this.canvas = canvas;
    this.graph = graph;
    const { gl, floatOk } = createContext(canvas);
    this.gl = gl;
    this.floatOk = floatOk;
    this.quad = createQuad(gl);
    this.blit = createProgram(gl, VERTEX, BLIT);
    this.programs = new Map();
    this.nodeState = new Map();
    this.cpuState = new Map();
    this.values = new Map();
    this.effective = new Map();
    this.errors = new Map();
    this.inbound = new Map();
    this.mipSources = new Set();
    this.frameCount = 0;

    this.black = createDataTexture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.specTex = createDataTexture(gl, 128, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(128));
    this.sgTex = createDataTexture(gl, 128, 128, gl.R8, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(128 * 128));
    this.waveTex = createDataTexture(gl, 512, 1, gl.R16F, gl.RED, gl.FLOAT, new Float32Array(512));
    this.sgBuf = new Uint8Array(128 * 128);
    this.waveBuf = new Float32Array(512);

    this.snapWaiters = [];
    this.dirty = true;
    graph.addEventListener('change', (e) => {
      if (e.detail.kind === 'structure' || e.detail.kind === 'load') this.dirty = true;
    });
    this.setResolution(1280, 720);
  }

  setResolution(w, h) {
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const st of this.nodeState.values()) this.freeTargets(st);
    this.dirty = true;
  }

  freeTargets(st) {
    for (const t of st.targets ?? []) deleteTarget(this.gl, t);
    st.targets = null;
  }

  // Bring GPU state in line with the patch after nodes/cables changed.
  reconcile() {
    const g = this.graph;
    for (const [id, st] of this.nodeState) {
      if (!g.nodes.has(id)) { this.freeTargets(st); this.nodeState.delete(id); }
    }
    for (const map of [this.cpuState, this.values, this.effective, this.errors]) {
      for (const id of [...map.keys()]) if (!g.nodes.has(id)) map.delete(id);
    }
    this.inbound.clear();
    this.mipSources.clear();
    for (const l of g.links.values()) {
      this.inbound.set(`${l.to}:${l.toPort}`, l);
      const def = g.def(g.nodes.get(l.to));
      if (def?.lod && (def.inputs ?? []).some((i) => i.name === l.toPort)) this.mipSources.add(l.from);
    }
    for (const [id, st] of this.nodeState) {
      if (st.targets && st.mips !== this.mipSources.has(id)) this.freeTargets(st);
      const def = g.def(g.nodes.get(id));
      if (st.targets && !!def?.feedback !== st.targets.length > 1) this.freeTargets(st);
    }
    this.dirty = false;
  }

  link(id, port) { return this.inbound.get(`${id}:${port}`); }

  stateFor(id) {
    let st = this.nodeState.get(id);
    if (!st) { st = { targets: null, ping: 0, phases: {} }; this.nodeState.set(id, st); }
    return st;
  }

  outputTex(id) {
    const st = this.nodeState.get(id);
    return st?.targets ? st.targets[st.ping].tex : this.black;
  }

  programFor(node, def) {
    const key = def.custom ? `glsl:${node.code}` : def.type;
    let p = this.programs.get(key);
    if (!p) {
      p = createProgram(this.gl, VERTEX, composeFragment(def));
      this.programs.set(key, p);
    }
    return p;
  }

  // Slider value, or slider + cable × depth × range when patched (raw params take the cable as-is).
  resolveParams(node, def) {
    const out = {};
    for (const p of def.params ?? []) {
      let v = node.params[p.name] ?? p.default;
      const l = isPatchable(p) && this.link(node.id, p.name);
      if (l) {
        const cv = this.values.get(l.from)?.[l.fromPort] ?? 0;
        if (p.type === 'select') v = Math.max(0, Math.min(p.options.length - 1, Math.floor(cv * p.options.length)));
        else if (p.raw) v = cv;
        else {
          const depth = node.depth[p.name] ?? DEFAULT_DEPTH;
          v = Math.min(p.max, Math.max(p.min, v + cv * depth * (p.max - p.min)));
          if (p.step) v = Math.round(v / p.step) * p.step;
        }
      }
      out[p.name] = v;
    }
    this.effective.set(node.id, out);
    return out;
  }

  updateAudioTextures(reader, mono, sampleRate, time) {
    const gl = this.gl;
    if (!reader) return null;
    const a = reader.analysis;
    const B = a.specBins;
    const f = reader.frameAt(time);
    const spectrum = a.spectrum.subarray(f * B, f * B + B);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RED, gl.UNSIGNED_BYTE, spectrum);
    for (let r = 0; r < 128; r++) {
      const fr = Math.max(0, f - r * 2);
      this.sgBuf.set(a.spectrum.subarray(fr * B, fr * B + B), r * 128);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.sgTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 128, gl.RED, gl.UNSIGNED_BYTE, this.sgBuf);
    if (mono) {
      // scope-style trigger: start the window on a rising zero crossing
      const end = Math.floor(time * sampleRate);
      let s0 = end - 2048;
      for (let i = s0; i < end - 1024; i++) {
        if ((mono[i - 1] ?? 0) <= 0 && (mono[i] ?? 0) > 0) { s0 = i; break; }
      }
      for (let k = 0; k < 512; k++) this.waveBuf[k] = mono[s0 + k * 2] ?? 0;
      gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 1, gl.RED, gl.FLOAT, this.waveBuf);
    }
    return spectrum;
  }

  // Text-style nodes draw onto a 2D canvas whenever their non-patchable params change.
  canvasTex(def, st, p) {
    const gl = this.gl;
    const key = JSON.stringify([this.w, this.h, ...def.canvas.keys.map((k) => p[k])]);
    if (st.canvasKey !== key) {
      st.canvas ??= document.createElement('canvas');
      st.canvas.width = this.w;
      st.canvas.height = this.h;
      def.canvas.draw(st.canvas.getContext('2d'), this.w, this.h, p);
      st.canvasTex ??= gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, st.canvasTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, st.canvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      st.canvasKey = key;
    }
    return st.canvasTex;
  }

  /**
   * f: { time, dt (track seconds advanced, 0 when paused), wallDt, playing,
   *      reader, mono, sampleRate, visible: Set<nodeId>, thumbs: [{id, canvas}] | null }
   */
  frame(f) {
    if (this.dirty) this.reconcile();
    const g = this.graph;
    const gl = this.gl;
    const order = g.order();
    const spectrum = this.updateAudioTextures(f.reader, f.mono, f.sampleRate, f.time);
    const ctx = {
      time: f.time, dt: f.dt, wallDt: f.wallDt, playing: f.playing, reader: f.reader, spectrum,
      beatPos: f.reader ? f.reader.beatPosition(f.time) : f.time * 2,
    };

    // ── control nodes ──
    for (const id of order) {
      const node = g.nodes.get(id);
      const def = g.def(node);
      if (!def?.process) continue;
      const p = this.resolveParams(node, def);
      let st = this.cpuState.get(id);
      if (!st) this.cpuState.set(id, (st = {}));
      let out;
      try { out = def.process(ctx, p, st, node) || {}; } catch (e) { console.error(e); out = {}; }
      for (const k in out) if (!Number.isFinite(out[k])) out[k] = 0;
      this.values.set(id, out);
    }

    // ── image nodes: only what reaches the Output or is on screen ──
    const outNode = g.outputNode();
    const want = new Set(f.visible ?? []);
    if (outNode) want.add(outNode.id);
    const live = g.upstream(want);

    gl.bindVertexArray(this.quad);
    gl.disable(gl.BLEND);
    for (const id of order) {
      if (!live.has(id)) continue;
      const node = g.nodes.get(id);
      const def = g.def(node);
      if (!isImage(def)) continue;
      const p = this.resolveParams(node, def);
      const prog = this.programFor(node, def);
      if (prog.error) { this.errors.set(id, prog.errors); continue; }
      this.errors.delete(id);
      const st = this.stateFor(id);
      if (!st.targets) {
        const mips = this.mipSources.has(id);
        const make = () => createTarget(gl, this.w, this.h, this.floatOk, mips);
        st.targets = def.feedback ? [make(), make()] : [make()];
        st.mips = mips;
        st.ping = 0;
      }
      for (const q of def.params ?? []) if (q.integrate) st.phases[q.name] = (st.phases[q.name] ?? 0) + p[q.name] * f.dt;

      const dst = def.feedback ? st.targets[st.ping ^ 1] : st.targets[0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, this.w, this.h);
      gl.useProgram(prog.program);
      const U = prog.uniforms;
      const loc = (n) => U.get(n);
      let l;
      if ((l = loc('u_time'))) gl.uniform1f(l, f.time);
      if ((l = loc('u_dt'))) gl.uniform1f(l, f.wallDt);
      if ((l = loc('u_frame'))) gl.uniform1i(l, this.frameCount);
      if ((l = loc('u_res'))) gl.uniform2f(l, this.w, this.h);
      if ((l = loc('u_aspect'))) gl.uniform1f(l, this.w / this.h);

      let unit = 0;
      const bind = (name, tex) => {
        const u = loc(name);
        if (!u) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(u, unit++);
      };
      bind('u_spectrum', this.specTex);
      bind('u_spectrogram', this.sgTex);
      bind('u_wave', this.waveTex);
      const mipped = [];
      for (const input of def.inputs ?? []) {
        const lk = this.link(id, input.name);
        const tex = lk ? this.outputTex(lk.from) : this.black;
        if (def.lod && tex !== this.black && this.mipSources.has(lk.from)) {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          mipped.push(tex);
        }
        bind(`t_${input.name}`, tex);
      }
      if (def.feedback) bind('t_prev', st.targets[st.ping].tex);
      for (const s of def.samplers ?? []) bind(`t_${s}`, this.canvasTex(def, st, p));

      for (const q of def.params ?? []) {
        if (q.type === 'text') continue;
        const u = loc(`p_${q.name}`);
        if (u) {
          if (q.type === 'select') gl.uniform1i(u, p[q.name] | 0);
          else if (q.type === 'color') gl.uniform3fv(u, hexToRgb(p[q.name]));
          else gl.uniform1f(u, p[q.name]);
        }
        if (q.integrate && (l = loc(`p_${q.name}_t`))) gl.uniform1f(l, st.phases[q.name]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (def.feedback) st.ping ^= 1;
      for (const tex of mipped) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
    }

    if (f.thumbs?.length) this.drawThumbnails(f.thumbs);

    // ── output ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    this.drawTexture(outNode ? this.outputTex(outNode.id) : this.black);
    this.frameCount++;
    if (this.snapWaiters.length) this.takeSnapshots();
  }

  // A JPEG of the output, taken right after a frame (the drawing buffer is only valid then).
  snapshot(width = 640) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame was rendered (is the tab hidden?)')), 3000);
      this.snapWaiters.push({ width, resolve: (url) => { clearTimeout(timer); resolve(url); } });
    });
  }

  takeSnapshots() {
    for (const w of this.snapWaiters.splice(0)) {
      const c = document.createElement('canvas');
      c.width = w.width;
      c.height = Math.round((w.width * this.h) / this.w);
      c.getContext('2d').drawImage(this.canvas, 0, 0, c.width, c.height);
      w.resolve(c.toDataURL('image/jpeg', 0.85));
    }
  }

  drawTexture(tex) {
    const gl = this.gl;
    gl.useProgram(this.blit.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.blit.uniforms.get('t'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Tiles each node's texture into the (not yet presented) canvas, copies the
  // tile area into a CPU-side atlas in ONE readback, then slices it into the
  // little 2D canvases on the nodes.
  drawThumbnails(list) {
    const gl = this.gl;
    const tw = Math.min(256, Math.floor(this.w / 4));
    const th = Math.round((tw * this.h) / this.w);
    const cols = Math.floor(this.w / tw), rows = Math.floor(this.h / th);
    const per = cols * rows;
    if (!this.atlas) {
      this.atlas = document.createElement('canvas');
      this.atlasCtx = this.atlas.getContext('2d', { willReadFrequently: true });
    }
    if (this.atlas.width !== cols * tw || this.atlas.height !== rows * th) {
      this.atlas.width = cols * tw;
      this.atlas.height = rows * th;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let start = 0; start < list.length; start += per) {
      const batch = list.slice(start, start + per);
      batch.forEach((item, i) => {
        gl.viewport((i % cols) * tw, Math.floor(i / cols) * th, tw, th);
        this.drawTexture(this.outputTex(item.id));
      });
      const used = Math.ceil(batch.length / cols);
      this.atlasCtx.drawImage(this.canvas, 0, this.h - used * th, cols * tw, used * th, 0, (rows - used) * th, cols * tw, used * th);
      batch.forEach((item, i) => {
        const c = item.canvas;
        if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
        const ax = (i % cols) * tw;
        const ay = (rows - 1 - Math.floor(i / cols)) * th;
        c.getContext('2d').drawImage(this.atlas, ax, ay, tw, th, 0, 0, tw, th);
      });
    }
  }
}
