// The live DJ on a fake clock: what it asks, when moves land, and what happens
// when the answer is late, wrong or missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/graph/graph.js';
import { DJ } from '../src/dj/dj.js';
import { checkRig, MAX_MOVES } from '../src/dj/rig.js';
import { isDue, pickMove, questionsFor } from '../src/dj/choose.js';
import { PRESETS } from '../src/presets.js';

const BAR = 2; // seconds; 120 BPM
const sections = [
  { start: 0, end: 16, bar: 0, bars: 8, label: 'groove', energy: 0.6 },
  { start: 16, end: 24, bar: 8, bars: 4, label: 'breakdown', energy: 0.1 },
  { start: 24, end: 64, bar: 12, bars: 20, label: 'drop', energy: 0.9 },
];
function fakeTransport() {
  const t = {
    time: 0,
    playing: true,
    play() { this.playing = true; },
    reader: {
      period: BAR / 4,
      analysis: { bpm: 120 },
      beatPosition: (x) => x / (BAR / 4),
      barTime: (bar) => bar * BAR,
      energyAt: (x) => sections.find((s) => x >= s.start && x < s.end)?.energy ?? 0,
      features: (x) => ({ barIndex: Math.floor(x / BAR), energy: sections.find((s) => x >= s.start && x < s.end)?.energy ?? 0 }),
      sectionAtBar(bar) {
        const i = Math.max(0, sections.findLastIndex((s) => s.bar <= bar));
        const s = sections[i];
        return { ...s, into: bar - s.bar, left: s.bar + s.bars - bar, next: sections[i + 1] ?? null };
      },
    },
  };
  return t;
}
const tick = () => new Promise((r) => setImmediate(r));

function rigged(groups) {
  const g = new Graph();
  g.load({ nodes: [{ id: 'n1', type: 'track' }, { id: 'n2', type: 'plasma' }, { id: 'n3', type: 'merge' }, { id: 'n4', type: 'output' }], links: [
    { id: 'l1', from: 'n2', fromPort: 'out', to: 'n3', toPort: 'a' }, { id: 'l2', from: 'n3', fromPort: 'out', to: 'n4', toPort: 'src' },
  ] });
  const { rig, problems } = checkRig(g, { brief: 'test', groups });
  assert.deepEqual(problems, []);
  g.setRig(rig);
  return g;
}
const set = (scale, glide = 0) => ({ glide, ops: [{ op: 'set', id: 'n2', params: { scale } }] });
const LOOK = { name: 'look', question: 'Which?', every: 4, moves: [{ name: 'a', description: 'A', ...set(2) }, { name: 'b', description: 'B', ...set(6) }, { name: 'c', description: 'C', ...set(10) }] };

function setup(groups = [LOOK], answer = () => ({ answers: { look: { type: 'choice', choice: 'b', probabilities: { a: 0, b: 1, c: 0 } } }, usage: { cost: 0.0001 }, model: 'm' })) {
  const graph = rigged(groups);
  const transport = fakeTransport();
  const asked = [];
  const dj = new DJ({ graph, transport, random: () => 0.5, decide: async (body, signal) => { asked.push(body); return answer(body, signal); } });
  const at = async (time) => { transport.time = time; dj.tick(); await tick(); };
  return { graph, transport, dj, asked, at, scale: () => graph.nodes.get('n2').params.scale };
}

test('a rig is checked: names, sizes, and only moves that can run during a set', () => {
  const g = rigged([LOOK]);
  const bad = (groups) => checkRig(g, { groups }).problems.join('\n');
  assert.match(bad([]), /at least one group/);
  assert.match(checkRig(g, { groups: [LOOK] }).problems.join(), /needs a brief/);
  assert.match(bad([{ ...LOOK, moves: [LOOK.moves[0]] }]), /at least 2 moves/);
  assert.match(bad([{ ...LOOK, moves: Array.from({ length: MAX_MOVES + 1 }, (_, i) => ({ name: `m${i}`, description: 'x', ...set(2) })) }]), /at most 26 moves/);
  assert.match(bad([{ ...LOOK, moves: [LOOK.moves[0], { name: 'x', description: '', ...set(2) }] }]), /needs a description/);
  assert.match(bad([{ ...LOOK, moves: [LOOK.moves[0], { name: 'x', description: 'x', ops: [{ op: 'add', type: 'noise' }] }] }]), /only set, connect and disconnect/);
  assert.match(bad([{ ...LOOK, moves: [LOOK.moves[0], { name: 'x', description: 'x', ops: [{ op: 'set', id: 'n99', params: {} }] }] }]), /no node "n99"/);
  assert.match(bad([{ ...LOOK, moves: [LOOK.moves[0], { name: 'x', description: 'x', ops: [{ op: 'set', id: 'n2', params: { wibble: 1 } }] }] }]), /no param "wibble"/);
  assert.match(bad([{ ...LOOK, moves: [LOOK.moves[0], { name: 'x', description: 'x', ops: [{ op: 'connect', from: 'n1', from_port: 'kik', to: 'n2', to_port: 'scale' }] }] }]), /no output "kik"/);
  assert.equal(g.nodes.size, 4, 'checking touches nothing');
  assert.equal(g.links.size, 2, 'checking touches nothing');
});

