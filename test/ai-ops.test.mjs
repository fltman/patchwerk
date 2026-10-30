import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/graph/graph.js';
import { applyOps, describePatch } from '../src/ai/ops.js';
import { systemPrompt } from '../src/ai/catalog.js';
import { allNodes } from '../src/nodes/index.js';

const fresh = () => { const g = new Graph(); g.addNode('output'); return g; };

test('builds a patch from refs, with dropdowns by name and depths', () => {
  const g = fresh();
  const { log } = applyOps(g, [
    { op: 'add', type: 'track', ref: 't' },
    { op: 'add', type: 'tunnel', ref: 'tun', params: { shape: 'hexagon', speed: 1.2, colorA: '#f0a' }, depth: { speed: 0.3 } },
    { op: 'add', type: 'bloom', ref: 'b' },
    { op: 'connect', from: 't', from_port: 'bass', to: 'tun', to_port: 'speed' },
    { op: 'connect', from: 't', from_port: 'kick', to: 'tun', to_port: 'glow', mod_depth: 0.8 },
    { op: 'connect', from: 'tun', to: 'b' },
    { op: 'connect', from: 'b', to: g.outputNode().id },
  ]);
  assert.ok(log.every((l) => l.startsWith('✓')), log.join('\n'));
  const tun = [...g.nodes.values()].find((n) => n.type === 'tunnel');
  assert.equal(tun.params.shape, 2);
  assert.equal(tun.params.colorA, '#ff00aa');
  assert.equal(tun.depth.speed, 0.3);
  assert.equal(tun.depth.glow, 0.8);
  assert.equal(g.links.size, 4);
  // laid out left → right
  const x = (type) => [...g.nodes.values()].find((n) => n.type === type).x;
  assert.ok(x('track') < x('tunnel') && x('tunnel') < x('bloom') && x('bloom') <= x('output'));
});

test('mistakes come back as explanations, and the rest still applies', () => {
  const g = fresh();
  const { log } = applyOps(g, [
    { op: 'add', type: 'tunnell', ref: 'x' },
    { op: 'add', type: 'noise', ref: 'n', params: { scale: 99, wibble: 1 } },
    { op: 'add', type: 'track', ref: 't' },
    { op: 'connect', from: 't', from_port: 'kik', to: 'n', to_port: 'scale' },
    { op: 'connect', from: 't', from_port: 'kick', to: 'n', to_port: 'src' },
    { op: 'connect', from: 'n', to: g.outputNode().id },
    { op: 'remove', id: g.outputNode().id },
  ]);
  assert.match(log[0], /✗.*unknown node type "tunnell"/);
  assert.match(log[1], /✓.*wibble/);
  assert.equal([...g.nodes.values()].find((n) => n.type === 'noise').params.scale, 20, 'clamped to max');
  assert.match(log[3], /no output "kik" \(outputs: level, bass/);
  assert.match(log[4], /no slider\/dropdown "src"/);
  assert.match(log[5], /^✓/);
  assert.match(log[6], /keep the Output/);
});

test('clear keeps the Output and re-lays out everything', () => {
  const g = fresh();
  applyOps(g, [{ op: 'add', type: 'noise' }, { op: 'add', type: 'lfo' }]);
  const { log } = applyOps(g, [{ op: 'clear' }, { op: 'add', type: 'plasma', ref: 'p' }, { op: 'connect', from: 'p', to: g.outputNode().id }]);
  assert.ok(log.every((l) => l.startsWith('✓')), log.join('\n'));
  assert.deepEqual([...g.nodes.values()].map((n) => n.type).sort(), ['output', 'plasma']);
});

test('glsl code op reshapes the node', () => {
  const g = fresh();
  const { log } = applyOps(g, [
    { op: 'add', type: 'glsl', ref: 'c' },
    { op: 'code', id: 'c', code: 'uniform float p_pulse; // 0 1 0\nvec4 render(vec2 uv) { return vec4(vec3(p_pulse), 1.0); }' },
    { op: 'add', type: 'track', ref: 't' },
    { op: 'connect', from: 't', from_port: 'kick', to: 'c', to_port: 'pulse', mod_depth: 1 },
  ]);
  assert.ok(log.every((l) => l.startsWith('✓')), log.join('\n'));
});

test('describePatch shows ids, changed params and cables', () => {
  const g = fresh();
  applyOps(g, [{ op: 'add', type: 'track', ref: 't' }, { op: 'add', type: 'tunnel', ref: 'u', params: { shape: 'Square' } }, { op: 'connect', from: 't', from_port: 'kick', to: 'u', to_port: 'glow', mod_depth: 0.7 }]);
  const s = describePatch(g);
  assert.match(s, /tunnel shape=Square/);
  assert.match(s, /\.kick → n\d+\.glow depth 0\.7/);
});

test('the system prompt lists every node type', () => {
  const s = systemPrompt();
  for (const d of allNodes) assert.ok(s.includes(`\n${d.type} — `), d.type);
});
