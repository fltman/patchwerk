// Reads the output back to the CPU for Syphon / Spout / NDI. The picture is
// turned upside down and swapped to BGRA on the GPU, so the bytes come out top
// row first in the order those take. Pixel buffers + fences mean the CPU never
// waits for the GPU: a frame arrives a frame or two after it was drawn.
// Each readback gets a fresh pixel buffer: Chrome throws away its fast readback
// copy (and warns, every frame) when one is reused.
import { createProgram, createTarget, deleteTarget } from './gl.js';
import { VERTEX } from './prelude.js';

const FLIP_BGRA = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D t;
void main() { o = vec4(clamp(texture(t, vec2(v_uv.x, 1.0 - v_uv.y)).bgr, 0.0, 1.0), 1.0); }`;

// each pixel of the copy is the mean of the part of the picture under it, not one spot of it
export const CELL_MEAN = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D t;
const int N = 8;
void main() {
  vec2 cell = vec2(dFdx(v_uv.x), dFdy(v_uv.y));
  vec3 sum = vec3(0.0);
  for (int y = 0; y < N; y++) for (int x = 0; x < N; x++) {
    vec2 at = v_uv + cell * ((vec2(x, y) + 0.5) / float(N) - 0.5);
    sum += clamp(texture(t, vec2(at.x, 1.0 - at.y)).rgb, 0.0, 1.0);
  }
  o = vec4(sum.bgr / float(N * N), 1.0);
}`;

export const HEADER = 8; // uint32 width, uint32 height (little-endian), then the pixels
const RING = 3;

export class FrameTap {
  // wants(): should this frame be read back? onFrame(Uint8Array): header + pixels, reused between calls
  // fragment: another way of drawing the small copy
  constructor(gl, { wants, onFrame, fragment = FLIP_BGRA }) {
    this.gl = gl;
    this.wants = wants;
    this.onFrame = onFrame;
    this.prog = createProgram(gl, VERTEX, fragment);
    this.target = null;
    this.waiting = []; // { pbo, fence, w, h } still on the GPU
    this.out = null;
  }

  // called right after the output was drawn; the quad's vertex array is bound
  frame(tex, w, h) {
    this.collect();
    const bytes = w * h * 4;
    if (this.waiting.length >= RING || !this.wants()) return;
    const gl = this.gl;
    if (this.target?.w !== w || this.target?.h !== h) {
      deleteTarget(gl, this.target);
      this.target = createTarget(gl, w, h, false);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.prog.uniforms.get('t'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.waiting.push({ pbo, fence: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), w, h });
  }

  dispose() {
    const { gl } = this;
    deleteTarget(gl, this.target);
    gl.deleteProgram(this.prog.program);
    for (const job of this.waiting) { gl.deleteSync(job.fence); gl.deleteBuffer(job.pbo); }
    this.waiting = [];
  }

  // hand over every readback the GPU has finished, oldest first
  collect() {
    const gl = this.gl;
    while (this.waiting.length) {
      const job = this.waiting[0];
      if (gl.clientWaitSync(job.fence, 0, 0) === gl.TIMEOUT_EXPIRED) return;
      this.waiting.shift();
      gl.deleteSync(job.fence);
      const bytes = job.w * job.h * 4;
      if (this.out?.length !== HEADER + bytes) this.out = new Uint8Array(HEADER + bytes);
      const head = new DataView(this.out.buffer);
      head.setUint32(0, job.w, true);
      head.setUint32(4, job.h, true);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.out, HEADER, bytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(job.pbo);
      this.onFrame(this.out);
    }
  }
}
