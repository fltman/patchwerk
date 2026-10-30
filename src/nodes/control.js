// Control (CV) nodes — JavaScript, evaluated once per frame in graph order.
// Outputs are plain floats, mostly 0..1. See CONTRACT.md.
import { FEATURE_NAMES } from '../audio/features.js';

const FEATURE_LABELS = {
  level: 'Level', bass: 'Bass', lowmid: 'Low mid', mid: 'Mid', high: 'High', treble: 'Treble',
  kick: 'Kick', snare: 'Snare', hat: 'Hat', beat: 'Beat', downbeat: 'Downbeat',
  phase: 'Beat phase', bar: 'Bar phase', energy: 'Energy',
};
const SMOOTHED = new Set(['level', 'bass', 'lowmid', 'mid', 'high', 'treble']);
const SILENT = Object.fromEntries(FEATURE_NAMES.map((k) => [k, 0]));

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const fract = (x) => x - Math.floor(x);
const hash = (n) => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);
// frame-rate independent one-pole: `amount` 0 = instant, ~1 = very slow
const smoothK = (amount, dt) => 1 - Math.pow(Math.min(amount, 0.999), Math.max(dt, 0) * 60);

// Schmitt-style trigger: fires when a signal jumps up or crosses 0.35 from below 0.15.
function triggered(state, key, v) {
  const prev = state[key + 'Prev'] ?? 0;
  const armed = state[key + 'Armed'] ?? true;
  state[key + 'Prev'] = v;
  let fire = false;
  if ((armed && v > 0.35) || v - prev > 0.25) { fire = true; state[key + 'Armed'] = false; }
  if (v < 0.15) state[key + 'Armed'] = true;
  return fire;
}

const hz = (v) => {
  const f = 30 * Math.pow(16000 / 30, v);
  return f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;
};

