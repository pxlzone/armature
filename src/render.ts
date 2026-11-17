// Plain-text answers for agents and terminals. Everything here reads a compiled graph.
import picomatch from 'picomatch';
import type { Change, DocInfo, DocRef, Edge, Flow, GNode, Graph, Interface, Problem, Requirement, Shape, Status, Todo } from './types.js';
import { GROUP_TITLE, warningGroup } from './types.js';
import { newPlanPath } from './paths.js';

const STATUS_MARK: Record<Status, string> = {
  retiring: 'retiring', failing: 'FAILING', stale: 'STALE', planned: 'planned', building: 'building', verified: 'verified', built: 'built',
};

function index(g: Graph) {
  return {
    nodes: new Map(g.nodes.map((n) => [n.id, n])),
    shapes: new Map(g.shapes.map((s) => [s.id, s])),
    flows: new Map(g.flows.map((f) => [f.id, f])),
    changes: new Map(g.changes.map((c) => [c.id, c])),
    edges: new Map(g.edges.map((e) => [e.id, e])),
  };
}

function arrow(e: Edge): string {
  const shapes = e.shapes.length ? e.shapes.join(', ') : '(no shape)';
  const back = e.returns.length ? ` => ${e.returns.join(', ')}` : '';
  const via = e.via ? ` via ${e.via}` : '';
  const st = e.status !== 'built' ? ` [${e.status}]` : '';
  const path = e.verb === 'reads' ? `${e.iface ?? e.from} -> ${e.to}` : `${e.from} -> ${e.iface ?? e.to}`;
  return `${path}: ${shapes}${back} (${e.verb}${via})${st}`;
}

function ifaceLine(i: Interface): string {
  const via = i.via ? ` via ${i.via}` : '';
  const route = i.route ? ` ${i.route}` : i.queue ? ` queue ${i.queue}` : '';
  const takes = i.takes.length ? ` takes ${i.takes.join(', ')}` : '';
  const gives = i.gives.length ? ` gives ${i.gives.join(', ')}` : '';
  const st = i.status !== 'built' ? ` [${i.status}]` : '';
  return `${i.ref}${via}${route}${takes}${gives}${st}`;
}

function shapeBlock(s: Shape): string[] {
  const flags = [s.stale ? 'STALE' : '', s.source ? (s.bound ? 'bound' : 'unconfirmed') : 'draft'].filter(Boolean).join(', ');
  const lines = [`shape ${s.id} (${flags})${s.source ? `  source: ${s.source}` : ''}`];
  for (const f of s.fields) lines.push(`  ${f.name}: ${f.type}${f.tags.length ? ` @${f.tags.join(' @')}` : ''}`);
  if (s.fields.length === 0) lines.push('  (no fields listed yet)');
  return lines;
}

function reqLine(q: Requirement): string {
  return `[${q.state}] ${q.ref}: ${q.text}${q.change ? ` (change ${q.change})` : ''}`;
}

