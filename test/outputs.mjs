// npm run outputs — Syphon and NDI end to end on the real GPU (macOS + Google Chrome).
// Patchwerk draws a picture with four coloured quadrants, and it is read back the
// way other apps read it: Syphon through Syphon's own OpenGL client
// (test/syphon-probe.m, not the library we send with), NDI through an NDI
// receiver. Checks size, orientation and colour at two resolutions, the frame
// rate the receivers get, and that the outputs switch off.
//
// Chrome is driven over a bare DevTools connection, not Playwright: Playwright
// listens to network events, which copies every WebSocket frame (megabytes, 60
// times a second) into the test process and chokes the connection.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import grandi from 'grandi';

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };

// top-left red, top-right green, bottom-left blue, bottom-right white (uv starts bottom-left)
const QUADS = `vec4 render(vec2 uv) {
  vec3 c = uv.y > 0.5 ? (uv.x < 0.5 ? vec3(1, 0, 0) : vec3(0, 1, 0)) : (uv.x < 0.5 ? vec3(0, 0, 1) : vec3(1));
  return vec4(c, 1.0);
}`;
const EXPECT = { tl: [255, 0, 0], tr: [0, 255, 0], bl: [0, 0, 255], br: [255, 255, 255] };
const quadsOk = (q, tol = 24) => Object.entries(EXPECT).every(([k, rgb]) => q[k]?.every((v, i) => Math.abs(v - rgb[i]) <= tol));
const show = (q) => (q.error ? q.error : `${q.w}×${q.h} tl ${q.tl} tr ${q.tr} bl ${q.bl} br ${q.br}`);

// the checker must catch what can go wrong: upside down, mirrored, red and blue swapped
check('checker accepts the right picture', quadsOk(EXPECT));
check('checker rejects it upside down', !quadsOk({ tl: EXPECT.bl, tr: EXPECT.br, bl: EXPECT.tl, br: EXPECT.tr }));
check('checker rejects it mirrored', !quadsOk({ tl: EXPECT.tr, tr: EXPECT.tl, bl: EXPECT.br, br: EXPECT.bl }));
check('checker rejects red and blue swapped', !quadsOk({ ...EXPECT, tl: [0, 0, 255], bl: [255, 0, 0] }));

// ── Syphon, read like an OpenGL VJ app does ──
const fw = dirname(require.resolve(`@napolab/texture-bridge-darwin-${process.arch}/package.json`));
mkdirSync('test/out', { recursive: true });
execFileSync('clang', ['-fobjc-arc', '-Wno-deprecated-declarations', `-F${fw}`, '-framework', 'Foundation', '-framework', 'OpenGL',
  '-framework', 'Syphon', `-Wl,-rpath,${fw}`, 'test/syphon-probe.m', '-o', 'test/out/syphon-probe']);
const probe = (...args) => {
  let out;
  try { out = execFileSync('test/out/syphon-probe', ['Patchwerk', ...args]).toString(); } catch (e) { out = e.stdout.toString(); }
  return JSON.parse(out.trim().split('\n').pop());
};
const syphonAt = async (w, h) => {
  let q;
  for (let i = 0; i < 10; i++) { q = probe(); if (q.w === w && q.h === h) break; await sleep(300); }
  return q;
};

// ── NDI, read by a receiver on this machine ──
async function ndiReceiver() {
  const finder = await grandi.find({ showLocalSources: true });
  let source;
  for (let i = 0; i < 50 && !source; i++) { await sleep(200); source = finder.sources().find((s) => s.name.endsWith('(Patchwerk)')); }
  finder.destroy?.();
  if (!source) return null;
  return grandi.receive({ source, colorFormat: grandi.ColorFormat.RGBX_RGBA, allowVideoFields: false });
}
async function ndiAt(rx, w, h) {
  for (let i = 0; i < 60; i++) {
    let f;
    try { f = await rx.video(1000); } catch { continue; }
    if (f.xres !== w || f.yres !== h) continue;
    const at = (x, y) => [...f.data.subarray(y * f.lineStrideBytes + x * 4, y * f.lineStrideBytes + x * 4 + 3)];
    const l = w >> 2, r = w - 1 - (w >> 2), t = h >> 2, b = h - 1 - (h >> 2);
    return { w, h, tl: at(l, t), tr: at(r, t), bl: at(l, b), br: at(r, b) };
  }
  return { error: `no ${w}×${h} frame` };
}
async function ndiFps(rx, seconds) {
  const seen = new Set();
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try { seen.add(String((await rx.video(500)).timecode)); } catch { /* no frame within 500 ms */ }
  }
  return seen.size / seconds;
}

// ── Chrome over a bare DevTools connection ──
async function launchChrome(url) {
  const profile = mkdtempSync(join(tmpdir(), 'patchwerk-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', '--mute-audio', '--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', '--window-size=1680,1000', '--remote-debugging-port=0', `--user-data-dir=${profile}`, url],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((ok, fail) => {
    let err = '';
    proc.stderr.on('data', (d) => { err += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err); if (m) ok(m[1]); });
    proc.on('exit', () => fail(new Error(`Chrome exited: ${err.slice(-300)}`)));
  });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(url));
    if (!target) await sleep(100);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 << 20 });
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } else events.push(m);
  });
  const send = (method, params = {}) => new Promise((ok) => { pending.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); // page errors
  await send('Log.enable');     // WebGL performance warnings
  const evaluate = async (fn, arg) => {
    const r = await send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  const waitFor = async (fn, arg, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await evaluate(fn, arg).catch(() => false)) return true;
    throw new Error(`timed out waiting for ${fn}`);
  };
  // also on a crash: a headless Chrome left behind would keep running unseen
  const close = async () => {
    ws.close();
    if (proc.exitCode === null) await new Promise((r) => { proc.once('exit', r); proc.kill(); });
    rmSync(profile, { recursive: true, force: true });
  };
  process.once('exit', () => { if (proc.exitCode === null) proc.kill(); });
  return { evaluate, waitFor, events, close };
}

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
const ready = await new Promise((r) => server.stdout.once('data', (d) => r(String(d))));
let stopping = false;
server.on('exit', (code, signal) => { if (!stopping) check('server stays up', false, `it exited (${code ?? signal})`); });
check('server offers Syphon and NDI', /outputs: Syphon, NDI/.test(ready), ready.trim());

