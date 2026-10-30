// npm run dj — the live DJ in a real browser on the GPU, with the decision model
// replaced by a stand-in, so timing and failures can be forced. No credit is spent.
// npm run dj-live — the real model, on the real server (a few tenths of a cent).
//   node test/dj.mjs --live [seconds] [track url]
// npm run dj-build — the real assistant builds a rig, then the real model plays it
// (spends a few tens of cents):
//   node test/dj.mjs --build [seconds] [track url]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BUILD = process.argv.includes('--build');
const LIVE = BUILD || process.argv.includes('--live');
const [seconds = 60, trackUrl] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
process.once('exit', () => server.kill());
await new Promise((r) => server.stdout.once('data', r));
mkdirSync('test/out', { recursive: true });

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failed++; };
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(m.text()); }); // the forced failures
  page.on('response', (r) => { if (r.status() === 404 && !r.url().endsWith('favicon.ico')) problems.push(`404 ${r.url()}`); });
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.patchwerk?.transport.reader, null, { timeout: 60000 });
  if (trackUrl) {
    await page.evaluate((u) => window.patchwerk.loadTrackUrl(u), trackUrl);
    await page.waitForFunction(() => !document.getElementById('busy').classList.contains('hidden') || window.patchwerk.transport.reader, null, { timeout: 60000 });
  }
  await page.selectOption('#examples', { label: BUILD ? 'Empty rack' : 'DJ rig' });
  await page.click('#dj-btn');
  if (BUILD) {
    const t0 = Date.now();
    await page.evaluate(() => window.patchwerk.transport.play());
    await page.click('#dj-build');
    await page.keyboard.type('Dark, driving and hypnotic.');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !window.patchwerk.chat.busy, null, { timeout: 420000, polling: 500 });
    const b = await page.evaluate(() => {
      const { graph, renderer, chat } = window.patchwerk;
      return {
        rig: graph.rig,
        nodes: [...graph.nodes.values()].map((n) => n.type).join(' '),
        errors: [...renderer.errors.keys()],
        items: chat.items.map((x) => (x.kind === 'ops' ? `[ops] ${x.lines.slice(0, 6).join(' | ')}` : `[${x.kind}] ${x.text ?? ''}`)),
      };
    });
    console.log(`built in ${Math.round((Date.now() - t0) / 1000)} s\n${b.items.join('\n').slice(-3500)}`);
    console.log(`\nnodes: ${b.nodes}\nbrief: ${b.rig?.brief}`);
    for (const g of b.rig?.groups ?? []) console.log(`  ${g.name} (every ${g.every}${g.on_section ? ', on section' : ''}${g.ordered ? ', ordered' : ''}): ${g.moves.map((m) => m.name).join(', ')}`);
    check(!!b.rig, 'the assistant built a rig');
    check(!b.errors.length, 'its shaders compile');
    await page.screenshot({ path: 'test/out/dj-build.png' });
    await page.evaluate(() => { const t = window.patchwerk.transport; t.pause(); t.seek(0); });
  }
  const frames = () => page.evaluate(async (ms) => {
    const gaps = [];
    let last = performance.now();
    await new Promise((done) => {
      const end = last + ms;
      const f = (now) => { gaps.push(now - last); last = now; if (now < end) requestAnimationFrame(f); else done(); };
      requestAnimationFrame(f);
    });
    gaps.shift();
    return { fps: 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length), worst: Math.max(...gaps), hitches: gaps.filter((g) => g > 40).length };
  }, 4000);
  const dj = () => page.evaluate(() => {
    const { dj } = window.patchwerk;
    return { running: dj.running, log: dj.log, stats: dj.stats, picture: dj.picture, message: dj.message, current: Object.fromEntries(dj.current), bar: dj.bar };
  });

  if (LIVE) {
    await page.click('#dj-start');
    const fps = await frames();
    await page.waitForTimeout((Number(seconds) - 4) * 1000);
    const s = await dj();
    await page.screenshot({ path: 'test/out/dj-live.png' });
    await page.click('#dj-start');
    const moves = s.log.filter((l) => l.by === 'dj');
    console.log(`${s.stats.calls} answers, ${s.stats.fails} failed, ${s.stats.late} late, last ${Math.round(s.stats.ms)} ms, $${s.stats.cost.toFixed(5)}, model ${s.stats.model}`);
    console.log(`bar ${s.bar}, ${fps.fps.toFixed(1)} fps, worst frame ${fps.worst.toFixed(0)} ms, picture ${JSON.stringify(s.picture)}`);
    for (const m of moves.slice(-16)) console.log(`  bar ${String(m.bar).padStart(3)}  ${m.group}/${m.move}  at beat ${m.beat.toFixed(3)}  odds ${m.odds?.toFixed?.(2) ?? '-'}`);
    check(s.stats.calls > 0, 'the model answered');
    check(s.stats.fails === 0, 'no failed calls');
    check(moves.length > 0, 'moves were made');
    check(moves.every((m) => Math.abs(m.beat) < 0.15), 'every move landed on a downbeat');
  } else {
    // ── the known arrangement of the demo track ──
    const a = await page.evaluate(() => {
      const r = window.patchwerk.transport.reader;
      return { sections: r.analysis.sections, bar: (r.period * 4) };
    });
    console.log(`  demo sections: ${a.sections.map((s) => `bar ${s.bar} ${s.label}`).join(', ')}`);
    const near = (bar) => a.sections.some((s) => Math.abs(s.bar - bar) <= 1);
    check(near(16) && near(20), 'the breakdown of the demo track (bars 16–20) is found');
    check(a.sections.find((s) => Math.abs(s.bar - 16) <= 1)?.label === 'breakdown', 'and called a breakdown');
    check(a.sections.find((s) => Math.abs(s.bar - 20) <= 1)?.label === 'drop', 'and what follows a drop');

    // ── a model that answers in 250 ms, liking things in turn ──
    let mode = 'ok';
    const seen = [];
    let turn = 0;
    await page.route('**/api/decide', async (route) => {
      const body = route.request().postDataJSON();
      seen.push(body);
      if (mode === 'down') return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'overloaded', status: 529 }) });
      await new Promise((r) => setTimeout(r, mode === 'slow' ? 4000 : 250));
      const answers = {};
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === 'score') answers[name] = { type: 'score', score: turn++ % q.criteria.length, probabilities: {} };
        else {
          const keys = Object.keys(q.criteria);
          const best = keys[turn++ % keys.length];
          answers[name] = { type: 'choice', choice: best, probabilities: Object.fromEntries(keys.map((k) => [k, k === best ? 0.97 : 0.03 / (keys.length - 1)])) };
        }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ answers, usage: { cost: 0.00004 }, model: 'stand-in' }) }).catch(() => {});
    });

    await page.click('#dj-start');
    await page.waitForFunction(() => window.patchwerk.dj.bar !== null);
    const fps = await frames();
    await page.waitForFunction(() => window.patchwerk.dj.log.filter((l) => l.by === 'dj').length >= 4, null, { timeout: 40000 }).catch(() => {});
    const s = await dj();
    await page.screenshot({ path: 'test/out/dj.png' });
    const moves = s.log.filter((l) => l.by === 'dj');
    const worst = Math.max(...moves.map((m) => Math.abs(m.beat)));
    console.log(`  ${s.stats.calls} answers, ${moves.length} moves, furthest from the downbeat ${worst.toFixed(3)} beats`);
    console.log(`  rig playing: ${fps.fps.toFixed(1)} fps, worst frame ${fps.worst.toFixed(1)} ms, ${fps.hitches} frames over 40 ms`);
    console.log(`  a question: ${JSON.stringify(seen.at(-1).state).slice(0, 400)}`);
    check(moves.length >= 4, 'moves are being made');
    check(worst < 0.12, 'every move landed within a frame or two of the downbeat');
    check(fps.fps > 55, 'the rig plays at 60 fps');
    check(fps.hitches === 0, 'no hitches while moves land');
    check(!!s.picture && s.picture.brightness > 0.01, 'the picture is being measured');
    check(seen.every((b) => b.state.picture && b.state.music.section), 'the model is told about the music and the picture');
    check(JSON.stringify(seen.at(-1).state).length < 2000, 'the state stays small');
    const lit = await page.$$eval('.dj-pad.on', (p) => p.length);
    check(lit === 4, 'one pad is lit per group');

    // ── the model goes down ──
    mode = 'down';
    await page.waitForTimeout(6000);
    const down = await dj();
    check(down.running && down.stats.fails > 0, 'failures are counted and the DJ keeps going');
    check(down.log.filter((l) => l.by === 'dj').length <= moves.length + 8 && down.message === 'overloaded', 'the panel says why nothing is happening');
    const stillFps = await frames();
    check(stillFps.fps > 55, `the picture does not care (${stillFps.fps.toFixed(1)} fps)`);

    // ── the model takes four seconds ──
    mode = 'slow';
    await page.evaluate(() => { window.patchwerk.dj.stats.inRow = 0; });
    const { log: { length: n }, stats: { late } } = await dj();
    await page.waitForFunction((was) => window.patchwerk.dj.stats.late > was, late, { timeout: 30000 }).catch(() => {});
    const slow = await dj();
    check(slow.stats.late > late, `answers that miss the downbeat are dropped (${slow.stats.late - late})`);
    check(slow.log.length === n, 'and change nothing');
    mode = 'ok';

    // ── your own pick ──
    const landed = page.waitForFunction(() => window.patchwerk.dj.log.at(-1)?.by === 'you', null, { timeout: 8000 });
    await page.click('[data-pad="texture/glitch"]');
    await landed;
    check((await dj()).current.texture === 'glitch', 'a pad lands on the next downbeat');

    // ── a picture gone black ──
    await page.evaluate(() => {
      const { dj, graph, transport } = window.patchwerk;
      transport.seek(46); // the full section, energy high
      dj.decide = () => new Promise(() => {}); // quiet, so only the safety acts
      dj.queue('look', 'tunnel');
      setTimeout(() => { for (const g of ['gainA', 'gainB', 'gainC', 'gainD']) graph.setParam('n7', g, 0); }, 2500);
    });
    await page.waitForFunction(() => window.patchwerk.dj.log.at(-1)?.by === 'safety', null, { timeout: 12000 }).then(
      () => check(true, 'a black picture brings the rig home'),
      () => check(false, 'a black picture brings the rig home'),
    );

    // ── stopping, and undo ──
    await page.click('#dj-start');
    const after = await page.evaluate(() => {
      const { dj, graph } = window.patchwerk;
      const undoSteps = graph.history.length;
      graph.undo();
      return { running: dj.running, undoSteps, gainB: graph.nodes.get('n7').params.gainB, rig: !!graph.rig };
    });
    check(!after.running, 'Stop stops it');
    check(after.rig, 'undo keeps the rig');

    // ── what the assistant does with a rig: audition ──
    await page.evaluate(() => { window.patchwerk.transport.pause(); });
    const aud = await page.evaluate(async () => {
      const images = [];
      const text = await window.patchwerk.chat.runTool({ function: { name: 'audition', arguments: '{"group":"look"}' } }, images);
      return { text, images: images.length, time: window.patchwerk.transport.time };
    });
    console.log(aud.text.split('\n').map((l) => `  ${l}`).join('\n'));
    check(aud.images === 4, 'audition shows every move of a group');
    check(!/nearly/.test(aud.text), 'no look of the built-in rig is black or white');
    const bad = await page.evaluate(async () => window.patchwerk.chat.runTool({ function: { name: 'set_rig', arguments: JSON.stringify({ brief: 'b', groups: [{ name: 'x', question: 'q', moves: [] }] }) } }, []));
    check(/not saved/.test(bad), 'a broken rig is sent back to the assistant');
  }
  check(!problems.length, `no errors in the page${problems.length ? `: ${problems.slice(0, 3).join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