function changeLine(c: Change): string {
  const p = c.progress;
  const parts = [];
  if (p.total) parts.push(`${p.built}/${p.total} nodes have code`);
  if (p.reqTotal) parts.push(`${p.reqVerified}/${p.reqTotal} requirements verified`);
  return `${c.id} [${c.state}] ${c.title}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

const ownerCache = new WeakMap<Graph, { code: Array<{ n: GNode; m: (f: string) => boolean }>; tests: Array<{ n: GNode; m: (f: string) => boolean }>; hit: Map<string, GNode | null> }>();

/** The most specific node whose code (or, failing that, tests) globs match a file. Compiled once per graph. */
export function ownerOf(g: Graph, file: string): GNode | null {
  let c = ownerCache.get(g);
  if (!c) {
    const code = g.nodes.filter((n) => n.code.length).map((n) => {
      const pos = n.code.filter((x) => !x.startsWith('!'));
      const neg = n.code.filter((x) => x.startsWith('!')).map((x) => x.slice(1));
      return { n, m: picomatch(pos, { dot: true, ignore: neg }) as (f: string) => boolean };
    }).sort((a, b) => b.n.depth - a.n.depth);
    const tests = g.nodes.filter((n) => n.tests.length).map((n) => ({ n, m: picomatch(n.tests, { dot: true }) as (f: string) => boolean })).sort((a, b) => b.n.depth - a.n.depth);
    c = { code, tests, hit: new Map() };
    ownerCache.set(g, c);
  }
  if (c.hit.has(file)) return c.hit.get(file)!;
  const found = c.code.find((x) => x.m(file))?.n ?? c.tests.find((x) => x.m(file))?.n ?? null;
  c.hit.set(file, found);
  return found;
}

export function orient(g: Graph): string {
  const full = orientText(g, false);
  return full.length <= 9000 ? full : orientText(g, true);
}

function orientText(g: Graph, compact: boolean): string {
  const ix = index(g);
  const out: string[] = [];
  out.push(`# ${g.system.name}: architecture model`);
  out.push(g.system.headline);
  out.push('');
  out.push(`${g.nodes.length} nodes, ${g.edges.length} links, ${g.shapes.length} shapes, ${g.flows.length} flows.${g.system.branch ? ` Branch ${g.system.branch}.` : ''} The model lives in ${g.system.dir}/ and is the map of this repo; keep it true when you change code.`);
  out.push(coverageLine(g));
  const platforms = g.nodes.filter((n) => n.kind === 'platform');
  if (platforms.length) out.push(`Runs on: ${platforms.map((n) => `${n.name} (${n.id})`).join(', ')}.`);
  out.push('');
  out.push('## Nodes');
  const line = (n: GNode, indent: string): void => {
    const st = n.status === 'built' ? '' : ` [${STATUS_MARK[n.status]}]`;
    out.push(`${indent}- ${n.id} (${n.kind})${st}: ${n.role}`);
  };
  const tops = g.nodes.filter((n) => !n.parent);
  const externals = tops.filter((n) => n.kind === 'external' || n.kind === 'actor');
  for (const n of tops.filter((x) => !externals.includes(x))) {
    line(n, '');
    const kids = n.children.map((c) => ix.nodes.get(c)!);
    if (kids.length <= 8 && !compact) for (const k of kids) line(k, '  ');
    else if (kids.length === 0) continue;
    else out.push(`  - ${kids.length} nodes inside: ${kids.map((k) => k.id.split('.').pop()).join(', ')}`);
  }
  if (externals.length) {
    out.push(`- outside the system: ${externals.map((n) => `${n.id}${n.status === 'planned' ? ' [planned]' : ''} (${n.role})`).join('; ')}`);
  }
  if (g.flows.length) {
    out.push('');
    out.push('## Flows');
    const shownFlows = compact ? g.flows.slice(0, 10) : g.flows;
    for (const f of shownFlows) out.push(`- ${f.id}: ${f.headline}`);
    if (shownFlows.length < g.flows.length) out.push(`- and ${g.flows.length - shownFlows.length} more: ${g.flows.slice(shownFlows.length).map((f) => f.id).join(', ')}`);
  }
  const openChanges = g.changes.filter((c) => c.state === 'proposed' || c.state === 'approved');
  if (openChanges.length) {
    out.push('');
    out.push('## Open changes (implement only approved ones)');
    for (const c of openChanges) out.push(`- ${changeLine(c)}`);
  }
  if (g.system.dir !== 'armature') {
    out.push('');
    out.push(`Note: the model is in ${g.system.dir}/, the folder's earlier name. Where a skill or message says armature/, read ${g.system.dir}/. Do not rename the folder unless the person asks.`);
  }
  const bad = g.nodes.filter((n) => (n.status === 'failing' || n.status === 'stale') && n.children.length === 0);
  const errors = g.problems.filter((p) => p.level === 'error');
  const looseDead = g.nodes.filter((n) => n.dead.length && !n.unused);
  const wrong = g.problems.filter((p) => p.level === 'warning' && (p.group ?? warningGroup(p.code)) === 'wrong');
  if (bad.length || errors.length || wrong.length || looseDead.length) {
    out.push('');
    out.push('## Needs attention');
    for (const n of bad) out.push(`- ${n.id} is ${n.status}: ${n.statusWhy}`);
    if (errors.length) out.push(`- armature check reports ${errors.length} error${errors.length === 1 ? '' : 's'}.`);
    if (wrong.length) out.push(`- ${wrong.length} warning${wrong.length === 1 ? '' : 's'} where the model disagrees with the code ("armature check --only wrong"). Trust the code over the model there.`);
    if (looseDead.length) out.push(`- ${looseDead.reduce((a, n) => a + n.dead.length, 0)} code files no entry point reaches ("armature islands"). Do not build on them.`);
  }
  out.push('');
  out.push('## Planning and documents');
  out.push(`- Plan new work in the model before writing code: a change in ${g.system.dir}/changes/<id>.yaml (state: proposed) with its planned elements, and its plan in ${newPlanPath(g.system.docs, g.system.dir)}. The armature-design skill has the steps. In plan mode, the plan you present needs a "Model change" section that lists them.`);
  out.push('- Only a person approves a change. Do not write code for a change that is still proposed, and do not create source files that no node owns.');
  out.push(`- Documents are Markdown with a header (kind, about, change) and [[references]] to nodes, node#interfaces, Shapes, flows and changes. New ones go under ${g.system.docs}/. The armature-docs skill has the format.`);
  out.push('');
  out.push('## Digging deeper');
  out.push('- `armature show <ref>` for a node, node#interface, Shape, flow or change. Add `--depth 2` to include children.');
  out.push('- `armature where <file>` for the node that owns a file, with its rules.');
  out.push('- `armature impact <ref>` for what depends on something before you change it.');
  if (g.code) {
    out.push(`- \`armature map <node>\` for a node's files, most central first, with exported signatures (${g.code.files} files and ${g.code.symbols} symbols are indexed). Use it to pick what to read.`);
    out.push('- `armature context "<task>"` first: the nodes, rules, data, ranked files and tests for that task, within a budget.');
    out.push('- `armature docs <ref>` for the plans and written documents about a node, shape, flow or change.');
    out.push('- `armature callers <symbol>` before changing a signature; `armature tests <file|node|symbol>` for what to run; `armature search "<words>"` to find code by topic.');
    out.push('- `armature symbol <name>` for where something is defined and who imports it. `armature deps <node>` for what a node\'s code imports.');
  }
  out.push('- `armature islands [node]` for dead code; `armature tech [id]` for the technologies and who uses them.');
  out.push(`- \`armature check\` after editing anything under ${g.system.dir}/.`);
  return out.join('\n');
}