test('moves that set different knobs are pointed out, and values are tidied', () => {
  const g = rigged([LOOK]);
  const { rig, notes, problems } = checkRig(g, { brief: 'test', groups: [{ ...LOOK, every: 7, moves: [
    { name: 'a', description: 'A', ops: [{ op: 'set', id: 'n2', params: { scale: 99, palette: 'fire' } }] },
    { name: 'b', description: 'B', ops: [{ op: 'set', id: 'n2', params: { warp: 1 } }] },
  ] }] });
  assert.deepEqual(problems, []);
  assert.equal(rig.groups[0].every, 8);
  assert.equal(rig.groups[0].moves[0].ops[0].params.scale, 12, 'clamped');
  assert.equal(rig.groups[0].moves[0].ops[0].params.palette, 2, 'by name');
  assert.match(notes.join('\n'), /look\/a leaves n2\.warp/);
});

test('the built-in rig fits its patch', () => {
  const g = new Graph();
  g.load(structuredClone(PRESETS.find((p) => p.name === 'DJ rig').patch));
  const { problems, notes } = checkRig(g, g.rig);
  assert.deepEqual(problems, []);
  assert.deepEqual(notes, []);
});

test('the rig is saved with the patch and follows undo', () => {
  const g = rigged([LOOK]);
  g.commit();
  const again = new Graph();
  again.load(JSON.parse(JSON.stringify(g.toJSON())));
  assert.equal(again.rig.groups[0].name, 'look');
  g.setRig(null);
  g.commit();
  g.undo();
  assert.equal(g.rig.groups[0].name, 'look');
});

test('questions: a choice with the descriptions, or an ordered score', () => {
  const q = questionsFor([LOOK, { ...LOOK, name: 'heat', ordered: true }]);
  assert.deepEqual(q.look.criteria, { a: 'A', b: 'B', c: 'C' });
  assert.equal(q.look.type, 'choice');
  assert.equal(q.heat.type, 'score');
  assert.deepEqual(q.heat.criteria, ['a: A', 'b: B', 'c: C']);
});

test('a group is due on its phrase, counted from the section start', () => {
  const g = { every: 8, on_section: false };
  assert.ok(isDue(g, 12, { bar: 12 }));
  assert.ok(isDue(g, 20, { bar: 12 }));
  assert.ok(!isDue(g, 16, { bar: 12 }));
  assert.ok(isDue({ every: 16, on_section: true }, 12, { bar: 12 }));
  assert.ok(!isDue({ every: 16, on_section: true }, 13, { bar: 12 }));
});

test('choices follow the odds, a worn-out move loses to the others, recent moves are held back', () => {
  const answer = { probabilities: { a: 0.6, b: 0.3, c: 0.1 } };
  const count = (opts) => {
    const n = {};
    for (let i = 0; i < 4000; i++) {
      const r = pickMove(LOOK, answer, { current: 'a', ...opts, random: () => i / 4000 });
      const k = r.move?.name ?? 'stay';
      n[k] = (n[k] ?? 0) + 1;
    }
    return n;
  };
  const fresh = count({ heldBars: 0 });
  assert.ok(fresh.stay > fresh.b && fresh.b > fresh.c, JSON.stringify(fresh));
  const worn = count({ heldBars: 32 });
  assert.ok(worn.stay < fresh.stay / 3, `${JSON.stringify(worn)} vs ${JSON.stringify(fresh)}`);
  const held = count({ heldBars: 32, recent: ['b'] });
  assert.ok(held.b < worn.b * 0.8, `${JSON.stringify(held)} vs ${JSON.stringify(worn)}`);
});

