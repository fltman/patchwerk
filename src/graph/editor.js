// The patching surface: nodes as DOM, cables as SVG, pan/zoom, drag-to-patch.
import { CATEGORIES, inputPorts, outputPorts, isImage, isFloatParam, defFor } from '../nodes/index.js';
import { DEFAULT_DEPTH } from '../engine/renderer.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const svg = (tag, cls) => {
  const e = document.createElementNS(SVGNS, tag);
  if (cls) e.setAttribute('class', cls);
  return e;
};

function fmt(p, v) {
  if (p.format) return p.format(v);
  if (p.step >= 1) return String(Math.round(v));
  const a = Math.abs(v);
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  return p.unit ? `${s}${p.unit}` : s;
}

export function cablePath(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  const sag = Math.min(110, Math.hypot(x2 - x1, y2 - y1) * 0.16); // gravity
  return `M${x1},${y1} C${x1 + dx},${y1 + sag} ${x2 - dx},${y2 + sag} ${x2},${y2}`;
}

export class Editor extends EventTarget {
  constructor(root, graph, menu) {
    super();
    this.root = root;
    this.graph = graph;
    this.menu = menu;
    this.view = { x: 40, y: 40, zoom: 1 };
    this.views = new Map();      // node id → view refs
    this.linkViews = new Map();  // link id → view refs
    this.selected = new Set();
    this.pointer = { x: 200, y: 200 };
    this.thumbsOn = true;

    root.classList.add('graph');
    this.world = el('div', 'world');
    this.svg = svg('svg', 'cables');
    this.linkLayer = svg('g', 'links');
    this.dragPath = svg('path', 'drag-cable');
    this.svg.append(this.linkLayer, this.dragPath);
    this.world.append(this.svg);
    this.hint = el('div', 'graph-hint', 'Double-click or press Tab to add a node · drag between ports to patch · pinch / ⌘-scroll to zoom');
    root.append(this.world, this.hint);

    graph.addEventListener('change', (e) => {
      const k = e.detail.kind;
      if (k === 'load') this.rebuild();
      else if (k === 'structure') this.sync();
    });
    this.bindEvents();
    this.rebuild();
  }

  // ── view ──────────────────────────────────────────────
  applyView() {
    const { x, y, zoom } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    const g = 24 * zoom;
    this.root.style.backgroundSize = `${g}px ${g}px, ${g}px ${g}px, ${g * 5}px ${g * 5}px, ${g * 5}px ${g * 5}px`;
    this.root.style.backgroundPosition = `${x}px ${y}px`;
    this.root.classList.toggle('zoomed-out', zoom < 0.55);
  }

