// A rig is a patch made to be performed. The assistant builds it and lists the
// moves; the live DJ only ever picks one of those moves. Moves change knobs and
// cables on nodes that already exist, so nothing compiles during a set and the DJ
// can't break the patch.
//
//   { brief, groups: [{ name, question, every, on_section, ordered,
//                       moves: [{ name, description, glide, ops: [...] }] }] }
//
// The first move of a group is its home: a state known to look right. ops are
// edit_patch operations, limited to set, connect and disconnect.
import { Graph } from '../graph/graph.js';
import { applyOps, coerce } from '../ai/ops.js';

export const MAX_GROUPS = 8;
export const MAX_MOVES = 26; // some decision models refuse longer choices
const EVERY = [1, 2, 4, 8, 16, 32];
const NAME = /^[a-z0-9_]{1,32}$/i;

const clone = (graph) => { const g = new Graph(); g.load(graph.toJSON()); return g; };

function checkMove(graph, group, m, seen, problems) {
  const where = `${group.name}/${m?.name}`;
  if (!NAME.test(m?.name ?? '')) problems.push(`${group.name}: a move needs a name of letters, digits and _ (got "${m?.name}")`);
  else if (seen.has(m.name)) problems.push(`${where}: two moves have this name`);
  seen.add(m?.name);
  if (typeof m?.description !== 'string' || !m.description.trim()) problems.push(`${where}: needs a description, it is all the DJ gets to read`);
  const ops = Array.isArray(m?.ops) ? m.ops : [];
  if (!ops.length) problems.push(`${where}: has no ops`);

  const out = [];
  ops.forEach((op, i) => {
    const at = `${where} op ${i + 1}`;
    if (!['set', 'connect', 'disconnect'].includes(op?.op)) { problems.push(`${at}: only set, connect and disconnect can run during a set (got "${op?.op}")`); return; }
    if (op.op === 'set') {
      const node = graph.nodes.get(String(op.id));
      if (!node) { problems.push(`${at}: no node "${op.id}"`); return; }
      const def = graph.def(node);
      const params = {};
      for (const [name, value] of Object.entries(op.params ?? {})) {
        try { params[name] = coerce(def, name, value); } catch (e) { problems.push(`${at}: ${e.message}`); }
      }
      const depth = {};
      for (const [name, value] of Object.entries(op.depth ?? {})) {
        if (!def.params?.some((q) => q.name === name)) problems.push(`${at}: ${def.type} has no param "${name}"`);
        else depth[name] = Math.max(-1, Math.min(1, Number(value) || 0));
      }
      out.push({ op: 'set', id: node.id, params, depth });
    } else if (op.op === 'connect') {
      // a trial run on a copy says everything a real one would
      const [line] = applyOps(clone(graph), [op]).log;
      if (line.startsWith('✗')) problems.push(`${at}: ${line.replace(/^✗ #\d+ connect: /, '')}`);
      out.push({ ...op });
    } else {
      if (!graph.nodes.has(String(op.to))) problems.push(`${at}: no node "${op.to}"`);
      out.push({ op: 'disconnect', to: op.to, to_port: op.to_port });
    }
  });
  const glide = Number.isFinite(m?.glide) ? Math.max(0, Math.min(16, m.glide)) : 1;
  return { name: m?.name, description: String(m?.description ?? '').trim(), glide, ops: out };
}

// What each move writes, as a set of "node.param" strings.
function knobs(move) {
  const out = new Set();
  for (const op of move.ops) {
    if (op.op === 'set') for (const k of [...Object.keys(op.params), ...Object.keys(op.depth).map((d) => `${d} depth`)]) out.add(`${op.id}.${k}`);
    else out.add(`${op.to}.${op.to_port} cable`);
  }
  return out;
}

// Returns the rig with values tidied, `problems` that block it, and `notes` that don't.
export function checkRig(graph, raw) {
  const problems = [], notes = [];
  const groups = Array.isArray(raw?.groups) ? raw.groups : [];
  if (!groups.length) problems.push('a rig needs at least one group');
  if (typeof raw?.brief !== 'string' || !raw.brief.trim()) problems.push('a rig needs a brief: one or two sentences on how to play it');
  if (groups.length > MAX_GROUPS) problems.push(`at most ${MAX_GROUPS} groups`);
  const names = new Set();
  const tidy = groups.map((g) => {
    if (!NAME.test(g?.name ?? '')) problems.push(`a group needs a name of letters, digits and _ (got "${g?.name}")`);
    else if (names.has(g.name)) problems.push(`${g.name}: two groups have this name`);
    names.add(g?.name);
    if (typeof g?.question !== 'string' || !g.question.trim()) problems.push(`${g?.name}: needs a question for the DJ`);
    const list = Array.isArray(g?.moves) ? g.moves : [];
    if (list.length < 2) problems.push(`${g?.name}: needs at least 2 moves, or there is nothing to decide`);
    if (list.length > MAX_MOVES) problems.push(`${g?.name}: at most ${MAX_MOVES} moves`);
    const seen = new Set();
    const group = {
      name: g?.name,
      question: String(g?.question ?? '').trim(),
      every: EVERY.includes(g?.every) ? g.every : 8,
      on_section: !!g?.on_section,
      ordered: !!g?.ordered,
      moves: [],
    };
    group.moves = list.map((m) => checkMove(graph, group, m, seen, problems));
    const sets = group.moves.map(knobs);
    const all = new Set(sets.flatMap((s) => [...s]));
    group.moves.forEach((m, i) => {
      const missing = [...all].filter((k) => !sets[i].has(k));
      if (missing.length) notes.push(`${group.name}/${m.name} leaves ${missing.join(', ')} as the previous move left them`);
    });
    return group;
  });
  return { rig: { brief: String(raw?.brief ?? '').trim(), groups: tidy }, problems, notes };
}