test('an ordered group follows the score, and does not twitch around a boundary', () => {
  const G = { ...LOOK, ordered: true };
  assert.equal(pickMove(G, { score: 2.1 }, { current: 'a' }).move.name, 'c');
  assert.equal(pickMove(G, { score: 1.6 }, { current: 'b' }).move, null, 'close to where it is');
  assert.equal(pickMove(G, { score: 1.9 }, { current: 'b' }).move.name, 'c');
  assert.equal(pickMove(G, { score: NaN }, { current: 'b' }).move, null);
});

test('moves land on the next downbeat, not when the answer arrives', async () => {
  const { dj, at, asked, scale } = setup();
  dj.start();
  assert.equal(scale(), 2, 'starts on home');
  await at(0.02);
  await at(2.02); // bar 1: nothing due at bar 2
  assert.equal(asked.length, 0);
  await at(6.01); // bar 3: bar 4 is a phrase start
  assert.equal(asked.length, 1);
  assert.equal(asked[0].state.music.bars_left_in_section, 4);
  assert.equal(asked[0].state.music.section, 'groove');
  assert.equal(asked[0].state.direction, 'test');
  assert.equal(asked[0].state.playing_now.look, 'a');
  assert.equal(dj.pending.get('look').move.name, 'b', 'answered, waiting for the downbeat');
  assert.equal(scale(), 2);
  await at(7.9);
  assert.equal(scale(), 2);
  await at(8.01);
  assert.equal(scale(), 6);
  assert.equal(dj.log.at(-1).move, 'b');
  assert.ok(Math.abs(dj.log.at(-1).beat - 0.02) < 1e-9);
  assert.ok(Math.abs(dj.stats.cost - 0.0001) < 1e-12);
});

test('a new section brings on_section groups forward', async () => {
  const { dj, at, asked } = setup([{ ...LOOK, every: 32, on_section: true }]);
  dj.start();
  await at(14.01); // bar 7: the breakdown starts at bar 8
  assert.equal(asked.length, 1);
  assert.equal(asked[0].state.music.section, 'breakdown');
  assert.equal(asked[0].state.music.bars_into_section, 0);
  assert.equal(asked[0].state.music.next_section, 'drop');
});

// A live source: no sections and no future, and it fails loudly if the DJ goes looking for them.
function liveSetup(groups, answer) {
  const music = { kick: true };
  const beat = BAR / 4;
  const transport = {
    time: 0,
    playing: true,
    play() {},
    reader: {
      period: beat,
      analysis: { bpm: 120, live: true, unscaled: () => (music.kick ? 0.5 : 0.1) },
      beatPosition: (x) => x / beat,
      barTime: (bar) => bar * BAR,
      energyAt() { throw new Error('a live input has no energy to look up'); },
      sectionAtBar() { throw new Error('a live input has no sections'); },
      features(x) {
        const pos = x / beat, phase = pos % 1, v = music.kick ? 0.7 : 0.2;
        return { level: v, bass: v, lowmid: v, mid: v, high: v, treble: v, kick: music.kick && phase < 0.5 ? 1 : 0, snare: 0, hat: phase > 0.5 ? 1 : 0, energy: 0.5, beatPos: pos, barIndex: Math.floor(pos / 4) };
      },
    },
  };
  const graph = rigged(groups);
  const asked = [];
  const dj = new DJ({ graph, transport, random: () => 0.5, decide: async (body, signal) => { asked.push({ at: transport.time, ...body }); return answer(body, signal); } });
  const run = async (until) => {
    for (; transport.time < until; transport.time += 0.02) { dj.tick(); await tick(); }
  };
  return { graph, transport, dj, asked, run, music, scale: () => graph.nodes.get('n2').params.scale };
}
const pickB = () => ({ answers: { look: { type: 'choice', choice: 'b', probabilities: { a: 0, b: 1, c: 0 } } }, usage: { cost: 0.0001 }, model: 'm' });
const SLOW = { ...LOOK, every: 64, on_section: true, moves: LOOK.moves.map((m) => ({ ...m, glide: 4 })) };

