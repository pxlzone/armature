import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Graph, GNode, Shape } from '../../src/types.ts';
import { pendingChanges, type ApproveFn } from './Review.tsx';
import { buildView, dataDirection, indexGraph, isInside, pathOf, visibleFor, HEADER, HUB_H, HUB_W, TILE, type VEdge, type View, type VNode } from './view.ts';
import { Panel } from './Panel.tsx';
import { colorOf, iconOf } from './icons.tsx';
import { Reader, docsFor } from './Docs.tsx';
import { SettingsButton, SettingsDialog, changedFromDefault, loadSettings, saveSettings, type ViewSettings } from './Settings.tsx';

export type Lens = 'structure' | 'flow' | 'data' | 'tests' | 'work' | 'review' | 'docs' | 'activity' | 'code' | 'rules';
export type Selection = { type: 'node' | 'edge'; id: string } | null;

const LENSES: Array<[Lens, string]> = [
  ['structure', 'Structure'], ['flow', 'Flow'], ['data', 'Data'], ['tests', 'Tests'], ['work', 'Work'], ['review', 'To approve'], ['docs', 'Docs'], ['activity', 'Activity'], ['code', 'Code'], ['rules', 'Rules'],
];
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const DIM = 0.15;



declare global {
  interface Window {
    __ARMATURE_GRAPH__?: Graph | null;
    /** Set by the live server only: lets this page ask it to approve a change. */
    __ARMATURE_APPROVE__?: string;
  }
}

function wrap(text: string, max: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && `${cur} ${w}`.length > max) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = `${kept[lines - 1].slice(0, max - 1)}…`;
    return kept;
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function activityCount(n: GNode, type: string | null): { commits: number; prs: number; total: number } {
  const a = n.activity;
  if (!a) return { commits: 0, prs: 0, total: 0 };
  if (type) {
    const t = a.byType[type] ?? 0;
    return { commits: t, prs: 0, total: t };
  }
  const prs = a.prsOpen + a.prsMerged + a.prsClosed;
  return { commits: a.commits, prs, total: a.commits + prs };
}

