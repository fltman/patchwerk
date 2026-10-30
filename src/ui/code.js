// The GLSL tab: read any image node's shader, edit GLSL nodes live, fork built-ins.
import { forkToCustom } from '../nodes/custom.js';
import { isImage, CATEGORIES } from '../nodes/index.js';
import { glslType } from '../engine/compose.js';

export class CodePanel {
  constructor(graph, renderer, editor) {
    this.graph = graph;
    this.renderer = renderer;
    this.editor = editor;
    this.id = null;
    this.title = document.getElementById('code-title');
    this.text = document.getElementById('code-text');
    this.gutter = document.getElementById('code-gutter');
    this.errors = document.getElementById('code-errors');
    this.forkBtn = document.getElementById('code-fork');
    this.errKey = null;

    let timer = null;
    this.text.addEventListener('input', () => {
      this.updateGutter();
      clearTimeout(timer);
      timer = setTimeout(() => this.apply(), 350);
    });
    this.text.addEventListener('blur', () => { clearTimeout(timer); this.apply(true); });
    this.text.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: a, selectionEnd: b, value } = this.text;
        this.text.value = value.slice(0, a) + '  ' + value.slice(b);
        this.text.selectionStart = this.text.selectionEnd = a + 2;
        this.text.dispatchEvent(new Event('input'));
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { clearTimeout(timer); this.apply(true); }
    });
    this.text.addEventListener('scroll', () => { this.gutter.scrollTop = this.text.scrollTop; });
    this.forkBtn.addEventListener('click', () => this.fork());
    graph.addEventListener('change', (e) => {
      if (e.detail.kind === 'load' || e.detail.kind === 'structure') {
        if (this.id && !graph.nodes.has(this.id)) this.show(null);
      }
    });
  }

  show(id) {
    this.id = id;
    this.errKey = null;
    const node = id ? this.graph.nodes.get(id) : null;
    const def = node ? this.graph.def(node) : null;
    if (!node || !isImage(def)) {
      this.title.textContent = 'Select an image node to see its shader — or add a GLSL node to write your own';
      this.text.value = '';
      this.text.readOnly = true;
      this.forkBtn.classList.add('hidden');
      this.updateGutter();
      this.errors.textContent = '';
      return;
    }
    const cat = CATEGORIES[def.category];
    if (def.custom) {
      this.title.textContent = `GLSL node ${node.id} — live: edits recompile as you type (⌘↵ to apply now)`;
      this.text.readOnly = false;
      this.text.value = node.code;
      this.forkBtn.classList.add('hidden');
    } else {
      this.title.textContent = `${def.title} · ${cat?.label ?? ''} · built-in (read-only)`;
      this.text.readOnly = true;
      const head = ['// Uniforms this node gets:'];
      for (const i of def.inputs ?? []) head.push(`//   sampler2D t_${i.name}  — image input "${i.label ?? i.name}"`);
      for (const s of def.samplers ?? []) head.push(`//   sampler2D t_${s}`);
      if (def.feedback) head.push('//   sampler2D t_prev  — this node, last frame');
      for (const p of def.params ?? []) {
        if (p.type === 'text') continue;
        head.push(`//   ${glslType(p).padEnd(5)} p_${p.name}${p.integrate ? ` (+ p_${p.name}_t)` : ''}`);
      }
      this.text.value = `${head.join('\n')}\n${def.glsl.trim()}\n`;
      this.forkBtn.classList.remove('hidden');
    }
    this.updateGutter();
    this.tick();
  }

  apply(commit = false) {
    const node = this.id && this.graph.nodes.get(this.id);
    if (!node || node.type !== 'glsl' || this.text.readOnly) return;
    if (node.code !== this.text.value) this.graph.setCode(node.id, this.text.value);
    if (commit) this.graph.commit();
  }

  fork() {
    const g = this.graph;
    const node = g.nodes.get(this.id);
    if (!node) return;
    const def = g.def(node);
    const copy = g.addNode('glsl', node.x, node.y, { code: forkToCustom(def), params: { ...node.params }, depth: { ...node.depth } });
    for (const l of g.linksOf(node.id)) {
      if (l.to === node.id) g.connect(l.from, l.fromPort, copy.id, l.toPort);
      else g.connect(copy.id, l.fromPort, l.to, l.toPort);
    }
    g.removeNode(node.id);
    g.commit();
    this.editor.select(copy.id);
    this.show(copy.id);
  }

  updateGutter() {
    const n = this.text.value.split('\n').length;
    this.gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    this.gutter.scrollTop = this.text.scrollTop;
  }

  tick() {
    if (!this.id) return;
    const errs = this.renderer.errors.get(this.id);
    const key = errs ? JSON.stringify(errs) : 'ok';
    if (key === this.errKey) return;
    this.errKey = key;
    this.errors.replaceChildren();
    if (!errs) {
      if (!this.text.readOnly) {
        const ok = document.createElement('div');
        ok.className = 'ok';
        ok.textContent = '✓ compiled';
        this.errors.append(ok);
      }
      return;
    }
    for (const e of errs) {
      const d = document.createElement('div');
      d.textContent = e.line ? `line ${e.line}: ${e.message}` : e.message;
      this.errors.append(d);
    }
  }
}