/** How much of the repo the model places, and the commit it describes. */
export function coverageLine(g: Graph): string {
  const c = g.coverage;
  if (!c || !c.files) return '';
  const placed = c.owned + c.tech + (c.docs ?? 0) + c.builtin + c.ignored;
  const pct = Math.floor((placed / c.files) * 1000) / 10;
  const snap = g.snapshot?.commit ? ` Snapshot of ${g.snapshot.commit}${g.snapshot.dirty ? ' with uncommitted changes' : ''}.` : '';
  return `Coverage: ${pct}% of ${c.files} files placed (${c.owned} in nodes, ${c.tech} tool files, ${c.docs ?? 0} documents, ${c.ignored} ignored, ${c.builtin} lockfiles and generated); ${c.unowned} unplaced.${snap}`;
}

/** Dead code: files no entry point reaches, by node, and whether the model already says so. */
export function islands(g: Graph, ref?: string): string {
  const scope = ref ? g.nodes.find((n) => n.id === ref || n.id.endsWith(`.${ref}`)) : null;
  if (ref && !scope) return `No node "${ref}".`;
  const inScope = (id: string | null): boolean => !scope || (!!id && (id === scope.id || id.startsWith(`${scope.id}.`)));
  const list = g.dead.filter((d) => inScope(d.node));
  if (!list.length) return scope ? `No dead code under ${scope.id}.` : 'No dead code: every code file is reached from an entry point.';
  const byNode = new Map<string, typeof list>();
  for (const d of list) byNode.set(d.node ?? '(no node)', [...(byNode.get(d.node ?? '(no node)') ?? []), d]);
  const out = [`${list.length} code file${list.length === 1 ? '' : 's'} (${list.reduce((a, d) => a + d.lines, 0)} lines) that no entry point reaches:`];
  for (const [id, files] of [...byNode].sort((a, b) => b[1].length - a[1].length)) {
    const n = g.nodes.find((x) => x.id === id);
    const marked = n && (n.unused || g.nodes.some((x) => x.unused && id.startsWith(`${x.id}.`)));
    out.push('', `${id}${marked ? ' (marked unused)' : ''}`);
    for (const d of files) out.push(`  ${d.path} (${d.lines} lines)`);
  }
  out.push('', 'Entry points: package scripts and bins, container commands, HTML script tags, Temporal workflowsPath, framework conventions, tests, and `entry:` in the model.');
  out.push('A file started by hand belongs in `entry:` on its node. Dead code you keep goes in a node with `unused: true` (drawn grey, no links); otherwise delete it.');
  return out.join('\n');
}

/** Technologies from armature/tech.yaml, by category, or one technology with who uses it. */
export function techText(g: Graph, id?: string): string {
  if (!g.tech.length) return `No ${g.system.dir}/tech.yaml yet. List the frameworks, databases, runtimes and tools there; node \`tech:\` entries then refer to them.`;
  if (id) {
    const t = g.tech.find((x) => x.id === id);
    if (!t) return `No technology "${id}" in tech.yaml.`;
    const lines = [`${t.name} (${t.id}, ${t.category})${t.version ? ` ${t.version}` : ''}${t.url ? ` ${t.url}` : ''}`];
    if (t.note) lines.push(t.note);
    lines.push(t.usedBy.length ? `Used by: ${t.usedBy.join(', ')}` : 'No node names it.');
    if (t.files.length) lines.push(`Owns ${t.fileCount} files: ${t.files.join(', ')}`);
    const runs = g.nodes.filter((n) => n.kind === 'platform' && n.tech.includes(t.id));
    if (runs.length) lines.push(`Runs as: ${runs.map((n) => n.id).join(', ')}`);
    return lines.join('\n');
  }
  const cats = new Map<string, typeof g.tech>();
  for (const t of g.tech) cats.set(t.category, [...(cats.get(t.category) ?? []), t]);
  const out: string[] = [];
  for (const [c, list] of cats) out.push(`${c}: ${list.map((t) => `${t.name}${t.usedBy.length ? ` (${t.usedBy.length})` : ''}`).join(', ')}`);
  return out.join('\n');
}

