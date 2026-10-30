// npm run perf — real-GPU frame cost per example patch (headless Chrome, Metal).
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.patchwerk?.transport.reader, null, { timeout: 60000 });
  const gpu = await page.evaluate(() => {
    const gl = window.patchwerk.renderer.gl;
    return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
  });
  console.log(gpu);
  const names = await page.$$eval('#examples option', (o) => o.filter((x) => x.value !== '').map((x) => x.textContent));
  for (const res of ['1280x720', '1920x1080']) {
    await page.selectOption('#resolution', res);
    for (let i = 0; i < names.length - 1; i++) {
      await page.selectOption('#examples', String(i));
      await page.evaluate(() => { const t = window.patchwerk.transport; t.seek(44); t.play(); });
      await page.waitForTimeout(800);
      // N frames back to back, each forced to finish on the GPU: the real cost of one frame
      const ms = await page.evaluate(async () => {
        const { renderer, transport, editor, graph } = window.patchwerk;
        const gl = renderer.gl;
        const px = new Uint8Array(4);
        const visible = editor.visibleNodes();
        const thumbs = editor.thumbTargets(visible.filter((id) => typeof graph.def(graph.nodes.get(id)).glsl === 'string'));
        const run = (withThumbs) => {
          const t0 = performance.now();
          for (let k = 0; k < 40; k++) {
            renderer.frame({ time: transport.time, dt: 1 / 60, wallDt: 1 / 60, playing: true, reader: transport.reader, mono: transport.mono, sampleRate: 44100, visible, thumbs: withThumbs ? thumbs : null });
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          }
          return (performance.now() - t0) / 40;
        };
        run(false);
        return { plain: run(false), thumbs: run(true), nodes: graph.nodes.size };
      });
      console.log(`${res.padEnd(10)} ${names[i].padEnd(18)} ${String(ms.nodes).padStart(2)} nodes  ${ms.plain.toFixed(2).padStart(6)} ms/frame  (${ms.thumbs.toFixed(2)} ms with node previews)`);
    }
  }
} finally {
  await browser.close();
  server.kill();
}
