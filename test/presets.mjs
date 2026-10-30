// npm run presets — plays every example patch and screenshots the output → test/out/preset-<i>.png
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
mkdirSync('test/out', { recursive: true });
const at = Number(process.argv[2] ?? 44);
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
let bad = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.patchwerk?.transport.reader, null, { timeout: 60000 });
  const names = await page.$$eval('#examples option', (o) => o.filter((x) => x.value !== '').map((x) => x.textContent));
  for (let i = 0; i < names.length; i++) {
    await page.selectOption('#examples', String(i));
    await page.evaluate((t) => { const tr = window.patchwerk.transport; tr.pause(); tr.seek(t); tr.play(); }, at);
    await page.waitForTimeout(2500);
    const errs = await page.evaluate(() => [...window.patchwerk.renderer.errors].map(([id, e]) => `${id} ${e[0]?.message}`));
    await page.locator('#preview').screenshot({ path: `test/out/preset-${i}.png` });
    if (i === 0) await page.screenshot({ path: 'test/out/app.png' });
    console.log(`${errs.length ? '✗' : '✓'} ${i} ${names[i]} ${errs.join('; ')}`);
    bad += errs.length;
  }
  if (errors.length) { console.log('page errors:\n' + errors.join('\n')); bad++; }
} finally {
  await browser.close();
  server.kill();
}
process.exit(bad ? 1 : 0);