function nodeCard(g: Graph, n: GNode, depth: number): string[] {
  const ix = index(g);
  const out: string[] = [];
  out.push(`node ${n.id} (${n.kind}) [${STATUS_MARK[n.status]}]: ${n.role}`);
  out.push(`  status: ${n.statusWhy}`);
  if (n.description) out.push(`  about: ${n.description}`);
  if (n.tech.length) out.push(`  tech: ${n.tech.join(', ')}`);
  if (n.code.length) out.push(`  code: ${n.code.join(', ')} (${n.files} files)`);
  if (n.tests.length) out.push(`  tests: ${n.tests.join(', ')} (${n.testFiles} files)`);
  if (n.testSummary) out.push(`  last test run: ${n.testSummary.passed} passed, ${n.testSummary.failed} failed, ${n.testSummary.skipped} skipped`);
  if (n.coverage !== null) out.push(`  coverage: ${n.coverage}%`);
  if (n.change) out.push(`  change: ${n.change}`);
  if (n.unused) out.push('  unused: dead code kept for reference; nothing reaches it and it takes part in no flow.');
  if (n.deployment.length) out.push(`  runs as: ${n.deployment.map((d) => `${d.service} [${d.env}]${d.image ? ` ${d.image}` : ''}`).join(', ')}`);
  if (n.dead.length) out.push(`  dead code: ${n.dead.map((d) => `${d.path} (${d.lines})`).join(', ')}`);
  out.push(`  model file: ${n.source}`);
  if (n.interfaces.length) {
    out.push('  interfaces:');
    for (const i of n.interfaces) out.push(`    ${ifaceLine(i)}`);
  }
  const incoming = g.edges.filter((e) => e.to === n.id);
  const outgoing = g.edges.filter((e) => e.from === n.id);
  if (incoming.length) {
    out.push('  data in:');
    for (const e of incoming) out.push(`    ${arrow(e)}`);
  }
  if (outgoing.length) {
    out.push('  data out:');
    for (const e of outgoing) out.push(`    ${arrow(e)}`);
  }
  if (n.rules.length) {
    out.push('  rules:');
    for (const r of n.rules) out.push(`    - ${r.text}${r.from !== n.id ? ` (from ${r.from})` : ''}`);
  }
  if (n.requirements.length) {
    out.push('  requirements:');
    for (const q of n.requirements) out.push(`    ${reqLine(q)}`);
  }
  if (n.todos.length) {
    out.push('  todos:');
    for (const t of n.todos) out.push(`    - ${todoLine(t)}`);
  }
  if (n.codeMap) {
    out.push(`  code map: ${n.codeMap.files} files, ${n.codeMap.lines} lines, ${n.codeMap.exported} exported symbols. Most central:`);
    for (const f of n.codeMap.top.slice(0, 4)) out.push(`    ${f.path} (${f.lines} lines)${f.symbols.length ? `: ${f.symbols.slice(0, 5).map((x) => x.name).join(', ')}` : ''}`);
    const deps = g.codeDeps.filter((d) => d.from === n.id);
    if (deps.length) out.push(`  code imports: ${deps.map((d) => `${d.to} (${d.count}${d.kind === 'undeclared' ? ', undeclared' : ''})`).join(', ')}`);
  }
  if (n.activity) {
    const v = n.activity;
    out.push(`  activity: ${v.commits} commits, ${v.prsOpen} open and ${v.prsMerged} merged PRs, ${v.authors} author${v.authors === 1 ? '' : 's'}`);
    for (const it of v.recent.slice(0, 5)) out.push(`    ${it.date.slice(0, 10)} ${it.id} ${it.type}${it.scope ? `(${it.scope})` : ''}: ${it.title}`);
  }
  if (n.prs.length) {
    out.push('  open pull requests:');
    for (const p of n.prs) out.push(`    #${p.number} ${p.title}`);
  }
  const inFlows = g.flows.filter((f) => f.steps.some((s) => s.from === n.id || s.to === n.id));
  if (inFlows.length) out.push(`  flows: ${inFlows.map((f) => f.id).join(', ')}`);
  if (n.children.length) {
    if (depth > 1) {
      for (const c of n.children) out.push('', ...nodeCard(g, ix.nodes.get(c)!, depth - 1));
    } else {
      out.push('  children:');
      for (const c of n.children) {
        const k = ix.nodes.get(c)!;
        out.push(`    ${k.id} (${k.kind}) [${STATUS_MARK[k.status]}]: ${k.role}`);
      }
    }
  }
  return out;
}

function resolveNodeRef(g: Graph, ref: string): GNode | null {
  const exact = g.nodes.find((n) => n.id === ref);
  if (exact) return exact;
  const hits = g.nodes.filter((n) => n.id.endsWith(`.${ref}`));
  return hits.length === 1 ? hits[0] : null;
}