export default [
  {
    type: 'track',
    title: 'Track',
    category: 'audio',
    description: 'The music, analysed: bands, drum hits, beat clock, energy',
    tags: ['audio', 'music', 'bass', 'kick', 'beat', 'bpm', 'input'],
    params: [
      { name: 'gain', label: 'Gain', min: 0, max: 4, default: 1 },
      { name: 'smooth', label: 'Smooth', min: 0, max: 0.95, default: 0.3 },
      { name: 'decay', label: 'Decay', min: 0.03, max: 1, default: 0.22, unit: 's' },
    ],
    outputs: FEATURE_NAMES.map((name) => ({ name, label: FEATURE_LABELS[name] })),
    process(ctx, p, st) {
      const f = ctx.reader ? ctx.reader.features(ctx.time, p.decay) : SILENT;
      const k = smoothK(p.smooth, ctx.wallDt);
      const out = {};
      for (const name of FEATURE_NAMES) {
        if (SMOOTHED.has(name)) {
          const target = f[name] * p.gain;
          st[name] = st[name] === undefined ? target : st[name] + (target - st[name]) * k;
          out[name] = st[name];
        } else out[name] = f[name];
      }
      return out;
    },
  },
  {
    type: 'band',
    title: 'Band',
    category: 'audio',
    description: 'Level of any frequency range you pick',
    tags: ['frequency', 'eq', 'filter', 'spectrum'],
    params: [
      { name: 'low', label: 'From Hz', min: 0, max: 1, default: 0.35, format: hz },
      { name: 'high', label: 'To Hz', min: 0, max: 1, default: 0.6, format: hz },
      { name: 'gain', label: 'Gain', min: 0, max: 4, default: 1.5 },
      { name: 'smooth', label: 'Smooth', min: 0, max: 0.95, default: 0.4 },
    ],
    outputs: [{ name: 'out', label: 'Level' }],
    process(ctx, p, st) {
      let v = 0;
      if (ctx.spectrum) {
        const n = ctx.spectrum.length;
        const a = Math.floor(Math.min(p.low, p.high) * (n - 1));
        const b = Math.max(a, Math.ceil(Math.max(p.low, p.high) * (n - 1)));
        for (let i = a; i <= b; i++) v += ctx.spectrum[i] / 255;
        v /= b - a + 1;
        v = Math.pow(v, 2); // the spectrum is in dB; squaring puts quiet stuff back down
      }
      const target = v * p.gain;
      st.v = st.v === undefined ? target : st.v + (target - st.v) * smoothK(p.smooth, ctx.wallDt);
      return { out: st.v };
    },
  },
  {
    type: 'clock',
    title: 'Clock',
    category: 'audio',
    description: 'Ramps locked to the beat grid: 16ths up to 4 bars',
    tags: ['tempo', 'sync', 'bpm', 'ramp', 'phase'],
    params: [],
    outputs: [
      { name: 's16', label: '1/16' },
      { name: 's8', label: '1/8' },
      { name: 'beat', label: 'Beat' },
      { name: 'bar', label: 'Bar' },
      { name: 'bar2', label: '2 bars' },
      { name: 'bar4', label: '4 bars' },
    ],
    process(ctx) {
      const pos = ctx.beatPos - (ctx.reader?.analysis.downbeat ?? 0);
      return {
        s16: fract(pos * 4), s8: fract(pos * 2), beat: fract(pos),
        bar: fract(pos / 4), bar2: fract(pos / 8), bar4: fract(pos / 16),
      };
    },
  },
  {
    type: 'number',
    title: 'Number',
    category: 'control',
    description: 'A constant you set with a slider',
    tags: ['value', 'constant', 'knob'],
    params: [{ name: 'value', label: 'Value', min: 0, max: 1, default: 0.5 }],
    outputs: [{ name: 'out', label: 'Value' }],
    process: (ctx, p) => ({ out: p.value }),
  },
  {
    type: 'lfo',
    title: 'LFO',
    category: 'control',
    description: 'Low-frequency oscillator, free or synced to beats',
    tags: ['oscillator', 'sine', 'wave', 'modulation', 'sync'],
    params: [
      { name: 'rate', label: 'Rate', min: 0.01, max: 8, default: 0.5 },
      { name: 'shape', label: 'Shape', type: 'select', options: ['Sine', 'Triangle', 'Saw', 'Ramp down', 'Square', 'Random'], default: 0 },
      { name: 'sync', label: 'Sync', type: 'select', options: ['Free (Hz)', 'Beats (per beat)'], default: 0 },
      { name: 'offset', label: 'Phase', min: 0, max: 1, default: 0 },
    ],
    outputs: [{ name: 'out', label: 'Out' }],
    process(ctx, p, st) {
      let x;
      if (p.sync === 1) x = ctx.beatPos * p.rate;
      else { st.phase = (st.phase ?? 0) + p.rate * ctx.dt; x = st.phase; }
      x += p.offset;
      const f = fract(x);
      const out = [
        0.5 - 0.5 * Math.cos(f * Math.PI * 2),
        1 - Math.abs(2 * f - 1),
        f,
        1 - f,
        f < 0.5 ? 1 : 0,
        hash(Math.floor(x)),
      ][p.shape] ?? 0;
      return { out };
    },
  },
  {
    type: 'wander',
    title: 'Wander',
    category: 'control',
    description: 'Smooth random drift, never repeats',
    tags: ['noise', 'random', 'drift', 'organic', 'perlin'],
    params: [
      { name: 'speed', label: 'Speed', min: 0.01, max: 4, default: 0.3 },
      { name: 'seed', label: 'Seed', min: 0, max: 100, default: 7, step: 1 },
    ],
    outputs: [{ name: 'out', label: 'Out' }],
    process(ctx, p, st) {
      st.x = (st.x ?? 0) + p.speed * ctx.dt;
      const i = Math.floor(st.x), f = st.x - i;
      const u = f * f * (3 - 2 * f);
      const a = hash(i + p.seed * 17.3), b = hash(i + 1 + p.seed * 17.3);
      return { out: a + (b - a) * u };
    },
  },
  {
    type: 'sequencer',
    title: 'Sequencer',
    category: 'control',
    description: 'Eight steps of values, stepped by the beat grid or a trigger',
    tags: ['step', 'pattern', 'switch', 'beat', 'sequence'],
    params: [
      { name: 'clock', label: 'Clock', type: 'select', options: ['16ths', '8ths', 'Beats', 'Bars', 'Trigger'], default: 2 },
      { name: 'trigger', label: 'Trigger', min: 0, max: 1, default: 0, raw: true },
      { name: 'steps', label: 'Steps', min: 1, max: 8, default: 4, step: 1 },
      ...[0.0, 0.33, 0.66, 1.0, 0.5, 0.2, 0.8, 0.4].map((d, i) => ({ name: `s${i + 1}`, label: `Step ${i + 1}`, min: 0, max: 1, default: d })),
    ],
    outputs: [
      { name: 'out', label: 'Value' },
      { name: 'index', label: 'Step' },
    ],
    process(ctx, p, st) {
      const n = Math.max(1, Math.round(p.steps));
      let i;
      if (p.clock === 4) {
        if (triggered(st, 'trig', p.trigger)) st.count = (st.count ?? -1) + 1;
        i = (st.count ?? 0) % n;
      } else {
        const pos = ctx.beatPos - (ctx.reader?.analysis.downbeat ?? 0);
        const per = [4, 2, 1, 0.25][p.clock];
        i = ((Math.floor(pos * per) % n) + n) % n;
      }
      return { out: p[`s${i + 1}`], index: n > 1 ? i / (n - 1) : 0 };
    },
  },
  {
    type: 'random',
    title: 'Random',
    category: 'control',
    description: 'New random value on every trigger (sample & hold)',
    tags: ['sample and hold', 's&h', 'chance', 'trigger'],
    params: [
      { name: 'trigger', label: 'Trigger', min: 0, max: 1, default: 0, raw: true },
      { name: 'glide', label: 'Glide', min: 0, max: 0.95, default: 0 },
    ],
    outputs: [{ name: 'out', label: 'Out' }],
    process(ctx, p, st, node) {
      if (triggered(st, 'trig', p.trigger) || st.target === undefined) {
        st.count = (st.count ?? 0) + 1;
        st.target = hash(st.count * 3.7 + node.id.length * 11.1 + parseInt(node.id.slice(1), 10) * 0.37);
      }
      st.v = st.v === undefined ? st.target : st.v + (st.target - st.v) * smoothK(p.glide, ctx.wallDt);
      return { out: st.v };
    },
  },
  {
    type: 'envelope',
    title: 'Envelope',
    category: 'control',
    description: 'Attack/decay envelope fired by a trigger',
    tags: ['ad', 'adsr', 'trigger', 'pulse', 'hit'],
    params: [
      { name: 'trigger', label: 'Trigger', min: 0, max: 1, default: 0, raw: true },
      { name: 'attack', label: 'Attack', min: 0, max: 2, default: 0.01, unit: 's' },
      { name: 'decay', label: 'Decay', min: 0.01, max: 4, default: 0.5, unit: 's' },
      { name: 'curve', label: 'Curve', min: 0.2, max: 5, default: 2 },
    ],
    outputs: [{ name: 'out', label: 'Out' }],
    process(ctx, p, st) {
      if (triggered(st, 'trig', p.trigger)) { st.stage = 'a'; st.start = st.v ?? 0; st.t = 0; }
      st.t = (st.t ?? 0) + ctx.wallDt;
      let v = 0;
      if (st.stage === 'a') {
        v = p.attack > 0 ? st.start + (1 - st.start) * Math.min(1, st.t / p.attack) : 1;
        if (st.t >= p.attack) { st.stage = 'd'; st.t = 0; }
      } else if (st.stage === 'd') {
        const x = Math.min(1, st.t / p.decay);
        v = Math.pow(1 - x, p.curve);
        if (x >= 1) st.stage = null;
      }
      st.v = v;
      return { out: v };
    },
  },
  {
    type: 'smooth',
    title: 'Smooth',
    category: 'control',
    description: 'Slew limiter: separate rise and fall times',
    tags: ['slew', 'lag', 'follower', 'filter', 'soften'],
    params: [
      { name: 'in', label: 'In', min: 0, max: 1, default: 0, raw: true },
      { name: 'rise', label: 'Rise', min: 0, max: 2, default: 0.03, unit: 's' },
      { name: 'fall', label: 'Fall', min: 0, max: 4, default: 0.4, unit: 's' },
    ],
    outputs: [{ name: 'out', label: 'Out' }],
    process(ctx, p, st) {
      const v = st.v ?? p.in;
      const tau = p.in > v ? p.rise : p.fall;
      const k = tau > 0 ? 1 - Math.exp(-ctx.wallDt / tau) : 1;
      st.v = v + (p.in - v) * k;
      return { out: st.v };
    },
  },
  {
    type: 'math',
    title: 'Math',
    category: 'control',
    description: 'Combine two signals: add, multiply, min, max…',
    tags: ['add', 'multiply', 'subtract', 'min', 'max', 'arithmetic'],
    params: [
      { name: 'a', label: 'A', min: -2, max: 2, default: 1, raw: true },
      { name: 'b', label: 'B', min: -2, max: 2, default: 1, raw: true },
      { name: 'op', label: 'Op', type: 'select', options: ['A × B', 'A + B', 'A − B', 'A ÷ B', 'min', 'max', 'A ^ B', '|A − B|', 'average'], default: 0 },
    ],
    outputs: [{ name: 'out', label: 'Out' }],
    process(ctx, { a, b, op }) {
      const r = [a * b, a + b, a - b, Math.abs(b) > 1e-6 ? a / b : 0, Math.min(a, b), Math.max(a, b),
        Math.pow(Math.max(a, 0), b), Math.abs(a - b), (a + b) / 2][op];
      return { out: Number.isFinite(r) ? r : 0 };
    },
  },
  {
    type: 'map',
    title: 'Map Range',
    category: 'control',
    description: 'Rescale a signal, with a curve',
    tags: ['scale', 'range', 'remap', 'curve', 'invert'],
    params: [
      { name: 'in', label: 'In', min: 0, max: 1, default: 0, raw: true },
      { name: 'inMin', label: 'In min', min: 0, max: 1, default: 0 },
      { name: 'inMax', label: 'In max', min: 0, max: 1, default: 1 },
      { name: 'outMin', label: 'Out min', min: -1, max: 2, default: 0 },
      { name: 'outMax', label: 'Out max', min: -1, max: 2, default: 1 },
      { name: 'curve', label: 'Curve', min: 0.2, max: 5, default: 1 },
    ],
    outputs: [{ name: 'out', label: 'Out' }],
    process(ctx, p) {
      const span = p.inMax - p.inMin;
      const x = clamp01(Math.abs(span) > 1e-6 ? (p.in - p.inMin) / span : 0);
      return { out: p.outMin + (p.outMax - p.outMin) * Math.pow(x, p.curve) };
    },
  },
  {
    type: 'gate',
    title: 'Gate',
    category: 'control',
    description: '1 while the input is above a threshold, else 0',
    tags: ['threshold', 'compare', 'trigger', 'on off'],
    params: [
      { name: 'in', label: 'In', min: 0, max: 1, default: 0, raw: true },
      { name: 'level', label: 'Level', min: 0, max: 1, default: 0.5 },
    ],
    outputs: [
      { name: 'out', label: 'Gate' },
      { name: 'inv', label: 'Inverted' },
    ],
    process(ctx, p) {
      const g = p.in > p.level ? 1 : 0;
      return { out: g, inv: 1 - g };
    },
  },
];