test('live: it hears a change, asks at once and lands on the next beat, fast', async () => {
  const { dj, run, music, asked, scale } = liveSetup([SLOW], pickB);
  await run(16);          // it listens before anyone presses Start
  dj.start();
  await run(20);
  assert.equal(asked.length, 0);
  music.kick = false;     // gone at 20.0 s, a downbeat
  await run(22);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].at < 21.5, `asked ${(asked[0].at - 20).toFixed(2)} s after the change`);
  const { music: told } = asked[0].state;
  assert.equal(told.section, 'breakdown');
  assert.equal(told.just_changed, 'kick dropped out');
  for (const key of ['next_section', 'bars_left_in_section', 'energy_in_4_bars']) assert.ok(!(key in told), key);
  const landed = dj.log.at(-1);
  assert.equal(landed.move, 'b');
  assert.equal(Math.abs(landed.beat % 1 - Math.round(landed.beat % 1)) < 0.1, true, 'on a beat');
  assert.notEqual(Math.round(landed.beat) % 4, 0, 'and not held back for the downbeat');
  await run(22.6);
  assert.equal(scale(), 6); // half a bar, though the move's own glide is four
});

test('live: a group not marked on_section keeps its own pace', async () => {
  const { dj, run, music, asked } = liveSetup([{ ...SLOW, on_section: false }], pickB);
  await run(16);
  dj.start();
  await run(20);
  music.kick = false;
  await run(24);
  assert.equal(asked.length, 0);
});

test('live: what was planned before the change is dropped, your own pick is not', async () => {
  const { dj, run, music } = liveSetup([SLOW], pickB);
  await run(16);
  dj.start();
  await run(20);
  dj.pending.set('look', { move: dj.rig.groups[0].moves[2], by: 'dj' });
  music.kick = false;
  await run(21);
  assert.notEqual(dj.pending.get('look')?.move.name, 'c');
  const you = liveSetup([SLOW], pickB);
  await you.run(16);
  you.dj.start();
  await you.run(20.2);
  you.dj.queue('look', 'c');
  you.music.kick = false;
  await you.run(21);
  assert.equal(you.dj.pending.get('look')?.move.name, 'c');
});

test('live: the bar ask does not cancel an answer to a change that is on its way', async () => {
  let release;
  const held = () => new Promise((r) => { release = r; });
  const { dj, run, music, asked } = liveSetup([{ ...SLOW, every: 1 }], (body) => (body.state.music.just_changed ? held() : pickB()));
  await run(16);
  dj.start();
  await run(20.2);        // past the bar's own ask
  const before = asked.length;
  music.kick = false;
  await run(21.8);
  assert.equal(asked.length, before + 1);
  await run(22.2);          // a downbeat passes, and this group is due every bar
  assert.equal(asked.length, before + 1);
  release(pickB());
  await run(23);
  assert.equal(dj.log.at(-1).move, 'b');
  assert.equal(dj.stats.late, 0);
});

test('live: a set started long into the Clock holds its moves from the start, not from bar zero', async () => {
  const { dj, run, transport } = liveSetup([LOOK], pickB);
  transport.time = 200;
  await run(204);
  dj.start();
  assert.equal(dj.changedAt.get('look'), 102);
});

test('daring: the middle changes nothing, careful holds and asks less, daring the other way round', () => {
  const g = { every: 8, on_section: false };
  for (let bar = 0; bar < 64; bar++) assert.equal(isDue(g, bar, { bar: 0 }, 0.5), isDue(g, bar, { bar: 0 }));
  assert.ok(!isDue(g, 8, { bar: 0 }, 0) && isDue(g, 16, { bar: 0 }, 0));
  assert.ok(isDue(g, 4, { bar: 0 }, 1));
  assert.ok(isDue({ every: 1 }, 3, { bar: 0 }, 1)); // never less than a bar
});

