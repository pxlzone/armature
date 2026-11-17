// Turns the full graph into what one screen shows: visible nodes (some expanded into
// containers), edges lifted to the deepest visible ends, and a nested layout.
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Edge, GNode, Graph } from '../../src/types.ts';

export const TILE = 56;
export const HUB_W = 250;
export const HUB_H = 64;
export const HEADER = 44;
const LABEL_W = 150;
const LABEL_H = 44;

export interface VNode {
  id: string;
  node: GNode;
  ghost: boolean;
  hub: boolean;
  /** Expanded in place: drawn as a container around its children. */
  container: boolean;
  parent: string | null;
  level: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VEdge {
  id: string;
  from: string;
  to: string;
  edges: Edge[];
  label: string;
  fullLabel: string;
  planned: boolean;
  retiring: boolean;
  async: boolean;
  ghost: boolean;
  /** Bundled view only: data also flows the other way, so the line has a head at both ends. */
  both: boolean;
  /** Set when the edge stands for imports between nodes rather than data links. */
  codeKind: 'declared' | 'library' | 'undeclared' | null;
  points: Array<{ x: number; y: number }>;
  labelAt: { x: number; y: number } | null;
}

export interface View {
  focus: string | null;
  nodes: VNode[];
  edges: VEdge[];
  width: number;
  height: number;
  hiddenLibraries: number;
  hiddenPlanned: number;
}

export interface Index {
  nodes: Map<string, GNode>;
  edges: Map<string, Edge>;
}

export interface ViewOptions {
  focus: string | null;
  expanded: Set<string>;
  showLibraries: boolean;
  /** Leave out everything that is only planned, to see the system as it is today. */
  hidePlanned: boolean;
  /** Overview drawing: one line per pair of nodes whatever the direction, routed along shared trunks. */
  bundle?: boolean;
  /** Draw these edges instead of the model's data links (the Code lens passes import dependencies). */
  edges?: Edge[];
}

export function indexGraph(g: Graph): Index {
  return { nodes: new Map(g.nodes.map((n) => [n.id, n])), edges: new Map(g.edges.map((e) => [e.id, e])) };
}

export function isInside(id: string, anc: string): boolean {
  return id === anc || id.startsWith(`${anc}.`);
}

function onlyLibraries(ix: Index, n: GNode): boolean {
  // Dead code stays on the map even when shared libraries are hidden: showing it is the point.
  if (n.unused) return false;
  if (n.kind === 'library') return n.shared !== false;
  if (n.children.length === 0) return false;
  return n.children.every((c) => onlyLibraries(ix, ix.nodes.get(c)!));
}

/**
 * The node that stands for `id` on this screen: the deepest ancestor-or-self that is drawn
 * as a tile. Inside the focus that means descending through expanded containers; outside it,
 * the neighbour just outside the focus. Null for the focus itself.
 */
export function visibleFor(ix: Index, id: string, focus: string | null, expanded: Set<string> = new Set()): string | null {
  const node = ix.nodes.get(id);
  if (!node) return null;
  if (focus && id === focus) return null;
  if (focus === null || isInside(id, focus)) {
    const chain: string[] = [];
    for (let cur: GNode | undefined = node; cur && cur.id !== focus; cur = cur.parent ? ix.nodes.get(cur.parent) : undefined) chain.unshift(cur.id);
    for (const c of chain) if (c === id || !expanded.has(c)) return c;
    return id;
  }
  let cur = node;
  for (;;) {
    const parent: string | null = cur.parent;
    if (parent === null || isInside(focus, parent)) return cur.id;
    cur = ix.nodes.get(parent)!;
  }
}

function edgeLabel(edges: Edge[]): string {
  if (edges[0]?.code) {
    const parts = new Map<string, number>();
    for (const e of edges) {
      const via = e.code?.via ?? 'import';
      parts.set(via, (parts.get(via) ?? 0) + (e.code?.count ?? 0));
    }
    return [...parts].map(([via, n]) => `${n} ${via === 'import' ? `import${n === 1 ? '' : 's'}` : via}`).join(', ');
  }
  const names: string[] = [];
  for (const e of edges) {
    const own = e.shapes.length ? e.shapes : e.iface ? [e.iface.split('#')[1]] : [];
    for (const s of own) if (!names.includes(s)) names.push(s);
  }
  if (names.length === 0) return edges.length > 1 ? `${edges.length} links` : '';
  const shown = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

/** What the screen shows before layout: which nodes are drawn and how links merge between them. */
export function visibleGraph(g: Graph, ix: Index, o: ViewOptions): { nodes: Map<string, VNode>; edges: Map<string, VEdge>; hiddenLibraries: number; hiddenPlanned: number } {
  const { focus, expanded } = o;
  const focusIsLib = focus ? onlyLibraries(ix, ix.nodes.get(focus)!) : false;
  const showLibs = o.showLibraries || !!o.edges;
  const libHidden = (n: GNode): boolean => !showLibs && !focusIsLib && onlyLibraries(ix, n);
  const planHidden = (n: GNode): boolean => o.hidePlanned && n.status === 'planned';
  let hiddenLibraries = 0;
  let hiddenPlanned = 0;

  const vnodes = new Map<string, VNode>();
  const addTree = (n: GNode, parent: string | null, level: number): void => {
    if (libHidden(n)) {
      hiddenLibraries++;
      return;
    }
    if (planHidden(n)) {
      hiddenPlanned++;
      return;
    }
    const container = expanded.has(n.id) && n.children.length > 0;
    const hub = n.hub && !container;
    vnodes.set(n.id, { id: n.id, node: n, ghost: false, hub, container, parent, level, x: 0, y: 0, w: hub ? HUB_W : TILE, h: hub ? HUB_H : TILE });
    if (container) for (const c of n.children) addTree(ix.nodes.get(c)!, n.id, level + 1);
  };
  for (const n of g.nodes) if (n.parent === focus) addTree(n, null, 0);

  const merged = new Map<string, VEdge>();
  for (const e of o.edges ?? g.edges) {
    if (o.hidePlanned && e.status === 'planned') continue;
    const a = visibleFor(ix, e.from, focus, expanded);
    const b = visibleFor(ix, e.to, focus, expanded);
    if (!a || !b || a === b) continue;
    const aIn = focus === null || isInside(a, focus);
    const bIn = focus === null || isInside(b, focus);
    if (!aIn && !bIn) continue;
    if ((aIn && !vnodes.has(a)) || (bIn && !vnodes.has(b))) continue;
    for (const [id, inside] of [[a, aIn], [b, bIn]] as const) {
      if (inside || vnodes.has(id)) continue;
      const n = ix.nodes.get(id)!;
      if ((!showLibs && onlyLibraries(ix, n)) || planHidden(n)) continue;
      vnodes.set(id, { id, node: n, ghost: true, hub: false, container: false, parent: null, level: 0, x: 0, y: 0, w: TILE, h: TILE });
    }
    if (!vnodes.has(a) || !vnodes.has(b)) continue;
    // Bundled: A to B and B to A share one line.
    const back = o.bundle ? merged.get(`${b}=>${a}`) : undefined;
    if (back) {
      back.both = true;
      back.edges.push(e);
      continue;
    }
    const key = `${a}=>${b}`;
    const m = merged.get(key) ?? { id: key, from: a, to: b, edges: [], label: '', fullLabel: '', planned: true, retiring: true, async: true, ghost: !aIn || !bIn, both: false, codeKind: null, points: [], labelAt: null };
    m.edges.push(e);
    merged.set(key, m);
  }
  for (const m of merged.values()) {
    m.label = m.fullLabel = edgeLabel(m.edges);
    m.planned = m.edges.every((e) => e.status === 'planned');
    m.retiring = m.edges.every((e) => e.status === 'retiring');
    m.async = m.edges.every((e) => e.async);
    const kinds = m.edges.map((e) => e.code?.kind).filter(Boolean);
    m.codeKind = kinds.length === 0 ? null : kinds.includes('undeclared') ? 'undeclared' : kinds.includes('declared') ? 'declared' : 'library';
  }
  return { nodes: vnodes, edges: merged, hiddenLibraries, hiddenPlanned };
}

const elk = new ELK();

const SPACING_DETAIL = {
  'elk.spacing.nodeNode': '36',
  'elk.spacing.edgeNode': '26',
  'elk.spacing.edgeEdge': '20',
  'elk.spacing.labelNode': '6',
  'elk.layered.spacing.nodeNodeBetweenLayers': '150',
  'elk.layered.spacing.edgeNodeBetweenLayers': '42',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
};

export async function buildView(g: Graph, ix: Index, o: ViewOptions): Promise<View> {
  const { nodes: vnodes, edges: merged, hiddenLibraries, hiddenPlanned } = visibleGraph(g, ix, o);
  // Bundled lines need far less room between layers, so the whole picture is tighter and nodes read larger.
  const SPACING = o.bundle
    ? { ...SPACING_DETAIL, 'elk.spacing.edgeEdge': '12', 'elk.spacing.edgeNode': '20', 'elk.layered.spacing.nodeNodeBetweenLayers': '104', 'elk.layered.spacing.edgeNodeBetweenLayers': '30', 'elk.layered.spacing.edgeEdgeBetweenLayers': '10' }
    : SPACING_DETAIL;

  const toElk = (v: VNode): any => {
    if (v.container) {
      return {
        id: v.id,
        children: [...vnodes.values()].filter((c) => c.parent === v.id).map(toElk),
        layoutOptions: { ...SPACING, 'elk.padding': `[top=${HEADER + 14},left=34,bottom=62,right=34]`, 'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': '(260,150)' },
      };
    }
    return {
      id: v.id,
      width: v.w,
      height: v.h,
      labels: v.hub ? [] : [{ id: `${v.id}__label`, text: v.node.name, width: LABEL_W, height: LABEL_H }],
      layoutOptions: { 'elk.nodeLabels.placement': 'OUTSIDE V_BOTTOM H_CENTER' },
    };
  };
  const laid: any = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      ...SPACING,
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.thoroughness': '30',
      'elk.layered.mergeEdges': o.bundle ? 'true' : 'false',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '70',
      'elk.padding': '[top=40,left=60,bottom=80,right=60]',
    },
    children: [...vnodes.values()].filter((v) => v.parent === null).map(toElk),
    edges: [...merged.values()].map((m) => ({ id: m.id, sources: [m.from], targets: [m.to] })),
  });

  const origin = new Map<string, { x: number; y: number }>([['root', { x: 0, y: 0 }]]);
  const place = (c: any, ox: number, oy: number): void => {
    const v = vnodes.get(c.id)!;
    v.x = ox + c.x;
    v.y = oy + c.y;
    if (v.container) {
      v.w = c.width;
      v.h = c.height;
    }
    origin.set(c.id, { x: v.x, y: v.y });
    for (const k of c.children ?? []) place(k, v.x, v.y);
  };
  for (const c of laid.children ?? []) place(c, 0, 0);

  // Edge coordinates are relative to the node that contains the edge: the lowest common
  // ancestor of its two ends.
  const chainOf = (id: string): string[] => {
    const out: string[] = [];
    for (let cur = vnodes.get(id)?.parent ?? null; cur; cur = vnodes.get(cur)?.parent ?? null) out.push(cur);
    return out;
  };
  const containerOf = (m: VEdge): string => {
    const a = chainOf(m.from);
    const b = new Set(chainOf(m.to));
    return a.find((x) => b.has(x)) ?? 'root';
  };
  const collect = (node: any): void => {
    for (const e of node.edges ?? []) {
      const m = merged.get(e.id);
      const s = e.sections?.[0];
      if (!m || !s) continue;
      const o2 = origin.get(e.container ?? containerOf(m)) ?? { x: 0, y: 0 };
      m.points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p: any) => ({ x: p.x + o2.x, y: p.y + o2.y }));
    }
    for (const c of node.children ?? []) collect(c);
  };
  collect(laid);

  // Labels sit on the longest horizontal run of each edge, clipped to fit it.
  let k = 0;
  for (const m of merged.values()) {
    if (m.points.length < 2) continue;
    let best: { x1: number; x2: number; y: number } | null = null;
    for (let i = 1; i < m.points.length; i++) {
      const a = m.points[i - 1];
      const b = m.points[i];
      if (Math.abs(a.y - b.y) > 0.5) continue;
      const len = Math.abs(b.x - a.x);
      if (!best || len > Math.abs(best.x2 - best.x1)) best = { x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x), y: a.y };
    }
    if (!best) {
      const mid = m.points[Math.floor(m.points.length / 2)];
      m.labelAt = { x: mid.x, y: mid.y };
      m.label = '';
      continue;
    }
    const len = best.x2 - best.x1;
    const room = Math.floor((len - 22) / 6.4);
    m.labelAt = { x: (best.x1 + best.x2) / 2, y: best.y };
    if (!m.label) continue;
    if (room < 4) {
      m.label = '';
      continue;
    }
    if (m.label.length > room) m.label = `${m.label.slice(0, room - 1)}…`;
    const half = (m.label.length * 6.4 + 10) / 2;
    const slack = Math.max(0, len / 2 - half - 8);
    m.labelAt.x += ((k++ % 3) - 1) * Math.min(slack, 26);
  }
  const order = [...vnodes.values()].sort((a, b) => a.level - b.level);
  return { focus: o.focus, nodes: order, edges: [...merged.values()], width: laid.width ?? 800, height: laid.height ?? 600, hiddenLibraries, hiddenPlanned };
}

