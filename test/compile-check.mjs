// npm run check:shaders — compile + test-render every image node in headless Chromium.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

// usage: npm run check:shaders [-- <filter>] [-- --shots]   (shots → test/out/<type>.png at 640×360)
const args = process.argv.slice(2);
const SHOTS = args.includes('--shots');
const FILTER = args.find((a) => !a.startsWith('--'));

// random free-ish port so several checks can run at once
const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));

let exit = 1;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://localhost:${PORT}/test/compile.html${SHOTS ? '?shots&w=640&h=360' : ''}`);
  await page.waitForFunction(() => window.__results || null, null, { timeout: 60000 }).catch(() => {});
  const out = await page.evaluate(() => window.__results);
  if (!out) {
    console.error('Page never produced results.', pageErrors.join('\n'));
  } else {
    let failed = 0;
    if (SHOTS) mkdirSync('test/out', { recursive: true });
    for (const r of out.results) {
      if (FILTER && !r.type.includes(FILTER)) continue;
      if (SHOTS && r.png) {
        writeFileSync(`test/out/${r.type}.png`, Buffer.from(r.png.split(',')[1], 'base64'));
      }
      const mark = r.ok ? '✓' : '✗';
      const info = r.ok ? `mean ${r.mean} max ${r.max}` : '';
      console.log(`${mark} ${r.category.padEnd(9)} ${r.type.padEnd(18)} ${info}`);
      for (const e of r.errors) console.log(`    error: ${e}`);
      for (const w of r.warnings) console.log(`    warning: ${w}`);
      if (!r.ok) failed++;
    }
    console.log(`\n${out.results.length} image nodes, ${failed} failed${out.floatOk ? '' : ' (no float readback — NaN check skipped)'}`);
    if (pageErrors.length) console.log('page errors:\n' + pageErrors.join('\n'));
    exit = failed || pageErrors.length ? 1 : 0;
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(exit);