export function show(g: Graph, ref: string, depth = 1): string {
  const ix = index(g);
  if (ref.includes('#')) {
    const [nref, iid] = ref.split('#');
    const n = resolveNodeRef(g, nref);
    const i = n?.interfaces.find((x) => x.id === iid);
    if (!n || !i) return `Nothing named "${ref}".`;
    const out = [`interface ${ifaceLine(i)}`];
    if (i.dlq) out.push(`  dead letters go to: ${i.dlq}`);
    if (i.note) out.push(`  note: ${i.note}`);
    const users = g.edges.filter((e) => e.iface === i.ref);
    out.push(users.length ? '  used by:' : '  used by: nothing declared');
    for (const e of users) out.push(`    ${arrow(e)}`);
    for (const s of [...i.takes, ...i.gives]) {
      const sh = ix.shapes.get(s);
      if (sh) out.push('', ...shapeBlock(sh));
    }
    return out.join('\n');
  }
  if (ref.includes(':')) {
    const [nref, slug] = ref.split(':');
    const n = resolveNodeRef(g, nref);
    const q = n?.requirements.find((x) => x.id === slug);
    if (!q) return `Nothing named "${ref}".`;
    const out = [`requirement ${reqLine(q)}`];
    out.push(`  tag a test with: [req ${q.ref}]`);
    for (const e of q.evidence) out.push(`  ${e}`);
    return out.join('\n');
  }
  const shape = ix.shapes.get(ref);
  if (shape) {
    const out = shapeBlock(shape);
    const edges = g.edges.filter((e) => e.shapes.includes(ref) || e.returns.includes(ref));
    if (edges.length) {
      out.push('  travels on:');
      for (const e of edges) out.push(`    ${arrow(e)}`);
    }
    return out.join('\n');
  }
  const flow = ix.flows.get(ref);
  if (flow) return showFlow(g, flow);
  const change = ix.changes.get(ref);
  if (change) return showChange(g, change);
  const n = resolveNodeRef(g, ref);
  if (n) return nodeCard(g, n, depth).join('\n');
  return `Nothing named "${ref}". Try "armature orient" for the list of nodes, flows and changes.`;
}

function showFlow(g: Graph, f: Flow): string {
  const ix = index(g);
  const out = [`flow ${f.id}: ${f.headline}`];
  if (f.trigger) out.push(`  trigger: ${f.trigger}`);
  if (f.change) out.push(`  change: ${f.change}`);
  f.steps.forEach((s, i) => {
    const e = s.edge ? ix.edges.get(s.edge) : undefined;
    out.push(`  ${i + 1}. ${e ? arrow(e) : `${s.text} (no matching link)`}${s.note ? `  -- ${s.note}` : ''}`);
  });
  return out.join('\n');
}

function showChange(g: Graph, c: Change): string {
  const ix = index(g);
  const out = [`change ${changeLine(c)}`];
  if (c.why) out.push(`  why: ${c.why}`);
  if (c.doc) out.push(`  doc: ${c.doc}`);
  if (c.issue) out.push(`  issue: #${c.issue}`);
  if (c.doneWhen.length) {
    out.push('  done when:');
    for (const d of c.doneWhen) out.push(`    - ${d}`);
  }
  if (c.nodes.length) {
    out.push('  nodes:');
    for (const id of c.nodes) {
      const n = ix.nodes.get(id)!;
      out.push(`    ${n.id} [${STATUS_MARK[n.status]}]: ${n.role}`);
    }
  }
  if (c.interfaces.length) out.push(`  interfaces: ${c.interfaces.join(', ')}`);
  if (c.edges.length) {
    out.push('  links:');
    for (const id of c.edges) out.push(`    ${arrow(ix.edges.get(id)!)}`);
  }
  if (c.shapes.length) out.push(`  shapes: ${c.shapes.join(', ')}`);
  if (c.flows.length) out.push(`  flows: ${c.flows.join(', ')}`);
  if (c.requirements.length) {
    out.push('  requirements:');
    for (const r of c.requirements) {
      const [nid, slug] = r.split(':');
      const q = ix.nodes.get(nid)?.requirements.find((x) => x.id === slug);
      if (q) out.push(`    ${reqLine(q)}`);
    }
  }
  if (c.state === 'proposed') out.push('  This change is proposed. A person must approve it before it is implemented.');
  return out.join('\n');
}

export function where(g: Graph, file: string): string {
  const n = ownerOf(g, file);
  if (!n) return `No node owns "${file}". If it is real source code, add it to a node's code globs (or to a new node) under ${g.system.dir}/nodes/.`;
  return [`"${file}" belongs to:`, '', ...nodeCard(g, n, 1)].join('\n');
}

