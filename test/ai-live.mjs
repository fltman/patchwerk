// npm run ai-live — talks to the real model (spends a few cents of OpenRouter credit):
// builds a patch from a description, then edits it, and screenshots both.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URL || 'http://127.0.0.1:8277/';
const prompts = process.argv.slice(2).length ? process.argv.slice(2) : [
  'Bygg en neon-tunnel som rusar fram på basen och blinkar på kicken.',
  'Lägg till texten PATCHWERK som pulserar på kicken, och låt hihatten glitcha bilden lite.',
];
mkdirSync('test/out', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
let ok = true;
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.waitForFunction(() => window.patchwerk?.transport.reader, null, { timeout: 60000 });
  await page.selectOption('#examples', { label: 'Empty rack' });
  await page.evaluate(() => { const t = window.patchwerk.transport; t.seek(44); t.play(); });
  await page.click('#ai-btn');
  for (const [i, text] of prompts.entries()) {
    const t0 = Date.now();
    await page.fill('#chat-input', text);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !window.patchwerk.chat.busy, null, { timeout: 240000, polling: 500 });
    const s = await page.evaluate(() => {
      const { graph, renderer, chat } = window.patchwerk;
      return {
        nodes: [...graph.nodes.values()].map((n) => `${n.id}:${n.type}`).join(' '),
        cables: graph.links.size,
        shaderErrors: [...renderer.errors.keys()],
        items: chat.items.slice(-8).map((x) => x.kind === 'ops' ? `[ops] ${x.lines.join(' | ')}` : `[${x.kind}] ${x.text ?? ''}`),
      };
    });
    console.log(`\n── “${text}”  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    console.log(s.items.join('\n'));
    console.log(`nodes: ${s.nodes}\ncables: ${s.cables}  shader errors: ${s.shaderErrors.length}`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `test/out/ai-${i}.png` });
    await page.locator('#preview').screenshot({ path: `test/out/ai-${i}-out.png` });
    if (s.shaderErrors.length || s.items.some((x) => x.startsWith('[error]'))) ok = false;
  }
  if (errors.length) { console.log('page errors:\n' + errors.join('\n')); ok = false; }
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