export function pathOf(points: Array<{ x: number; y: number }>, radius = 8): string {
  if (points.length === 0) return '';
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    const a = { x: p1.x - ((p1.x - p0.x) / (d1 || 1)) * r, y: p1.y - ((p1.y - p0.y) / (d1 || 1)) * r };
    const b = { x: p1.x + ((p2.x - p1.x) / (d2 || 1)) * r, y: p1.y + ((p2.y - p1.y) / (d2 || 1)) * r };
    d += ` L${a.x} ${a.y} Q${p1.x} ${p1.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x} ${last.y}`;
}

/** Which way data travels on a drawn line: a read brings data back from the store, a call with a reply goes both ways. */
export function dataDirection(m: VEdge): { fwd: boolean; back: boolean } {
  if (m.codeKind) return { fwd: false, back: false };
  let fwd = false;
  let back = false;
  const atFrom = (id: string): boolean => id === m.from || isInside(id, m.from);
  for (const e of m.edges) {
    if (e.status === 'planned') continue;
    const source = e.verb === 'reads' ? e.to : e.from;
    const along = atFrom(source);
    if (along) fwd = true;
    else back = true;
    if (e.verb === 'calls' && e.returns.length > 0) {
      if (along) back = true;
      else fwd = true;
    }
  }
  if (m.both && (fwd || back)) {
    fwd = true;
    back = true;
  }
  return { fwd, back };
}
