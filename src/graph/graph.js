// The patch: nodes, cables between ports, and undo history.
// Emits 'change' events with detail.kind: 'structure' | 'param' | 'move' | 'load' | 'rig'.
import { defFor, getDef, inputPorts, outputPorts, DEFAULT_CODE } from '../nodes/index.js';

export class Graph extends EventTarget {
  constructor() {
    super();
    this.nodes = new Map();
    this.links = new Map();
    this.rig = null; // the moves a live DJ may play on this patch (src/dj/rig.js)
    this.nextId = 1;
    this._order = null;
    this.history = [];
    this.future = [];
  }

  def(node) { return defFor(node); }

  addNode(type, x = 0, y = 0, init = {}) {
    const base = getDef(type);
    if (!base) throw new Error(`unknown node type ${type}`);
    const id = init.id ?? `n${this.nextId++}`;
    const node = { id, type, x, y, params: {}, depth: {} };
    if (type === 'glsl') node.code = init.code ?? DEFAULT_CODE;
    for (const p of this.def(node).params ?? []) node.params[p.name] = p.default;
    Object.assign(node.params, init.params);
    Object.assign(node.depth, init.depth);
    this.nodes.set(id, node);
    this.changed('structure');
    return node;
  }

  removeNode(id) {
    for (const l of [...this.links.values()]) if (l.from === id || l.to === id) this.links.delete(l.id);
    this.nodes.delete(id);
    this.changed('structure');
  }

  // After a GLSL node's code changes its ports may differ: drop cables to ports that vanished.
  setCode(id, code) {
    const node = this.nodes.get(id);
    node.code = code;
    const def = this.def(node);
    for (const p of def.params ?? []) if (!(p.name in node.params)) node.params[p.name] = p.default;
    const ins = new Set(inputPorts(def).map((p) => p.name));
    for (const l of [...this.links.values()]) if (l.to === id && !ins.has(l.toPort)) this.links.delete(l.id);
    this.changed('structure');
  }

  portKind(nodeId, port, dir) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    const list = dir === 'out' ? outputPorts(this.def(node)) : inputPorts(this.def(node));
    return list.find((p) => p.name === port)?.kind ?? null;
  }

  canConnect(from, fromPort, to, toPort) {
    if (from === to) return { ok: false, reason: 'same node' };
    const a = this.portKind(from, fromPort, 'out');
    const b = this.portKind(to, toPort, 'in');
    if (!a || !b) return { ok: false, reason: 'no such port' };
    if (a !== b) return { ok: false, reason: a === 'image' ? 'an image cable goes into an image input' : 'a control cable goes into a slider' };
    if (this.reaches(to, from)) return { ok: false, reason: 'that would make a loop — use a Feedback node' };
    return { ok: true };
  }

  // does `start` reach `target` following cables downstream?
  reaches(start, target) {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop();
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const l of this.links.values()) if (l.from === id) stack.push(l.to);
    }
    return false;
  }

  connect(from, fromPort, to, toPort) {
    const check = this.canConnect(from, fromPort, to, toPort);
    if (!check.ok) return check;
    const existing = this.linkInto(to, toPort);
    if (existing) this.links.delete(existing.id);
    const id = `l${this.nextId++}`;
    this.links.set(id, { id, from, fromPort, to, toPort });
    this.changed('structure');
    return { ok: true, id };
  }

  disconnect(linkId) {
    if (this.links.delete(linkId)) this.changed('structure');
  }

  linkInto(nodeId, port) {
    for (const l of this.links.values()) if (l.to === nodeId && l.toPort === port) return l;
    return null;
  }

  linksOf(nodeId) {
    return [...this.links.values()].filter((l) => l.from === nodeId || l.to === nodeId);
  }

  setParam(id, name, value) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.params[name] = value;
    this.changed('param');
  }

  setDepth(id, name, value) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.depth[name] = value;
    this.changed('param');
  }

  setRig(rig) {
    this.rig = rig;
    this.changed('rig');
  }

  moveNode(id, x, y) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.x = x;
    node.y = y;
    this.changed('move');
  }

  // Topological order (Kahn). Cables never form cycles, so this always covers every node.
  order() {
    if (this._order) return this._order;
    const indeg = new Map([...this.nodes.keys()].map((id) => [id, 0]));
    const out = new Map([...this.nodes.keys()].map((id) => [id, []]));
    for (const l of this.links.values()) {
      if (!indeg.has(l.to) || !out.has(l.from)) continue;
      indeg.set(l.to, indeg.get(l.to) + 1);
      out.get(l.from).push(l.to);
    }
    const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const next of out.get(id)) {
        indeg.set(next, indeg.get(next) - 1);
        if (indeg.get(next) === 0) queue.push(next);
      }
    }
    this._order = order;
    return order;
  }

  // every node upstream of `ids` (inclusive)
  upstream(ids) {
    const seen = new Set();
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const l of this.links.values()) if (l.to === id) stack.push(l.from);
    }
    return seen;
  }

  outputNode() {
    for (const n of this.nodes.values()) if (n.type === 'output') return n;
    return null;
  }

  changed(kind) {
    if (kind === 'structure' || kind === 'load') this._order = null;
    this.dispatchEvent(new CustomEvent('change', { detail: { kind } }));
  }

  // ── persistence ─────────────────────────────────────────
  toJSON() {
    return {
      version: 1,
      nodes: [...this.nodes.values()].map((n) => ({ ...n, params: { ...n.params }, depth: { ...n.depth } })),
      links: [...this.links.values()].map((l) => ({ ...l })),
      ...(this.rig ? { rig: this.rig } : {}),
    };
  }

  load(json) {
    this.nodes.clear();
    this.links.clear();
    this.rig = json.rig ?? null;
    let max = 0;
    const num = (id) => Number(String(id).slice(1)) || 0;
    for (const n of json.nodes ?? []) {
      if (!getDef(n.type)) continue;
      const node = { id: n.id, type: n.type, x: n.x ?? 0, y: n.y ?? 0, params: {}, depth: { ...n.depth } };
      if (n.type === 'glsl') node.code = n.code ?? DEFAULT_CODE;
      for (const p of this.def(node).params ?? []) node.params[p.name] = p.default;
      Object.assign(node.params, n.params);
      this.nodes.set(node.id, node);
      max = Math.max(max, num(node.id));
    }
    for (const l of json.links ?? []) {
      max = Math.max(max, num(l.id));
      if (!this.nodes.has(l.from) || !this.nodes.has(l.to)) continue;
      if (this.portKind(l.from, l.fromPort, 'out') !== this.portKind(l.to, l.toPort, 'in')) continue;
      this.links.set(l.id, { id: l.id, from: l.from, fromPort: l.fromPort, to: l.to, toPort: l.toPort });
    }
    this.nextId = max + 1;
    this.changed('load');
  }

  // ── undo: whole-patch snapshots, pushed after each finished edit ──
  commit() {
    const snap = JSON.stringify(this.toJSON());
    if (this.history[this.history.length - 1] === snap) return;
    this.history.push(snap);
    if (this.history.length > 200) this.history.shift();
    this.future = [];
    this.dispatchEvent(new CustomEvent('commit'));
  }

  undo() {
    if (this.history.length < 2) return;
    this.future.push(this.history.pop());
    this.load(JSON.parse(this.history[this.history.length - 1]));
    this.dispatchEvent(new CustomEvent('commit'));
  }

  redo() {
    if (!this.future.length) return;
    const snap = this.future.pop();
    this.history.push(snap);
    this.load(JSON.parse(snap));
    this.dispatchEvent(new CustomEvent('commit'));
  }
}
