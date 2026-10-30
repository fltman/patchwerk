// The live input: a reader with the same answers as a file's, the relay that feeds it, and who may
// connect. Calibrated against the offline analysis on the same sound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { analyze, FFT_SIZE, SPEC_BINS } from '../src/audio/analysis.js';
import { createReader, FEATURE_NAMES } from '../src/audio/features.js';
import { HEAD, LiveAnalysis } from '../src/audio/live.js';
import { attachLive } from '../server/live.mjs';
import { attachOutputs } from '../server/outputs.mjs';
import { WebSocket } from 'ws';

const SR = 48000, BPM = 132;

// four to the floor, offbeat noise hats, and a bass note that changes every bar
function track(seconds, { hats = true, kick = true } = {}) {
  const x = new Float32Array(seconds * SR);
  const beat = (60 / BPM) * SR;
  let seed = 22222;
  const noise = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
  for (let i = 0; i < x.length; i++) {
    const b = i / beat, phase = b % 1, age = (phase * beat) / SR;
    const offbeat = ((b + 0.5) % 1) * (beat / SR);
    const bar = Math.floor(b / 4);
    x[i] = 0.15 * Math.sin((2 * Math.PI * (55 + 11 * (bar % 3)) * i) / SR)
      + (kick ? 0.6 * Math.exp(-age / 0.09) * Math.sin(2 * Math.PI * (48 * age + 30 * 0.04 * (1 - Math.exp(-age / 0.04)))) : 0)
      + (hats ? 0.14 * Math.exp(-offbeat / 0.03) * noise() : 0);
  }
  return x;
}

const header = (o) => Float32Array.from([SR, o.position, BPM, 1, o.kicks ?? 0, o.snares ?? 0, o.hats ?? 0, o.kinds ?? 0b111]);

// plays a track into the analysis the way the page gets it: a frame every 20 ms
function feed(x, { kinds = 0b111, each, drums = true } = {}) {
  let now = 100;
  const live = new LiveAnalysis({ clock: () => now });
  const step = 0.02, beat = 60 / BPM;
  for (let k = 0; (k + 1) * step * SR + FFT_SIZE < x.length; k++) {
    const t = k * step, end = Math.floor(t * SR) + FFT_SIZE;
    const frame = new Float32Array(HEAD + FFT_SIZE);
    frame.set(header({ position: (t / beat) * 4, kicks: drums ? Math.floor(t / beat) + 1 : 0, kinds }));
    frame.set(x.subarray(end - FFT_SIZE, end), HEAD);
    now = 100 + t;
    live.push(frame);
    each?.(live, t, (FFT_SIZE / 2) / SR);
  }
  return live;
}

test('a live reader answers everything a file reader does', () => {
  const file = createReader(analyze(track(4), SR));
  const live = feed(track(4)).reader;
  const shape = (o) => Object.keys(o).filter((k) => k !== 'sampleEnd').sort();
  assert.deepEqual(shape(live).filter((k) => k !== 'sampleEnd'), shape(file));
  const f = live.features(1);
  for (const name of [...FEATURE_NAMES, 'beatPos', 'barIndex']) assert.ok(Number.isFinite(f[name]), name);
  assert.deepEqual(Object.keys(f).sort(), Object.keys(file.features(1)).sort());
});

test('bands, level and spectrum read like the offline analysis of the same sound', () => {
  const x = track(24);
  const a = analyze(x, SR);
  const r = createReader(a);
  const pairs = { level: [[], []], bass: [[], []], treble: [[], []] };
  let specDiff = 0, specN = 0;
  feed(x, { each: (live, t, delay) => {
    if (t < 12 || (Math.round(t * 50) % 5)) return;
    const when = t + delay;   // the middle of the window this frame analysed
    const off = r.features(when), now = live.now;
    for (const k of Object.keys(pairs)) { pairs[k][0].push(off[k]); pairs[k][1].push(now[k]); }
    const fa = r.frameAt(when), fl = live.reader.frameAt();
    const sa = a.spectrum.subarray(fa * SPEC_BINS, (fa + 1) * SPEC_BINS), sl = live.analysis.spectrum.subarray(fl * SPEC_BINS, (fl + 1) * SPEC_BINS);
    for (let b = 0; b < SPEC_BINS; b++) specDiff += Math.abs(sa[b] - sl[b]);
    specN += SPEC_BINS;
  } });
  const corr = (u, v) => {
    const mu = u.reduce((s, y) => s + y, 0) / u.length, mv = v.reduce((s, y) => s + y, 0) / v.length;
    let c = 0, a2 = 0, b2 = 0;
    for (let i = 0; i < u.length; i++) { c += (u[i] - mu) * (v[i] - mv); a2 += (u[i] - mu) ** 2; b2 += (v[i] - mv) ** 2; }
    return c / Math.sqrt(a2 * b2);
  };
  for (const [k, [u, v]] of Object.entries(pairs)) {
    const c = corr(u, v), err = u.reduce((s, y, i) => s + Math.abs(y - v[i]), 0) / u.length;
    assert.ok(c > 0.9, `${k}: correlation ${c.toFixed(3)}`);
    assert.ok(err < 0.12, `${k}: mean error ${err.toFixed(3)}`);
  }
  assert.ok(specDiff / specN < 16, `spectrum off by ${(specDiff / specN).toFixed(1)} of 255`);
});

