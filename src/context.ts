// Answers built on the code index for agents: ranked search, callers of a symbol, tests to run,
// runtime drift, hotspots, and the task-shaped context pack.
import { mustHold } from './security.js';
import fs from 'node:fs';
import path from 'node:path';
import { importersOf, rankFiles, stem, words, type CodeFile, type CodeIndex } from './code.js';
import { MODEL_DIR } from './paths.js';
import { coChange, hotspots, readHistory, type History } from './history.js';
import { ownerOf } from './render.js';
import type { GNode, Graph } from './types.js';

const NO_INDEX = 'No code index yet. Run "armature index" first.';

/** Ranking weights. Chosen with "armature eval retrieval" on held-out commits; overridable for experiments. */
export const TUNE = {
  b: Number(process.env.ARMATURE_B ?? 0.3),
  cover: Number(process.env.ARMATURE_COVER ?? 1.5),
  graph: Number(process.env.ARMATURE_GRAPH ?? 0.35),
  cochange: Number(process.env.ARMATURE_COCHANGE ?? 0.25),
  node: Number(process.env.ARMATURE_NODE ?? 0.15),
};

export function readSummaries(root: string): Record<string, { hash: string; text: string }> {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, MODEL_DIR, '.cache', 'summaries.json'), 'utf8'));
  } catch {
    return {};
  }
}

// ---- ranked search -----------------------------------------------------------

export interface Ranked {
  path: string;
  score: number;
}

/** BM25 over each file's weighted terms (path, names, doc comments, summaries, then body text). */
export class FileSearch {
  private df = new Map<string, number>();
  private len = new Map<string, number>();
  private avg = 1;
  private n = 0;
  constructor(private idx: CodeIndex, private summaries: Record<string, { hash: string; text: string }> = {}) {
    for (const f of Object.values(idx.files)) {
      const t = this.terms(f);
      this.n++;
      let l = 0;
      for (const [w, c] of Object.entries(t)) {
        this.df.set(w, (this.df.get(w) ?? 0) + 1);
        l += c;
      }
      this.len.set(f.path, l);
    }
    this.avg = [...this.len.values()].reduce((a, b) => a + b, 0) / Math.max(1, this.n);
  }
  terms(f: CodeFile): Record<string, number> {
    const s = this.summaries[f.path];
    if (!s || s.hash !== f.hash) return f.terms ?? {};
    const t = { ...(f.terms ?? {}) };
    for (const w of words(s.text)) t[w] = (t[w] ?? 0) + 2;
    return t;
  }
  idf(w: string): number {
    const d = this.df.get(w) ?? 0;
    return Math.log(1 + (this.n - d + 0.5) / (d + 0.5));
  }
  score(f: CodeFile, q: string[]): number {
    const t = this.terms(f);
    const l = this.len.get(f.path) ?? this.avg;
    const b = TUNE.b;
    let s = 0;
    let hit = 0;
    for (const w of q) {
      const tf = t[w] ?? 0;
      if (!tf) continue;
      hit++;
      s += (this.idf(w) * tf * 2.2) / (tf + 1.2 * (1 - b + b * (l / this.avg)));
    }
    // Files that match more of the task's words rank higher than files that match one word often.
    return s * (1 + TUNE.cover * (hit / q.length));
  }
  rank(query: string, filter: (f: CodeFile) => boolean = () => true): Ranked[] {
    const q = [...new Set(words(query))];
    if (!q.length) return [];
    const out: Ranked[] = [];
    for (const f of Object.values(this.idx.files)) {
      if (!filter(f)) continue;
      const s = this.score(f, q);
      if (s > 0) out.push({ path: f.path, score: s });
    }
    return out.sort((a, b) => b.score - a.score);
  }
}

