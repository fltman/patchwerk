// Calibrates the analysis against tracks with a known answer: synthetic drum
// patterns where every kick, clap and bar start is placed by us.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/audio/analysis.js';
import { createReader } from '../src/audio/features.js';

function synth({ bpm, bars = 24, sr = 44100, lead = 0.37, bassline = true, plays = () => true }) {
  const beat = 60 / bpm;
  const dur = lead + bars * 4 * beat + 1;
  const out = new Float32Array(Math.ceil(dur * sr));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t0, len, fn) => {
    const s0 = Math.round(t0 * sr);
    let prev = 0;
    const total = Math.floor(len * sr), fade = Math.floor(0.005 * sr);
    for (let i = 0; i < total && s0 + i < out.length; i++) {
      const v = fn(i / sr, prev);
      prev = v.raw ?? 0;
      const g = i > total - fade ? (total - i) / fade : 1; // no clicks when a hit ends
      out[s0 + i] += (v.out ?? v) * g;
    }
  };
  const hpNoise = (gain, decay) => (t, prev) => {
    const raw = rnd();
    return { raw, out: (raw - prev) * 0.5 * gain * Math.exp(-t / decay) };
  };
  const kicks = [], barStarts = [];
  for (let i = 0; i < bars * 4; i++) {
    const t = lead + i * beat;
    const bar = Math.floor(i / 4);
    if (i % 4 === 0) barStarts.push(t);
    let ph = 0;
    if (plays('kick', bar)) {
      kicks.push(t);
      add(t, 0.3, (x) => {
        ph += (2 * Math.PI * (48 + 110 * Math.exp(-x / 0.03))) / sr;
        return 0.9 * Math.sin(ph) * Math.exp(-x / 0.14);
      });
    }
    if (plays('clap', bar) && (i % 4 === 1 || i % 4 === 3)) add(t, 0.2, hpNoise(0.6, 0.05));
    if (plays('hat', bar)) add(t + beat / 2, 0.06, hpNoise(0.35, 0.015));
    if (i % 16 === 0) add(t, 1.2, hpNoise(0.25, 0.5));
  }
  if (bassline) {
    // off-grid-ish sawtooth notes so not every onset is a beat
    const notes = [55, 55, 65.4, 49, 73.4, 55, 82.4, 61.7];
    for (let k = 0; k < bars * 8; k++) {
      const f = notes[k % notes.length];
      const t0 = lead + k * (beat / 2) + beat / 4;
      if (plays('bass', Math.floor(k / 8))) add(t0, beat / 2 - 0.01, (x) => 0.12 * (((x * f) % 1) * 2 - 1) * Math.exp(-x / 0.2));
    }
  }
  return { samples: out, sr, kicks, barStarts, beat };
}

const near = (list, t, tol) => list.some((x) => Math.abs(x - t) <= tol);

for (const bpm of [100, 128, 140]) {
  test(`tempo, beat grid and kicks at ${bpm} BPM`, (t) => {
    const { samples, sr, kicks, barStarts } = synth({ bpm });
    const a = analyze(samples, sr);
    assert.ok(Math.abs(a.bpm - bpm) < 0.75, `bpm ${a.bpm.toFixed(2)} vs ${bpm}`);

    const beats = Array.from(a.beats);
    const hit = kicks.filter((k) => near(beats, k, 0.025)).length / kicks.length;
    assert.ok(hit > 0.9, `only ${(hit * 100).toFixed(0)}% of true beats matched by the tracker`);

    const det = Array.from(a.onsets.kick.times);
    const recall = kicks.filter((k) => near(det, k, 0.025)).length / kicks.length;
    const precision = det.filter((d) => near(kicks, d, 0.025)).length / det.length;
    assert.ok(recall > 0.9, `kick recall ${recall.toFixed(2)}`);
    assert.ok(precision > 0.85, `kick precision ${precision.toFixed(2)}`);

    const reader = createReader(a);
    const onTheOne = barStarts.filter((t) => reader.features(t + 0.03).bar < 0.1).length / barStarts.length;
    t.diagnostic(`bpm ${a.bpm.toFixed(2)} · beats matched ${(hit * 100).toFixed(0)}% · kick recall ${(recall * 100).toFixed(0)}% precision ${(precision * 100).toFixed(0)}% · bar starts on the one ${(onTheOne * 100).toFixed(0)}%`);
    assert.ok(onTheOne > 0.85, `bar phase is ~0 on only ${(onTheOne * 100).toFixed(0)}% of bar starts`);
  });
}