let chrome, rx;
try {
  // only pages from this server may drive the outputs
  const opens = (origin) => new Promise((ok) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/api/out`, { origin });
    ws.on('open', () => { ws.close(); ok(true); });
    ws.on('error', () => ok(false));
  });
  check('another website cannot open /api/out', !(await opens('http://evil.example')));
  check('the page’s own origin can', await opens(`http://localhost:${PORT}`));

  chrome = await launchChrome(`http://localhost:${PORT}/`);
  const { evaluate, waitFor, events } = chrome;
  await waitFor(() => document.querySelector('#outputs input[data-out=ndi]'));
  check('the settings show Syphon and NDI switches', (await evaluate(() => [...document.querySelectorAll('#outputs label')].map((l) => l.textContent.trim()).join(','))) === 'Syphon,NDI');

  const log = await evaluate(async (code) => {
    const { applyOps } = await import('/src/ai/ops.js');
    const g = window.patchwerk.graph;
    const out = g.outputNode().id;
    const r = applyOps(g, [{ op: 'clear' }, { op: 'add', type: 'glsl', ref: 'q' }, { op: 'code', id: 'q', code }, { op: 'connect', from: 'q', to: out, to_port: 'src' }]);
    g.commit();
    return r.log;
  }, QUADS);
  check('test picture patched', !log.some((l) => l.startsWith('✗')), log.join(' | '));
  await sleep(500);
  const screen = await evaluate(async () => {
    const img = new Image();
    img.src = await window.patchwerk.renderer.snapshot(320);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const at = (px, py) => [...x.getImageData(px, py, 1, 1).data.slice(0, 3)];
    const l = c.width >> 2, r = c.width - 1 - l, t = c.height >> 2, b = c.height - 1 - t;
    return { w: c.width, h: c.height, tl: at(l, t), tr: at(r, t), bl: at(l, b), br: at(r, b) };
  });
  check('on screen the test picture is the right way up (the reference)', quadsOk(screen), show(screen));

  check('no Syphon server before it is switched on', probe('--absent').present === false);
  await evaluate(() => { for (const k of ['syphon', 'ndi']) document.querySelector(`#outputs input[data-out=${k}]`).click(); });
  await waitFor(() => document.querySelectorAll('#outputs label.live').length === 2, null, 15000);
  check('both switches turn live', true);
  rx = await ndiReceiver();
  check('an NDI receiver finds “Patchwerk” on the network', !!rx);

  for (const [w, h] of [[1280, 720], [1080, 1920], [1920, 1080]]) {
    await evaluate((v) => { const s = document.getElementById('resolution'); s.value = v; s.dispatchEvent(new Event('change')); }, `${w}x${h}`);
    const s = await syphonAt(w, h);
    check(`Syphon ${w}×${h}: right size, way up and colours`, s.w === w && s.h === h && quadsOk(s), show(s));
    const n = await ndiAt(rx, w, h);
    check(`NDI ${w}×${h}: right size, way up and colours`, n.w === w && n.h === h && quadsOk(n), show(n));
    if (h === 1920) continue;
    // what the receiving apps get, while Patchwerk keeps drawing
    const syphonFps = probe('--fps', '3').fps;
    const ndiFpsNow = await ndiFps(rx, 3);
    const loop = await evaluate(() => document.getElementById('fps').textContent);
    check(`${w}×${h} reaches the receivers at ≥ 50 fps`, syphonFps >= 50 && ndiFpsNow >= 50, `Syphon ${syphonFps} fps, NDI ${ndiFpsNow.toFixed(1)} fps; Patchwerk draws ${loop}`);
  }

  // a burst of switching while a receiver is connected must still end where the switches end
  await evaluate(() => { for (let i = 0; i < 10; i++) for (const k of ['syphon', 'ndi']) document.querySelector(`#outputs input[data-out=${k}]`).click(); });
  await sleep(2000);
  const after = await evaluate(() => document.querySelectorAll('#outputs label.live').length);
  const s2 = probe();
  check('after 20 quick switches both outputs run again', after === 2 && quadsOk(s2), `${after} live, Syphon ${show(s2)}`);

  rx.destroy();
  rx = null;
  await evaluate(() => { for (const k of ['syphon', 'ndi']) document.querySelector(`#outputs input[data-out=${k}]`).click(); });
  await waitFor(() => document.querySelectorAll('#outputs label.live').length === 0, null, 10000);
  check('switched off, the Syphon server goes away', probe('--absent').present === false);

  const warnings = events.filter((e) => e.method === 'Log.entryAdded' && /performance warning/.test(e.params.entry.text)).map((e) => e.params.entry.text);
  check('no WebGL readback warnings', warnings.length === 0, warnings[0]);
  const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text);
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run finished', false, e.message);
} finally {
  rx?.destroy();
  await chrome?.close();
  stopping = true;
  server.kill();
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