export function searchText(g: Graph, idx: CodeIndex | null, root: string, query: string, limit = 15): string {
  if (!idx) return NO_INDEX;
  const fs2 = new FileSearch(idx, readSummaries(root));
  const hits = fs2.rank(query, (f) => !f.test).slice(0, limit);
  if (!hits.length) return `Nothing matches "${query}".`;
  const q = new Set(words(query));
  const out = [`${hits.length} files for "${query}", best first:`];
  for (const h of hits) {
    const f = idx.files[h.path];
    const node = ownerOf(g, h.path);
    const syms = f.symbols.filter((s) => s.kind !== 'reexport' && words(s.name).some((w) => q.has(w))).slice(0, 3);
    out.push(`${h.path}${node ? ` [${node.id}]` : ''}`);
    for (const s of syms) out.push(`  ${s.sig}  :${s.line}`);
  }
  return out.join('\n');
}

// ---- callers -----------------------------------------------------------------

export interface CallSite {
  file: string;
  line: number;
  in?: string;
  count: number;
  called: boolean;
}

/** Every use of a top-level symbol: in its own file, and in files that import it (directly or through a re-export). */
export function callersOf(idx: CodeIndex, file: string, name: string): CallSite[] {
  const out: CallSite[] = [];
  const def = idx.files[file];
  for (const r of def?.refs ?? []) if (r.n === name && r.in !== name) out.push({ file, line: r.l, in: r.in, count: r.x, called: !!r.c });
  // Files that re-export the symbol stand in for its definition (index files, barrels).
  const sources = new Set<string>([file]);
  for (const f of Object.values(idx.files)) {
    if (f.imports.some((i) => i.file === file && (i.names.includes(name) || i.names.includes('*'))) && f.symbols.some((s) => s.kind === 'reexport' && (s.name === name || s.name === '*'))) sources.add(f.path);
  }
  for (const f of Object.values(idx.files)) {
    if (f.path === file) continue;
    const locals = new Set<string>();
    for (const i of f.imports) {
      if (!i.file || !sources.has(i.file)) continue;
      for (const [local, imported] of Object.entries(i.as ?? {})) {
        if (imported === name) locals.add(local);
        if (imported === '*') locals.add(`${local}.${name}`);
      }
      if (!i.as && i.names.includes(name)) locals.add(name);
    }
    if (!locals.size) continue;
    let any = false;
    for (const r of f.refs ?? []) {
      if (!locals.has(r.n)) continue;
      out.push({ file: f.path, line: r.l, in: r.in, count: r.x, called: !!r.c });
      any = true;
    }
    if (!any && !f.symbols.some((s) => s.kind === 'reexport')) out.push({ file: f.path, line: 0, count: 0, called: false });
  }
  return out;
}

function definitions(idx: CodeIndex, name: string): Array<{ f: CodeFile; s: CodeFile['symbols'][number] }> {
  const out: Array<{ f: CodeFile; s: CodeFile['symbols'][number] }> = [];
  for (const f of Object.values(idx.files)) for (const s of f.symbols) if (s.name === name && s.kind !== 'reexport') out.push({ f, s });
  return out;
}

/** Tests that import a file directly or through an index file. */
export function testsForFiles(idx: CodeIndex, files: string[]): string[] {
  const importers = new Map<string, string[]>();
  for (const f of Object.values(idx.files)) for (const i of f.imports) if (i.file) importers.set(i.file, [...(importers.get(i.file) ?? []), f.path]);
  const out = new Set<string>();
  for (const file of files) {
    for (const u of importers.get(file) ?? []) {
      if (idx.files[u]?.test) out.add(u);
      else if (/(^|\/)index\.[cm]?[jt]sx?$/.test(u)) for (const v of importers.get(u) ?? []) if (idx.files[v]?.test) out.add(v);
    }
  }
  return [...out].sort();
}

