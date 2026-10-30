// npm run interact — drives the editor with a real mouse: add, patch, lift, delete, undo.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.patchwerk?.transport.reader, null, { timeout: 60000 });
  await page.selectOption('#examples', { label: 'Empty rack' });
  await page.evaluate(() => { const e = window.patchwerk.editor; e.view = { x: 0, y: 0, zoom: 1 }; e.applyView(); });
  const state = () => page.evaluate(() => {
    const g = window.patchwerk.graph;
    return { nodes: [...g.nodes.values()].map((n) => n.type), links: [...g.links.values()].map((l) => `${g.nodes.get(l.from).type}.${l.fromPort}→${g.nodes.get(l.to).type}.${l.toPort}`) };
  });
  const center = async (sel) => { const b = await page.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const drag = async (a, b) => {
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2 + 30, { steps: 5 });
    await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
  };

  // 1. add via double-click + search
  await page.mouse.dblclick(420, 420);
  check('double-click opens the add menu', await page.locator('.add-menu:not(.hidden)').count() === 1);
  await page.keyboard.type('noise');
  await page.keyboard.press('Enter');
  let s = await state();
  check('search + Enter adds the node', s.nodes.includes('noise'), s.nodes.join(','));
  const noiseId = await page.evaluate(() => [...window.patchwerk.graph.nodes.values()].find((n) => n.type === 'noise').id);
  const outId = await page.evaluate(() => window.patchwerk.graph.outputNode().id);
  const trackId = await page.evaluate(() => [...window.patchwerk.graph.nodes.values()].find((n) => n.type === 'track').id);

  // 2. patch noise.out → output.src
  await drag(await center(`.node[data-id="${noiseId}"] .port.out`), await center(`.node[data-id="${outId}"] .port.in.image`));
  s = await state();
  check('drag out→in makes an image cable', s.links.includes('noise.out→output.src'), s.links.join(' '));

  // 3. patch track.bass → noise.scale
  await drag(await center(`.node[data-id="${trackId}"] .port[data-port="bass"]`), await center(`.node[data-id="${noiseId}"] .port[data-port="scale"]`));
  s = await state();
  check('drag control out→slider makes a control cable', s.links.includes('track.bass→noise.scale'), s.links.join(' '));
  check('patched slider shows its mod depth row', await page.locator(`.node[data-id="${noiseId}"] .row.param.linked + .depth-row`).isVisible());

  // 4. wrong kind is refused
  await drag(await center(`.node[data-id="${trackId}"] .port[data-port="kick"]`), await center(`.node[data-id="${outId}"] .port.in.image`));
  s = await state();
  check('control→image input is refused', !s.links.some((l) => l.startsWith('track.kick')), s.links.join(' '));

  // 5. drop a cable on empty space → filtered menu → auto-connect
  await page.keyboard.press('Escape');
  const from = await center(`.node[data-id="${noiseId}"] .port.out`);
  await drag(from, { x: from.x + 120, y: from.y + 330 });
  check('dropping on empty space opens the menu', await page.locator('.add-menu:not(.hidden)').count() === 1);
  const offered = await page.locator('.add-item .t').allTextContents();
  check('menu only offers nodes with an image input', offered.includes('Transform') && !offered.includes('LFO') && !offered.includes('Noise'), `${offered.length} items`);
  await page.keyboard.type('transform');
  await page.keyboard.press('Enter');
  s = await state();
  check('picked node is auto-connected', s.links.includes('noise.out→transform.src'), s.links.join(' '));

  // 6. lift a cable off an input and drop it nowhere → removed
  await page.evaluate(() => window.patchwerk.editor.updateCables());
  await page.waitForTimeout(100);
  const inPort = await center(`.node[data-id="${noiseId}"] .port[data-port="scale"]`);
  await drag(inPort, { x: inPort.x - 60, y: inPort.y + 260 });
  s = await state();
  check('lifting a plugged input removes the cable', !s.links.includes('track.bass→noise.scale'), s.links.join(' '));

  // 7. slider drag changes the value
  const before = await page.evaluate((id) => window.patchwerk.graph.nodes.get(id).params.scale, noiseId);
  const sl = await page.locator(`.node[data-id="${noiseId}"] .row.param .slider`).first().boundingBox();
  await page.mouse.move(sl.x + sl.width * 0.2, sl.y + sl.height / 2); await page.mouse.down();
  await page.mouse.move(sl.x + sl.width * 0.8, sl.y + sl.height / 2, { steps: 4 }); await page.mouse.up();
  const after = await page.evaluate((id) => window.patchwerk.graph.nodes.get(id).params.scale, noiseId);
  check('dragging a slider changes the param', after > before + 5, `${before} → ${after.toFixed(2)}`);

  // 8. select + delete, then undo
  await page.click(`.node[data-id="${noiseId}"] .node-head .title`);
  await page.keyboard.press('Backspace');
  s = await state();
  check('Backspace deletes the selected node and its cables', !s.nodes.includes('noise') && !s.links.some((l) => l.includes('noise')));
  await page.keyboard.press('Meta+z');
  s = await state();
  check('⌘Z brings it back with its cables', s.nodes.includes('noise') && s.links.includes('noise.out→output.src'), s.links.join(' '));

  // 9. GLSL tab shows code; fork makes it editable
  await page.dblclick(`.node[data-id="${noiseId}"] .node-head .title`);
  check('double-clicking a title opens its GLSL', (await page.inputValue('#code-text')).includes('vec4 render'));
  await page.click('#code-fork');
  const forked = await page.evaluate(() => [...window.patchwerk.graph.nodes.values()].some((n) => n.type === 'glsl'));
  s = await state();
  check('fork replaces the node with an editable GLSL node, cables kept', forked && s.links.includes('glsl.out→output.src') && !(await page.locator('#code-text').getAttribute('readonly')), s.links.join(' '));
  await page.click('#code-text');
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('uniform float p_k; // 0 1 0.5\nvec4 render(vec2 uv) { return vec4(uv, p_k, 1.0) }');
  await page.waitForTimeout(1500); // debounce + a software-GL compile
  const errText = await page.locator('#code-errors').textContent();
  check('a syntax error is reported with its line', /line 2/.test(errText), errText.trim().slice(0, 80));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(';');
  await page.waitForTimeout(1500);
  check('fixing it compiles', (await page.locator('#code-errors').textContent()).includes('compiled'));
  await page.click('.tabs button[data-tab="graph"]');
  const glslNode = await page.locator('.node.cat-custom .slider .slabel').allTextContents();
  check('the new uniform became a slider on the node', glslNode.includes('k'), glslNode.join(','));

  // 10. values changed from code (the assistant) show on the sliders
  const shown = await page.evaluate(() => {
    const { graph, editor } = window.patchwerk;
    const n = [...graph.nodes.values()].find((x) => x.type === 'transform');
    const t = [...graph.nodes.values()].find((x) => x.type === 'track');
    graph.connect(t.id, 'kick', n.id, 'zoom');
    graph.setParam(n.id, 'zoom', 4);
    graph.setDepth(n.id, 'zoom', -0.4);
    editor.refreshNode(n.id);
    const row = editor.views.get(n.id).params.get('zoom');
    return { val: row.val.textContent, depth: row.depth.val.textContent, fill: row.fill.style.width };
  });
  check('values set from code show on the slider and its mod depth', shown.depth === '-40%' && shown.fill.startsWith('49'), JSON.stringify(shown));

  if (errors.length) console.log('page errors:\n' + errors.join('\n'));
  check('no page errors', errors.length === 0);
} finally {
  await browser.close();
  server.kill();
}
process.exit(results.every(Boolean) ? 0 : 1);