export function impact(g: Graph, ref: string): string {
  const ix = index(g);
  const out: string[] = [];
  const shape = ix.shapes.get(ref);
  if (shape) {
    out.push(`Changing shape ${ref} touches:`);
    const edges = g.edges.filter((e) => e.shapes.includes(ref) || e.returns.includes(ref));
    const ifaces = g.nodes.flatMap((n) => n.interfaces).filter((i) => i.takes.includes(ref) || i.gives.includes(ref));
    const nested = g.shapes.filter((s) => s.fields.some((f) => new RegExp(`\\b${ref}\\b`).test(f.type)));
    for (const i of ifaces) out.push(`  interface ${ifaceLine(i)}`);
    for (const e of edges) out.push(`  link ${arrow(e)}`);
    for (const s of nested) out.push(`  shape ${s.id} embeds it`);
    const nodes = new Set([...edges.flatMap((e) => [e.from, e.to]), ...ifaces.map((i) => i.node)]);
    if (nodes.size) out.push(`  nodes whose code reads or writes it: ${[...nodes].join(', ')}`);
    docsNaming(g, out, (r) => r.type === 'shape' && r.id === ref);
    if (out.length === 1) out.push('  nothing declared.');
    return out.join('\n');
  }
  if (ref.includes('#')) {
    const [nref, iid] = ref.split('#');
    const n = resolveNodeRef(g, nref);
    const i = n?.interfaces.find((x) => x.id === iid);
    if (!i) return `Nothing named "${ref}".`;
    out.push(`Changing interface ${i.ref} touches:`);
    const users = g.edges.filter((e) => e.iface === i.ref);
    for (const e of users) out.push(`  link ${arrow(e)}`);
    const flows = g.flows.filter((f) => f.steps.some((s) => s.edge && users.some((e) => e.id === s.edge)));
    if (flows.length) out.push(`  flows: ${flows.map((f) => f.id).join(', ')}`);
    docsNaming(g, out, (r) => r.type === 'interface' && r.id === i.ref);
    if (out.length === 1) out.push('  nothing declared.');
    return out.join('\n');
  }
  const n = resolveNodeRef(g, ref);
  if (!n) return `Nothing named "${ref}".`;
  const inside = (id: string): boolean => id === n.id || id.startsWith(`${n.id}.`);
  const incoming = g.edges.filter((e) => inside(e.to) && !inside(e.from));
  const outgoing = g.edges.filter((e) => inside(e.from) && !inside(e.to));
  out.push(`Changing node ${n.id} touches:`);
  if (incoming.length) {
    out.push('  nodes that send it data:');
    for (const e of incoming) out.push(`    ${arrow(e)}`);
  }
  if (outgoing.length) {
    out.push('  nodes it sends data to:');
    for (const e of outgoing) out.push(`    ${arrow(e)}`);
  }
  const flows = g.flows.filter((f) => f.steps.some((s) => inside(s.from) || inside(s.to)));
  if (flows.length) out.push(`  flows: ${flows.map((f) => f.id).join(', ')}`);
  const reqs = g.nodes.filter((x) => inside(x.id)).flatMap((x) => x.requirements);
  if (reqs.length) {
    out.push('  requirements that must keep holding:');
    for (const q of reqs) out.push(`    ${reqLine(q)}`);
  }
  docsNaming(g, out, (r) => !!r.node && inside(r.node));
  if (out.length === 1) out.push('  nothing declared.');
  return out.join('\n');
}

/** Documents whose header or [[references]] name an element: they need a look when it changes. */
function docsNaming(g: Graph, out: string[], hit: (r: DocRef) => boolean): void {
  const docs = g.docs.filter((d) => d.refs.some(hit));
  if (!docs.length) return;
  out.push('  documents that name it (update them in the same change):');
  for (const d of docs.slice(0, 12)) out.push(`    ${d.path}${d.kind ? ` (${d.kind})` : ''}: ${d.title}`);
  if (docs.length > 12) out.push(`    … ${docs.length - 12} more`);
}

export function status(g: Graph): string {
  const leaves = g.nodes.filter((n) => n.children.length === 0);
  const counts = new Map<Status, number>();
  for (const n of leaves) counts.set(n.status, (counts.get(n.status) ?? 0) + 1);
  const out = [`${g.system.name}: ${leaves.length} leaf nodes`];
  for (const s of ['verified', 'built', 'building', 'planned', 'stale', 'failing', 'retiring'] as Status[]) {
    const c = counts.get(s);
    if (c) out.push(`  ${s.padEnd(9)} ${c}  ${leaves.filter((n) => n.status === s).map((n) => n.id).join(', ')}`);
  }
  const reqs = g.nodes.flatMap((n) => n.requirements);
  if (reqs.length) {
    out.push(`requirements: ${reqs.filter((q) => q.state === 'verified').length} verified, ${reqs.filter((q) => q.state === 'failing').length} failing, ${reqs.filter((q) => q.state === 'unverified').length} unverified`);
  }
  out.push(`reports: ${g.system.reports.junit} JUnit, ${g.system.reports.lcov} lcov`);
  if (g.changes.length) {
    out.push('changes:');
    for (const c of g.changes) out.push(`  ${changeLine(c)}`);
  }
  const all = g.nodes.flatMap((n) => n.todos);
  if (all.length) {
    const debt = all.filter((t) => t.kind === 'debt').length;
    out.push(`todos: ${all.length} (${debt} debt). Run "armature todos" for the list.`);
  }
  return out.join('\n');
}