test('finds sections where the arrangement changes, and names the breakdown and the drop', () => {
  // bar:  0 ─ kick + hats ─ 8 ─ everything ─ 24 ─ bass and hats only ─ 32 ─ everything ─ 48
  const full = (b) => (b >= 8 && b < 24) || b >= 32;
  const plays = (part, b) => {
    if (part === 'hat') return true;
    if (part === 'kick') return b < 24 || b >= 32;
    return part === 'bass' ? b >= 8 : full(b);
  };
  const bpm = 128, lead = 0.37, bars = 48;
  const { samples, sr } = synth({ bpm, bars, lead, plays });
  const a = analyze(samples, sr);
  const barLength = (60 / bpm) * 4;
  const truth = [8, 24, 32].map((b) => lead + b * barLength);
  const starts = a.sections.slice(1).map((s) => s.start);
  for (const t of truth) assert.ok(starts.some((s) => Math.abs(s - t) < barLength / 2), `no section starts near ${t.toFixed(1)} s: ${starts.map((s) => s.toFixed(1))}`);
  assert.equal(a.sections.length, truth.length + 1, `extra sections: ${a.sections.map((s) => `${s.start.toFixed(1)} ${s.label}`).join(', ')}`);

  const at = (t) => a.sections.find((s) => t >= s.start && t < s.end);
  assert.equal(at(truth[1] + 2 * barLength).label, 'breakdown');
  assert.equal(at(truth[2] + 2 * barLength).label, 'drop');

  const reader = createReader(a);
  const bar = reader.features(truth[1] + 0.1).barIndex;
  const s = reader.sectionAtBar(bar + 2);
  assert.equal(s.label, 'breakdown');
  assert.equal(s.into, 2);
  assert.equal(s.left, 6);
  assert.equal(s.next.label, 'drop');
  assert.ok(Math.abs(reader.barTime(bar) - truth[1]) < 0.05, `bar ${bar} starts at ${reader.barTime(bar)}`);
});

test('a track that never changes is one section', () => {
  const { samples, sr } = synth({ bpm: 128, bars: 32 });
  const a = analyze(samples, sr);
  assert.equal(a.sections.length, 1, a.sections.map((s) => `${s.start.toFixed(1)} ${s.label}`).join(', '));
  assert.equal(a.sections[0].start, 0);
  assert.ok(Math.abs(a.sections[0].end - a.duration) < 1e-6);
});

test('features stay in range and envelopes peak on kicks', () => {
  const { samples, sr, kicks } = synth({ bpm: 128, bars: 8 });
  const a = analyze(samples, sr);
  const r = createReader(a);
  for (let t = 0; t < a.duration; t += 0.013) {
    const f = r.features(t);
    for (const [k, v] of Object.entries(f)) {
      if (k === 'beatPos' || k === 'barIndex') continue;
      assert.ok(v >= 0 && v <= 1.0001, `${k}=${v} at ${t.toFixed(2)}`);
    }
  }
  const atKick = kicks.slice(2, 10).map((t) => r.features(t + 0.015).kick);
  const between = kicks.slice(2, 10).map((t, i) => r.features(t + 0.3).kick);
  assert.ok(Math.min(...atKick) > 0.5, `kick envelope at kicks: ${atKick.map((x) => x.toFixed(2))}`);
  assert.ok(Math.max(...between) < 0.5, `kick envelope between kicks: ${between.map((x) => x.toFixed(2))}`);
});

test('silence does not produce NaN or beats', () => {
  const a = analyze(new Float32Array(44100 * 3), 44100);
  const r = createReader(a);
  const f = r.features(1.5);
  for (const v of Object.values(f)) assert.ok(Number.isFinite(v));
  assert.equal(a.onsets.kick.times.length, 0);
  assert.equal(a.sections.length, 1);
  assert.ok(r.sectionAtBar(0));
});
