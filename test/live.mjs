// npm run live — both apps at once, in real Chrome, muted: Soundwerk plays, Patchwerk follows. Needs
// Soundwerk next to this folder, or SOUNDWERK_DIR. Runs on its own ports, next to any servers you have.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const SOUNDWERK = resolve(process.env.SOUNDWERK_DIR ?? '../soundwerk');
const SECONDS = Number(process.argv[2]) || 20;
const PW = 20000 + Math.floor(Math.random() * 20000), SW = PW + 1;
const start = (cwd, port, env = {}) => new Promise((ok, no) => {
  const p = spawn(process.execPath, ['server.mjs'], { cwd, env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.once('data', () => ok(p));
  p.stderr.once('data', (d) => no(new Error(String(d))));
});
const servers = [await start('.', PW, { PATCHWERK_LIVE_ORIGINS: `http://localhost:${SW}` }), await start(SOUNDWERK, SW)];
mkdirSync('test/out', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const problems = [];
const open = async (url) => {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !m.location().url.endsWith('/favicon.ico')) problems.push(`${new URL(url).port}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${new URL(url).port}: ${e.message}`));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  return page;
};
let failed = false;
const check = (name, ok, more = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${more ? ` — ${more}` : ''}`);
  if (!ok) failed = true;
};

try {
  const pw = await open(`http://localhost:${PW}/`);
  await pw.waitForFunction(() => window.patchwerk?.transport.reader, null, { timeout: 30000 });
  await pw.waitForFunction(() => document.getElementById('track-name').textContent.includes('demo'), null, { timeout: 30000 });
  check('the button is there before Soundwerk sends', await pw.locator('#live-btn').isVisible());
  await pw.click('#live-btn');
  check('pressing it waits, and says what to do', await pw.locator('#live-btn.wait').isVisible(), await pw.locator('#toast').textContent());
  check('the track stays until something arrives', (await pw.locator('#track-name').textContent()).includes('demo'));

  const sw = await open(`http://localhost:${SW}/`);
  await sw.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);
  await sw.evaluate(async (port) => {
    const { host, link } = window.soundwerk;
    await host.start();
    host.setRunning(true);
    link.url = `ws://localhost:${port}/api/live?role=source`;
    link.toggle(true);
  }, PW);
  await sw.waitForFunction(() => window.soundwerk.link.connected, null, { timeout: 5000 });
  await sw.waitForTimeout(300);
  check('Soundwerk connects', true);
  await pw.waitForFunction(() => window.patchwerk.transport.live, null, { timeout: 5000 });
  check('Patchwerk follows it by itself', true, await pw.locator('#track-name').textContent());
  check('the button shows it', await pw.locator('#live-btn.on').isVisible());
  await pw.evaluate(() => {
    const { transport } = window.patchwerk;
    const seen = window.seen = { kicks: 0, hits: new Set(), bars: new Set(), peak: 0, frames: 0, jumps: 0, last: null, lag: [] };
    const look = () => {
      const r = transport.reader, f = r.features(transport.time);
      const hit = window.patchwerk.live.analysis.hits.kick;
      if (hit) seen.hits.add(hit.t);
      seen.bars.add(f.barIndex);
      seen.peak = Math.max(seen.peak, f.level);
      if (seen.last !== null && f.beatPos - seen.last > 0.25) seen.jumps++;
      seen.last = f.beatPos;
      seen.frames++;
      requestAnimationFrame(look);
    };
    look();
  });
  const a = await sw.evaluate(() => {
    const { graph, host } = window.soundwerk;
    const clock = [...graph.nodes.values()].find((n) => n.type === 'clock');
    const kick = [...graph.nodes.values()].find((n) => n.type === 'kick');
    return { position: host.ui(clock.id)[3], kicks: host.ui(kick.id)[63], bpm: clock.params.bpm, drops: host.ctx.playbackStats?.underrunEvents ?? null };
  });
  await pw.waitForTimeout(SECONDS * 1000);
  const b = await sw.evaluate(() => {
    const { graph, host } = window.soundwerk;
    const clock = [...graph.nodes.values()].find((n) => n.type === 'clock');
    const kick = [...graph.nodes.values()].find((n) => n.type === 'kick');
    return { position: host.ui(clock.id)[3], kicks: host.ui(kick.id)[63], drops: host.ctx.playbackStats?.underrunEvents ?? null };
  });
  const r = await pw.evaluate(() => {
    const { transport } = window.patchwerk, s = window.seen, f = transport.reader.features(transport.time);
    const a = transport.reader.analysis;
    const spec = a.spectrum.subarray(transport.reader.frameAt() * a.specBins, (transport.reader.frameAt() + 1) * a.specBins);
    return {
      hits: s.hits.size, bars: s.bars.size, peak: s.peak, jumps: s.jumps, frames: s.frames, bpm: a.bpm, beatPos: f.beatPos,
      lit: spec.reduce((n, v) => n + (v > 0 ? 1 : 0), 0), wave: transport.mono.some((v) => v !== 0), fps: document.getElementById('fps').textContent,
    };
  });
  await sw.evaluate(() => 0);
  const played = b.kicks - a.kicks;
  check('tempo comes across', r.bpm === a.bpm, `${r.bpm}`);
  check('every kick arrives', Math.abs(r.hits - played) <= 2, `${r.hits} seen, ${played} played`);
  check('the bars are counted', Math.abs(r.bars - (b.position - a.position) / 16) <= 2, `${r.bars} bars`);
  check('the sound arrives', r.peak > 0.5 && r.lit > 40 && r.wave, `level ${r.peak.toFixed(2)}, ${r.lit} of 128 spectrum bins lit`);
  check('the beat runs smoothly', r.jumps === 0, `${r.jumps} jumps in ${r.frames} frames`);
  check('Soundwerk didn\'t drop out while linked', b.drops === a.drops, `${a.drops} at the start, ${b.drops} after ${SECONDS} s`);
  console.log(`     Patchwerk: ${r.fps}`);

  // how far behind the sound the picture is told about a hit, on one clock
  const clockGap = await Promise.all([
    sw.evaluate(() => new Promise((done) => {
      const { graph, host } = window.soundwerk;
      const kick = [...graph.nodes.values()].find((n) => n.type === 'kick');
      const at = [];
      let n = host.ui(kick.id)[63];
      const look = () => {
        const v = host.ui(kick.id)[63];
        if (v > n) { at.push(performance.timeOrigin + performance.now()); n = v; }
        if (at.length >= 8) done(at); else setTimeout(look, 1);
      };
      look();
    })),
    pw.evaluate(() => new Promise((done) => {
      const a = window.patchwerk.live.analysis, at = [];
      let last = a.hits.kick;
      const look = () => {
        if (a.hits.kick !== last) { last = a.hits.kick; at.push(performance.timeOrigin + performance.now()); }
        if (at.length >= 9) done(at); else setTimeout(look, 1);
      };
      look();
    })),
  ]);
  const [sent, got] = clockGap;
  // each kick paired with the arrival nearest after it, within a fifth of a beat
  const gaps = sent.map((t) => got.find((g) => g >= t && g - t < 90) - t).filter(Number.isFinite).sort((x, y) => x - y);
  console.log(`     a kick reaches Patchwerk ${gaps[gaps.length >> 1]?.toFixed(0)} ms after the engine fires it (worst ${gaps.at(-1)?.toFixed(0)} ms, ${gaps.length} of ${sent.length} paired)`);
  check('a hit arrives within two frames of the picture', gaps[gaps.length >> 1] < 40);

  // the transport stops, then Soundwerk goes away
  await sw.evaluate(() => window.soundwerk.host.setRunning(false));
  await pw.waitForFunction(() => !window.patchwerk.transport.playing, null, { timeout: 3000 });
  check('stopping Soundwerk stops the picture', true);
  await sw.evaluate(() => window.soundwerk.host.setRunning(true));
  await pw.waitForFunction(() => window.patchwerk.transport.playing, null, { timeout: 3000 });
  check('and starting it starts it again', true);
  await pw.screenshot({ path: 'test/out/live.png' });
  await sw.evaluate(() => window.soundwerk.link.toggle(false));
  await pw.waitForFunction(() => !window.patchwerk.transport.live, null, { timeout: 3000 });
  check('when Soundwerk leaves, the track comes back', (await pw.locator('#track-name').textContent()).includes('demo'));
  check('and the button waits for it to return', await pw.locator('#live-btn.wait').isVisible());
  await sw.evaluate(() => window.soundwerk.link.toggle(true));
  await pw.waitForFunction(() => window.patchwerk.transport.live, null, { timeout: 5000 });
  check('it follows again by itself', true);
  await pw.click('#live-btn');
  check('pressing it again goes back to the track', !(await pw.evaluate(() => !!window.patchwerk.transport.live)) && !(await pw.locator('#live-btn.wait').isVisible()) && await pw.locator('#live-btn.ready').isVisible());
  await pw.click('#live-btn');
  check('and forth', await pw.evaluate(() => !!window.patchwerk.transport.live));
  check('no errors on either page', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL', e.message);
  failed = true;
}
await browser.close();
servers.forEach((s) => s.kill());
process.exit(failed ? 1 : 0);