/** Commit and pull-request activity per node, busiest first. */
export function activity(g: Graph): string {
  const a = g.activity;
  if (!a) return 'No activity data. This needs a git repository.';
  const out = [`Last ${a.days} days: ${a.commits} commits (${a.conventional} follow Conventional Commits)${a.prsLoaded ? `, ${a.prs} pull requests` : '; pull requests not loaded (add --github)'}.`];
  const types = Object.entries(a.byType).sort((x, y) => y[1] - x[1]).map(([t, c]) => `${t} ${c}`).join(', ');
  if (types) out.push(`By type: ${types}.`);
  // Busiest first, with each parent followed by its own children.
  const rows: GNode[] = [];
  const walk = (parent: string | null): void => {
    for (const n of g.nodes.filter((x) => x.parent === parent && x.activity).sort((x, y) => total(y) - total(x))) {
      rows.push(n);
      walk(n.id);
    }
  };
  walk(null);
  out.push('Per node (parents include their children):');
  for (const n of rows.slice(0, 60)) {
    const v = n.activity!;
    const prs = v.prsOpen + v.prsMerged + v.prsClosed;
    const top = Object.entries(v.byType).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t, c]) => `${t} ${c}`).join(', ');
    out.push(`  ${'  '.repeat(n.depth)}${n.id}: ${v.commits} commits${prs ? `, ${prs} PRs (${v.prsOpen} open)` : ''}, ${v.authors} author${v.authors === 1 ? '' : 's'} [${top}]`);
  }
  if (a.unmatchedScopes.length) out.push(`Scopes that match no node: ${a.unmatchedScopes.map((u) => `${u.scope} (${u.count})`).join(', ')}. Add "scopes:" to a node to claim one.`);
  if (a.unmapped) out.push(`${a.unmapped} items touched no modelled file and carried no known scope.`);
  return out.join('\n');
}

function total(n: GNode): number {
  const v = n.activity;
  return v ? v.commits + v.prsOpen + v.prsMerged + v.prsClosed : 0;
}

/** One document on one line: path, kind, title and its status (computed for plans). */
function docLine(d: DocInfo, tag = ''): string {
  const st = d.state ?? (d.status ? `status: ${d.status}` : '');
  return `${d.path}: ${d.title}${d.kind ? ` (${d.kind})` : ''}${st ? ` (${st})` : ''}${tag}`;
}

