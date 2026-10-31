// The DJ's ears, calibrated on sound with a known answer: drums placed by us, played through the real
// live analysis. Born.mp3 stays out of the repo, so that test only runs where the file is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { analyze, FFT_SIZE } from '../src/audio/analysis.js';
import { createReader } from '../src/audio/features.js';
import { HEAD, LiveAnalysis } from '../src/audio/live.js';
import { Ear } from '../src/dj/ear.js';

const SR = 48000, BPM = 132, BEAT = 60 / BPM, BAR = 4 * BEAT;
const BORN = 'video/born.mp3';

// four to the floor, offbeat hats and a bass that changes note every bar; plays(part, bar) says what's in
function track(bars, plays = () => true) {
  const x = new Float32Array(Math.ceil((bars * BAR + 0.5) * SR));
  const beat = BEAT * SR;
  let seed = 22222;
  const noise = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
  for (let i = 0; i < x.length; i++) {
    const b = i / beat, age = ((b % 1) * beat) / SR, offbeat = ((b + 0.5) % 1) * BEAT;
    const bar = Math.floor(b / 4);
    x[i] = (plays('bass', bar) ? 0.15 * Math.sin((2 * Math.PI * (55 + 11 * (bar % 3)) * i) / SR) : 0)
      + (plays('kick', bar) ? 0.6 * Math.exp(-age / 0.09) * Math.sin(2 * Math.PI * (48 * age + 30 * 0.04 * (1 - Math.exp(-age / 0.04)))) : 0)
      + (plays('hat', bar) ? 0.14 * Math.exp(-offbeat / 0.03) * noise() : 0);
  }
  return x;
}

// plays sound into the analysis the way the page gets it, a frame every 20 ms, with the ear on the end
function listen(x, { sr = SR, bpm = BPM, beatAt = (t) => t / BEAT, drums = () => [0, 0, 0], kinds = 0 } = {}) {
  let now = 100;
  const live = new LiveAnalysis({ clock: () => now });
  const ear = new Ear(), heard = [];
  const step = 0.02;
  for (let k = 0; (k + 1) * step * sr + FFT_SIZE < x.length; k++) {
    const t = k * step, end = Math.floor(t * sr) + FFT_SIZE;
    const frame = new Float32Array(HEAD + FFT_SIZE);
    frame.set([sr, beatAt(t) * 4, bpm, 1, ...drums(t), kinds]);
    frame.set(x.subarray(end - FFT_SIZE, end), HEAD);
    now = 100 + t;
    live.push(frame);
    const f = live.reader.features(live.time);
    const change = ear.hear(f, live.analysis.unscaled);
    if (change) heard.push({ t: f.beatPos * BEAT, bar: f.barIndex, change, state: ear.now(f.barIndex) });
  }
  return { ear, heard };
}
const kicks = (plays) => (t) => { let n = 0; for (let b = 0; b * BEAT <= t; b++) if (plays('kick', Math.floor(b / 4))) n++; return [n, 0, 0]; };

test('a steady groove is not news', () => {
  const { heard } = listen(track(32));
  assert.deepEqual(heard.filter((h) => h.bar >= 4), []);
});

test('the kick leaving and coming back is heard within a bar, and named', () => {
  const plays = (part, bar) => part !== 'kick' || bar < 16 || bar >= 24;
  const { heard } = listen(track(32, plays), { drums: kicks(plays), kinds: 0b001 });
  const out = heard.find((h) => h.bar >= 16), back = heard.find((h) => h.bar >= 24);
  assert.equal(out.change, 'kick dropped out');
  assert.ok(out.t - 16 * BAR <= 3 * BEAT, `${(out.t - 16 * BAR).toFixed(2)} s after the kick left`);
  assert.equal(out.state.section, 'breakdown');
  assert.ok(!out.state.drums.includes('kick'));
  assert.equal(out.state.just_changed, 'kick dropped out');
  assert.equal(back.change, 'kick came in');
  assert.ok(back.t - 24 * BAR <= 3 * BEAT, `${(back.t - 24 * BAR).toFixed(2)} s after it came back`);
  assert.equal(back.state.section, 'drop');
});