export function callersText(g: Graph, idx: CodeIndex | null, name: string): string {
  if (!idx) return NO_INDEX;
  const defs = definitions(idx, name);
  if (!defs.length) return `No top-level symbol named "${name}". Try "armature search ${name}".`;
  const out: string[] = [];
  for (const { f, s } of defs.slice(0, 5)) {
    const node = ownerOf(g, f.path);
    out.push(`${s.sig}`);
    out.push(`  defined at ${f.path}:${s.line}${node ? ` [${node.id}]` : ''}`);
    const sites = callersOf(idx, f.path, name);
    if (!sites.length) {
      out.push('  no uses found in indexed files');
      continue;
    }
    const byNode = new Map<string, CallSite[]>();
    for (const c of sites) {
      const id = ownerOf(g, c.file)?.id ?? '(no node)';
      byNode.set(id, [...(byNode.get(id) ?? []), c]);
    }
    out.push(`  used in ${new Set(sites.map((c) => c.file)).size} file${sites.length === 1 ? '' : 's'} across ${byNode.size} node${byNode.size === 1 ? '' : 's'}:`);
    for (const [id, list] of [...byNode].sort((a, b) => b[1].length - a[1].length)) {
      out.push(`  ${id}:`);
      for (const c of list.slice(0, 12)) out.push(`    ${c.file}${c.line ? `:${c.line}` : ''}${c.in ? ` in ${c.in}` : ''}${c.called ? ' (call)' : c.line ? ' (reference)' : ' (imported)'}${c.count > 1 ? ` x${c.count}` : ''}`);
      if (list.length > 12) out.push(`    … ${list.length - 12} more`);
    }
    const tests = testsForFiles(idx, [f.path, ...new Set(sites.map((c) => c.file))]).slice(0, 10);
    if (tests.length) out.push(`  tests that exercise it or its callers: ${tests.join(', ')}`);
  }
  if (defs.length > 5) out.push(`… ${defs.length - 5} more definitions with this name`);
  out.push('Found from imports and identifier uses, not from the type checker: a method called on an object is not resolved.');
  return out.join('\n');
}

export function testsText(g: Graph, idx: CodeIndex | null, ref: string): string {
  if (!idx) return NO_INDEX;
  let files: string[] = [];
  let label = ref;
  if (idx.files[ref]) files = [ref];
  else {
    const node = g.nodes.find((n) => n.id === ref) ?? (g.nodes.filter((n) => n.id.endsWith(`.${ref}`)).length === 1 ? g.nodes.find((n) => n.id.endsWith(`.${ref}`)) : undefined);
    if (node) {
      label = node.id;
      const tests = node.testedBy.length ? node.testedBy : [];
      const declared = node.tests.length ? ` Declared test globs: ${node.tests.join(', ')}.` : '';
      if (!tests.length) return `No test file imports the code of ${node.id}.${declared}`;
      return [`${tests.length} test file${tests.length === 1 ? '' : 's'} import the code of ${node.id}:${declared}`, ...tests.map((t) => `  ${t}`)].join('\n');
    }
    const defs = definitions(idx, ref);
    if (!defs.length) return `Nothing named "${ref}". Give a file, a node or a symbol.`;
    files = [...new Set(defs.flatMap((d) => [d.f.path, ...callersOf(idx, d.f.path, ref).map((c) => c.file)]))];
    label = `${ref} and its callers`;
  }
  const tests = testsForFiles(idx, files);
  if (!tests.length) return `No test file imports ${label}.`;
  return [`${tests.length} test file${tests.length === 1 ? '' : 's'} for ${label}:`, ...tests.map((t) => `  ${t}`)].join('\n');
}

// ---- runtime drift and history -------------------------------------------------

