// Applies the assistant's edit operations to the patch, validating each one and
// reporting back in words the model can act on.
import { getDef, inputPorts, outputPorts, isImage, isFloatParam } from '../nodes/index.js';
import { placeNodes } from '../graph/layout.js';

const list = (xs) => xs.join(', ') || '(none)';

export function coerce(def, name, value) {
  const p = def.params?.find((q) => q.name === name);
  if (!p) throw new Error(`${def.type} has no param "${name}" (params: ${list((def.params ?? []).map((q) => q.name))})`);
  if (p.type === 'select') {
    if (typeof value === 'number') return Math.max(0, Math.min(p.options.length - 1, Math.round(value)));
    const s = String(value).toLowerCase();
    let i = p.options.findIndex((o) => o.toLowerCase() === s);
    if (i < 0) i = p.options.findIndex((o) => o.toLowerCase().startsWith(s));
    if (i < 0) throw new Error(`${def.type}.${name} has no option "${value}" (options: ${list(p.options)})`);
    return i;
  }
  if (p.type === 'color') {
    let h = String(value).trim();
    if (/^#?[0-9a-f]{3}$/i.test(h)) h = '#' + h.replace('#', '').split('').map((c) => c + c).join('');
    if (!h.startsWith('#')) h = '#' + h;
    if (!/^#[0-9a-f]{6}$/i.test(h)) throw new Error(`${def.type}.${name} needs a colour like "#ff2a6d", got "${value}"`);
    return h.toLowerCase();
  }
  if (p.type === 'text') return String(value);
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error(`${def.type}.${name} needs a number, got "${value}"`);
  return Math.min(p.max, Math.max(p.min, v));
}

export function applyOps(graph, ops, { heightOf } = {}) {
  const refs = new Map();
  const added = [];
  const touched = new Set();
  const log = [];
  let cleared = false;

  const resolve = (x, what = 'node') => {
    if (x === undefined || x === null || x === '') throw new Error(`missing ${what}`);
    const id = refs.get(String(x)) ?? (graph.nodes.has(String(x)) ? String(x) : null);
    if (!id) throw new Error(`no node "${x}" (ids: ${list([...graph.nodes.keys(), ...refs.keys()])})`);
    return id;
  };
  const label = (id) => `${id} (${graph.nodes.get(id)?.type})`;

  const setValues = (id, params = {}, depth = {}) => {
    const node = graph.nodes.get(id);
    const def = graph.def(node);
    const notes = [];
    for (const [name, value] of Object.entries(params ?? {})) {
      try { graph.setParam(id, name, coerce(def, name, value)); } catch (e) { notes.push(e.message); }
    }
    for (const [name, value] of Object.entries(depth ?? {})) {
      const p = def.params?.find((q) => q.name === name);
      if (!p || !isFloatParam(p) || p.raw) { notes.push(`${def.type}.${name} takes no mod depth`); continue; }
      graph.setDepth(id, name, Math.max(-1, Math.min(1, Number(value) || 0)));
    }
    return notes;
  };

  const run = (op) => {
    switch (op.op) {
      case 'clear': {
        for (const n of [...graph.nodes.values()]) if (n.type !== 'output') graph.removeNode(n.id);
        if (!graph.outputNode()) graph.addNode('output');
        cleared = true;
        return 'cleared (Output kept)';
      }
      case 'add': {
        if (!getDef(op.type)) throw new Error(`unknown node type "${op.type}"`);
        if (op.type === 'output' && graph.outputNode()) throw new Error(`there is already an Output (${graph.outputNode().id})`);
        const node = graph.addNode(op.type, 0, 0);
        if (op.ref) refs.set(String(op.ref), node.id);
        added.push(node.id);
        touched.add(node.id);
        const notes = setValues(node.id, op.params, op.depth);
        return `added ${op.type} → ${node.id}${op.ref ? ` (ref ${op.ref})` : ''}${notes.length ? `; problems: ${notes.join('; ')}` : ''}`;
      }
      case 'remove': {
        const id = resolve(op.id);
        if (graph.nodes.get(id).type === 'output') throw new Error('keep the Output — disconnect it instead');
        graph.removeNode(id);
        return `removed ${id}`;
      }
      case 'set': {
        const id = resolve(op.id);
        touched.add(id);
        const notes = setValues(id, op.params, op.depth);
        if (notes.length) throw new Error(notes.join('; '));
        return `set ${label(id)}`;
      }
      case 'connect': {
        const from = resolve(op.from, 'from');
        const to = resolve(op.to, 'to');
        const fromDef = graph.def(graph.nodes.get(from));
        const toDef = graph.def(graph.nodes.get(to));
        const outs = outputPorts(fromDef);
        let fromPort = op.from_port || (outs.length === 1 ? outs[0].name : null);
        if (!fromPort) throw new Error(`say which output of ${label(from)} (outputs: ${list(outs.map((o) => o.name))})`);
        const kind = outs.find((o) => o.name === fromPort)?.kind;
        if (!kind) throw new Error(`${label(from)} has no output "${fromPort}" (outputs: ${list(outs.map((o) => o.name))})`);
        const ins = inputPorts(toDef).filter((p) => p.kind === kind);
        const toPort = op.to_port || (kind === 'image' ? (ins.find((p) => !graph.linkInto(to, p.name)) ?? ins[0])?.name : null);
        if (!toPort || !ins.some((p) => p.name === toPort)) {
          throw new Error(`${label(to)} has no ${kind === 'image' ? 'image input' : 'slider/dropdown'} "${toPort ?? ''}" (${kind} inputs: ${list(ins.map((p) => p.name))})`);
        }
        const replaced = graph.linkInto(to, toPort);
        const res = graph.connect(from, fromPort, to, toPort);
        if (!res.ok) throw new Error(res.reason);
        touched.add(to);
        if (op.mod_depth !== undefined) setValues(to, {}, { [toPort]: op.mod_depth });
        return `${from}.${fromPort} → ${to}.${toPort}${replaced ? ` (replaced the cable from ${replaced.from}.${replaced.fromPort})` : ''}`;
      }
      case 'disconnect': {
        const to = resolve(op.to, 'to');
        const l = graph.linkInto(to, op.to_port);
        if (!l) throw new Error(`nothing is plugged into ${to}.${op.to_port}`);
        graph.disconnect(l.id);
        return `unplugged ${l.from}.${l.fromPort} → ${to}.${op.to_port}`;
      }
      case 'code': {
        const id = resolve(op.id);
        if (graph.nodes.get(id).type !== 'glsl') throw new Error(`${label(id)} is not a glsl node`);
        if (typeof op.code !== 'string' || !/render\s*\(/.test(op.code)) throw new Error('code must define vec4 render(vec2 uv)');
        graph.setCode(id, op.code);
        touched.add(id);
        const ports = inputPorts(graph.def(graph.nodes.get(id))).map((p) => p.name);
        return `code set on ${id} (ports now: ${list(ports)})`;
      }
      default:
        throw new Error(`unknown op "${op.op}"`);
    }
  };

  (Array.isArray(ops) ? ops : []).forEach((op, i) => {
    try { log.push(`✓ ${run(op ?? {})}`); } catch (e) { log.push(`✗ #${i + 1} ${op?.op ?? '?'}: ${e.message}`); }
  });

  const place = cleared ? [...graph.nodes.keys()] : added.filter((id) => graph.nodes.has(id));
  if (place.length) placeNodes(graph, place, heightOf);
  return { log, added: added.filter((id) => graph.nodes.has(id)), touched: [...touched].filter((id) => graph.nodes.has(id)), cleared };
}

// The patch as the assistant sees it: ids, non-default params, cables with depths.
export function describePatch(graph, { selected = [] } = {}) {
  const lines = [];
  for (const n of graph.nodes.values()) {
    const def = graph.def(n);
    const vals = [];
    for (const p of def.params ?? []) {
      const v = n.params[p.name];
      if (v === p.default) continue;
      if (p.type === 'select') vals.push(`${p.name}=${p.options[v]}`);
      else if (typeof v === 'number') vals.push(`${p.name}=${+v.toFixed(3)}`);
      else vals.push(`${p.name}=${JSON.stringify(v)}`);
    }
    lines.push(`${n.id} ${n.type}${vals.length ? ' ' + vals.join(' ') : ''}${selected.includes(n.id) ? '  ← selected' : ''}`);
  }
  const cables = [...graph.links.values()].map((l) => {
    const to = graph.nodes.get(l.to);
    const p = graph.def(to).params?.find((q) => q.name === l.toPort);
    const d = p && isFloatParam(p) && !p.raw ? ` depth ${+(to.depth[l.toPort] ?? 0.5).toFixed(2)}` : '';
    return `${l.from}.${l.fromPort} → ${l.to}.${l.toPort}${d}`;
  });
  const rig = graph.rig ? `\nDJ rig: ${graph.rig.groups.map((g) => `${g.name} (${g.moves.map((m) => m.name).join(', ')})`).join('; ')}` : '';
  return `nodes:\n${lines.join('\n') || '(none)'}\ncables:\n${cables.join('\n') || '(none)'}${rig}`;
}

export { isImage };
