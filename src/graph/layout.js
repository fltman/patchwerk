// Places nodes in columns by how far downstream they sit: sources left, Output right.
import { defFor, inputPorts, outputPorts, isImage } from '../nodes/index.js';

export const COL = 280;
const X0 = 40, Y0 = 40, GAP = 34;

export function estimateHeight(graph, id) {
  const node = graph.nodes.get(id);
  const def = defFor(node);
  const rows = (def.inputs?.length ?? 0) + (def.params?.length ?? 0);
  const patched = inputPorts(def).filter((p) => p.kind === 'float' && !p.param?.raw && p.param?.type !== 'select' && graph.linkInto(id, p.name)).length;
  const outs = outputPorts(def).filter((p) => p.kind === 'float').length;
  const thumb = isImage(def) && def.category !== 'output' ? 125 : 0;
  return 40 + rows * 22 + patched * 17 + outs * 22 + thumb;
}

/** Give `ids` positions; other nodes stay where they are. */
export function placeNodes(graph, ids, heightOf = (id) => estimateHeight(graph, id)) {
  const fresh = new Set(ids);
  const order = graph.order();
  const depth = new Map();
  for (const id of order) {
    let d = 0;
    for (const l of graph.links.values()) if (l.to === id) d = Math.max(d, (depth.get(l.from) ?? 0) + 1);
    depth.set(id, d);
  }
  const out = graph.outputNode();
  if (out && fresh.has(out.id)) depth.set(out.id, Math.max(...depth.values()));

  const bottom = new Map();
  for (const n of graph.nodes.values()) {
    if (fresh.has(n.id) || n === out) continue; // the Output gets moved after, if it's in the way
    const c = Math.round((n.x - X0) / COL);
    bottom.set(c, Math.max(bottom.get(c) ?? Y0, n.y + heightOf(n.id) + GAP));
  }
  for (const id of order) {
    if (!fresh.has(id)) continue;
    const c = depth.get(id);
    const y = bottom.get(c) ?? Y0;
    graph.moveNode(id, X0 + c * COL, y);
    bottom.set(c, y + estimateHeight(graph, id) + GAP);
  }
  flowRight(graph, heightOf);
}

/** Every node sits at least one column right of the nodes that feed it, so cables run left → right. */
export function flowRight(graph, heightOf = (id) => estimateHeight(graph, id)) {
  for (const id of graph.order()) {
    const n = graph.nodes.get(id);
    const feeders = [...graph.links.values()].filter((l) => l.to === id).map((l) => graph.nodes.get(l.from));
    if (!feeders.length) continue;
    const x = Math.max(...feeders.map((f) => f.x)) + COL;
    if (n.x >= x) continue;
    const h = heightOf(id);
    const column = [...graph.nodes.values()].filter((o) => o !== n && Math.abs(o.x - x) < COL / 2);
    const clash = (y) => column.some((o) => y < o.y + heightOf(o.id) + GAP && y + h + GAP > o.y);
    // stay level with the main feeder if there's room, else go below the column
    let y = graph.nodes.get(graph.linkInto(id, 'src')?.from)?.y ?? n.y;
    if (clash(y)) y = clash(n.y) ? Math.max(Y0, ...column.map((o) => o.y + heightOf(o.id) + GAP)) : n.y;
    graph.moveNode(id, x, y);
  }
}