test('the beat follows the Clock: right tempo, steady, and never backwards', () => {
  let last = -Infinity;
  const live = feed(track(6), { each: (l) => {
    const p = l.beatAt(l.time);
    assert.ok(p >= last - 1e-6, `went back from ${last} to ${p}`);
    last = p;
  } });
  const t = live.time;
  assert.ok(Math.abs(live.beatAt(t) - (t * BPM) / 60) < 0.02, `beat ${live.beatAt(t)} at ${t}`);
  const r = live.reader;
  const f = r.features(t);
  assert.equal(f.barIndex, Math.floor(Math.floor(f.beatPos) / 4));
  assert.ok(Math.abs(r.beatPosition(r.barTime(f.barIndex + 1)) - (f.barIndex + 1) * 4) < 1e-6);
  assert.ok(Math.abs(r.period - 60 / BPM) < 1e-9);
});

test('it jumps when the Clock starts over, and time stands still while stopped', () => {
  let now = 10;
  const live = new LiveAnalysis({ clock: () => now });
  const frame = (position, running = 1) => {
    const f = new Float32Array(HEAD + FFT_SIZE);
    f.set(header({ position }));
    f[3] = running;
    return f;
  };
  live.push(frame(0));
  now = 11;
  live.push(frame(8));
  const t = live.time;
  assert.ok(t > 0.99);
  assert.ok(live.push(frame(8, 0)), 'a stop is a change the page must hear about');
  now = 20;
  live.push(frame(8, 0));
  assert.equal(live.time, t);
  live.push(frame(0, 1));
  assert.ok(Math.abs(live.beatAt(live.time)) < 1e-6);
});

test('a hit lights its envelope the moment the count goes up, and it decays', () => {
  let now = 0;
  const live = new LiveAnalysis({ clock: () => now });
  const frame = (kicks) => { const f = new Float32Array(HEAD + FFT_SIZE); f.set(header({ position: now * 8.8, kicks })); return f; };
  live.push(frame(5));
  assert.equal(live.reader.features(0).kick, 0);     // what was counted before we came is not a hit
  now = 1;
  live.push(frame(6));
  assert.equal(live.reader.features(live.time).kick, 1);
  const later = live.reader.features(live.time + 0.2, 0.2).kick;
  assert.ok(Math.abs(later - Math.exp(-1)) < 1e-6, `${later}`);
  now = 1.1;
  live.push(frame(4));                                // a drum was removed: not a hit
  assert.ok(live.reader.features(live.time).kick < 1);
});

test('with no drum modules it listens for hits instead, about as often as they happen', () => {
  const x = track(16, { hats: true });
  let kicks = 0, hats = 0, lastK = null, lastH = null;
  feed(x, { kinds: 0, drums: false, each: (l, t) => {
    if (t < 8) return;
    if (l.hits.kick !== lastK && l.hits.kick) { kicks++; lastK = l.hits.kick; }
    if (l.hits.hat !== lastH && l.hits.hat) { hats++; lastH = l.hits.hat; }
  } });
  const expected = (8 * BPM) / 60;
  assert.ok(Math.abs(kicks - expected) <= expected * 0.15, `${kicks} kicks, ${expected.toFixed(0)} played`);
  assert.ok(Math.abs(hats - expected) <= expected * 0.25, `${hats} hats, ${expected.toFixed(0)} played`);
});