test('a change is heard by ear alone, with no drum counts from the source', () => {
  const plays = (part, bar) => part !== 'kick' || bar < 16;
  const { heard } = listen(track(24, plays));
  const out = heard.find((h) => h.bar >= 16);
  assert.ok(out && out.t - 16 * BAR <= 3 * BEAT, out ? `${(out.t - 16 * BAR).toFixed(2)} s` : 'never heard');
  assert.equal(out.change, 'kick dropped out');
});

// a kick that hardly moves the low end, under a loud steady bass, stays unheard: the wall's halves it
test('the low end muted at the desk is heard, though the hits keep coming', () => {
  const plays = (part, bar) => part === 'hat' || bar < 16 || bar >= 24;
  const all = () => true;
  const { heard } = listen(track(32, plays), { drums: kicks(all), kinds: 0b001 });
  const out = heard.find((h) => h.bar >= 16), back = heard.find((h) => h.bar >= 24);
  assert.ok(out.t - 16 * BAR <= 4 * BEAT, `${(out.t - 16 * BAR).toFixed(2)} s after it went`);
  assert.equal(out.change, 'low end dropped out');
  assert.equal(out.state.section, 'breakdown');
  assert.ok(!out.state.drums.includes('kick'));
  assert.equal(back.change, 'low end came in');
  assert.equal(back.state.section, 'drop');
});

test('a two-bar gap is caught at both ends: it can hear again straight after a change', () => {
  const plays = (part, bar) => part !== 'kick' || bar < 16 || bar >= 19;
  const { heard } = listen(track(28, plays), { drums: kicks(plays), kinds: 0b001 });
  assert.deepEqual(heard.filter((h) => h.bar >= 4).map((h) => h.change).slice(0, 2), ['kick dropped out', 'kick came in']);
});

test('nothing it says is about the future', () => {
  const { ear } = listen(track(12));
  const said = ear.now(11);
  for (const key of ['next_section', 'bars_left_in_section', 'energy_in_4_bars']) assert.ok(!(key in said), key);
});

test('energy remembers further back than the window the live bands are scaled over', () => {
  const plays = (part, bar) => part !== 'kick' || bar < 24 || bar >= 56;
  const x = track(56, plays);
  const { ear } = listen(x, { drums: kicks(plays), kinds: 0b001 });
  const steady = listen(track(56), { drums: kicks(() => true), kinds: 0b001 }).ear;
  assert.ok(ear.energy() < 0.4, `a long breakdown still reads low: ${ear.energy().toFixed(2)}`);
  assert.equal(steady.energy(), 0.5);
});

test('when the Clock jumps it forgets the bars before', () => {
  const ear = new Ear();
  const frame = (beatPos) => ({ level: 0.5, bass: 0.5, lowmid: 0.5, mid: 0.5, high: 0.5, treble: 0.5, kick: 1, snare: 0, hat: 0, beatPos });
  for (let b = 0; b < 40; b += 0.1) ear.hear(frame(b), () => 0.5);
  assert.ok(ear.prints.length > 16);
  ear.hear(frame(0), () => 0.5);
  assert.equal(ear.prints.length, 0);
  assert.equal(ear.changedBar, 0);
});

test('on a real record it catches every drop and breakdown the offline analysis found', { skip: !existsSync(BORN) }, () => {
  const sr = 44100;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', BORN, '-f', 'f32le', '-ac', '1', '-ar', String(sr), '-'], { maxBuffer: 1 << 30 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4)).slice();
  const reader = createReader(analyze(x, sr)), a = reader.analysis;
  const strong = a.sections.filter((s) => s.label === 'drop' || s.label === 'breakdown');
  assert.ok(strong.length >= 7);
  const { heard } = listen(x, { sr, bpm: a.bpm, beatAt: (t) => reader.beatPosition(t) - a.downbeat });
  for (const s of strong) assert.ok(heard.some((h) => Math.abs(h.bar - s.bar) <= 1), `bar ${s.bar} ${s.label} was never heard`);
  const minutes = x.length / sr / 60;
  assert.ok(heard.length / minutes <= 5, `${(heard.length / minutes).toFixed(1)} changes a minute is restless`);
});
