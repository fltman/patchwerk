// npm run dj-ears — the live DJ's ears in real Chrome, muted, with the real decision model (a fraction
// of a cent): Soundwerk plays, Patchwerk's DJ follows, and the music is changed the way a performer
// would, once at the mixer and once at the sequencer. Needs Soundwerk next to this folder, or
// SOUNDWERK_DIR. Runs on its own ports, next to any servers you have.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const SOUNDWERK = resolve(process.env.SOUNDWERK_DIR ?? '../soundwerk');
const PW = 20000 + Math.floor(Math.random() * 20000), SW = PW + 1;
const start = (cwd, port, env = {}) => new Promise((ok, no) => {
  const p = spawn(process.execPath, ['server.mjs'], { cwd, env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.once('data', () => ok(p));
  p.stderr.once('data', (d) => no(new Error(String(d))));
});
const servers = [await start('.', PW, { PATCHWERK_LIVE_ORIGINS: `http://localhost:${SW}` }), await start(SOUNDWERK, SW)];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const problems = [];
const open = async (url) => {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !m.location().url.endsWith('/favicon.ico')) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
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
  await pw.selectOption('#examples', { label: 'DJ rig' });
  const sw = await open(`http://localhost:${SW}/`);
  await sw.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);
  const wall = await sw.evaluate(async (port) => {
    const { graph, host, link } = window.soundwerk;
    await host.start();
    host.setRunning(true);
    link.url = `ws://localhost:${port}/api/live?role=source`;
    link.toggle(true);
    const nodes = [...graph.nodes.values()], links = [...graph.links.values()];
    const kick = nodes.find((n) => n.type === 'kick');
    const trig = links.find((l) => l.to === kick.id && l.toPort === 'trig');
    const out = links.find((l) => l.from === kick.id && /^ch\d+$/.test(l.toPort));
    const channel = { id: out.to, n: out.toPort.slice(2) };
    window.cut = { trig, channel };
    return { bpm: nodes.find((n) => n.type === 'clock').params.bpm, channel, type: graph.nodes.get(out.to).type, params: Object.keys(graph.nodes.get(out.to).params).filter((k) => k.includes('mute')) };
  }, PW);
  console.log(`the wall: ${wall.bpm} BPM, kick on ${wall.type} channel ${wall.channel.n}, ${wall.params.join(' ')}`);
  await pw.waitForFunction(() => window.patchwerk.transport.live, null, { timeout: 5000 });
  const bar = (240 / wall.bpm) * 1000;

  await pw.evaluate(() => {
    const { dj } = window.patchwerk;
    const events = (window.events = []);
    const say = (e) => events.push({ at: Date.now(), ...e });
    const hear = dj.ear.hear.bind(dj.ear);
    dj.ear.hear = (f, loud) => { const c = hear(f, loud); if (c) say({ kind: 'heard', change: c, music: dj.ear.now(f.barIndex) }); return c; };
    const fire = dj.fire.bind(dj);
    dj.fire = (g, m, o) => { say({ kind: 'move', group: g.name, move: m.name, by: o?.by ?? 'dj', bars: o?.bars ?? m.glide }); return fire(g, m, o); };
    const decide = dj.decide;
    dj.decide = (body, signal) => { say({ kind: 'asked', groups: Object.keys(body.questions), music: body.state.music }); return decide(body, signal); };
  });
  await pw.click('#dj-btn');
  await pw.locator('#dj-daring').fill('80');
  check('the Daring knob reaches the DJ', await pw.evaluate(() => window.patchwerk.dj.daring) === 0.8);
  check('and is remembered', await pw.evaluate(() => localStorage.getItem('patchwerk.dj.daring')) === '80');
  await pw.locator('#dj-daring').fill('50');
  await pw.waitForTimeout(16 * bar);
  const started = await pw.evaluate(() => window.patchwerk.dj.start());
  check('the DJ starts on a live input', started !== false);
  const since = await pw.evaluate(() => Date.now());
  await pw.waitForTimeout(24 * bar);
  const quiet = await pw.evaluate((t) => window.events.filter((e) => e.kind === 'heard' && e.at >= t), since);
  check('a steady wall is not news', quiet.length <= 1, `${quiet.length} false alarms in 24 bars ${quiet.map((e) => e.change).join(', ')}`);

  const gesture = async (name, cut, restore) => {
    const t0 = await sw.evaluate(cut);
    await pw.waitForTimeout(8 * bar);
    const t1 = await sw.evaluate(restore);
    await pw.waitForTimeout(8 * bar);
    const log = await pw.evaluate(([a, b]) => window.events.filter((e) => e.at >= a && e.at < b), [t0, t1 + 6 * 240000 / 240]);
    for (const [label, at] of [[`${name}: gone`, t0], [`${name}: back`, t1]]) {
      const heard = log.find((e) => e.kind === 'heard' && e.at >= at);
      const asked = log.find((e) => e.kind === 'asked' && e.at >= at && e.music.just_changed);
      const move = log.find((e) => e.kind === 'move' && e.at >= at && e.by === 'dj');
      console.log(`  ${label}: heard ${heard ? `${heard.at - at} ms "${heard.change}"` : 'never'}, told ${JSON.stringify(asked?.music ?? null)}, moved ${move ? `${move.at - at} ms ${move.group}→${move.move} over ${move.bars} bars` : 'never'}`);
      check(`${label} is heard within 2 bars`, heard && heard.at - at <= 2 * bar);
    }
  };
  await gesture('kick muted at the mixer',
    () => { const { graph } = window.soundwerk, { channel } = window.cut; graph.setParam(channel.id, `mute${channel.n}`, 1); return Date.now(); },
    () => { const { graph } = window.soundwerk, { channel } = window.cut; graph.setParam(channel.id, `mute${channel.n}`, 0); return Date.now(); });
  await gesture('kick pulled from the sequencer',
    () => { const { graph } = window.soundwerk, { trig } = window.cut; graph.disconnect(trig.id); return Date.now(); },
    () => { const { graph } = window.soundwerk, { trig } = window.cut; graph.connect(trig.from, trig.fromPort, trig.to, trig.toPort); return Date.now(); });

  const r = await pw.evaluate(() => {
    const { dj } = window.patchwerk;
    return { stats: dj.stats, heard: window.events.filter((e) => e.kind === 'heard').length, asks: window.events.filter((e) => e.kind === 'asked').length, moves: window.events.filter((e) => e.kind === 'move' && e.by === 'dj').length, sample: window.events.filter((e) => e.kind === 'asked').at(-1)?.music };
  });
  console.log(`${r.heard} changes heard, ${r.asks} asks, ${r.moves} moves, ${r.stats.fails} failed, ${r.stats.late} late, ${Math.round(r.stats.ms)} ms last answer, $${r.stats.cost.toFixed(4)}, ${r.stats.model}`);
  check('the real model answered', r.stats.calls > 0 && r.stats.fails === 0);
  check('no errors on either page', !problems.length, problems.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  servers.forEach((s) => s.kill());
}
process.exit(failed ? 1 : 0);
