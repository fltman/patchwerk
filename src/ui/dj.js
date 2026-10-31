// The DJ panel: every group of the rig as a row of pads. The lit pad is playing,
// the blinking one lands on the next downbeat, the bar under a pad is what the
// model thought of it. Click a pad to play it yourself.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const DARING = 'patchwerk.dj.daring';

export class DJPanel {
  constructor({ dj, graph, chat, transport }) {
    Object.assign(this, { dj, graph, chat, transport });
    this.panel = document.getElementById('dj');
    this.rows = document.getElementById('dj-groups');
    this.status = document.getElementById('dj-status');
    this.meta = document.getElementById('dj-meta');
    this.startBtn = document.getElementById('dj-start');
    this.btn = document.getElementById('dj-btn');
    this.pads = new Map();
    this.btn.onclick = () => this.toggle();
    document.getElementById('dj-close').onclick = () => this.toggle(false);
    document.getElementById('dj-build').onclick = () => this.build();
    this.startBtn.onclick = () => (dj.running ? dj.stop() : dj.start());
    const daring = document.getElementById('dj-daring');
    daring.value = localStorage.getItem(DARING) ?? daring.value;
    dj.daring = daring.value / 100;
    daring.oninput = () => { dj.daring = daring.value / 100; localStorage.setItem(DARING, daring.value); };
    daring.onkeydown = (e) => e.stopPropagation(); // arrows nudge the knob, not the patch
    dj.addEventListener('update', () => this.refresh());
    graph.addEventListener('change', (e) => { if (e.detail.kind === 'rig' || e.detail.kind === 'load') this.render(); });
    this.render();
  }

  toggle(open = this.panel.classList.contains('hidden')) {
    this.panel.classList.toggle('hidden', !open);
    this.btn.classList.toggle('active', open);
  }

  // leaves the request in the chat box, so you can say what kind of set it should be
  build() {
    this.chat.toggle(true);
    this.chat.input.value = 'Build a live DJ rig for this track. ';
    this.chat.input.focus();
  }

  render() {
    this.rows.replaceChildren();
    this.pads.clear();
    const rig = this.graph.rig;
    this.startBtn.disabled = !rig;
    if (!rig) this.rows.append(el('div', 'dj-empty', 'No rig on this patch. Ask the assistant to build one, or load the example “DJ rig”.'));
    for (const g of rig?.groups ?? []) {
      const row = el('div', 'dj-row');
      const head = el('div', 'dj-group', g.name);
      head.title = g.question;
      row.append(head);
      for (const m of g.moves) {
        const pad = el('button', 'dj-pad', m.name);
        pad.title = m.description;
        pad.dataset.pad = `${g.name}/${m.name}`;
        pad.onclick = () => this.dj.queue(g.name, m.name);
        const odds = el('i');
        pad.append(odds);
        row.append(pad);
        this.pads.set(pad.dataset.pad, { pad, odds, group: g.name, move: m.name });
      }
      this.rows.append(row);
    }
    this.refresh();
  }

  refresh() {
    const { dj } = this;
    this.startBtn.textContent = dj.running ? 'Stop' : 'Start';
    this.startBtn.classList.toggle('accent', !dj.running);
    this.btn.classList.toggle('live', dj.running);
    for (const { pad, odds, group, move } of this.pads.values()) {
      pad.classList.toggle('on', dj.current.get(group) === move);
      pad.classList.toggle('next', dj.pending.get(group)?.move.name === move);
      const scale = dj.group(group)?.ordered ? 0 : dj.odds.get(group)?.[move] ?? 0;
      odds.style.width = `${Math.round(scale * 100)}%`;
    }
    const r = this.transport.reader;
    let line = dj.message;
    if (dj.running && r && dj.bar !== null) {
      const heard = r.analysis.live && dj.ear.now(dj.bar);
      const s = !heard && r.sectionAtBar(dj.bar);
      const where = heard ? [heard.section, heard.just_changed].filter(Boolean).join(', ')
        : s ? `${s.label}, ${s.left} bars left${s.next ? ` → ${s.next.label}` : ''}` : '';
      line = [`bar ${dj.bar + 1}`, where, dj.message].filter(Boolean).join(' · ');
    }
    this.status.textContent = line;
    const st = dj.stats;
    this.meta.textContent = st.calls || st.fails
      ? `${st.model.replace(/-\d{8}$/, '')} · ${Math.round(st.ms)} ms · ${st.calls} answers${st.late ? `, ${st.late} late` : ''}${st.fails ? `, ${st.fails} failed` : ''} · $${st.cost.toFixed(4)}`
      : '';
  }
}