test('daring: long shots come up as the knob turns, and the favourite wins when it is down', () => {
  const group = { every: 8, moves: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
  const answer = { probabilities: { a: 0.08, b: 0.9, c: 0.02 } };
  const share = (daring) => {
    let other = 0, n = 2000;
    for (let i = 0; i < n; i++) {
      const { move } = pickMove(group, answer, { current: 'b', heldBars: 0, random: () => (i + 0.5) / n, daring });
      if (move) other++;
    }
    return other / n;
  };
  const low = share(0), mid = share(0.5), high = share(1);
  assert.ok(low < 0.001, `careful: ${low}`);
  assert.ok(mid > 0.02 && mid < 0.1, `middle: ${mid}`);
  assert.ok(high > 0.2, `daring: ${high}`);
});

test('daring: an ordered group moves on a smaller nudge, and a careful one waits for a big one', () => {
  const group = { ordered: true, every: 4, moves: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }] };
  const at = (daring, score) => pickMove(group, { score }, { current: 'b', daring }).move?.name ?? null;
  assert.equal(at(0.5, 1.5), null);
  assert.equal(at(1, 1.6), 'c');
  assert.equal(at(0, 2.2), null);
  assert.equal(at(0, 2.7), 'd');
});

test('a late answer changes nothing', async () => {
  let release;
  const { dj, at, scale } = setup([LOOK], () => new Promise((r) => { release = r; }));
  dj.start();
  await at(6.01);
  await at(8.01); // the downbeat passed without an answer
  release({ answers: { look: { probabilities: { a: 0, b: 1, c: 0 } } } });
  await tick();
  await at(9);
  assert.equal(scale(), 2);
  assert.equal(dj.stats.late, 1);
  assert.equal(dj.pending.size, 0);
});

test('it does not ask for a downbeat it cannot reach', async () => {
  const { dj, at, asked } = setup();
  dj.start();
  await at(7.9); // a seek lands at the very end of the bar before a phrase
  assert.equal(asked.length, 0);
  await at(14.01);
  assert.equal(asked.length, 1);
});

test('failures change nothing and the picture carries on; key and credit errors stop the DJ', async () => {
  let status = 529;
  const { dj, at, scale } = setup([LOOK], () => Promise.reject(Object.assign(new Error('overloaded'), { status })));
  dj.start();
  await at(6.01);
  await at(8.01);
  assert.equal(scale(), 2);
  assert.ok(dj.running);
  assert.equal(dj.stats.fails, 1);
  assert.equal(dj.message, 'overloaded');
  status = 402;
  await at(14.01);
  assert.ok(!dj.running);
  assert.match(dj.message, /overloaded/);
});

test('after repeated failures it asks less often', async () => {
  const { dj, at, asked } = setup([{ ...LOOK, every: 1 }], () => Promise.reject(new Error('down')));
  dj.start();
  for (let b = 0; b < 16; b++) await at(b * BAR + 0.01);
  assert.ok(asked.length < 8, `${asked.length} requests in 16 bars`);
  assert.ok(asked.length >= 4);
});

test('a seek throws away what was waiting', async () => {
  const { dj, at, scale } = setup();
  dj.start();
  await at(6.01);
  assert.ok(dj.pending.size);
  const waiting = dj.pending.get('look');
  await at(30.01);
  assert.notEqual(dj.pending.get('look'), waiting);
  assert.equal(scale(), 2);
});

test('your own pick wins over the model, and lands on the downbeat', async () => {
  const { dj, at, scale } = setup();
  dj.start();
  dj.queue('look', 'c');
  assert.equal(scale(), 2);
  await at(6.01); // bar 3, would ask for bar 4
  assert.equal(scale(), 10);
  assert.equal(dj.log.at(-1).by, 'you');
});

test('with the DJ stopped a pad plays at once', () => {
  const { dj, scale } = setup();
  dj.queue('look', 'c');
  assert.equal(scale(), 10);
  assert.ok(!dj.running);
});

test('glides follow the beat, finish exactly, and stop when the track does', async () => {
  const { dj, at, transport, scale } = setup([{ ...LOOK, moves: [{ name: 'a', description: 'A', ...set(2) }, { name: 'b', description: 'B', ...set(10, 2) }] }]);
  dj.start();
  await at(8);
  dj.fire(dj.group('look'), dj.group('look').moves[1]);
  await at(10); // a quarter of the way (2 of 8 beats... of 2 bars = 4 s)
  const part = scale();
  assert.ok(part > 2 && part < 10, `${part}`);
  transport.playing = false;
  await at(10); // paused: same place
  assert.equal(scale(), part);
  transport.playing = true;
  await at(12);
  assert.equal(scale(), 10);
  assert.equal(dj.glides.size, 0);
});

