// One way to resolve a reference, used by the compiler (documents, requirements), the text answers
// (show, impact, docs) and the tools that rewrite references. A reference is a node id (full, or its
// last segments when that is unique), node#interface, node~link, node:requirement, a Shape or
// Shape.field, a flow or a change. A bare name can be more than one of these; a kind in front
// ("flow:checkout") says which.
import type { DocRefType, Graph } from './types.js';

export interface RefIndex {
  nodeIds: string[];
  /** node#interface, full node id. */
  ifaces: Set<string>;
  /** node:requirement, full node id. */
  reqs: Set<string>;
  /** node~link to the edge id. */
  links: Map<string, string>;
  /** Shape id to its field names. */
  shapes: Map<string, string[]>;
  flows: Set<string>;
  changes: Set<string>;
}

export interface Resolved {
  type: DocRefType;
  /** The canonical reference: full node id, node#interface, node~link, node:requirement, Shape, flow or change id. */
  id: string;
  /** The node it belongs to, for nodes, interfaces, links and requirements. */
  node?: string;
  /** Other things the same bare name could mean, each written so that it resolves to exactly that. */
  also: string[];
}

export function refIndexOf(g: Graph): RefIndex {
  return {
    nodeIds: g.nodes.map((n) => n.id),
    ifaces: new Set(g.nodes.flatMap((n) => n.interfaces.map((i) => i.ref))),
    reqs: new Set(g.nodes.flatMap((n) => n.requirements.map((q) => q.ref))),
    links: new Map(g.edges.filter((e) => e.ref).map((e) => [e.ref as string, e.id])),
    shapes: new Map(g.shapes.map((s) => [s.id, s.fields.map((f) => f.name)])),
    flows: new Set(g.flows.map((f) => f.id)),
    changes: new Set(g.changes.map((c) => c.id)),
  };
}

/** A node by its full id, or by its last segments when exactly one node ends with them. */
export function findNode(ids: string[], ref: string): { id: string | null; candidates: string[] } {
  if (ids.includes(ref)) return { id: ref, candidates: [ref] };
  const hits = ids.filter((i) => i.endsWith(`.${ref}`));
  return { id: hits.length === 1 ? hits[0] : null, candidates: hits };
}

/** Why a node reference does not resolve: it names nothing, or more than one node. */
export function nodeProblem(ids: string[], ref: string): string {
  const { candidates } = findNode(ids, ref);
  return candidates.length > 1
    ? `"${ref}" could be ${candidates.slice(0, 4).join(' or ')}${candidates.length > 4 ? ', …' : ''}. Write the full id.`
    : `node "${ref}" does not exist.`;
}

/** The shortest way to write a node id that still names only that node. */
export function shortestNodeRef(ids: string[], id: string): string {
  const parts = id.split('.');
  for (let k = 1; k < parts.length; k++) {
    const tail = parts.slice(parts.length - k).join('.');
    if (!ids.includes(tail) && ids.filter((i) => i.endsWith(`.${tail}`)).length === 1) return tail;
  }
  return id;
}

const KINDS = ['node', 'shape', 'flow', 'change'] as const;

export function resolveRef(ix: RefIndex, text: string): Resolved | null {
  const node = (ref: string): string | null => findNode(ix.nodeIds, ref).id;
  const sub = (sep: string, set: { has(k: string): boolean }, type: DocRefType): Resolved | null => {
    const at = text.indexOf(sep);
    const nid = node(text.slice(0, at));
    const id = nid ? `${nid}${sep}${text.slice(at + 1)}` : '';
    return nid && set.has(id) ? { type, id, node: nid, also: [] } : null;
  };
  if (text.includes('#')) return sub('#', ix.ifaces, 'interface');
  if (text.includes('~')) return sub('~', ix.links, 'link');
  if (text.includes(':')) {
    const req = sub(':', ix.reqs, 'requirement');
    if (req) return req;
    // A kind in front picks one meaning of a name that has several.
    const at = text.indexOf(':');
    const kind = text.slice(0, at) as (typeof KINDS)[number];
    const name = text.slice(at + 1);
    if (!KINDS.includes(kind)) return null;
    if (kind === 'node') {
      const nid = node(name);
      return nid ? { type: 'node', id: nid, node: nid, also: [] } : null;
    }
    if (kind === 'shape') return shapeRef(ix, name);
    if (kind === 'flow') return ix.flows.has(name) ? { type: 'flow', id: name, also: [] } : null;
    return ix.changes.has(name) ? { type: 'change', id: name, also: [] } : null;
  }
  const found: Array<Resolved & { as: string }> = [];
  if (ix.nodeIds.includes(text)) found.push({ type: 'node', id: text, node: text, also: [], as: `node:${text}` });
  if (ix.shapes.has(text)) found.push({ type: 'shape', id: text, also: [], as: `shape:${text}` });
  if (ix.flows.has(text)) found.push({ type: 'flow', id: text, also: [], as: `flow:${text}` });
  if (ix.changes.has(text)) found.push({ type: 'change', id: text, also: [], as: `change:${text}` });
  if (!ix.nodeIds.includes(text)) {
    const nid = node(text);
    if (nid) found.push({ type: 'node', id: nid, node: nid, also: [], as: `node:${nid}` });
  }
  if (!found.length) return shapeRef(ix, text);
  const { as: _as, ...first } = found[0];
  return { ...first, also: found.slice(1).map((f) => f.as) };
}

/** A shape, or "Shape.field" for one of its fields. */
function shapeRef(ix: RefIndex, text: string): Resolved | null {
  if (ix.shapes.has(text)) return { type: 'shape', id: text, also: [] };
  const dot = text.indexOf('.');
  const fields = dot > 0 ? ix.shapes.get(text.slice(0, dot)) : undefined;
  return fields?.includes(text.slice(dot + 1)) ? { type: 'shape', id: text.slice(0, dot), also: [] } : null;
}