  toWorld(clientX, clientY) {
    const r = this.root.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.zoom, y: (clientY - r.top - this.view.y) / this.view.zoom };
  }

  zoomAt(clientX, clientY, factor) {
    const r = this.root.getBoundingClientRect();
    const z = Math.min(2, Math.max(0.2, this.view.zoom * factor));
    const px = clientX - r.left, py = clientY - r.top;
    this.view.x = px - ((px - this.view.x) * z) / this.view.zoom;
    this.view.y = py - ((py - this.view.y) * z) / this.view.zoom;
    this.view.zoom = z;
    this.applyView();
  }

  frameAll() {
    const nodes = [...this.graph.nodes.values()];
    if (!nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const v = this.views.get(n.id);
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + (v?.w ?? 220)); y1 = Math.max(y1, n.y + (v?.h ?? 200));
    }
    const r = this.root.getBoundingClientRect();
    const w = r.width - (this.insetRight ?? 0); // e.g. the chat panel covering the right edge
    const z = Math.min(1.1, Math.max(0.2, Math.min((w - 80) / (x1 - x0), (r.height - 80) / (y1 - y0))));
    this.view.zoom = z;
    this.view.x = (w - (x1 - x0) * z) / 2 - x0 * z;
    this.view.y = (r.height - (y1 - y0) * z) / 2 - y0 * z;
    this.applyView();
  }

  // ── building DOM ──────────────────────────────────────
  rebuild() {
    for (const v of this.views.values()) v.el.remove();
    this.views.clear();
    for (const lv of this.linkViews.values()) lv.g.remove();
    this.linkViews.clear();
    for (const id of [...this.selected]) if (!this.graph.nodes.has(id)) this.selected.delete(id);
    for (const node of this.graph.nodes.values()) this.buildNode(node);
    this.sync();
    this.applyView();
  }

  sync() {
    const g = this.graph;
    for (const [id, v] of this.views) {
      if (!g.nodes.has(id)) { v.el.remove(); this.views.delete(id); this.selected.delete(id); }
    }
    for (const node of g.nodes.values()) {
      const v = this.views.get(node.id);
      // a GLSL node whose code changed its interface gets rebuilt
      if (v && node.type === 'glsl' && v.code !== node.code) { v.el.remove(); this.views.delete(node.id); }
      if (!this.views.has(node.id)) this.buildNode(node);
    }
    for (const [id, lv] of this.linkViews) if (!g.links.has(id)) { lv.g.remove(); this.linkViews.delete(id); }
    for (const l of g.links.values()) if (!this.linkViews.has(l.id)) this.buildLink(l);
    // linked state of every input port
    for (const [id, v] of this.views) {
      for (const [port, pv] of v.inputs) {
        const linked = !!g.linkInto(id, port);
        pv.row.classList.toggle('linked', linked);
        pv.port.classList.toggle('plugged', linked);
      }
      for (const [port, pv] of v.outputs) {
        pv.port.classList.toggle('plugged', [...g.links.values()].some((l) => l.from === id && l.fromPort === port));
      }
    }
    requestAnimationFrame(() => {
      for (const v of this.views.values()) { v.w = v.el.offsetWidth; v.h = v.el.offsetHeight; }
      this.updateCables();
    });
    this.root.classList.toggle('empty', g.nodes.size === 0);
  }

  buildNode(node) {
    const g = this.graph;
    const def = g.def(node);
    const cat = CATEGORIES[def.category] ?? CATEGORIES.effect;
    const root = el('div', `node cat-${def.category}`);
    root.dataset.id = node.id;
    root.style.setProperty('--cat', cat.color);
    root.style.left = `${node.x}px`;
    root.style.top = `${node.y}px`;
    if (this.selected.has(node.id)) root.classList.add('selected');

    const head = el('div', 'node-head');
    head.append(el('span', 'title', def.title), el('span', 'badge', cat.badge));
    root.append(head);
    const body = el('div', 'node-body');
    root.append(body);

    const v = { el: root, node, def, inputs: new Map(), outputs: new Map(), params: new Map(), selects: new Map(), fields: new Map(), thumb: null, code: node.code, w: 220, h: 200 };

    const makePort = (dir, kind, name) => {
      const p = el('span', `port ${dir} ${kind}`);
      p.dataset.node = node.id;
      p.dataset.port = name;
      p.dataset.dir = dir;
      p.dataset.kind = kind;
      return p;
    };

    // image output sits in the header, like a module's main out jack
    for (const o of outputPorts(def)) {
      const port = makePort('out', o.kind, o.name);
      if (o.kind === 'image') {
        head.append(port);
        v.outputs.set(o.name, { port, row: head });
      }
    }

    for (const ip of inputPorts(def).filter((p) => p.kind === 'image')) {
      const row = el('div', 'row io');
      const port = makePort('in', 'image', ip.name);
      row.append(port, el('span', 'label', ip.label));
      body.append(row);
      v.inputs.set(ip.name, { port, row });
    }

    for (const p of def.params ?? []) {
      const row = el('div', 'row param');
      if (isFloatParam(p)) {
        const port = makePort('in', 'float', p.name);
        const s = this.makeSlider(node, p);
        row.append(port, s.el);
        body.append(row);
        const depthRow = el('div', 'row depth-row');
        let depth = null;
        if (!p.raw) {
          depth = this.makeSlider(node, { name: p.name, label: 'mod depth', min: -1, max: 1, default: DEFAULT_DEPTH }, true);
          depthRow.append(el('span', 'depth-icon', '⤷'), depth.el);
          body.append(depthRow);
        }
        v.inputs.set(p.name, { port, row, depthRow });
        v.params.set(p.name, { ...s, p, depth });
      } else if (p.type === 'select') {
        const sel = el('select', 'select');
        p.options.forEach((o, i) => sel.append(new Option(o, i)));
        sel.value = node.params[p.name];
        sel.addEventListener('change', () => { g.setParam(node.id, p.name, Number(sel.value)); g.commit(); });
        const port = makePort('in', 'float', p.name);
        row.append(port, el('span', 'plabel', p.label ?? p.name), sel);
        body.append(row);
        v.inputs.set(p.name, { port, row });
        v.selects.set(p.name, sel);
      } else if (p.type === 'color') {
        const c = el('input', 'color');
        c.type = 'color';
        c.value = node.params[p.name];
        c.addEventListener('input', () => g.setParam(node.id, p.name, c.value));
        c.addEventListener('change', () => g.commit());
        v.fields.set(p.name, c);
        row.append(el('span', 'plabel', p.label ?? p.name), c);
        body.append(row);
      } else if (p.type === 'text') {
        const t = el('textarea', 'text');
        t.rows = 1;
        t.value = node.params[p.name];
        t.spellcheck = false;
        t.addEventListener('input', () => g.setParam(node.id, p.name, t.value));
        t.addEventListener('change', () => g.commit());
        v.fields.set(p.name, t);
        row.classList.add('text-row');
        row.append(t);
        body.append(row);
      }
    }

    if (isImage(def) && def.category !== 'output') {
      const thumb = el('canvas', 'thumb');
      thumb.width = 192;
      thumb.height = 108;
      body.append(thumb);
      v.thumb = thumb;
    }

    for (const o of outputPorts(def).filter((o) => o.kind === 'float')) {
      const row = el('div', 'row out');
      const meter = el('span', 'meter');
      const fill = el('span', 'meter-fill');
      meter.append(fill);
      const port = makePort('out', 'float', o.name);
      row.append(el('span', 'label', o.label), meter, port);
      body.append(row);
      v.outputs.set(o.name, { port, row, fill });
    }

    const err = el('div', 'node-error');
    root.append(err);
    v.err = err;
    v.errKey = '';

    this.world.append(root);
    this.views.set(node.id, v);
    return v;
  }

  makeSlider(node, p, isDepth = false) {
    const g = this.graph;
    const s = el('div', isDepth ? 'slider depth' : 'slider');
    const fill = el('div', 'fill');
    const mod = el('div', 'mod');
    const label = el('span', 'slabel', p.label ?? p.name);
    const val = el('span', 'val');
    s.append(fill, mod, label, val);
    const get = () => (isDepth ? node.depth[p.name] ?? DEFAULT_DEPTH : node.params[p.name]);
    const show = (v) => {
      const t = (v - p.min) / (p.max - p.min);
      if (isDepth) {
        const a = Math.min(t, 0.5), b = Math.max(t, 0.5);
        fill.style.left = `${a * 100}%`;
        fill.style.width = `${(b - a) * 100}%`;
      } else fill.style.width = `${Math.max(0, Math.min(1, t)) * 100}%`;
      val.textContent = isDepth ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : fmt(p, v);
    };
    show(get());
    const set = (v) => {
      if (p.step) v = Math.round(v / p.step) * p.step;
      v = Math.min(p.max, Math.max(p.min, v));
      if (isDepth) g.setDepth(node.id, p.name, v);
      else g.setParam(node.id, p.name, v);
      show(v);
    };
    let drag = null;
    s.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.tagName === 'INPUT') return;
      e.stopPropagation();
      s.setPointerCapture(e.pointerId);
      const r = s.getBoundingClientRect();
      drag = { x: e.clientX, v: get(), w: r.width, left: r.left, moved: false };
      if (!e.shiftKey) set(p.min + ((e.clientX - r.left) / r.width) * (p.max - p.min));
    });
    s.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.moved = true;
      if (e.shiftKey) set(drag.v + ((e.clientX - drag.x) / drag.w) * (p.max - p.min) * 0.1);
      else set(p.min + ((e.clientX - drag.left) / drag.w) * (p.max - p.min));
    });
    s.addEventListener('pointerup', () => { if (drag) { drag = null; g.commit(); } });
    s.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = el('input', 'slider-input');
      input.value = isDepth ? String(get()) : String(+get().toFixed(4));
      s.append(input);
      input.focus();
      input.select();
      const done = (ok) => {
        if (ok && input.value.trim() !== '' && Number.isFinite(Number(input.value))) { set(Number(input.value)); g.commit(); }
        input.remove();
      };
      input.addEventListener('keydown', (k) => { k.stopPropagation(); if (k.key === 'Enter') done(true); if (k.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
    });
    return { el: s, fill, mod, val, show, get };
  }

  buildLink(l) {
    const kind = this.graph.portKind(l.from, l.fromPort, 'out');
    const gEl = svg('g', `link ${kind}`);
    const glow = svg('path', 'glow');
    const core = svg('path', 'core');
    const hit = svg('path', 'hit');
    gEl.append(glow, core, hit);
    hit.addEventListener('dblclick', (e) => { e.stopPropagation(); this.graph.disconnect(l.id); this.graph.commit(); });
    hit.addEventListener('pointerdown', (e) => {
      if (e.altKey) { e.stopPropagation(); this.graph.disconnect(l.id); this.graph.commit(); }
    });
    hit.addEventListener('pointerenter', () => gEl.classList.add('hover'));
    hit.addEventListener('pointerleave', () => gEl.classList.remove('hover'));
    this.linkLayer.append(gEl);
    this.linkViews.set(l.id, { g: gEl, glow, core, hit, link: l, kind });
  }

  portCenter(nodeId, port, dir) {
    const v = this.views.get(nodeId);
    const pv = (dir === 'out' ? v?.outputs : v?.inputs)?.get(port);
    if (!pv) return null;
    const r = pv.port.getBoundingClientRect();
    const w = this.world.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - w.left) / this.view.zoom, y: (r.top + r.height / 2 - w.top) / this.view.zoom };
  }

  updateCables(onlyNodes) {
    for (const lv of this.linkViews.values()) {
      const l = lv.link;
      if (onlyNodes && !onlyNodes.has(l.from) && !onlyNodes.has(l.to)) continue;
      const a = this.portCenter(l.from, l.fromPort, 'out');
      const b = this.portCenter(l.to, l.toPort, 'in');
      if (!a || !b) continue;
      const d = cablePath(a.x, a.y, b.x, b.y);
      lv.glow.setAttribute('d', d);
      lv.core.setAttribute('d', d);
      lv.hit.setAttribute('d', d);
    }
  }

  select(id, additive = false) {
    if (!additive) this.selected.clear();
    if (id) {
      if (additive && this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    }
    for (const [nid, v] of this.views) v.el.classList.toggle('selected', this.selected.has(nid));
    this.dispatchEvent(new CustomEvent('select', { detail: { ids: [...this.selected] } }));
  }

  // ── adding nodes ──────────────────────────────────────
  openAdd(clientX, clientY, from = null) {
    const g = this.graph;
    const pos = this.toWorld(clientX, clientY);
    const hasOutput = !!g.outputNode();
    this.menu.open({
      x: clientX,
      y: clientY,
      filter: (d) => {
        if (d.type === 'output' && hasOutput) return false;
        if (!from) return true;
        const full = defFor({ type: d.type });
        const ports = from.dir === 'out' ? inputPorts(full) : outputPorts(full);
        return ports.some((p) => p.kind === from.kind);
      },
      onPick: (d) => {
        const w = 220;
        const node = g.addNode(d.type, from?.dir === 'in' ? pos.x - w - 20 : pos.x, pos.y - 20);
        if (from) {
          const full = g.def(node);
          if (from.dir === 'out') {
            const target = inputPorts(full).find((p) => p.kind === from.kind);
            if (target) g.connect(from.node, from.port, node.id, target.name);
          } else {
            const src = outputPorts(full).find((p) => p.kind === from.kind);
            if (src) g.connect(node.id, src.name, from.node, from.port);
          }
        }
        g.commit();
        this.select(node.id);
      },
    });
  }

  deleteSelected() {
    if (!this.selected.size) return;
    for (const id of this.selected) this.graph.removeNode(id);
    this.selected.clear();
    this.graph.commit();
  }

  duplicateSelected() {
    const g = this.graph;
    const fresh = [];
    for (const id of this.selected) {
      const n = g.nodes.get(id);
      if (!n || n.type === 'output') continue;
      const copy = g.addNode(n.type, n.x + 30, n.y + 30, { params: { ...n.params }, depth: { ...n.depth }, code: n.code });
      fresh.push(copy.id);
    }
    if (!fresh.length) return;
    g.commit();
    this.selected = new Set(fresh);
    this.select(null, true);
  }

  // ── events ────────────────────────────────────────────
  bindEvents() {
    const root = this.root;
    let pan = null, nodeDrag = null, cable = null;

    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
      else { this.view.x -= e.deltaX; this.view.y -= e.deltaY; this.applyView(); }
    }, { passive: false });

    root.addEventListener('pointerdown', (e) => {
      const portEl = e.target.closest('.port');
      const nodeEl = e.target.closest('.node');
      if (e.target.closest('select, input, textarea, .slider')) return;
      if (portEl) {
        e.preventDefault();
        root.setPointerCapture(e.pointerId);
        cable = this.startCable(portEl);
        this.updateDragCable(cable, e);
        return;
      }
      if (nodeEl && e.button === 0) {
        const id = nodeEl.dataset.id;
        if (e.shiftKey) this.select(id, true);
        else if (!this.selected.has(id)) this.select(id);
        if (e.target.closest('.node-head')) {
          root.setPointerCapture(e.pointerId);
          nodeDrag = {
            x: e.clientX, y: e.clientY, moved: false,
            start: [...this.selected].map((nid) => ({ id: nid, x: this.graph.nodes.get(nid).x, y: this.graph.nodes.get(nid).y })),
          };
        }
        return;
      }
      if (e.button === 0 || e.button === 1) {
        root.setPointerCapture(e.pointerId);
        pan = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
      }
    });

    root.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX, y: e.clientY };
      if (pan) {
        this.view.x = pan.vx + e.clientX - pan.x;
        this.view.y = pan.vy + e.clientY - pan.y;
        if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 3) pan.moved = true;
        this.applyView();
      } else if (nodeDrag) {
        const dx = (e.clientX - nodeDrag.x) / this.view.zoom, dy = (e.clientY - nodeDrag.y) / this.view.zoom;
        if (Math.abs(dx) + Math.abs(dy) > 2) nodeDrag.moved = true;
        for (const s of nodeDrag.start) {
          const nx = Math.round(s.x + dx), ny = Math.round(s.y + dy);
          this.graph.moveNode(s.id, nx, ny);
          const v = this.views.get(s.id);
          v.el.style.left = `${nx}px`;
          v.el.style.top = `${ny}px`;
        }
        this.updateCables(new Set(nodeDrag.start.map((s) => s.id)));
      } else if (cable) {
        this.updateDragCable(cable, e);
      }
    });

    const end = (e) => {
      if (pan) {
        if (!pan.moved && e.button === 0) this.select(null);
        pan = null;
      }
      if (nodeDrag) {
        if (nodeDrag.moved) this.graph.commit();
        nodeDrag = null;
      }
      if (cable) {
        this.finishCable(cable, e);
        cable = null;
      }
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    // pointer capture retargets click events to the root, so look at what's under the pointer
    const under = (e) => document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
    root.addEventListener('dblclick', (e) => {
      const hit = under(e);
      if (hit.closest('.node, .link')) {
        const head = hit.closest('.node-head');
        if (head) this.dispatchEvent(new CustomEvent('open-code', { detail: { id: head.parentElement.dataset.id } }));
        return;
      }
      this.openAdd(e.clientX, e.clientY);
    });
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!under(e).closest('.node')) this.openAdd(e.clientX, e.clientY);
    });
  }

  startCable(portEl) {
    const { node, port, dir, kind } = portEl.dataset;
    this.root.classList.add('patching', `patching-${kind}`, `patching-from-${dir}`);
    if (dir === 'in') {
      // grabbing a plugged input lifts that cable off and carries it
      const existing = this.graph.linkInto(node, port);
      if (existing) {
        this.graph.disconnect(existing.id);
        this.root.classList.replace('patching-from-in', 'patching-from-out');
        return { node: existing.from, port: existing.fromPort, dir: 'out', kind, lifted: true };
      }
    }
    return { node, port, dir, kind };
  }

  updateDragCable(c, e) {
    const a = this.portCenter(c.node, c.port, c.dir);
    const b = this.toWorld(e.clientX, e.clientY);
    this.dragPath.setAttribute('d', c.dir === 'out' ? cablePath(a.x, a.y, b.x, b.y) : cablePath(b.x, b.y, a.x, a.y));
    this.dragPath.setAttribute('class', `drag-cable ${c.kind}`);
  }

  finishCable(c, e) {
    this.dragPath.setAttribute('d', '');
    this.root.classList.remove('patching', 'patching-image', 'patching-float', 'patching-from-in', 'patching-from-out');
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.port');
    const g = this.graph;
    if (target && target.dataset.dir !== c.dir) {
      const res = c.dir === 'out'
        ? g.connect(c.node, c.port, target.dataset.node, target.dataset.port)
        : g.connect(target.dataset.node, target.dataset.port, c.node, c.port);
      if (!res.ok) this.dispatchEvent(new CustomEvent('message', { detail: { text: `Can't patch that: ${res.reason}` } }));
      g.commit();
      return;
    }
    if (c.lifted) { g.commit(); return; }
    if (!target && !e.target.closest?.('.node') && !document.elementFromPoint(e.clientX, e.clientY)?.closest('.node')) {
      this.openAdd(e.clientX, e.clientY, c);
    }
  }

  // ── per-frame ─────────────────────────────────────────
  visibleNodes() {
    const r = this.root.getBoundingClientRect();
    const out = [];
    if (!r.width) return out;
    const { x, y, zoom } = this.view;
    for (const [id, v] of this.views) {
      const n = v.node;
      const sx = x + n.x * zoom, sy = y + n.y * zoom;
      if (sx + v.w * zoom < 0 || sy + v.h * zoom < 0 || sx > r.width || sy > r.height) continue;
      out.push(id);
    }
    return out;
  }

  thumbTargets(visible) {
    if (!this.thumbsOn || this.view.zoom < 0.35) return [];
    return visible.map((id) => this.views.get(id)).filter((v) => v?.thumb).map((v) => ({ id: v.node.id, canvas: v.thumb }));
  }

  tick(renderer, visible) {
    for (const id of visible) {
      const v = this.views.get(id);
      if (!v) continue;
      const eff = renderer.effective.get(id);
      if (eff) {
        for (const [name, pv] of v.params) {
          const row = v.inputs.get(name)?.row;
          if (!row?.classList.contains('linked')) continue;
          const p = pv.p;
          const t = Math.max(0, Math.min(1, (eff[name] - p.min) / (p.max - p.min)));
          pv.mod.style.left = `${t * 100}%`;
          pv.val.textContent = fmt(p, eff[name]);
        }
        for (const [name, sel] of v.selects) {
          const linked = v.inputs.get(name).row.classList.contains('linked');
          sel.disabled = linked;
          const want = String(linked ? eff[name] : v.node.params[name]);
          if (sel.value !== want) sel.value = want;
        }
      }
      const vals = renderer.values.get(id);
      if (vals) for (const [name, ov] of v.outputs) if (ov.fill) ov.fill.style.width = `${Math.max(0, Math.min(1, vals[name] ?? 0)) * 100}%`;
      const errs = renderer.errors.get(id);
      const key = errs ? JSON.stringify(errs) : '';
      if (key !== v.errKey) {
        v.errKey = key;
        v.el.classList.toggle('has-error', !!errs);
        v.err.textContent = errs ? errs.slice(0, 3).map((x) => (x.line ? `line ${x.line}: ${x.message}` : x.message)).join('\n') : '';
      }
    }
    // control cables glow with the signal they carry
    for (const lv of this.linkViews.values()) {
      if (lv.kind !== 'float') continue;
      const v = Math.max(0, Math.min(1, renderer.values.get(lv.link.from)?.[lv.link.fromPort] ?? 0));
      lv.glow.style.opacity = (0.08 + 0.75 * v).toFixed(3);
      lv.core.style.opacity = (0.55 + 0.45 * v).toFixed(3);
    }
  }

  // after nodes were moved in the model (auto-layout), move their DOM too
  syncPositions() {
    for (const [id, v] of this.views) {
      const n = this.graph.nodes.get(id);
      v.el.style.left = `${n.x}px`;
      v.el.style.top = `${n.y}px`;
    }
    requestAnimationFrame(() => {
      for (const v of this.views.values()) { v.w = v.el.offsetWidth; v.h = v.el.offsetHeight; }
      this.updateCables();
    });
  }

  // Show values changed from code (the assistant, scripts) — sliders, depths, colours, text.
  refreshNode(id) {
    const v = this.views.get(id);
    if (!v) return;
    for (const pv of v.params.values()) {
      pv.show(pv.get());
      pv.depth?.show(pv.depth.get());
    }
    for (const [name, f] of v.fields) if (f.value !== v.node.params[name]) f.value = v.node.params[name];
    for (const [name, sel] of v.selects) sel.value = String(v.node.params[name]);
  }
}