export function App() {
  const [graph, setGraph] = useState<Graph | null>(window.__ARMATURE_GRAPH__ ?? null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lens, setLens] = useState<Lens>('structure');
  const [sel, setSel] = useState<Selection>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  // Secondary view options live in the Settings popover and are remembered per browser.
  const [settings, setSettings] = useState<ViewSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { showLibs, hidePlanned, zoomOpens, lineMode, motion, follow, legend } = settings;
  const [showProblems, setShowProblems] = useState(false);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [step, setStep] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [shapeId, setShapeId] = useState<string | null>(null);
  const [changeId, setChangeId] = useState<string | null>(null);
  const [activityType, setActivityType] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [version, setVersion] = useState(0);
  const [tf, setTf] = useState({ k: 1, x: 0, y: 0 });
  const [glide, setGlide] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [docPath, setDocPath] = useState<string | null>(null);
  const [autoBundle, setAutoBundle] = useState(true);
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;
  /** Keeps one node under the same screen point while the layout around it changes. */
  const anchor = useRef<{ id: string; sx: number; sy: number; fill?: boolean } | null>(null);
  const freeze = useRef(0);
  const fitNext = useRef(true);
  const busy = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const userZoom = useRef(0);

  const load = useCallback(() => {
    fetch('/graph.json')
      .then((r) => r.json())
      .then((g) => {
        if (g.error) setError(g.error);
        else {
          setGraph(g);
          setError(null);
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Approving goes through the server that gave out this page. A saved copy has no server and no key.
  const approve = useMemo<ApproveFn | null>(() => {
    const key = window.__ARMATURE_APPROVE__;
    if (!key) return null;
    return async (id) => {
      const res = await fetch('/approve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-armature-token': key }, body: JSON.stringify({ id }) });
      const out = (await res.json()) as { ok: boolean; message: string };
      if (out.ok) load();
      return out;
    };
  }, [load]);

  useEffect(() => {
    if (window.__ARMATURE_GRAPH__) return;
    load();
    const es = new EventSource('/events');
    es.onmessage = () => load();
    return () => es.close();
  }, [load]);

  const ix = useMemo(() => (graph ? indexGraph(graph) : null), [graph]);

  useEffect(() => {
    if (graph) document.title = `${graph.system.name} architecture`;
  }, [graph]);

  useEffect(() => {
    if (graph && ix && focus && !ix.nodes.has(focus)) setFocus(null);
  }, [graph, ix, focus]);

  const fit = useCallback((v: View) => {
    const el = svgRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const k = Math.max(MIN_ZOOM, Math.min(width / v.width, height / v.height, 1.25));
    setGlide(true);
    setTf({ k, x: (width - v.width * k) / 2, y: (height - v.height * k) / 2 });
  }, []);

  const updateSettings = useCallback((patch: Partial<ViewSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      // A fixed line mode redraws the whole map, so fit it again.
      if (patch.lineMode && patch.lineMode !== prev.lineMode && patch.lineMode !== 'auto') fitNext.current = true;
      saveSettings(next);
      return next;
    });
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Merged lines for the overview, separate lines up close. A selected flow needs every direction, so it is never merged.
  const bundled = lens === 'flow' && flowId ? false : lineMode === 'merged' || (lineMode === 'auto' && autoBundle);
  const lastKey = useRef('');
  useEffect(() => {
    if (!graph || !ix) return;
    let live = true;
    const f = focus && ix.nodes.has(focus) ? focus : null;
    // The Code lens draws what the code imports, node to node, in place of the declared data links.
    const codeEdges: Edge[] | undefined = lens === 'code'
      ? graph.codeDeps.map((d) => ({ id: `code:${d.from}>${d.to}>${d.via ?? 'import'}`, from: d.from, to: d.to, owner: d.from, verb: 'calls' as const, async: false, shapes: [], returns: [], status: 'built' as const, evidence: 'seen' as const, code: { count: d.count, kind: d.kind, via: d.via ?? 'import' } }))
      : undefined;
    buildView(graph, ix, { focus: f, expanded, showLibraries: showLibs, hidePlanned, edges: codeEdges, bundle: bundled }).then((v) => {
      if (!live) return;
      setView(v);
      setVersion((n) => n + 1);
      busy.current = false;
      const key = `${f}|${showLibs}|${hidePlanned}|${lens === 'code'}`;
      const a = anchor.current;
      anchor.current = null;
      const target = a ? v.nodes.find((n) => n.id === a.id) : undefined;
      if (a && target) {
        // The node that was opened or closed stays where the eye already is.
        setGlide(true);
        const box = svgRef.current?.getBoundingClientRect();
        if (a.fill && box) {
          // Opened by zooming in: the group now fills the screen, as if you had flown into it.
          const k = Math.max(MIN_ZOOM, Math.min((box.width * 0.86) / target.w, (box.height * 0.82) / target.h, 1.35));
          setTf({ k, x: box.width / 2 - (target.x + target.w / 2) * k, y: box.height / 2 - (target.y + target.h / 2) * k });
        } else {
          const k = tfRef.current.k;
          setTf({ k, x: a.sx - (target.x + target.w / 2) * k, y: a.sy - (target.y + target.h / 2) * k });
        }
        freeze.current = Date.now() + 700;
        lastKey.current = key;
      } else if (key !== lastKey.current || fitNext.current) {
        // Refit when the view itself changed, not when its data did.
        lastKey.current = key;
        fitNext.current = false;
        requestAnimationFrame(() => fit(v));
      }
    });
    return () => {
      live = false;
    };
  }, [graph, ix, focus, expanded, showLibs, hidePlanned, fit, lens === 'code', bundled]);

  const zoomAt = useCallback((px: number, py: number, factor: number, smooth: boolean) => {
    if (Date.now() < freeze.current) return; // let an opening group settle before zooming on
    userZoom.current = Date.now();
    pointer.current = { x: px, y: py };
    setGlide(smooth);
    setTf((t) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.k * factor));
      return { k, x: px - ((px - t.x) / t.k) * k, y: py - ((py - t.y) / t.k) * k };
    });
  }, []);

  // The wheel listener must be non-passive, or the browser zooms the whole page on pinch.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const pinch = e.ctrlKey || e.metaKey;
      // A mouse wheel sends large whole-number steps on one axis; a trackpad sends small ones on both.
      const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (pinch || mouseWheel) {
        const factor = Math.exp(-e.deltaY * (pinch ? 0.01 : e.deltaMode !== 0 ? 0.05 : 0.0016));
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor, false);
      } else {
        setGlide(false);
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        setTf((t) => ({ ...t, x: t.x - dx, y: t.y - dy }));
      }
    };
    const stop = (e: Event): void => e.preventDefault();
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', stop);
    el.addEventListener('gesturechange', stop);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', stop);
      el.removeEventListener('gesturechange', stop);
    };
  }, [zoomAt, graph]);

  const flow = graph?.flows.find((f) => f.id === flowId) ?? null;
  useEffect(() => {
    if (!playing || !flow) return;
    const t = setInterval(() => setStep((s) => (s + 1) % flow.steps.length), 2200);
    return () => clearInterval(t);
  }, [playing, flow]);

  // What the current lens highlights, as visible node ids and merged edge ids.
  const lensSet = useMemo(() => {
    if (!graph || !ix || !view) return null;
    const nodes = new Set<string>();
    const edges = new Set<string>();
    const vis = (id: string): string | null => visibleFor(ix, id, view.focus, expanded);
    const onScreen = new Set(view.nodes.map((n) => n.id));
    const addNode = (id: string): void => {
      const v = vis(id);
      if (v && onScreen.has(v)) nodes.add(v);
    };
    const addEdge = (edgeId: string): void => {
      for (const m of view.edges) if (m.edges.some((e) => e.id === edgeId)) {
        edges.add(m.id);
        nodes.add(m.from);
        nodes.add(m.to);
      }
    };
    if (lens === 'flow' && flow) {
      const add = (steps: typeof flow.steps): { nodes: Set<string>; edges: Set<string> } => {
        for (const s of steps) {
          if (s.edge) addEdge(s.edge);
          addNode(s.from);
          addNode(s.to);
        }
        return { nodes: new Set(nodes), edges: new Set(edges) };
      };
      const current = add(step >= 0 ? [flow.steps[step]].filter(Boolean) : flow.steps);
      // `whole` is every step of the flow, whichever one is playing.
      return { ...current, whole: step >= 0 ? add(flow.steps) : current };
    }
    if (lens === 'data' && shapeId) {
      for (const e of graph.edges) if (e.shapes.includes(shapeId) || e.returns.includes(shapeId)) addEdge(e.id);
      for (const n of graph.nodes) if (n.interfaces.some((i) => i.takes.includes(shapeId) || i.gives.includes(shapeId))) addNode(n.id);
      return { nodes, edges };
    }
    if (lens === 'docs' && docPath) {
      const d = graph.docs.find((x) => x.path === docPath);
      if (!d) return null;
      for (const l of d.links) addNode(l.node);
      return { nodes, edges };
    }
    if ((lens === 'work' || lens === 'review') && changeId) {
      const c = graph.changes.find((x) => x.id === changeId);
      if (!c) return null;
      for (const id of c.edges) addEdge(id);
      for (const e of graph.edges) {
        if ((e.iface && c.interfaces.includes(e.iface)) || c.nodes.some((id) => isInside(e.from, id) || isInside(e.to, id))) addEdge(e.id);
      }
      for (const id of [...c.nodes, ...c.interfaces.map((r) => r.split('#')[0]), ...c.requirements.map((r) => r.split(':')[0])]) addNode(id);
      return { nodes, edges };
    }
    return null;
  }, [graph, ix, view, lens, flow, step, shapeId, changeId, expanded, docPath]);

  // Bring a set of nodes and edges into view, at a readable size, with a glide.
  const glideTo = useCallback((nodeIds: string[], edgeIds: string[], maxK = 1.05) => {
    const el = svgRef.current;
    if (!el || !view) return;
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    const add = (x: number, y: number): void => {
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x);
      y2 = Math.max(y2, y);
    };
    for (const v of view.nodes) if (nodeIds.includes(v.id)) {
      add(v.x - 50, v.y - 30);
      add(v.x + v.w + 50, v.y + v.h + 60);
    }
    for (const m of view.edges) if (edgeIds.includes(m.id)) {
      for (const pt of m.points) add(pt.x, pt.y);
      if (m.labelAt) add(m.labelAt.x, m.labelAt.y + 190);
    }
    if (!Number.isFinite(x1)) return;
    const { width, height } = el.getBoundingClientRect();
    const k = Math.max(MIN_ZOOM, Math.min((width - 80) / (x2 - x1), (height - 80) / (y2 - y1), maxK));
    setGlide(true);
    setTf({ k, x: width / 2 - ((x1 + x2) / 2) * k, y: height / 2 - ((y1 + y2) / 2) * k });
  }, [view]);

  // A selected flow owns the map: only its own nodes and lines react to the pointer.
  const flowSet = lensSet && 'whole' in lensSet ? lensSet.whole : null;
  const hotNode = hover && (!flowSet || flowSet.nodes.has(hover)) ? hover : null;
  const hotEdge = hoverEdge && (!flowSet || flowSet.edges.has(hoverEdge)) ? hoverEdge : null;

  // Picking a flow brings the whole of it into view. Its lines are drawn unmerged, so the map may be
  // laid out again just after the pick; the camera follows that redraw too.
  const flowZoomUntil = useRef(0);
  useEffect(() => {
    flowZoomUntil.current = flowId ? Date.now() + 2000 : 0;
  }, [flowId]);
  useEffect(() => {
    if (!flowSet || step >= 0 || Date.now() > flowZoomUntil.current) return;
    glideTo([...flowSet.nodes], [...flowSet.edges]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, version, !!flowSet]);

  // While a flow is stepped through, the camera follows the active step.
  const followKey = lens === 'flow' && follow && flow && step >= 0 && lensSet ? `${flow.id}|${step}|${version}` : '';
  useEffect(() => {
    if (!followKey || !lensSet) return;
    glideTo([...lensSet.nodes], [...lensSet.edges]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey]);

  // Hover previews a node's neighbourhood; a selection keeps it; otherwise the lens decides.
  const emphasis = useMemo(() => {
    if (!view) return null;
    const around = (id: string): { nodes: Set<string>; edges: Set<string> } => {
      const nodes = new Set<string>([id]);
      const edges = new Set<string>();
      const inside = (x: string): boolean => x === id || view.nodes.some((v) => v.id === x && isInside(x, id));
      for (const m of view.edges) {
        if (inside(m.from) || inside(m.to)) {
          edges.add(m.id);
          nodes.add(m.from);
          nodes.add(m.to);
        }
      }
      for (const v of view.nodes) if (isInside(v.id, id)) nodes.add(v.id);
      return { nodes, edges };
    };
    if (hotNode && view.nodes.some((v) => v.id === hotNode)) {
      const a = around(hotNode);
      // Inside a selected flow, a hover narrows to that node's part of the flow.
      return flowSet ? { nodes: new Set([...a.nodes].filter((x) => flowSet.nodes.has(x))), edges: new Set([...a.edges].filter((x) => flowSet.edges.has(x))) } : a;
    }
    if (hotEdge) {
      const m = view.edges.find((e) => e.id === hotEdge);
      if (m) return { nodes: new Set([m.from, m.to]), edges: new Set([m.id]) };
    }
    if (lensSet) return lensSet;
    if (sel?.type === 'node' && view.nodes.some((v) => v.id === sel.id)) return around(sel.id);
    if (sel?.type === 'edge') {
      const m = view.edges.find((e) => e.id === sel.id);
      if (m) return { nodes: new Set([m.from, m.to]), edges: new Set([m.id]) };
    }
    return null;
  }, [view, hotNode, hotEdge, flowSet, lensSet, sel]);

  const maxActivity = useMemo(() => {
    if (!view) return 1;
    return Math.max(1, ...view.nodes.filter((v) => !v.container).map((v) => activityCount(v.node, activityType).total));
  }, [view, activityType]);

  // Lines merge into trunks when zoomed out and separate when zoomed in. The node nearest the cursor stays put.
  useEffect(() => {
    if (lineMode !== 'auto' || busy.current || Date.now() - userZoom.current > 400) return;
    const want = tf.k >= 1.0 ? false : tf.k <= 0.62 ? true : autoBundle;
    if (want === autoBundle) return;
    const v = viewRef.current;
    const el = svgRef.current;
    if (v && el) {
      const { width, height } = el.getBoundingClientRect();
      const at = pointer.current ?? { x: width / 2, y: height / 2 };
      let best: VNode | null = null;
      let bestD = Infinity;
      for (const n of v.nodes) {
        if (n.container) continue;
        const d = Math.hypot(tf.x + (n.x + n.w / 2) * tf.k - at.x, tf.y + (n.y + n.h / 2) * tf.k - at.y);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best) anchor.current = { id: best.id, sx: tf.x + (best.x + best.w / 2) * tf.k, sy: tf.y + (best.y + best.h / 2) * tf.k };
    }
    busy.current = true;
    setAutoBundle(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf.k, lineMode]);

  // Literal zoom: zoom far enough into a group and it opens; zoom far enough out and it closes.
  useEffect(() => {
    if (!zoomOpens || !ix || busy.current || Date.now() - userZoom.current > 400) return;
    const v = viewRef.current;
    const el = svgRef.current;
    if (!v || !el) return;
    const { width, height } = el.getBoundingClientRect();
    const k = tf.k;
    const at = pointer.current ?? { x: width / 2, y: height / 2 };
    const screen = (n: VNode): { x: number; y: number } => ({ x: tf.x + (n.x + n.w / 2) * k, y: tf.y + (n.y + n.h / 2) * k });
    const act = (n: VNode, open: boolean): void => {
      const c = screen(n);
      anchor.current = { id: n.id, sx: c.x, sy: c.y, fill: open };
      busy.current = true;
      freeze.current = Date.now() + 1200;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (open) next.add(n.id);
        else for (const x of [...next]) if (isInside(x, n.id)) next.delete(x);
        return next;
      });
    };
    // Close the innermost container that has become too small to read.
    const small = v.nodes.filter((n) => n.container && n.w * k < 230 && n.h * k < 230).sort((a, b) => b.level - a.level)[0];
    if (small) return act(small, false);
    if (k < 1.7) return;
    let best: VNode | null = null;
    let bestD = 170;
    for (const n of v.nodes) {
      if (n.container || n.ghost || n.node.children.length === 0) continue;
      const c = screen(n);
      const d = Math.hypot(c.x - at.x, c.y - at.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (best) act(best, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf.k, zoomOpens]);

  if (error && !graph) return <div className="empty">Could not load the model: {error}</div>;
  if (!graph || !ix) return <div className="empty">Loading the model…</div>;

  const shapes = new Map(graph.shapes.map((s) => [s.id, s]));
  const focusNode = focus ? ix.nodes.get(focus) ?? null : null;
  const crumbs: GNode[] = [];
  for (let n = focusNode; n; n = n.parent ? ix.nodes.get(n.parent) ?? null : null) crumbs.unshift(n);
  const errors = graph.problems.filter((p) => p.level === 'error').length;
  const warnings = graph.problems.length - errors;
  const wrongCount = graph.problems.filter((p) => p.level === 'warning' && p.group === 'wrong').length;
  const incompleteCount = warnings - wrongCount;
  // Plans nobody has approved yet stand out on the map in every lens.
  const pending = pendingChanges(graph);
  const pendingNodes = pending.flatMap((c) => c.nodes);
  const toApprove = (id: string): boolean => pendingNodes.some((x) => isInside(x, id) || isInside(id, x));
  const headline = lens === 'flow' && flow ? flow.headline : focusNode ? focusNode.description ?? focusNode.role : graph.system.headline;
  const plannedCount = graph.nodes.filter((n) => n.children.length === 0 && n.status === 'planned').length;

  // What a lens has picked (a flow, a shape, a change) belongs to that lens; leaving it clears the pick.
  const clearPicks = (): void => {
    setFlowId(null);
    setStep(-1);
    setPlaying(false);
    setShapeId(null);
    setChangeId(null);
  };

  const toggle = (id: string, on?: boolean): void => {
    const n = ix.nodes.get(id);
    if (!n || n.children.length === 0) return;
    const v = view?.nodes.find((x) => x.id === id);
    if (v) anchor.current = { id, sx: tf.x + (v.x + v.w / 2) * tf.k, sy: tf.y + (v.y + v.h / 2) * tf.k };
    busy.current = true;
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = on ?? !next.has(id);
      if (want) next.add(id);
      else for (const x of [...next]) if (isInside(x, id)) next.delete(x);
      return next;
    });
  };
  const open = (id: string): void => {
    const n = ix.nodes.get(id);
    if (n && n.children.length) {
      setFocus(id);
      setSel(null);
      setHover(null);
    }
  };
  const goTo = (id: string): void => {
    // Make the node visible where it lives: expand its ancestors inside the current view, or change view.
    const n = ix.nodes.get(id);
    if (!n) return;
    const chain: string[] = [];
    for (let p = n.parent; p; p = ix.nodes.get(p)?.parent ?? null) chain.unshift(p);
    if (focus && !isInside(id, focus)) setFocus(null);
    const base = focus && isInside(id, focus) ? focus : null;
    setExpanded((prev) => new Set([...prev, ...chain.filter((c) => c !== base && (!base || isInside(c, base)))]));
    setSel({ type: 'node', id });
  };
  const expandAll = (): void => { fitNext.current = true; setExpanded(new Set(graph.nodes.filter((n) => n.children.length > 0 && n.depth === (focusNode ? focusNode.depth + 1 : 0) && (!focus || isInside(n.id, focus)))  .map((n) => n.id))); };

  const center = (): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: r.width / 2, y: r.height / 2 };
  };
  const onKey = (e: React.KeyboardEvent): void => {
    const c = center();
    const pan = (dx: number, dy: number): void => {
      setGlide(true);
      setTf((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
    };
    if (e.key === '+' || e.key === '=') zoomAt(c.x, c.y, 1.25, true);
    else if (e.key === '-' || e.key === '_') zoomAt(c.x, c.y, 0.8, true);
    else if (e.key === '0' || (e.shiftKey && e.key === '!')) view && fit(view);
    else if (e.key === 'ArrowLeft') pan(80, 0);
    else if (e.key === 'ArrowRight') pan(-80, 0);
    else if (e.key === 'ArrowUp') pan(0, 80);
    else if (e.key === 'ArrowDown') pan(0, -80);
    else if (e.key === 'Escape') {
      if (sel) setSel(null);
      else clearPicks();
    }
    else return;
    e.preventDefault();
  };

  const lit = (id: string, kind: 'node' | 'edge'): boolean => !emphasis || (kind === 'node' ? emphasis.nodes.has(id) : emphasis.edges.has(id));

  const renderEdge = (m: VEdge, raised: boolean) => {
    const active = emphasis?.edges.has(m.id) ?? false;
    const selected = sel?.type === 'edge' && sel.id === m.id;
    if (raised !== (active || selected)) return null;
    const d = pathOf(m.points);
    const strong = active || selected;
    const undeclared = m.codeKind === 'undeclared';
    const color = strong ? (undeclared ? 'var(--red)' : 'var(--accent)') : undeclared ? 'var(--red)' : m.planned ? 'var(--ink-3)' : 'var(--line-2)';
    const hovered = hotEdge === m.id;
    // Moving dots show which way the data goes. "Active" moves only what is in focus; "All" moves every built link.
    const moving = motion === 'all' ? !m.planned && !m.retiring : motion === 'active' && strong;
    const playing = lens === 'flow' && flow && step >= 0 && flow.steps[step]?.edge ? { edge: flow.steps[step].edge as string, reply: !!flow.steps[step].reply } : undefined;
    const dir = moving ? dataDirection(m, playing) : { fwd: false, back: false };
    const dotKind = `${m.async ? 'dots async' : 'dots'}${strong ? '' : ' quiet'}`;
    // In the merged overview, labels appear only on what is highlighted.
    const label = strong && m.fullLabel ? clip(m.fullLabel, 44) : bundled ? '' : m.label;
    const lw = label.length * 6.4 + 12;
    return (
      <g
        key={`${m.id}|${version}`}
        className={`ve${raised ? ' lift' : ''}${hovered ? ' hot' : ''}`}
        opacity={m.retiring ? 0.4 : strong ? 1 : emphasis ? DIM : m.ghost ? 0.7 : 1}
        onClick={(e) => { e.stopPropagation(); setSel({ type: 'edge', id: m.id }); }}
        data-hover-edge={m.id}
      >
        <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
        {hovered && <path d={d} className="e-glow" />}
        <path d={d} className="e-halo" strokeWidth={strong ? 7 : 5} />
        <path d={d} className="e-line" fill="none" stroke={color} strokeWidth={hovered ? 3 : strong ? 2.2 : 1.25} strokeDasharray={m.planned || undeclared ? '6 5' : m.codeKind === 'library' ? '2 4' : undefined} markerEnd={m.async ? 'url(#arr-open)' : 'url(#arr)'} markerStart={m.both ? 'url(#arr)' : undefined} style={{ color }} />
        {dir.fwd && <path d={d} className={dotKind} />}
        {dir.back && <path d={d} className={`${dotKind} rev`} />}
        {label && m.labelAt && (
          <g className="e-labelg">
            <rect className={strong ? 'e-label-bg on' : 'e-label-bg'} x={m.labelAt.x - lw / 2} y={m.labelAt.y - 9} width={lw} height={18} rx={5} />
            <text className={strong ? 'e-label on' : 'e-label'} x={m.labelAt.x} y={m.labelAt.y} textAnchor="middle" dominantBaseline="central">{label}</text>
          </g>
        )}
      </g>
    );
  };

  const badgeFor = (n: GNode): string | null => {
    const inside = (): GNode[] => graph.nodes.filter((x) => isInside(x.id, n.id));
    if (lens === 'tests') {
      let passed = 0;
      let failed = 0;
      const all = inside();
      for (const x of all) {
        passed += x.testSummary?.passed ?? 0;
        failed += x.testSummary?.failed ?? 0;
      }
      const reqs = all.flatMap((x) => x.requirements);
      const parts: string[] = [];
      if (n.coverage !== null) parts.push(`${n.coverage}%`);
      if (passed + failed > 0) parts.push(`${passed}✓${failed ? ` ${failed}✗` : ''}`);
      if (reqs.length) parts.push(`${reqs.filter((q) => q.state === 'verified').length}/${reqs.length} req`);
      return parts.join(' · ') || null;
    }
    if (lens === 'work') {
      const all = inside();
      const todos = all.flatMap((x) => x.todos);
      const debt = todos.filter((t) => t.kind === 'debt').length;
      const prs = new Set(all.flatMap((x) => x.prs.map((pr) => pr.number))).size;
      const parts: string[] = [];
      if (prs) parts.push(`${prs} open PR`);
      if (todos.length - debt) parts.push(`${todos.length - debt} todo`);
      if (debt) parts.push(`${debt} debt`);
      return parts.join(' · ') || null;
    }
    if (lens === 'activity') {
      const c = activityCount(n, activityType);
      if (!c.total) return null;
      return activityType ? `${c.commits} ${activityType}` : `${c.commits} commits${c.prs ? ` · ${c.prs} PR` : ''}`;
    }
    if (lens === 'docs') {
      const c = docsFor(graph, ix, n.id).filter((e) => e.how !== 'mentions').length;
      return c ? `${c} doc${c === 1 ? '' : 's'}` : null;
    }
    if (lens === 'rules') return n.ownRules ? `${n.ownRules} rule${n.ownRules === 1 ? '' : 's'}` : null;
    return null;
  };

  const Badge = ({ x, y, text }: { x: number; y: number; text: string }) => (
    <g transform={`translate(${x} ${y})`} className="badge">
      <rect x={-(text.length * 6 + 14) / 2} y={-9} width={text.length * 6 + 14} height={18} rx={9} />
      <text x={0} y={0.5} textAnchor="middle" dominantBaseline="central">{text}</text>
    </g>
  );

  const nodeEvents = (v: VNode) => ({
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); setSel({ type: 'node', id: v.id }); },
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (v.ghost) goTo(v.id);
      else toggle(v.id);
    },
    'data-hover-node': v.id,
  });

  const renderContainer = (v: VNode) => {
    const n = v.node;
    const Icon = iconOf(n);
    const color = colorOf(n, ix);
    const selected = sel?.type === 'node' && sel.id === v.id;
    const hot = hotNode === v.id;
    const planned = n.status === 'planned';
    const badge = badgeFor(n);
    // Nesting levels alternate between a tinted and a near-white body, so a container never
    // blends into the one around it. Every level has its own solid title bar.
    const odd = v.level % 2 === 1;
    const body = odd ? `color-mix(in srgb, ${color} 3%, var(--tile))` : `color-mix(in srgb, ${color} ${v.level === 0 ? 8 : 11}%, var(--canvas))`;
    const bar = `color-mix(in srgb, ${color} ${odd ? 16 : 22}%, var(--tile))`;
    const edge = selected ? 'var(--ink)' : hot ? 'var(--accent)' : `color-mix(in srgb, ${color} ${55 + Math.min(v.level, 3) * 10}%, var(--line))`;
    // Zoomed out, the title is drawn larger than its slot so it stays readable.
    const hb = Math.min(2.4, Math.max(1, 0.95 / tf.k));
    const r = 18;
    const head = `M0 ${HEADER} V${r} Q0 0 ${r} 0 H${v.w - r} Q${v.w} 0 ${v.w} ${r} V${HEADER} Z`;
    const room = Math.max(6, Math.floor((v.w - 64) / (8.6 * hb)));
    const parents: string[] = [];
    for (let p = n.parent ? ix.nodes.get(n.parent) : undefined; p && parents.length < 2; p = p.parent ? ix.nodes.get(p.parent) : undefined) parents.unshift(p.name);
    return (
      <g key={v.id} className={`vn${hot ? ' hot' : ''}`} style={{ transform: `translate(${v.x}px, ${v.y}px)` }} opacity={lit(v.id, 'node') ? 1 : 0.55}>
        <g className="enter">
          <rect className={`cont${v.level > 0 ? ' inner' : ''}`} style={{ width: v.w, height: v.h, fill: body, stroke: edge }} rx={r} strokeWidth={selected || hot ? 2.4 : v.level > 0 ? 1.8 : 1.4} strokeDasharray={planned ? '7 5' : undefined} />
          <g className="cont-head" {...nodeEvents(v)}>
            <path d={head} fill={bar} />
            <path d={`M0 ${HEADER} H${v.w}`} stroke={edge} strokeWidth={1} opacity={0.6} />
            <g transform={`translate(14 ${HEADER / 2}) scale(${hb})`}>
              <Icon x={0} y={-11} width={22} height={22} color={color} stroke={1.8} />
              <text className="c-name" x={30} y={1} dominantBaseline="central">{clip(n.name, room)}</text>
            </g>
            {hb < 1.25 && v.w > 380 && (
              <text className="c-role" x={v.w - 44} y={HEADER / 2 + 1} dominantBaseline="central" textAnchor="end">
                {clip(`${parents.length ? `in ${parents.join(' › ')} · ` : ''}${n.role}`, Math.max(0, Math.floor((v.w - 60 - Math.min(n.name.length, room) * 8.6 - 90) / 6.2)))}
              </text>
            )}
            <g className="collapse" onClick={(e) => { e.stopPropagation(); toggle(v.id, false); }} transform={`translate(${v.w - 26} ${HEADER / 2}) scale(${Math.min(hb, 1.6)})`}>
              <title>Collapse</title>
              <circle r={10} />
              <path d="M-4.5 0 H4.5" />
            </g>
          </g>
          {badge && <g transform={`translate(${v.w / 2} 0) scale(${hb})`}><Badge x={0} y={0} text={badge} /></g>}
          {pendingNodes.includes(v.id) && <g transform={`translate(${v.w / 2} ${v.h}) scale(${hb})`}><Tag x={0} y={0} text="to approve" warn /></g>}
        </g>
      </g>
    );
  };

  const renderNode = (v: VNode) => {
    const n = v.node;
    const Icon = iconOf(n);
    const color = colorOf(n, ix);
    const on = lit(v.id, 'node');
    const strong = !!emphasis && on;
    const selected = sel?.type === 'node' && sel.id === v.id;
    const hot = hotNode === v.id;
    const st = n.status;
    const planned = st === 'planned';
    const building = st === 'building';
    const unused = n.unused;
    const waiting = toApprove(v.id);
    const stroke = unused ? 'var(--ink-3)' : st === 'failing' ? 'var(--red)' : st === 'stale' ? 'var(--amber)' : selected ? 'var(--ink)' : waiting ? 'var(--amber)' : strong ? 'var(--accent)' : st === 'verified' ? 'var(--ok)' : planned || building ? 'var(--ink-3)' : 'var(--line-2)';
    const dash = planned || building ? '6 5' : undefined;
    const sw = waiting || st === 'verified' || st === 'failing' || st === 'stale' || selected || strong ? 2.2 : 1.4;
    let fill = unused ? 'var(--unused)' : planned ? 'var(--canvas)' : building ? 'url(#hatch)' : 'var(--tile)';
    if (lens === 'activity' && !planned) {
      const heat = Math.sqrt(activityCount(n, activityType).total / maxActivity);
      fill = `color-mix(in srgb, var(--heat) ${Math.round(heat * 55)}%, var(--tile))`;
    } else if (strong && !planned) fill = 'var(--accent-bg)';
    const w = v.hub ? HUB_W : TILE;
    const h = v.hub ? HUB_H : TILE;
    const badge = badgeFor(n);
    const roleLines = wrap(n.role, 22, 2);
    const op = (st === 'retiring' ? 0.45 : 1) * (on ? 1 : DIM) * (v.ghost && !strong && !selected ? 0.6 : 1);
    const stacked = n.children.length > 0;
    // Zoomed out, tiles are drawn larger than their layout slot so they stay readable.
    const boost = Math.min(1.7, Math.max(1, 0.72 / tf.k)) * (hot ? 1.06 : 1);
    return (
      <g key={v.id} className={`vn${hot ? ' hot' : ''}`} style={{ transform: `translate(${v.x}px, ${v.y}px)` }} opacity={op} {...nodeEvents(v)}>
        <g className="enter">
        <g className="boost" style={{ transform: `translate(${w / 2}px, ${h / 2}px) scale(${boost}) translate(${-w / 2}px, ${-h / 2}px)` }}>
          <title>{`${n.id}: ${n.statusWhy}${stacked ? ' Double-click to expand.' : ''}`}</title>
          {stacked && <rect x={6} y={6} width={w} height={h} rx={14} fill="var(--tile)" stroke={stroke} strokeWidth={1} strokeDasharray={dash} opacity={0.7} />}
          <rect className="tile" width={w} height={h} rx={14} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
          {v.hub ? (
            <>
              <Icon x={16} y={(h - 28) / 2} width={28} height={28} color={color} stroke={1.6} opacity={planned ? 0.55 : 1} />
              <text className="n-name" x={56} y={h / 2 - 9} dominantBaseline="central">{clip(n.name, 22)}</text>
              <text className="n-role" x={56} y={h / 2 + 10} dominantBaseline="central" style={{ fill: color }}>{clip(n.role, 28)}</text>
            </>
          ) : (
            <>
              <Icon x={(TILE - 28) / 2} y={(TILE - 28) / 2} width={28} height={28} color={unused ? 'var(--ink-3)' : color} stroke={1.6} opacity={planned || unused ? 0.5 : 1} />
              <text className={planned || unused ? 'n-name planned' : 'n-name'} x={TILE / 2} y={TILE + 17} textAnchor="middle" style={st === 'retiring' ? { textDecoration: 'line-through' } : undefined}>{clip(n.name, 19)}</text>
              {roleLines.map((l, i) => (
                <text key={i} className="n-role" x={TILE / 2} y={TILE + 32 + i * 13} textAnchor="middle" style={{ fill: planned ? 'var(--ink-3)' : color }}>{l}</text>
              ))}
            </>
          )}
          {waiting && <Tag x={w / 2} y={h} text="to approve" warn />}
          {!waiting && planned && <Tag x={w / 2} y={h} text="planned" />}
          {!waiting && unused && <Tag x={w / 2} y={h} text="unused" />}
          {!waiting && building && <Tag x={w / 2} y={h} text="building" accent />}
          {st === 'verified' && <StatusDot x={w - 3} color="var(--ok)" glyph="✓" />}
          {st === 'failing' && <StatusDot x={w - 3} color="var(--red)" glyph="!" />}
          {st === 'stale' && <StatusDot x={w - 3} color="var(--amber)" glyph="≠" />}
          {stacked && (
            <g className="expand" transform={`translate(${w + 2} ${h + 2})`} onClick={(e) => { e.stopPropagation(); toggle(v.id, true); }}>
              <title>Expand: {n.children.length} inside</title>
              <circle r={10} />
              <path d="M-4.5 0 H4.5 M0 -4.5 V4.5" />
            </g>
          )}
          {badge && <Badge x={w / 2} y={-13} text={badge} />}
        </g>
        </g>
      </g>
    );
  };

  // The card that shows what actually travels on the highlighted link.
  const cardEdge: VEdge | null = (() => {
    if (!view) return null;
    if (lens === 'code') return null;
    if (sel?.type === 'edge') return view.edges.find((m) => m.id === sel.id) ?? null;
    if (lens === 'flow' && flow && step >= 0 && lensSet && lensSet.edges.size === 1) return view.edges.find((m) => lensSet.edges.has(m.id)) ?? null;
    return null;
  })();
  const rawStepEdge: Edge | null = lens === 'flow' && flow && step >= 0 && flow.steps[step]?.edge ? ix.edges.get(flow.steps[step].edge as string) ?? null : null;
  // A reply step is the answer to a call: the card shows what comes back, not what was sent.
  const stepEdge: Edge | null = rawStepEdge && flow?.steps[step]?.reply ? { ...rawStepEdge, shapes: [], returns: rawStepEdge.returns } : rawStepEdge;

  return (
    <div className="app">
      <header className="top">
        <div className="top-row">
          <span className="sysname">{graph.system.name}</span>
          <nav className="crumbs" aria-label="Zoom level">
            {focusNode ? <button onClick={() => { setFocus(null); setSel(null); }}>System</button> : <span className="here">System</span>}
            {crumbs.map((c, i) => (
              <span key={c.id}>
                {' / '}
                {i === crumbs.length - 1 ? <span className="here">{c.name}</span> : <button onClick={() => { setFocus(c.id); setSel(null); }}>{c.name}</button>}
              </span>
            ))}
          </nav>
          <span className="spacer" />
          <div className="tabs" role="tablist" aria-label="Lens">
            {LENSES.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={lens === id} className={lens === id ? 'on' : ''} onClick={() => { if (id !== lens) clearPicks(); setLens(id); setShowProblems(false); setSel(null); }}>
                {label}
                {id === 'review' && pending.length > 0 && <span className="count" aria-label={`${pending.length} waiting`}>{pending.length}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="top-row second">
          <div className="headline">{headline}</div>
          <span className="spacer" />
          <button className="chip" onClick={() => { if (expanded.size) { fitNext.current = true; setExpanded(new Set()); } else expandAll(); }}>{expanded.size ? 'Collapse all' : 'Expand all'}</button>
          <button
            className={`chip checks ${errors ? 'err' : wrongCount ? 'warn' : ''}${showProblems ? ' open' : ''}`}
            onClick={() => { setShowProblems(!showProblems); setSel(null); }}
            title={errors ? 'The model is broken; open the checks' : 'Wrong: the model disagrees with the code. Incomplete: the model leaves something out.'}
          >
            {errors ? `${errors} error${errors === 1 ? '' : 's'}` : warnings ? (
              <>
                {wrongCount > 0 && <span className="ck-wrong">{wrongCount} wrong</span>}
                {wrongCount > 0 && incompleteCount > 0 && <span className="ck-sep">·</span>}
                {incompleteCount > 0 && <span className="ck-incomplete">{incompleteCount} incomplete</span>}
              </>
            ) : 'No problems'}
          </button>
          <SettingsButton open={settingsOpen} setOpen={setSettingsOpen} changed={changedFromDefault(settings)} />
          {settingsOpen && <SettingsDialog s={settings} set={updateSettings} plannedCount={plannedCount} onClose={closeSettings} />}
        </div>
      </header>
      <div className="main">
        <div className="canvas">
          <svg
            ref={svgRef}
            tabIndex={0}
            className={dragging ? 'drag' : ''}
            role="img"
            aria-label={`Architecture diagram of ${focusNode ? focusNode.name : graph.system.name}. Drag or scroll to pan, pinch or hold Control and scroll to zoom.`}
            onKeyDown={onKey}
            onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) {
                // Hover is read from what is under the pointer right now. A hovered line is redrawn in a
                // higher layer, so enter and leave events on the line itself get lost and the hover sticks.
                const hit = (e.target as Element).closest?.('[data-hover-node], [data-hover-edge]');
                setHover(hit?.getAttribute('data-hover-node') ?? null);
                setHoverEdge(hit?.getAttribute('data-hover-edge') ?? null);
                return;
              }
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              if (!d.moved && Math.hypot(dx, dy) < 4) return;
              d.moved = true;
              d.x = e.clientX;
              d.y = e.clientY;
              setDragging(true);
              setHover(null);
              setHoverEdge(null);
              setGlide(false);
              setTf((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
            }}
            onPointerUp={() => { drag.current = null; setTimeout(() => setDragging(false), 0); }}
            onPointerLeave={() => { drag.current = null; setDragging(false); setHover(null); setHoverEdge(null); }}
            onClick={() => { if (!dragging) setSel(null); }}
            onDoubleClick={(e) => { const r = svgRef.current!.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, e.shiftKey ? 0.6 : 1.6, true); }}
          >
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M1 1 L9 5 L1 9 Z" fill="context-stroke" stroke="context-stroke" strokeWidth="1" strokeLinejoin="round" />
              </marker>
              <marker id="arr-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
                <path d="M1.5 1 L9 5 L1.5 9" fill="none" stroke="context-stroke" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </marker>
              <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="7" height="7" fill="var(--tile)" />
                <path d="M0 0 V7" stroke="var(--line-2)" strokeWidth="2" />
              </pattern>
            </defs>
            {view && (
              <g className={`cam${glide ? ' glide' : ''}${tf.k < 0.5 ? ' far' : ''}`} style={{ transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.k})` }}>
                {view.nodes.filter((v) => v.container).map(renderContainer)}
                {view.edges.map((m) => renderEdge(m, false))}
                {/* Highlighted lines rise above the other lines, never above the blocks they connect. */}
                {view.edges.map((m) => renderEdge(m, true))}
                {view.nodes.filter((v) => !v.container).map(renderNode)}
                {cardEdge && cardEdge.labelAt && <DataCard key={`${cardEdge.id}|${stepEdge?.id ?? ''}|${version}`} m={cardEdge} only={stepEdge} shapes={shapes} at={cardEdge.labelAt} />}
              </g>
            )}
          </svg>
          {docPath && (
            <Reader
              graph={graph}
              path={docPath}
              onClose={() => setDocPath(null)}
              openDoc={setDocPath}
              goTo={(id) => { goTo(id); }}
              openRef={(r) => {
                // A reference in a document leads to the thing it names, in the lens that shows it.
                if (r.node) return goTo(r.node);
                clearPicks();
                setSel(null);
                setShowProblems(false);
                setDocPath(null);
                if (r.type === 'shape') { setLens('data'); setShapeId(r.id); }
                else if (r.type === 'flow') { setLens('flow'); setFlowId(r.id); }
                else if (r.type === 'change') { setLens('work'); setChangeId(r.id); }
              }}
            />
          )}
          {lens === 'flow' && flow && (
            <div className="flowbar" role="status">
              <span className="flowbar-dot" />
              <span>Flow: <b>{flow.title}</b>{step >= 0 ? ` · step ${step + 1} of ${flow.steps.length}` : ''}</span>
              <button onClick={clearPicks} aria-label="Close the flow">Close ✕</button>
            </div>
          )}
          <div className="hint">
            Scroll or drag to pan · pinch or Ctrl/⌘ + scroll to zoom · {zoomOpens ? 'zoom into' : 'double-click'} a stacked node to open it
            {view && view.hiddenLibraries > 0 && !showLibs ? ` · ${view.hiddenLibraries} shared-code node${view.hiddenLibraries === 1 ? '' : 's'} hidden` : ''}
            {hidePlanned ? ` · built parts only${view && view.hiddenPlanned > 0 ? ` (${view.hiddenPlanned} planned hidden)` : ''}; change in Settings` : ''}
          </div>
          <div className="zoomctl">
            <button onClick={() => { const c = center(); zoomAt(c.x, c.y, 1.25, true); }} aria-label="Zoom in">+</button>
            <span className="zoomval" aria-live="polite">{Math.round(tf.k * 100)}%</span>
            <button onClick={() => { const c = center(); zoomAt(c.x, c.y, 0.8, true); }} aria-label="Zoom out">−</button>
            <button onClick={() => view && fit(view)}>Fit</button>
          </div>
          {legend && <div className="legend" aria-label="Legend">
            <span><i className="lg verified" />Verified by tests</span>
            <span><i className="lg" />Built</span>
            <span><i className="lg building" />Building</span>
            <span><i className="lg planned" />Planned</span>
            {pending.length > 0 && <span><i className="lg need" />To approve</span>}
            <span><i className="lg unused" />Unused (dead code)</span>
            <span><i className="lg stale" />Stale</span>
            <span><i className="lg failing" />Failing</span>
            <span><b>▶</b> call&nbsp;&nbsp;<b>›</b> one-way message&nbsp;&nbsp;<b>- -</b> planned link</span>
          </div>}
        </div>
        <Panel
          graph={graph}
          ix={ix}
          view={view}
          lens={lens}
          sel={sel}
          setSel={setSel}
          showProblems={showProblems}
          focus={focus}
          expanded={expanded}
          toggle={toggle}
          open={open}
          goTo={goTo}
          flowId={flowId}
          setFlow={(id) => { setFlowId(id); setStep(-1); setPlaying(false); }}
          step={step}
          setStep={(s) => { setStep(s); setPlaying(false); }}
          playing={playing}
          setPlaying={(p) => { setPlaying(p); if (p && step < 0) setStep(0); }}
          shapeId={shapeId}
          setShape={setShapeId}
          pickShape={(id) => { setLens('data'); setShapeId(id); setSel(null); setShowProblems(false); }}
          changeId={changeId}
          setChange={setChangeId}
          approve={approve}
          activityType={activityType}
          setActivityType={setActivityType}
          isInside={isInside}
          docPath={docPath}
          openDoc={setDocPath}
        />
      </div>
    </div>
  );
}

function StatusDot({ x, color, glyph }: { x: number; color: string; glyph: string }) {
  return (
    <g transform={`translate(${x} 3)`}>
      <circle r={8.5} fill={color} stroke="var(--canvas)" strokeWidth={2} />
      <text textAnchor="middle" dominantBaseline="central" fontSize={10.5} fontWeight={700} fill="#fff" style={{ fontFamily: 'var(--sans)' }}>{glyph}</text>
    </g>
  );
}

function Tag({ x, y, text, accent, warn }: { x: number; y: number; text: string; accent?: boolean; warn?: boolean }) {
  const w = text.length * 5.6 + 12;
  return (
    <g transform={`translate(${x} ${y})`} className={warn ? 'tagchip warn' : accent ? 'tagchip accent' : 'tagchip'}>
      <rect x={-w / 2} y={-7} width={w} height={14} rx={7} />
      <text textAnchor="middle" dominantBaseline="central" y={0.5}>{text}</text>
    </g>
  );
}

/** Field list of the shapes on a link, drawn on the canvas next to it. */
function DataCard({ m, only, shapes, at }: { m: VEdge; only: Edge | null; shapes: Map<string, Shape>; at: { x: number; y: number } }) {
  const source = only && m.edges.some((e) => e.id === only.id) ? [only] : m.edges;
  const sections: Array<{ title: string; back: boolean; shape: Shape | null }> = [];
  const seen = new Set<string>();
  for (const e of source) {
    for (const [list, back] of [[e.shapes, false], [e.returns, true]] as const) {
      for (const s of list) {
        const key = `${s}|${back}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sections.push({ title: s, back, shape: shapes.get(s) ?? null });
      }
    }
  }
  if (sections.length === 0) {
    const via = [...new Set(source.map((e) => e.via).filter(Boolean))].join(', ');
    sections.push({ title: source.length === 1 ? `${source[0].verb}${via ? ` over ${via}` : ''}` : `${source.length} links`, back: false, shape: null });
  }
  const shown = sections.slice(0, 3);
  const MAXF = shown.length > 1 ? 5 : 9;
  const lines: Array<{ kind: 'head' | 'field' | 'more' | 'none'; a: string; b?: string; pii?: boolean; back?: boolean }> = [];
  for (const s of shown) {
    lines.push({ kind: 'head', a: s.title, back: s.back });
    if (!s.shape) lines.push({ kind: 'none', a: 'no data shape declared yet' });
    else {
      for (const f of s.shape.fields.slice(0, MAXF)) lines.push({ kind: 'field', a: f.name, b: f.type, pii: f.tags.includes('pii') });
      if (s.shape.fields.length > MAXF) lines.push({ kind: 'more', a: `+${s.shape.fields.length - MAXF} more fields` });
      if (s.shape.fields.length === 0) lines.push({ kind: 'none', a: 'no fields listed yet' });
    }
  }
  if (sections.length > shown.length) lines.push({ kind: 'more', a: `+${sections.length - shown.length} more shapes on this link` });
  const longest = Math.max(...lines.map((l) => (l.kind === 'field' ? l.a.length + (l.b?.length ?? 0) + 4 : l.a.length + 4)));
  const w = Math.min(340, Math.max(170, longest * 6.3 + 24));
  const rowH = 16;
  const h = lines.length * rowH + 14;
  const maxChars = Math.floor((w - 24) / 6.3);
  let y = 7;
  return (
    <g className="card" transform={`translate(${at.x - w / 2} ${at.y + 16})`} pointerEvents="none">
      <path d={`M${w / 2 - 6} 0 L${w / 2} -6 L${w / 2 + 6} 0`} className="card-tip" />
      <rect width={w} height={h} rx={10} className="card-bg" />
      {lines.map((l, i) => {
        const cy = (y += rowH) - rowH / 2;
        if (l.kind === 'head') {
          return (
            <g key={i}>
              {i > 0 && <path d={`M0 ${cy - rowH / 2} H${w}`} className="card-rule" />}
              <text x={12} y={cy} className="card-head" dominantBaseline="central">{l.back ? '↩ ' : ''}{clip(l.a, maxChars)}</text>
            </g>
          );
        }
        if (l.kind === 'field') {
          const room = Math.max(4, maxChars - l.a.length - 2);
          return (
            <text key={i} x={12} y={cy} className="card-field" dominantBaseline="central">
              {l.a}<tspan className="card-type">  {clip(l.b ?? '', room)}</tspan>{l.pii && <tspan className="card-pii"> pii</tspan>}
            </text>
          );
        }
        return <text key={i} x={12} y={cy} className="card-more" dominantBaseline="central">{l.a}</text>;
      })}
    </g>
  );
}