export function driftText(g: Graph, ref?: string): string {
  if (!g.code) return NO_INDEX;
  const inside = (id: string): boolean => !ref || id === ref || id.startsWith(`${ref}.`);
  const reports = g.runtime.filter((r) => inside(r.node) && (r.undeclared.length || r.unseen.length));
  const cover = detectorNote(g, inside);
  if (!reports.length) return [ref ? `Nothing found in the code of ${ref} contradicts the declared links.` : 'Nothing found in the code contradicts the declared links.', ...cover].join('\n');
  const out: string[] = [];
  if (!ref) {
    const und = reports.reduce((n, r) => n + r.undeclared.length, 0);
    const uns = reports.reduce((n, r) => n + r.unseen.length, 0);
    out.push(`${und} things the code does that the model does not declare, ${uns} declared table links not seen in the code, across ${reports.length} nodes.`);
  }
  for (const r of reports.slice(0, ref ? 50 : 30)) {
    out.push(`${r.node}: ${r.confirmed} confirmed`);
    for (const u of r.undeclared.slice(0, ref ? 40 : 6)) out.push(`  in code, not in model: ${u.kind} ${u.what}${u.op ? ` (${u.op})` : ''}${u.file ? `  ${u.file}:${u.line}` : ''}`);
    if (!ref && r.undeclared.length > 6) out.push(`  … ${r.undeclared.length - 6} more`);
    for (const u of r.unseen.slice(0, ref ? 40 : 4)) out.push(`  in model, not seen in code: ${u.kind} ${u.what} (${u.op})`);
  }
  out.push('Detected from route registrations, HTTP paths in strings, Temporal task queues and workflow starts, Drizzle and Supabase table access, and SQL text. Fix the model or the code, whichever is wrong.');
  out.push(...cover);
  return out.join('\n');
}

/** What the drift check could see, per node: no finding on a node it cannot read means nothing. */
function detectorNote(g: Graph, inside: (id: string) => boolean): string[] {
  const all = g.detectors.filter((d) => inside(d.node));
  if (!all.length) return [];
  const names: Record<string, string> = { route: 'routes', http: 'HTTP calls', queue: 'queues', workflow: 'workflows', table: 'tables' };
  const seen = all.filter((d) => d.kinds.length);
  const unread = all.filter((d) => !d.kinds.length && d.indexed === 0);
  const blank = all.filter((d) => !d.kinds.length && d.indexed > 0);
  const out: string[] = [];
  if (seen.length) out.push(`Checked: ${seen.map((d) => `${d.node} (${d.kinds.map((k) => names[k] ?? k).join(', ')})`).join('; ')}.`);
  const not: string[] = [];
  if (unread.length) not.push(`${unread.map((d) => d.node).join(', ')} (no file in a language the code index reads)`);
  if (blank.length) not.push(`${blank.map((d) => d.node).join(', ')} (no route, table, queue or HTTP pattern the index knows)`);
  if (not.length) out.push(`Not checked: ${not.join('; ')}. Their links and interfaces are unverified, not confirmed.`);
  return out;
}

export function hotspotsText(g: Graph, idx: CodeIndex | null, root: string, ref?: string): string {
  const h = readHistory(root);
  if (!h) return 'No git history.';
  const inside = (f: string): boolean => {
    if (!ref) return true;
    const n = ownerOf(g, f);
    return !!n && (n.id === ref || n.id.startsWith(`${ref}.`));
  };
  const list = hotspots(h, (f) => (inside(f) ? idx?.files[f]?.lines : undefined), 20);
  const out = [`Files that change most and are largest${ref ? ` in ${ref}` : ''} (last ${h.commits.length} commits):`];
  for (const x of list) {
    const n = ownerOf(g, x.path);
    out.push(`  ${x.path}${n ? ` [${n.id}]` : ''}: ${x.changes} changes, ${x.lines} lines`);
  }
  return out.join('\n');
}

// ---- context pack --------------------------------------------------------------

export interface ContextOptions {
  budget?: number;
  /** Files already in play (open, or named in the task). */
  files?: string[];
  /** For the evaluation: commits whose co-change evidence must be ignored. */
  skipCommits?: Set<string>;
  history?: History | null;
  summaries?: Record<string, { hash: string; text: string }>;
  /** Turn parts of the ranking off, to measure what each one adds. */
  use?: { graph?: boolean; nodes?: boolean; cochange?: boolean };
}

export interface ContextResult {
  nodes: Array<{ id: string; score: number }>;
  files: Ranked[];
  text: string;
}

