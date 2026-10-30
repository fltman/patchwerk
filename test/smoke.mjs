// npm run smoke — boots the app headless, plays the demo track, screenshots it,
// and fails on console errors or shader errors.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
mkdirSync('test/out', { recursive: true });

const preset = process.argv[2]; // optional preset index
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.patchwerk?.transport.reader, null, { timeout: 60000 });
  if (preset !== undefined) {
    await page.selectOption('#examples', preset);
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => { window.patchwerk.transport.seek(40); window.patchwerk.transport.play(); });
  await page.waitForTimeout(3500);
  const info = await page.evaluate(() => {
    const { renderer, transport, graph } = window.patchwerk;
    return {
      playing: transport.playing, time: transport.time.toFixed(2), bpm: transport.reader.analysis.bpm.toFixed(2),
      kicks: transport.reader.analysis.onsets.kick.times.length, downbeat: transport.reader.analysis.downbeat,
      nodes: graph.nodes.size, errors: [...renderer.errors].map(([id, e]) => `${id}: ${JSON.stringify(e)}`),
      fps: document.getElementById('fps').textContent,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: `test/out/app${preset ?? ''}.png` });
  if (problems.length) console.log('console problems:\n' + problems.join('\n'));
  failed = problems.some((p) => !p.startsWith('warning')) || info.errors.length > 0 || !info.playing;
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
