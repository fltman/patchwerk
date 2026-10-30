import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/graph/graph.js';
import { customDef, forkToCustom } from '../src/nodes/custom.js';
import { getDef } from '../src/nodes/index.js';
import { composeFragment } from '../src/engine/compose.js';

function rack() {
  const g = new Graph();
  const track = g.addNode('track');
  const noise = g.addNode('noise');
  const fx = g.addNode('transform');
  const out = g.addNode('output');
  return { g, track, noise, fx, out };
}

test('cables only join matching kinds', () => {
  const { g, track, noise, fx } = rack();
  assert.equal(g.connect(track.id, 'kick', fx.id, 'zoom').ok, true);
  assert.equal(g.connect(noise.id, 'out', fx.id, 'zoom').ok, false, 'image into a slider');
  assert.equal(g.connect(track.id, 'kick', fx.id, 'src').ok, false, 'control into an image input');
  assert.equal(g.connect(fx.id, 'out', fx.id, 'src').ok, false, 'node into itself');
});

test('no loops, and a new cable replaces the old one on an input', () => {
  const { g, noise, fx, out } = rack();
  g.connect(noise.id, 'out', fx.id, 'src');
  g.connect(fx.id, 'out', out.id, 'src');
  const fx2 = g.addNode('transform');
  g.connect(fx.id, 'out', fx2.id, 'src');
  assert.equal(g.connect(fx2.id, 'out', fx.id, 'src').ok, false, 'cycle rejected');
  g.connect(fx2.id, 'out', out.id, 'src');
  assert.equal(g.linkInto(out.id, 'src').from, fx2.id);
  assert.equal([...g.links.values()].filter((l) => l.to === out.id).length, 1);
});

test('topological order puts sources first', () => {
  const { g, track, noise, fx, out } = rack();
  g.connect(fx.id, 'out', out.id, 'src');
  g.connect(noise.id, 'out', fx.id, 'src');
  g.connect(track.id, 'bass', noise.id, 'warp');
  const o = g.order();
  assert.ok(o.indexOf(track.id) < o.indexOf(noise.id));
  assert.ok(o.indexOf(noise.id) < o.indexOf(fx.id));
  assert.ok(o.indexOf(fx.id) < o.indexOf(out.id));
  assert.deepEqual([...g.upstream([out.id])].sort(), [track.id, noise.id, fx.id, out.id].sort());
});

test('undo/redo and JSON round-trip', () => {
  const { g, noise, out } = rack();
  g.commit();
  g.connect(noise.id, 'out', out.id, 'src');
  g.setParam(noise.id, 'scale', 7);
  g.commit();
  g.undo();
  assert.equal(g.links.size, 0);
  assert.equal(g.nodes.get(noise.id).params.scale, getDef('noise').params.find((p) => p.name === 'scale').default);
  g.redo();
  assert.equal(g.links.size, 1);
  const copy = new Graph();
  copy.load(JSON.parse(JSON.stringify(g.toJSON())));
  assert.deepEqual(copy.toJSON(), g.toJSON());
  const fresh = copy.addNode('lfo');
  assert.ok(!g.nodes.has(fresh.id) || fresh.id !== noise.id, 'ids keep counting after load');
});

test('GLSL node: uniforms in the code become ports', () => {
  const def = customDef(`uniform sampler2D t_a;
uniform sampler2D t_prev;
uniform float p_amount; // 0 2 1.5
uniform float p_speed; // -1 1 0.2 integrate
uniform vec3 p_tint; // #ff0088
uniform int p_mode; // Soft | Hard
vec4 render(vec2 uv) { return texture(t_a, uv) * p_amount; }`);
  assert.deepEqual(def.inputs.map((i) => i.name), ['a']);
  assert.equal(def.feedback, true);
  assert.deepEqual(def.params.map((p) => [p.name, p.type ?? 'float']), [['amount', 'float'], ['speed', 'float'], ['tint', 'color'], ['mode', 'select']]);
  assert.equal(def.params[0].max, 2);
  assert.equal(def.params[1].integrate, true);
  assert.deepEqual(def.params[3].options, ['Soft', 'Hard']);
  const src = composeFragment(def);
  assert.equal((src.match(/uniform float p_amount;/g) || []).length, 1, 'declared once');
  assert.match(src, /uniform float p_speed_t;/);
});

test('forking a built-in keeps its interface', () => {
  const def = getDef('feedback');
  const forked = customDef(forkToCustom(def));
  assert.deepEqual(forked.inputs.map((i) => i.name), def.inputs.map((i) => i.name));
  assert.deepEqual(forked.params.map((p) => p.name), def.params.map((p) => p.name));
  assert.equal(forked.feedback, true);
});

test('changing GLSL code drops cables to ports that vanished', () => {
  const g = new Graph();
  const n = g.addNode('noise');
  const c = g.addNode('glsl');
  const t = g.addNode('track');
  g.connect(n.id, 'out', c.id, 'src');
  g.connect(t.id, 'kick', c.id, 'amount');
  g.setCode(c.id, 'uniform sampler2D t_src;\nvec4 render(vec2 uv) { return texture(t_src, uv); }');
  assert.ok(g.linkInto(c.id, 'src'));
  assert.equal(g.linkInto(c.id, 'amount'), null);
});