test('sections come from the DJ\'s arc when there is one, and go round', () => {
  const live = new LiveAnalysis({ clock: () => 0 });
  const r = live.reader;
  assert.equal(r.sectionAtBar(17).bar, 16);
  assert.equal(r.sectionAtBar(17).bars, 16);
  live.setArc([{ name: 'groove', bars: 8 }, { name: 'peak', bars: 4 }], 100);
  const s = r.sectionAtBar(109);
  assert.deepEqual([s.label, s.bar, s.into, s.left, s.next.label], ['peak', 108, 1, 3, 'groove']);
  assert.equal(r.sectionAtBar(112).label, 'groove');
  assert.equal(live.analysis.sections.length, 2);
  live.setArc(null);
  assert.equal(r.sectionAtBar(109).label, 'live');
});

test('the spectrogram can read back through the ring wherever it wraps', () => {
  const x = track(24);
  const live = feed(x);
  const f = live.reader.frameAt(), B = SPEC_BINS, s = live.analysis.spectrum;
  assert.ok(live.frames > 1024);
  assert.equal(f, 1024 + live.index);
  // a frame in the top half is the same frame in the bottom half
  const at = live.index;
  assert.deepEqual([...s.subarray(at * B, (at + 1) * B)], [...s.subarray((1024 + at) * B, (1025 + at) * B)]);
  assert.ok(f - 127 * 2 >= 0);
});

// ── the relay ───────────────────────────────────────────
async function relay() {
  const server = createServer();
  attachOutputs(server, []);
  attachLive(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
const open = (url, origin) => new Promise((resolve) => {
  const ws = new WebSocket(url, origin ? { origin } : {});
  const inbox = [];
  ws.on('message', (d, binary) => inbox.push(binary ? new Float32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.length)) : JSON.parse(d)));
  ws.on('open', () => resolve({ ws, inbox, ok: true }));
  ws.on('error', () => resolve({ ok: false }));
  ws.on('close', () => resolve({ ok: false }));
});
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn(), 'timed out'); };

test('frames from Soundwerk reach the page, and the page hears it come and go', async () => {
  const { port, close } = await relay();
  const page = await open(`ws://127.0.0.1:${port}/api/live`, `http://127.0.0.1:${port}`);
  await until(() => page.inbox.length === 1);
  assert.deepEqual(page.inbox[0], { source: false });
  const source = await open(`ws://127.0.0.1:${port}/api/live?role=source`, 'http://localhost:8280');
  assert.ok(source.ok);
  await until(() => page.inbox.length === 2);
  assert.deepEqual(page.inbox[1], { source: true });
  source.ws.send(Float32Array.from([1, 2, 3]));
  source.ws.send(JSON.stringify({ arc: [{ name: 'a', bars: 8 }], origin: 3 }));
  await until(() => page.inbox.length === 4);
  assert.deepEqual([...page.inbox[2]], [1, 2, 3]);
  assert.equal(page.inbox[3].origin, 3);
  source.ws.close();
  await until(() => page.inbox.length === 5);
  assert.deepEqual(page.inbox[4], { source: false });
  page.ws.close();
  await close();
});

test('only a Soundwerk page may send, and only our own pages may listen', async () => {
  const { port, close } = await relay();
  const url = `ws://127.0.0.1:${port}/api/live`;
  assert.equal((await open(`${url}?role=source`, 'https://evil.example')).ok, false);
  assert.equal((await open(`${url}?role=source`)).ok, false, 'no Origin is not a browser page');
  assert.equal((await open(url, 'https://evil.example')).ok, false);
  await close();
});

test('the newest source wins', async () => {
  const { port, close } = await relay();
  const page = await open(`ws://127.0.0.1:${port}/api/live`, `http://127.0.0.1:${port}`);
  const first = await open(`ws://127.0.0.1:${port}/api/live?role=source`, 'http://localhost:8280');
  const second = await open(`ws://127.0.0.1:${port}/api/live?role=source`, 'http://127.0.0.1:8280');
  await until(() => first.ws.readyState === WebSocket.CLOSED);
  second.ws.send(Float32Array.from([7]));
  await until(() => page.inbox.some((m) => m instanceof Float32Array));
  assert.equal(page.inbox.find((m) => m.source === false && page.inbox.indexOf(m) > 1), undefined);
  page.ws.close();
  second.ws.close();
  await close();
});

test('the outputs socket still answers next to it', async () => {
  const { port, close } = await relay();
  const out = await open(`ws://127.0.0.1:${port}/api/out`, `http://127.0.0.1:${port}`);
  assert.ok(out.ok);
  out.ws.close();
  await close();
});