/** Plans and documents about a node and what is inside it, about a shape, flow or change, or the whole library. */
export function docsText(g: Graph, ref?: string, opts: { loose?: boolean } = {}): string {
  const rank = { declared: 3, inside: 2, mentions: 1 } as const;
  if (opts.loose) {
    const loose = g.docs.filter((d) => d.loose);
    if (!loose.length) return 'Every document is tied to the model.';
    const out = [`${loose.length} document${loose.length === 1 ? ' is' : 's are'} not tied to the model. Give each a header (kind, about), or list it under a node's "docs:". The nodes each one mentions most are a starting point for "about":`];
    for (const d of loose.slice(0, 200)) {
      const hint = d.links.slice(0, 4).map((l) => l.node).join(', ');
      out.push(`  ${d.path}: ${d.title}${hint ? `  -> mentions ${hint}` : ''}`);
    }
    if (loose.length > 200) out.push(`  … ${loose.length - 200} more`);
    return out.join('\n');
  }
  let scope: GNode | null = null;
  if (ref) {
    scope = g.nodes.find((n) => n.id === ref) ?? null;
    if (!scope && !ref.includes('#') && !ref.includes(':')) {
      const hits = g.nodes.filter((n) => n.id.endsWith(`.${ref}`));
      scope = hits.length === 1 ? hits[0] : null;
    }
    if (!scope) {
      // Not a node: a shape, interface, requirement, flow or change that documents name.
      const change = g.changes.find((c) => c.id === ref);
      const named = g.docs.filter((d) => d.refs.some((r) => r.id === ref) || (change && d.changes.includes(change.id)));
      const known = change || g.shapes.some((x) => x.id === ref) || g.flows.some((f) => f.id === ref) || g.nodes.some((n) => n.interfaces.some((i) => i.ref === ref) || n.requirements.some((q) => q.ref === ref));
      if (!known) return `Nothing named "${ref}".`;
      const out = [`Documents that name ${ref}:`];
      if (change) out.push(`  change ${change.id} [${change.state}] ${change.title}`);
      for (const d of named) out.push(`  ${docLine(d)}`);
      if (!named.length) out.push('  none.');
      return out.join('\n');
    }
  }
  const byPath = new Map(g.docs.map((d) => [d.path, d]));
  const best = new Map<string, { how: keyof typeof rank; count: number; via: string }>();
  for (const n of g.nodes) {
    if (scope && !(n.id === scope.id || n.id.startsWith(`${scope.id}.`))) continue;
    for (const l of n.docs) {
      const prev = best.get(l.path);
      if (!prev || rank[l.how] > rank[prev.how]) best.set(l.path, { how: l.how, count: (prev?.count ?? 0) + l.count, via: n.id });
      else prev.count += l.count;
    }
  }
  const list = scope ? [...best].map(([p, v]) => ({ d: byPath.get(p)!, ...v })) : g.docs.map((d) => ({ d, how: 'mentions' as const, count: d.links.length, via: '' }));
  list.sort((a, b) => rank[b.how] - rank[a.how] || b.count - a.count || a.d.path.localeCompare(b.d.path));
  const inside = (id: string): boolean => !scope || id === scope.id || id.startsWith(`${scope.id}.`);
  const plans = g.changes.filter((c) => c.nodes.some(inside) || c.interfaces.some((r) => inside(r.split('#')[0])) || c.requirements.some((r) => inside(r.split(':')[0])));
  const tied = g.docs.filter((d) => d.model).length;
  const out: string[] = [scope ? `Plans and documents for ${scope.id}:` : `${g.docs.length} documents in the repo, ${tied} with a header that ties them to the model.`];
  if (plans.length) {
    out.push('plans:');
    for (const c of plans) out.push(`  ${c.id} [${c.state}] ${c.title}${c.doc ? `  -> ${c.doc}` : ''}`);
  }
  out.push('documents (read the files directly):');
  for (const x of list.slice(0, scope ? 40 : 300)) {
    const tag = scope ? ` [${x.how === 'declared' ? 'named in the model' : x.how === 'inside' ? 'inside its code' : `mentions it ${x.count}x`}${x.via && x.via !== scope.id ? `, ${x.via}` : ''}]` : x.d.links.length ? ` [${x.d.links.slice(0, 3).map((l) => l.node).join(', ')}${x.d.links.length > 3 ? ', …' : ''}]` : '';
    out.push(`  ${docLine(x.d, tag)}`);
  }
  if (list.length > (scope ? 40 : 300)) out.push(`  … ${list.length - (scope ? 40 : 300)} more`);
  const looseCount = scope ? 0 : g.docs.filter((d) => d.loose).length;
  if (looseCount) out.push(`${looseCount} not tied to the model: "armature docs --loose".`);
  return out.join('\n');
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;

function todoLine(t: Todo): string {
  const meta = [t.kind, t.priority !== 'medium' ? t.priority : '', t.owner ? `@${t.owner}` : '', t.issue ? `#${t.issue}` : ''].filter(Boolean).join(', ');
  return `[${meta}] ${t.text}`;
}

/** Every todo in the model, most urgent first. `kind` narrows to one kind, for example "debt". */
export function todos(g: Graph, kind?: string): string {
  const all = g.nodes.flatMap((n) => n.todos).filter((t) => !kind || t.kind === kind);
  if (all.length === 0) return kind ? `No ${kind} todos.` : 'No todos.';
  all.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.node.localeCompare(b.node));
  const out = [`${all.length} todo${all.length === 1 ? '' : 's'}${kind ? ` of kind ${kind}` : ''}, most urgent first:`];
  for (const t of all) out.push(`  ${t.node}: ${todoLine(t)}`);
  return out.join('\n');
}

/** Errors first, then warnings in two groups: where the model is wrong, then where it is incomplete. */
export function formatProblems(problems: Problem[]): string {
  const errors = problems.filter((p) => p.level === 'error');
  const warnings = problems.filter((p) => p.level === 'warning');
  const wrong = warnings.filter((p) => (p.group ?? warningGroup(p.code)) === 'wrong');
  const incomplete = warnings.filter((p) => (p.group ?? warningGroup(p.code)) === 'incomplete');
  const out: string[] = [];
  const fmt = (p: Problem): string => `  ${p.level === 'error' ? 'error  ' : 'warning'} [${p.code}] ${p.message}${p.file ? `  (${p.file})` : ''}`;
  if (errors.length) {
    out.push(`Errors: the model is broken (${errors.length})`);
    for (const p of errors) out.push(fmt(p));
  }
  for (const [list, group] of [[wrong, 'wrong'], [incomplete, 'incomplete']] as const) {
    if (!list.length) continue;
    if (out.length) out.push('');
    out.push(`${GROUP_TITLE[group]} (${list.length})`);
    for (const p of list) out.push(fmt(p));
  }
  if (out.length) out.push('');
  out.push(`${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${wrong.length} wrong, ${incomplete.length} incomplete.`);
  return out.join('\n');
}
