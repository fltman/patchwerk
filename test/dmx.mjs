// npm run dmx — the lights on the real GPU, muted, with a stand-in for the USB interface: a known
// picture goes in and the exact bytes on the wire come out. There is no hardware in this test.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
process.once('exit', () => server.kill());
await new Promise((r) => server.stdout.once('data', r));
mkdirSync('test/out', { recursive: true });

let failed = 0;
const check = (ok, what, more = '') => { console.log(`${ok ? '✓' : '✗'} ${what}${more ? ` — ${more}` : ''}`); if (!ok) failed++; };
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

// left half has no red, the top half has green: four known colours
const QUARTERS = 'vec4 render(vec2 uv) { return vec4(uv.x > 0.5 ? 1.0 : 0.0, uv.y > 0.5 ? 1.0 : 0.0, 0.0, 1.0); }';
const patch = (cells) => ({
  version: 1,
  nodes: [
    { id: 'n1', type: 'glsl', x: 0, y: 0, code: QUARTERS },
    { id: 'n2', type: 'dmx-pixels', x: 300, y: 0, params: { address: 11, columns: cells[0], rows: cells[1], layout: 0, level: 1 } },
    { id: 'n3', type: 'output', x: 600, y: 0 },
    { id: 'n4', type: 'dmx-out', x: 300, y: 300, params: { address: 1, ch1: 0.5 } },
  ],
  links: [
    { id: 'l1', from: 'n1', fromPort: 'out', to: 'n2', toPort: 'src' },
    { id: 'l2', from: 'n2', fromPort: 'out', to: 'n3', toPort: 'src' },
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  await page.addInitScript(() => {
    const frames = (window.wire = []);
    const port = {
      async open() {}, async close() {}, async setSignals() {},
      writable: { getWriter: () => ({ write: async (b) => { frames.push({ at: performance.now(), bytes: b.slice() }); }, releaseLock() {} }) },
      readable: { getReader: () => ({
        sent: false,
        read() { if (this.sent) return new Promise(() => {}); this.sent = true; return Promise.resolve({ value: Uint8Array.from([0x7e, 3, 5, 0, 1, 2, 3, 4, 5, 0xe7]), done: false }); },
        cancel: async () => {}, releaseLock() {},
      }) },
    };
    Object.defineProperty(navigator, 'serial', { value: Object.assign(new EventTarget(), { getPorts: async () => [port], requestPort: async () => port }) });
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.patchwerk?.transport.reader, null, { timeout: 60000 });
  await page.evaluate((json) => { window.patchwerk.graph.load(json); window.patchwerk.graph.commit(); }, patch([2, 2]));
  await page.waitForFunction(() => window.patchwerk.renderer.dmx.some((b) => b > 0), null, { timeout: 5000 });
  await page.waitForTimeout(300);

  const universe = await page.evaluate(() => [...window.patchwerk.renderer.dmx.subarray(0, 24)]);
  // left to right, top row first: green, yellow, black, red
  const lamps = universe.slice(10, 22).join(' ');
  check(lamps === '0 255 0 255 255 0 0 0 0 255 0 0', 'a known picture lands on the right channels', lamps);
  check(universe[0] === 128, 'DMX Out sits beside it on its own address', `channel 1 = ${universe[0]}`);

  await page.click('#dmx-btn');
  await page.click('#dmx-connect');
  await page.waitForFunction(() => window.wire.length > 40, null, { timeout: 5000 });
  const sent = await page.evaluate(() => {
    const w = window.wire.slice(1), gaps = w.slice(1).map((f, i) => f.at - w[i].at).sort((a, b) => a - b);
    const last = window.wire.at(-1).bytes;
    return { kind: window.patchwerk.dmx.serial.kind, status: document.getElementById('dmx-status').textContent, hz: 1000 / gaps[gaps.length >> 1], head: [...last.subarray(0, 5)], size: last.length, lamps: [...last.subarray(15, 27)].join(' '), end: last.at(-1) };
  });
  check(sent.kind === 'Pro', 'the interface is recognised', sent.status);
  check(sent.size === 518 && sent.head.join() === '126,6,1,2,0' && sent.end === 0xe7, 'the frames are well formed');
  check(sent.lamps === '0 255 0 255 255 0 0 0 0 255 0 0', 'the same colours reach the wire', sent.lamps);
  check(sent.hz > 25 && sent.hz <= 44, 'never faster than DMX can carry', `${sent.hz.toFixed(1)} frames a second`);

  await page.waitForTimeout(300);
  const stage = await page.evaluate(() => {
    const c = document.getElementById('dmx-stage'), x = c.getContext('2d');
    return { w: c.width, h: c.height, visible: !c.classList.contains('hidden'), green: [...x.getImageData(11, 11, 1, 1).data], red: [...x.getImageData(33, 33, 1, 1).data] };
  });
  check(stage.visible && stage.green[1] === 255 && stage.green[0] === 0 && stage.red[0] === 255 && stage.red[1] === 0, 'the stage shows the lamps with their colours');
  await page.screenshot({ path: 'test/out/dmx.png' });

  await page.evaluate(() => window.patchwerk.graph.setParam('n2', 'columns', 1));
  await page.evaluate(() => window.patchwerk.graph.setParam('n2', 'rows', 1));
  await page.waitForTimeout(300);
  const mean = await page.evaluate(() => [...window.patchwerk.renderer.dmx.subarray(10, 13)]);
  check(mean.every((v, i) => Math.abs(v - [128, 128, 0][i]) <= 2), 'one lamp gets the mean of the whole picture, not one spot', mean.join(' '));

  const big = await page.evaluate(async () => {
    const { graph } = window.patchwerk;
    graph.setParam('n2', 'columns', 32);
    graph.setParam('n2', 'rows', 16);
    await new Promise((r) => setTimeout(r, 500));
    let n = 0, worst = 0, last = performance.now();
    await new Promise((ok) => { const step = (t) => { worst = Math.max(worst, t - last); last = t; if (++n < 180) requestAnimationFrame(step); else ok(); }; requestAnimationFrame(step); });
    return { worst };
  });
  check(big.worst < 40, 'the biggest grid costs no frames', `worst frame ${big.worst.toFixed(1)} ms over 180 frames`);

  await page.evaluate(() => { window.patchwerk.graph.removeNode('n4'); window.patchwerk.graph.commit(); });
  await page.waitForTimeout(150);
  check(await page.evaluate(() => window.patchwerk.renderer.dmx[0]) === 0, 'removing a module turns its channels off');

  await page.click('#dmx-connect');
  await page.waitForTimeout(200);
  const off = await page.evaluate(() => { const l = window.wire.at(-1).bytes; return { dark: l.subarray(5, 517).every((b) => b === 0), label: document.getElementById('dmx-connect').textContent }; });
  check(off.dark && off.label.startsWith('Connect'), 'disconnecting sends a blackout');
  check(!problems.length, 'no errors on the page', problems.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