test('colours and whole numbers glide too; dropdowns switch', async () => {
  const g = rigged([LOOK]);
  const transport = fakeTransport();
  const dj = new DJ({ graph: g, transport, decide: async () => ({}) });
  g.nodes.get('n2').params.palette = 0;
  dj.glideTo('n2', 'params', 'palette', 3, 0, 8);
  assert.equal(g.nodes.get('n2').params.palette, 3);
  const n = g.addNode('lasers');
  n.params.count = 2;
  n.params.colorA = '#000000';
  dj.glideTo(n.id, 'params', 'count', 12, 0, 8);
  dj.glideTo(n.id, 'params', 'colorA', '#ffffff', 0, 8);
  dj.stepGlides(4);
  assert.equal(n.params.count, 7);
  assert.equal(n.params.colorA, '#808080');
  dj.stepGlides(8);
  assert.equal(n.params.count, 12);
  assert.equal(n.params.colorA, '#ffffff');
});

test('moves can change cables, without touching the undo history', async () => {
  const groups = [{ ...LOOK, moves: [
    { name: 'kick', description: 'Kick', glide: 0, ops: [{ op: 'connect', from: 'n1', from_port: 'kick', to: 'n2', to_port: 'scale', mod_depth: 0.3 }] },
    { name: 'hat', description: 'Hat', glide: 0, ops: [{ op: 'connect', from: 'n1', from_port: 'hat', to: 'n2', to_port: 'scale' }] },
    { name: 'none', description: 'None', glide: 0, ops: [{ op: 'disconnect', to: 'n2', to_port: 'scale' }] },
  ] }];
  const { dj, graph } = setup(groups);
  graph.commit();
  const undo = graph.history.length;
  dj.start();
  assert.equal(graph.linkInto('n2', 'scale').fromPort, 'kick');
  dj.queue('look', 'hat');
  dj.stop();
  dj.queue('look', 'hat');
  assert.equal(graph.linkInto('n2', 'scale').fromPort, 'hat');
  assert.equal(graph.links.size, 3);
  dj.queue('look', 'none');
  dj.queue('look', 'none'); // nothing to unplug: fine
  assert.equal(graph.linkInto('n2', 'scale'), null);
  assert.equal(graph.history.length, undo + 1, 'one step: stopping');
});

test('a black picture during the music goes home; one in a quiet passage is left alone', async () => {
  const { dj, at, scale } = setup();
  dj.start();
  dj.current.set('look', 'c');
  dj.picture = { brightness: 0.001, saturation: 0, motion: 0 };
  await at(0.01);
  assert.equal(dj.pending.size, 0, 'one bar could be a flash');
  await at(2.01);
  assert.equal(dj.pending.get('look')?.by, 'safety');
  await at(4.01);
  assert.equal(scale(), 2);
  assert.equal(dj.log.at(-1).by, 'safety');

  const quiet = setup();
  quiet.dj.start();
  quiet.dj.current.set('look', 'c');
  quiet.dj.picture = { brightness: 0.001, saturation: 0, motion: 0 };
  for (const t of [16.01, 18.01, 20.01, 22.01]) await quiet.at(t); // the breakdown, energy 0.1
  assert.equal(quiet.dj.log.filter((l) => l.by === 'safety').length, 0);
});

test('white-out counts as blank, a bright colourful picture does not', async () => {
  for (const [picture, expected] of [[{ brightness: 0.95, saturation: 0.05, motion: 0 }, true], [{ brightness: 0.95, saturation: 0.7, motion: 0 }, false]]) {
    const { dj, at } = setup();
    dj.start();
    dj.current.set('look', 'c');
    dj.picture = picture;
    await at(0.01);
    await at(2.01);
    assert.equal(dj.pending.get('look')?.by === 'safety', expected);
  }
});

test('it refuses to start without a track, a rig, or when the rig no longer fits', () => {
  const a = setup();
  a.transport.reader = null;
  assert.equal(a.dj.start(), false);
  assert.match(a.dj.message, /Load a track/);
  const b = setup();
  b.graph.setRig(null);
  assert.equal(b.dj.start(), false);
  const c = setup();
  c.graph.removeNode('n2');
  assert.equal(c.dj.start(), false);
  assert.match(c.dj.message, /no longer fits/);
});

test('loading another patch stops the DJ', () => {
  const { dj, graph } = setup();
  dj.start();
  graph.load({ nodes: [], links: [] });
  assert.ok(!dj.running);
});
