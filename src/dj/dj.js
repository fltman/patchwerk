// The live DJ performs a rig. On every downbeat it asks a decision model what
// suits the next bar, and the answer lands on the next downbeat. Code decides when
// something may change and the model decides what; a late or failed answer means
// nothing changes. Everything runs off the track's beat grid, so it follows what
// you hear, and the picture never waits for the network.
import { checkRig } from './rig.js';
import { isDue, pickMove, questionsFor } from './choose.js';
import { applyOps } from '../ai/ops.js';

const RECENT = 6;        // moves it remembers
const LOG = 40;
const BLACK = 0.012;     // mean brightness
const WHITE = 0.9;
const GREY = 0.15;       // saturation below which a bright picture counts as blown out
const QUIET = 0.15;      // below this energy a dark picture may well be the music
const BLANK_BARS = 2;    // bars the picture must stay blank before the DJ steps in
const RESCUE_EVERY = 8;  // bars between rescues
const GIVE_UP = 4;       // failures in a row; after this it asks only every 8 bars
const MIN_LEAD = 0.3;    // seconds; a downbeat closer than this can't be reached, so don't ask
const FATAL = new Set([401, 402, 403]); // no use trying again: key or credit

async function askServer(body, signal) {
  const r = await fetch('/api/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const json = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || json.error) throw Object.assign(new Error(json.error || `HTTP ${r.status}`), { status: json.status ?? r.status });
  return json;
}

const byte = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
const mixHex = (a, b, t) => `#${[0, 1, 2].map((i) => Math.round(byte(a, i) + (byte(b, i) - byte(a, i)) * t).toString(16).padStart(2, '0')).join('')}`;
const round2 = (x) => +x.toFixed(2);

export class DJ extends EventTarget {
  constructor({ graph, transport, decide = askServer, random = Math.random }) {
    super();
    Object.assign(this, { graph, transport, decide, random });
    this.running = false;
    this.current = new Map();   // group → move name
    this.changedAt = new Map(); // group → bar it last changed
    this.pending = new Map();   // group → { move, by }: lands on the next downbeat
    this.odds = new Map();      // group → the model's last odds
    this.glides = new Map();
    this.touched = new Set();   // nodes whose sliders need redrawing
    this.recent = [];
    this.log = [];
    this.picture = null;
    this.bar = null;
    this.message = '';
    this.resetStats();
    graph.addEventListener('change', (e) => {
      if (e.detail.kind === 'load' && this.running) this.stop('The patch changed, so the DJ stopped', false);
    });
  }

  get rig() { return this.graph.rig; }

  group(name) { return this.rig?.groups.find((g) => g.name === name); }

  resetStats() {
    this.stats = { calls: 0, fails: 0, late: 0, cost: 0, ms: 0, model: '', inRow: 0 };
  }

  update() { this.dispatchEvent(new Event('update')); }

  say(text) {
    this.message = text;
    this.update();
    return false;
  }

  start() {
    const { rig, transport } = this;
    if (!transport.reader) return this.say('Load a track first');
    if (!rig) return this.say('This patch has no rig yet');
    const { problems } = checkRig(this.graph, rig);
    if (problems.length) return this.say(`The rig no longer fits the patch: ${problems[0]}`);
    this.resetStats();
    this.pending.clear();
    this.recent = [];
    this.log = [];
    this.bar = null;
    this.blankBars = 0;
    this.rescuedAt = -Infinity;
    if (!transport.playing) transport.play();
    this.running = true;
    this.message = '';
    for (const g of rig.groups) this.fire(g, g.moves[0], { by: 'start', bars: Math.min(1, g.moves[0].glide) });
    this.update();
    return true;
  }

  stop(message = '', commit = true) {
    this.running = false;
    this.abort?.abort();
    this.pending.clear();
    this.message = message;
    if (commit) this.graph.commit();
    this.update();
  }

  // Your own pick: lands on the next downbeat, or right away when the DJ isn't playing.
  queue(groupName, moveName) {
    const g = this.group(groupName);
    const move = g?.moves.find((m) => m.name === moveName);
    if (!move) return;
    if (this.running) this.pending.set(g.name, { move, by: 'you' });
    else this.fire(g, move, { by: 'you' });
    this.update();
  }

  // ── every frame ───────────────────────────────────────
  tick() {
    const { reader, playing } = this.transport;
    if (!reader) return;
    const time = this.transport.time;
    const pos = reader.beatPosition(time);
    this.stepGlides(pos);
    if (!this.running || !playing) return;
    const f = reader.features(time);
    if (f.barIndex === this.bar) return;
    const jumped = this.bar !== null && f.barIndex !== this.bar + 1;
    this.bar = f.barIndex;
    if (jumped) this.pending.clear(); // seeked or looped: those were meant for another moment
    for (const [name, { move, by, odds }] of this.pending) this.fire(this.group(name), move, { by, odds });
    this.pending.clear();
    this.watchPicture(f.energy);
    if (reader.barTime(this.bar + 1) - time >= MIN_LEAD) this.ask(this.bar + 1);
    this.update();
  }

  // ── asking ────────────────────────────────────────────
  ask(bar) {
    const { reader } = this.transport;
    if (this.stats.inRow >= GIVE_UP && bar % 8) return;
    const section = reader.sectionAtBar(bar);
    const due = this.rig.groups.filter((g) => !this.pending.has(g.name) && isDue(g, bar, section));
    if (!due.length) return;
    this.abort?.abort(); // anything still on its way is too late now
    const abort = (this.abort = new AbortController());
    const t0 = performance.now();
    this.decide({ state: this.moment(bar, section), questions: questionsFor(due) }, abort.signal).then(
      (res) => this.answered(bar, due, res, performance.now() - t0),
      (e) => this.failed(e),
    );
  }

  // What the model gets to see. Nothing about the patch: the moves say what they do.
  moment(bar, section) {
    const { reader } = this.transport;
    const a = reader.analysis;
    const t = reader.barTime(bar);
    const span = reader.period * 4;
    const was = reader.energyAt(t - 4 * span), is = reader.energyAt(t), will = reader.energyAt(t + 4 * span);
    const change = will - was;
    const now = {}, held = {};
    for (const g of this.rig.groups) {
      now[g.name] = this.current.get(g.name);
      held[g.name] = Math.max(0, bar - (this.changedAt.get(g.name) ?? bar));
    }
    return {
      direction: this.rig.brief || undefined,
      music: {
        bpm: Math.round(a.bpm),
        section: section?.label,
        bars_into_section: section?.into,
        bars_left_in_section: section?.left,
        next_section: section?.next?.label ?? 'end of the track',
        energy: round2(is),
        energy_trend: change > 0.12 ? 'rising' : change < -0.12 ? 'falling' : 'steady',
        energy_in_4_bars: round2(will),
      },
      picture: this.picture ?? undefined,
      playing_now: now,
      bars_held: held,
      recent_moves: this.recent,
    };
  }

  answered(bar, due, res, ms) {
    const s = this.stats;
    s.calls++;
    s.inRow = 0;
    s.cost += res.usage?.cost ?? 0;
    s.ms = ms;
    s.model = res.model ?? s.model;
    if (!this.running) return;
    if (this.bar !== bar - 1) { s.late++; this.update(); return; }
    for (const g of due) {
      if (this.pending.has(g.name) || !res.answers?.[g.name]) continue;
      const current = this.current.get(g.name);
      const { move, odds } = pickMove(g, res.answers[g.name], {
        current,
        heldBars: bar - (this.changedAt.get(g.name) ?? bar),
        recent: this.recent.filter((r) => r.startsWith(`${g.name}:`)).map((r) => r.slice(g.name.length + 1)),
        random: this.random,
      });
      this.odds.set(g.name, odds);
      if (move) this.pending.set(g.name, { move, by: 'dj', odds });
    }
    this.update();
  }

  failed(e) {
    if (e.name === 'AbortError') {
      if (this.running) this.stats.late++;
      return;
    }
    this.stats.fails++;
    this.stats.inRow++;
    if (FATAL.has(e.status)) this.stop(`The DJ stopped: ${e.message}`);
    else this.say(e.message);
  }

  // A black or blown-out picture is for code to catch: back to the moves known to look right.
  watchPicture(energy) {
    const p = this.picture;
    const blank = p && (p.brightness < BLACK || (p.brightness > WHITE && p.saturation < GREY));
    this.blankBars = blank && energy >= QUIET ? this.blankBars + 1 : 0;
    if (this.blankBars < BLANK_BARS || this.bar - this.rescuedAt < RESCUE_EVERY) return;
    this.rescuedAt = this.bar;
    for (const g of this.rig.groups) {
      if (this.current.get(g.name) !== g.moves[0].name) this.pending.set(g.name, { move: g.moves[0], by: 'safety' });
    }
  }

  // ── moves ─────────────────────────────────────────────
  // Plays a move now. bars: how long it takes, in bars.
  fire(group, move, { by = 'dj', bars = move.glide, odds } = {}) {
    const { reader, playing } = this.transport;
    const time = this.transport.time;
    const pos = reader ? reader.beatPosition(time) : 0;
    const beats = playing && reader ? bars * 4 : 0;
    for (const op of move.ops) {
      if (op.op === 'set') {
        for (const [name, v] of Object.entries(op.params)) this.glideTo(op.id, 'params', name, v, pos, beats);
        for (const [name, v] of Object.entries(op.depth)) this.glideTo(op.id, 'depth', name, v, pos, beats);
      } else if (op.op === 'connect') {
        applyOps(this.graph, [op]);
        this.touched.add(op.to);
      } else {
        const l = this.graph.linkInto(op.to, op.to_port);
        if (l) this.graph.disconnect(l.id);
      }
    }
    const was = this.current.get(group.name);
    if (was && was !== move.name) this.recent = [...this.recent, `${group.name}:${was}`].slice(-RECENT);
    this.current.set(group.name, move.name);
    this.changedAt.set(group.name, this.bar ?? 0);
    const beat = pos - (reader ? reader.beatPosition(reader.barTime(this.bar ?? 0)) : 0); // into the bar
    this.log = [...this.log, { bar: this.bar, group: group.name, move: move.name, by, beat, odds: odds?.[move.name] }].slice(-LOG);
  }

  glideTo(id, field, name, value, pos, beats) {
    const node = this.graph.nodes.get(id);
    if (!node) return;
    const p = this.graph.def(node).params?.find((q) => q.name === name);
    const key = `${id}.${field}.${name}`;
    const from = field === 'depth' ? node.depth[name] ?? 0.5 : node.params[name];
    this.glides.delete(key);
    if (!beats || !p || p.type === 'select' || p.type === 'text' || from === value) { this.write(id, field, name, value); return; }
    this.glides.set(key, { id, field, name, from, to: value, p0: pos, p1: pos + beats, color: p.type === 'color', step: p.step });
  }

  write(id, field, name, value) {
    if (field === 'depth') this.graph.setDepth(id, name, value);
    else this.graph.setParam(id, name, value);
    this.touched.add(id);
  }

  stepGlides(pos) {
    for (const [key, g] of this.glides) {
      // well behind the start means the track looped or was seeked: finish it
      const t = pos < g.p0 - 1 ? 1 : Math.max(0, Math.min(1, (pos - g.p0) / (g.p1 - g.p0)));
      const e = t * t * (3 - 2 * t);
      let v;
      if (g.color) v = mixHex(g.from, g.to, e);
      else {
        v = g.from + (g.to - g.from) * e;
        if (g.step) v = Math.round(v / g.step) * g.step;
      }
      this.write(g.id, g.field, g.name, t >= 1 ? g.to : v);
      if (t >= 1) this.glides.delete(key);
    }
  }
}
