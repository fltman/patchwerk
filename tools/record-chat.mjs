// Records a real conversation with the patch assistant so a video can replay it
// frame by frame.  Spends a few cents of OpenRouter credit per prompt.
//
//   node tools/record-chat.mjs <out.json> [--track /video/born.mp3] [--at 62] "prompt 1" "prompt 2" …
//
// Starts from the "Empty rack" example. Saves { prompts, startPatch, steps } where steps are
// the chat items in order; every "ops" step carries the patch as it was right after that edit.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const out = args.shift();
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const track = opt('--track', '/video/born.mp3');
const at = Number(opt('--at', 62));
const prompts = args;
if (!out || !prompts.length) { console.error('usage: node tools/record-chat.mjs out.json [--track url] [--at seconds] "prompt" …'); process.exit(1); }

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.patchwerk?.transport.reader, null, { timeout: 60000 });
  await page.evaluate(([url]) => window.patchwerk.loadTrackUrl(url), [track]);
  await page.selectOption('#examples', { label: 'Empty rack' });
  await page.evaluate((t) => {
    const P = window.patchwerk;
    P.transport.seek(t);
    P.transport.play();
    P.chat.toggle(true);
    P.chat.reset();
    window.__rec = { startPatch: P.graph.toJSON(), steps: [] };
    const add = P.chat.add.bind(P.chat);
    P.chat.add = (item, persist) => {
      const step = { ...item };
      if (item.kind === 'ops') step.patch = P.graph.toJSON();
      window.__rec.steps.push(step);
      return add(item, persist);
    };
  }, at);
  for (const p of prompts) {
    const t0 = Date.now();
    await page.fill('#chat-input', p);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !window.patchwerk.chat.busy, null, { timeout: 240000, polling: 300 });
    console.log(`“${p}” — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const rec = await page.evaluate(() => window.__rec);
  writeFileSync(out, JSON.stringify({ prompts, ...rec }, null, 1));
  for (const [i, s] of rec.steps.entries()) {
    console.log(`  step ${i}: ${s.kind}${s.kind === 'ops' ? ` (${s.lines.length} ops${s.lines.some((l) => !l.startsWith('✓')) ? ', some failed' : ''})` : ''}${s.text ? ' — ' + s.text.slice(0, 110).replace(/\n/g, ' ') : ''}`);
  }
} finally {
  await browser.close();
  server.kill();
}