function nodeTerms(g: Graph, n: GNode): Map<string, number> {
  const t = new Map<string, number>();
  const add = (s: string | undefined, w: number): void => {
    if (!s) return;
    for (const x of words(s)) t.set(x, (t.get(x) ?? 0) + w);
  };
  add(n.id, 4);
  add(n.name, 4);
  add(n.role, 3);
  add(n.description, 1.5);
  for (const i of n.interfaces) {
    add(i.id, 2);
    add(i.route, 1);
    for (const s of [...i.takes, ...i.gives]) add(s, 1.5);
  }
  for (const r of n.requirements) add(r.text, 1);
  for (const td of n.todos) add(td.text, 0.5);
  void g;
  return t;
}

/** Personalised PageRank over the import graph, both directions, from the seed files. */
function spread(idx: CodeIndex, seeds: Map<string, number>, iterations = 20): Map<string, number> {
  const nbr = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    nbr.set(a, [...(nbr.get(a) ?? []), b]);
  };
  for (const f of Object.values(idx.files)) for (const i of f.imports) if (i.file && idx.files[i.file] && i.file !== f.path) {
    link(f.path, i.file);
    link(i.file, f.path);
  }
  const total = [...seeds.values()].reduce((a, b) => a + b, 0) || 1;
  const p = new Map([...seeds].map(([k, v]) => [k, v / total]));
  let r = new Map(p);
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    for (const [k, v] of p) next.set(k, 0.3 * v);
    for (const [k, v] of r) {
      const ns = nbr.get(k);
      if (!ns?.length) continue;
      const share = (0.7 * v) / ns.length;
      for (const n of ns) next.set(n, (next.get(n) ?? 0) + share);
    }
    r = next;
  }
  return r;
}

