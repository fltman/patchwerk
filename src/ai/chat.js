// The patch assistant: a chat panel that turns descriptions into patches.
// The browser runs the tool loop (it owns the graph); the server only relays to the model.
import { applyOps, describePatch } from './ops.js';
import { checkRig } from '../dj/rig.js';
import { audition } from '../dj/audition.js';

const STORE = 'patchwerk.chat.v1';
const MAX_ROUNDS = 14; // a rig takes several rounds: patch, moves, audition, fixes
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
// just enough markdown for chat: paragraphs, **bold**, `code`
function richText(s) {
  return escapeHtml(s.trim())
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

export class Chat {
  constructor({ graph, editor, renderer, transport, dj, toast }) {
    Object.assign(this, { graph, editor, renderer, transport, dj, toast });
    this.panel = document.getElementById('chat');
    this.log = document.getElementById('chat-log');
    this.input = document.getElementById('chat-input');
    this.sendBtn = document.getElementById('chat-send');
    this.history = [];   // what the model sees (OpenAI-style messages)
    this.items = [];     // what the panel shows
    this.busy = false;
    this.abort = null;

    document.getElementById('chat-form').addEventListener('submit', (e) => { e.preventDefault(); this.busy ? this.stop() : this.send(); });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!this.busy) this.send(); }
      if (e.key === 'Escape') this.input.blur();
    });
    document.getElementById('chat-new').addEventListener('click', () => this.reset());
    document.getElementById('chat-close').addEventListener('click', () => this.toggle(false));
    this.restore();
  }

  toggle(open = this.panel.classList.contains('hidden')) {
    this.panel.classList.toggle('hidden', !open);
    document.getElementById('ai-btn').classList.toggle('active', open);
    this.editor.insetRight = open ? this.panel.offsetWidth : 0;
    if (open) setTimeout(() => this.input.focus(), 0);
  }

  // ── conversation ──────────────────────────────────────
  context() {
    const t = this.transport;
    const a = t.reader?.analysis;
    const head = a
      ? `[Patch right now — track "${t.name}", ${t.playing ? 'playing' : 'paused'} at ${fmtTime(t.time)} of ${fmtTime(t.duration)}, ${a.bpm.toFixed(1)} BPM]`
      : '[Patch right now — no track loaded]';
    const sections = a?.sections?.length ? `\nSections: ${a.sections.map((s) => `${fmtTime(s.start)} ${s.label} (${s.bars} bars)`).join(', ')}` : '';
    const rig = this.graph.rig ? `\nThe rig in full: ${JSON.stringify(this.graph.rig)}` : '';
    return `${head}${sections}\n${describePatch(this.graph, { selected: [...this.editor.selected] })}${rig}`;
  }

  async send(text = this.input.value.trim()) {
    if (!text || this.busy) return;
    this.input.value = '';
    this.history.push({ role: 'user', content: `${this.context()}\n\n${text}` });
    this.add({ kind: 'user', text });
    this.setBusy(true);
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await this.request();
        if (!res) break;
        const msg = res.message;
        this.history.push(msg);
        if (msg.content?.trim()) this.add({ kind: 'assistant', text: msg.content });
        if (res.finish === 'length') this.add({ kind: 'error', text: 'The answer was cut off (too long).' });
        if (!msg.tool_calls?.length) break;
        const images = [];
        for (const call of msg.tool_calls) {
          const result = await this.runTool(call, images);
          this.history.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        if (images.length) {
          this.history.push({ role: 'user', content: [{ type: 'text', text: 'Snapshot of the output:' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] });
        }
        if (this.stopped) break;
      }
    } catch (e) {
      if (e.name !== 'AbortError') this.add({ kind: 'error', text: e.message });
    }
    this.setBusy(false);
    this.save();
  }

  // older snapshots are dropped from what we resend — only the latest picture matters
  outgoing() {
    let seen = 0;
    return [...this.history].reverse().map((m) => {
      if (!Array.isArray(m.content) || !m.content.some((p) => p.type === 'image_url')) return m;
      if (seen++ === 0) return m;
      return { role: m.role, content: '[an earlier snapshot of the output]' };
    }).reverse();
  }

  async request() {
    this.abort = new AbortController();
    this.status(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: this.outgoing() }),
        signal: this.abort.signal,
      });
      const json = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    } finally {
      this.status(false);
    }
  }

  async runTool(call, images) {
    let args = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { return 'The arguments were not valid JSON — send them again.'; }
    if (call.function.name === 'edit_patch') {
      const g = this.graph;
      const heightOf = (id) => this.editor.views.get(id)?.h || undefined;
      const r = applyOps(g, args.operations, { heightOf: (id) => heightOf(id) ?? 200 });
      g.commit();
      for (const id of r.touched) this.editor.refreshNode(id);
      this.editor.syncPositions();
      if (r.added.length || r.cleared) this.editor.frameAll();
      // let the renderer compile anything new, then report shaders that don't build
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      const broken = r.touched
        .filter((id) => this.renderer.errors.has(id))
        .map((id) => `⚠ ${id} does not compile: ${this.renderer.errors.get(id).slice(0, 3).map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join(' | ')}`);
      this.add({ kind: 'ops', lines: [...r.log, ...broken] });
      return `${[...r.log, ...broken].join('\n')}\n\nPatch now:\n${describePatch(g, { selected: [...this.editor.selected] })}`;
    }
    if (call.function.name === 'look') {
      try {
        const url = await this.renderer.snapshot(640);
        images.push(url);
        this.add({ kind: 'look', url });
        const t = this.transport;
        return `Snapshot taken at ${fmtTime(t.time)} (${t.playing ? 'playing' : 'paused'}). It follows in the next message.`;
      } catch (e) {
        return `Could not take a snapshot: ${e.message}`;
      }
    }
    if (call.function.name === 'set_rig') {
      const { rig, problems, notes } = checkRig(this.graph, args);
      const lines = problems.length ? problems.map((p) => `✗ ${p}`) : [`✓ rig saved: ${rig.groups.map((g) => `${g.name} (${g.moves.length} moves)`).join(', ')}`, ...notes.map((n) => `⚠ ${n}`)];
      this.add({ kind: 'ops', lines });
      if (problems.length) return `The rig was not saved. Fix these and send it again:\n${lines.join('\n')}`;
      this.graph.setRig(rig);
      this.graph.commit();
      return `${lines.join('\n')}\n\nThe rig isn't ready yet: call audition now, once for each group, and look at every picture before you reply.`;
    }
    if (call.function.name === 'audition') {
      try {
        const r = await audition({ dj: this.dj, renderer: this.renderer, transport: this.transport, group: args.group });
        images.push(...r.images);
        for (const url of r.images) this.add({ kind: 'look', url });
        return `${r.lines.join('\n')}${r.images.length ? '\nThe rig is back on its home moves. The images follow in the next message, in this order.' : ''}`;
      } catch (e) {
        return `Could not audition: ${e.message}`;
      }
    }
    return `Unknown tool ${call.function.name}`;
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  setBusy(on) {
    this.busy = on;
    this.stopped = false;
    this.sendBtn.textContent = on ? 'Stop' : 'Send';
    this.panel.classList.toggle('busy', on);
  }

  status(on) {
    clearInterval(this.timer);
    this.statusEl?.remove();
    this.statusEl = null;
    if (!on) return;
    const el = document.createElement('div');
    el.className = 'chat-status';
    const t0 = performance.now();
    const tick = () => { el.textContent = `Thinking… ${Math.round((performance.now() - t0) / 1000)} s`; };
    tick();
    this.timer = setInterval(tick, 500);
    this.log.append(el);
    this.statusEl = el;
    this.scroll();
  }

  // ── display ───────────────────────────────────────────
  add(item, persist = true) {
    if (persist) this.items.push(item);
    const el = document.createElement('div');
    el.className = `chat-item ${item.kind}`;
    if (item.kind === 'user' || item.kind === 'error') el.textContent = item.text;
    else if (item.kind === 'assistant') el.innerHTML = richText(item.text);
    else if (item.kind === 'ops') {
      const lines = item.lines;
      const shown = lines.length > 10 ? [...lines.slice(0, 9), `… ${lines.length - 9} more`] : lines;
      for (const l of shown) {
        const d = document.createElement('div');
        d.className = l.startsWith('✗') || l.startsWith('⚠') ? 'bad' : '';
        d.textContent = l;
        el.append(d);
      }
    } else if (item.kind === 'look') {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = 'What the assistant saw';
      el.append(img);
    }
    if (this.statusEl) this.log.insertBefore(el, this.statusEl);
    else this.log.append(el);
    this.scroll();
  }

  scroll() { this.log.scrollTop = this.log.scrollHeight; }

  greet() {
    this.add({
      kind: 'assistant',
      text: 'Describe what you want to see and I\'ll patch it — for example **"a neon tunnel that rushes forward on the bass and flashes on the kick"**, or **"make the selected node react to the hi-hats"**. I know every module and how they connect. ⌘Z undoes my last change.',
    }, false);
  }

  reset() {
    this.stop();
    this.history = [];
    this.items = [];
    this.log.replaceChildren();
    this.greet();
    this.save();
  }

  save() {
    // snapshots are big; keep the text of the conversation only
    const strip = (m) => (Array.isArray(m.content) ? { ...m, content: '[snapshot of the output]' } : m);
    const items = this.items.filter((i) => i.kind !== 'look');
    try {
      localStorage.setItem(STORE, JSON.stringify({ history: this.history.map(strip), items }));
    } catch { /* storage full: forget it */ }
  }

  restore() {
    this.greet();
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      if (!s?.history?.length) return;
      // a conversation cut off mid tool-call can't be resumed: drop the dangling tail
      let h = s.history;
      while (h.length && h[h.length - 1].role === 'assistant' && h[h.length - 1].tool_calls) h = h.slice(0, -1);
      this.history = h;
      this.items = s.items ?? [];
      for (const item of this.items) this.add(item, false);
    } catch { /* ignore */ }
  }
}