/** Ranks nodes and files for a task, and renders what an agent needs within a budget. */
export function contextPack(g: Graph, idx: CodeIndex, root: string, task: string, opt: ContextOptions = {}): ContextResult {
  const budget = opt.budget ?? 6000;
  const use = { graph: true, nodes: true, cochange: true, ...(opt.use ?? {}) };
  const summaries = opt.summaries ?? readSummaries(root);
  const search = new FileSearch(idx, summaries);
  const q = [...new Set(words(task))];
  const fileOwner = new Map<string, GNode | null>();
  const ownerCached = (f: string): GNode | null => {
    if (!fileOwner.has(f)) fileOwner.set(f, ownerOf(g, f));
    return fileOwner.get(f)!;
  };

  // 1. Lexical scores for files and nodes.
  const lex = search.rank(task, (f) => !f.test).slice(0, 400);
  const lexMax = lex[0]?.score ?? 1;
  const nodeScore = new Map<string, number>();
  if (use.nodes) {
    const docs = g.nodes.filter((n) => n.children.length === 0 || n.code.length).map((n) => ({ n, t: nodeTerms(g, n) }));
    const df = new Map<string, number>();
    for (const d of docs) for (const w of d.t.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    for (const d of docs) {
      let s = 0;
      for (const w of q) {
        const tf = d.t.get(w) ?? 0;
        if (tf) s += Math.log(1 + docs.length / (1 + (df.get(w) ?? 0))) * (tf / (tf + 1));
      }
      // Stores and outside systems match many words (table names) but are rarely where the work is.
      if (s > 0) nodeScore.set(d.n.id, s * (d.n.code.length ? 1 : 0.4));
    }
    // A node also scores through its best files.
    for (const h of lex.slice(0, 60)) {
      const n = ownerCached(h.path);
      if (n) nodeScore.set(n.id, (nodeScore.get(n.id) ?? 0) + 0.5 * (h.score / lexMax));
    }
  }
  const nodeMax = Math.max(1e-9, ...nodeScore.values());
  const topNodes = [...nodeScore].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, s]) => ({ id, score: s / nodeMax }));

  // 2. Seeds: the best lexical files, files already in play, and the central files of the top nodes.
  const seeds = new Map<string, number>();
  for (const h of lex.slice(0, 25)) seeds.set(h.path, h.score / lexMax);
  for (const f of opt.files ?? []) if (idx.files[f]) seeds.set(f, 1.5);
  if (use.nodes) {
    const rank = rankFiles(idx);
    for (const n of topNodes) {
      const node = g.nodes.find((x) => x.id === n.id);
      for (const t of node?.codeMap?.top.slice(0, 3) ?? []) seeds.set(t.path, Math.max(seeds.get(t.path) ?? 0, 0.6 * n.score * (0.5 + (rank.get(t.path) ?? 0))));
    }
  }

  // 3. Spread through the import graph, and add files that historically change with the seeds.
  const scores = new Map<string, number>();
  for (const h of lex) scores.set(h.path, 0.55 * (h.score / lexMax));
  for (const [f, v] of seeds) scores.set(f, Math.max(scores.get(f) ?? 0, 0.55 * v));
  if (use.graph && seeds.size) {
    const pr = spread(idx, seeds);
    const prMax = Math.max(1e-9, ...pr.values());
    for (const [f, v] of pr) if (!idx.files[f]?.test) scores.set(f, (scores.get(f) ?? 0) + TUNE.graph * (v / prMax));
  }
  const hist = opt.history === undefined ? readHistory(root) : opt.history;
  if (use.cochange && hist) {
    const seedList = [...seeds].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [f, v] of seedList) {
      for (const p of coChange(hist, f, (x) => !!idx.files[x] && !idx.files[x].test, opt.skipCommits, 5)) {
        scores.set(p.path, (scores.get(p.path) ?? 0) + TUNE.cochange * p.share * Math.min(1, v));
      }
    }
  }
  if (use.nodes) for (const [f, v] of scores) {
    const n = ownerCached(f);
    const ns = n ? nodeScore.get(n.id) : undefined;
    if (ns) scores.set(f, v + TUNE.node * (ns / nodeMax));
  }
  const files = [...scores].map(([path, score]) => ({ path, score })).sort((a, b) => b.score - a.score);

  // 4. Render within the budget.
  const out: string[] = [];
  const used = (): number => out.reduce((n, l) => n + l.length + 1, 0);
  const push = (...lines: string[]): boolean => {
    const size = lines.reduce((n, l) => n + l.length + 1, 0);
    if (used() + size > budget) return false;
    out.push(...lines);
    return true;
  };
  push(`Context for: ${task.length > 160 ? `${task.slice(0, 159)}…` : task}`);
  const shown = topNodes.map((t) => g.nodes.find((n) => n.id === t.id)!).filter(Boolean);
  if (shown.length) {
    // The "where" section may use at most a third of the budget; files matter more.
    const cap = Math.floor(budget * 0.33);
    const lines: string[] = ['', '## Where this lives'];
    const qs = new Set(q);
    const overlaps = (text: string): boolean => words(text).some((w) => qs.has(w));
    for (const n of shown) {
      const block = [`- ${n.id} (${n.kind}): ${n.role}${n.status !== 'built' ? ` [${n.status}]` : ''}`];
      const own = n.rules.filter((r) => r.from === n.id);
      for (const r of [...own.filter((r) => overlaps(r.text)), ...own.filter((r) => !overlaps(r.text))].slice(0, 2)) block.push(`  rule: ${r.text}`);
      const plans = g.changes.filter((c) => c.state !== 'done' && c.state !== 'dropped' && (c.nodes.includes(n.id) || c.interfaces.some((i) => i.startsWith(`${n.id}#`))) && overlaps(`${c.title} ${c.why ?? ''}`));
      for (const c of plans.slice(0, 2)) block.push(`  plan: ${c.title} [${c.state}]${c.doc ? ` (${c.doc})` : ''}`);
      for (const r of n.requirements.filter((r) => overlaps(r.text)).slice(0, 2)) block.push(`  must hold: ${r.text}`);
      if (lines.concat(block).reduce((k, l) => k + l.length + 1, 0) > cap) break;
      lines.push(...block);
    }
    if (lines.length > 2) push(...lines);
    // Every constraint on those nodes, so a plan is made with them in view rather than refused afterwards.
    const hold = mustHold(g, shown.map((n) => n.id));
    if (hold.length) {
      const head = ['', '## Must hold', 'Boundaries, who may call, where data may go, secrets and rules for these nodes. Check, approval and the gate refuse work that breaks the first four.'];
      if (!push(...head, ...hold.slice(0, 40))) push(...head, ...hold.slice(0, 12), '  … "armature impact <node>" lists the rest.');
    }
  }
  const shapeIds = new Set<string>();
  for (const n of shown) for (const i of n.interfaces) for (const s of [...i.takes, ...i.gives]) shapeIds.add(s);
  const shapeList = g.shapes.filter((s) => shapeIds.has(s.id) && (q.some((w) => words(s.id).includes(w)) || shapeIds.size <= 4)).slice(0, 4);
  if (shapeList.length) {
    push('', '## Data');
    for (const s of shapeList) push(`- ${s.id}${s.source ? ` (${s.source})` : ''}: ${s.fields.slice(0, 12).map((f) => `${f.name}: ${f.type}`).join(', ')}${s.fields.length > 12 ? ', …' : ''}`);
  }
  push('', '## Files, most relevant first (signatures only)');
  let listed = 0;
  const qset = new Set(q);
  for (const r of files) {
    const f = idx.files[r.path];
    if (!f || f.test) continue;
    const n = ownerCached(r.path);
    const syms = f.symbols.filter((s) => s.exported && s.kind !== 'reexport');
    const relevant = [...syms.filter((s) => words(s.name).some((w) => qset.has(w))), ...syms.filter((s) => !words(s.name).some((w) => qset.has(w)))].slice(0, listed < 5 ? 6 : 2);
    const summary = summaries[r.path]?.hash === f.hash ? `  // ${summaries[r.path].text}` : '';
    const ok = push(`${r.path}${n ? ` [${n.id}]` : ''}${summary}`, ...relevant.map((s) => `  ${s.sig}  :${s.line}`));
    if (!ok) break;
    listed++;
    if (listed >= 25) break;
  }
  const topFiles = files.filter((f) => !idx.files[f.path]?.test).slice(0, Math.max(3, listed)).map((f) => f.path);
  if (hist) {
    const partners = new Map<string, number>();
    for (const f of topFiles.slice(0, 3)) for (const p of coChange(hist, f, (x) => !!idx.files[x], opt.skipCommits, 3)) if (!topFiles.includes(p.path)) partners.set(p.path, Math.max(partners.get(p.path) ?? 0, p.share));
    if (partners.size) {
      push('', '## Usually changed together with these');
      for (const [p, s] of [...partners].sort((a, b) => b[1] - a[1]).slice(0, 4)) push(`- ${p} (${Math.round(s * 100)}% of the time)`);
    }
  }
  const tests = testsForFiles(idx, topFiles.slice(0, 8)).slice(0, 6);
  if (tests.length) push('', '## Tests to run', ...tests.map((t) => `- ${t}`));
  const docs = new Set<string>();
  const replaced = new Set(g.docs.filter((d) => d.supersededBy).map((d) => d.path));
  for (const n of shown) for (const d of n.docs.filter((x) => x.how !== 'mentions' && !replaced.has(x.path)).slice(0, 2)) docs.add(d.path);
  if (docs.size) push('', '## Documents', ...[...docs].slice(0, 4).map((d) => `- ${d}: ${g.docs.find((x) => x.path === d)?.title ?? ''}`));
  push('', 'More: armature map <node or file>, armature callers <symbol>, armature docs <node>.');
  return { nodes: topNodes, files, text: out.join('\n') };
}

export function contextText(g: Graph, idx: CodeIndex | null, root: string, task: string, opt: ContextOptions = {}): string {
  if (!idx) return NO_INDEX;
  return contextPack(g, idx, root, task, opt).text;
}

void stem;
void importersOf;
