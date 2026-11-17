// Compares what the code does at run time (tables it reads and writes, queues it starts or serves,
// HTTP routes it serves and calls) with the links the model declares, in both directions:
// what the code does that the model does not declare, and what the model declares that the code
// does not show. The second only counts where a detector works on that node's code; everywhere
// else the answer is "not checked", never "fine".
import type { CodeIndex } from './code.js';
import type { CodeDep, Edge, GNode, Interface, RuntimeItem, RuntimeReport } from './types.js';

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();

function routePath(route: string): string {
  return route.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, '').split('?')[0].replace(/\/+$/, '');
}

function segs(p: string): string[] {
  return p.split('/').filter(Boolean).map((s) => (/^[:{]|^\*$|^\$/.test(s) ? ':' : s.toLowerCase()));
}

/** True when `tail` matches the end of `full`, with path parameters matching anything. */
function pathEndsWith(full: string, tail: string): boolean {
  const a = segs(full);
  const b = segs(tail);
  if (b.length === 0 || b.length > a.length) return false;
  const off = a.length - b.length;
  return b.every((s, i) => s === ':' || a[off + i] === ':' || s === a[off + i]);
}

/** True when a route registered in code (`op` and `path`) is the route an interface declares. */
function sameRoute(declared: string, op: string | undefined, path: string): boolean {
  return pathEndsWith(routePath(declared), path) && (!/^[A-Z]+\s/.test(declared) || !op || declared.toUpperCase().startsWith(`${op} `));
}

export interface RuntimeResult {
  reports: RuntimeReport[];
  deps: CodeDep[];
  /** Per node, what was recognised in its own files: route, http, queue, workflow, table. */
  kinds: Map<string, Set<string>>;
}

export function analyzeRuntime(
  idx: CodeIndex,
  nodes: Map<string, GNode>,
  edges: Edge[],
  ifaces: Map<string, Interface>,
  owner: Map<string, string>,
  ancestors: (id: string) => string[],
  /** True for an element that is still planned: it is not expected in the code yet. */
  planned: (change: string | undefined) => boolean = () => false,
): RuntimeResult {
  // Real table names, which Drizzle constant names which table, and which node's files define each table.
  const tables = new Set<string>();
  const constToTable = new Map<string, string | null>();
  const definedBy = new Map<string, Set<string>>();
  const define = (file: string, table: string): void => {
    tables.add(table);
    const id = owner.get(file);
    if (id) definedBy.set(id, (definedBy.get(id) ?? new Set()).add(table));
  };
  for (const f of Object.values(idx.files)) {
    for (const [name, s] of Object.entries(f.schemas ?? {})) {
      if (s.kind !== 'drizzle' || !s.table) continue;
      define(f.path, s.table);
      constToTable.set(name, constToTable.has(name) && constToTable.get(name) !== s.table ? null : s.table);
    }
    for (const op of f.sql ?? []) if (op.op === 'create') define(f.path, op.table);
  }
  const tableIface = new Map<string, Interface>();
  for (const i of ifaces.values()) {
    if (!i.holds) continue;
    tables.add(i.id.replace(/-/g, '_'));
    tableIface.set(i.id.replace(/-/g, '_'), i);
  }
  const allIds = [...nodes.keys()];
  const families = new Map<string, string[]>();
  const family = (id: string): string[] => {
    let f = families.get(id);
    if (!f) families.set(id, (f = [id, ...ancestors(id), ...allIds.filter((k) => k.startsWith(`${id}.`))]));
    return f;
  };

  // Declared links, indexed by the declaring node and its relatives.
  const declaredFrom = new Map<string, Edge[]>();
  for (const e of edges) declaredFrom.set(e.owner, [...(declaredFrom.get(e.owner) ?? []), e]);
  const declaredBy = (id: string): Edge[] => family(id).flatMap((x) => declaredFrom.get(x) ?? []);

  const reports = new Map<string, RuntimeReport>();
  const deps = new Map<string, CodeDep>();
  const report = (id: string): RuntimeReport => {
    let r = reports.get(id);
    if (!r) reports.set(id, (r = { node: id, undeclared: [], unseen: [], confirmed: 0 }));
    return r;
  };
  const dep = (from: string, to: string, via: CodeDep['via'], declared: boolean, file: string, what: string): void => {
    if (from === to) return;
    const key = `${from}|${to}|${via}`;
    let d = deps.get(key);
    if (!d) deps.set(key, (d = { from, to, count: 0, kind: declared ? 'declared' : 'undeclared', samples: [], via }));
    if (!declared) d.kind = 'undeclared';
    d.count++;
    if (d.samples.length < 3) d.samples.push({ from: file, to: what, names: [] });
  };
  const add = (r: RuntimeReport, item: RuntimeItem): void => {
    if (!r.undeclared.some((u) => u.kind === item.kind && u.what === item.what && u.op === item.op)) r.undeclared.push(item);
  };

  // What each node's own files do, kept for the reverse check below.
  const kinds = new Map<string, Set<string>>();
  const seenTables = new Map<string, Set<string>>();
  const routes = new Map<string, Array<{ op?: string; path: string }>>();
  const served = new Map<string, Set<string>>();
  const started = new Map<string, Set<string>>();
  const httpCalls = new Map<string, string[]>();
  const put = <T>(m: Map<string, Set<T>>, id: string, v: T): void => void m.set(id, (m.get(id) ?? new Set<T>()).add(v));
  const across = <T>(m: Map<string, Set<T>>, id: string): Set<T> => new Set(family(id).flatMap((x) => [...(m.get(x) ?? [])]));

  for (const f of Object.values(idx.files)) {
    if (f.test) continue;
    const id = owner.get(f.path);
    if (!id) continue;
    const node = nodes.get(id)!;
    // Stores hold data, and dead code takes part in nothing: neither is checked against links.
    if (node.kind === 'store' || [id, ...ancestors(id)].some((x) => nodes.get(x)?.unused)) continue;
    const mine = declaredBy(id);
    for (const h of f.hints ?? []) {
      if (h.k === 'table') {
        const table = h.v.startsWith('const:') ? constToTable.get(h.v.slice(6)) ?? null : h.v;
        if (!table || !tables.has(table)) continue;
        put(kinds, id, 'table');
        const iface = tableIface.get(table);
        put(seenTables, id, table);
        const ok = mine.some((e) => (e.iface === iface?.ref || (!e.iface && iface && (e.to === iface.node || e.from === iface.node))) && (h.op === 'write' ? e.verb === 'writes' : e.verb === 'reads' || e.verb === 'writes'));
        if (iface) dep(id, iface.node, 'table', ok, f.path, table);
        if (ok) report(id).confirmed++;
        else add(report(id), { kind: 'table', what: iface ? iface.ref : `${table} (not in the model)`, op: h.op, file: f.path, line: h.l });
      } else if (h.k === 'queue') {
        put(kinds, id, 'queue');
        const target = [...ifaces.values()].find((i) => i.queue === h.v);
        if (h.op === 'consume') {
          put(served, id, h.v);
          // Declared as an interface of the node, or as a read from a queue node that carries it.
          const ok = family(id).some((x) => nodes.get(x)!.interfaces.some((i) => i.queue === h.v)) || mine.some((e) => e.verb === 'reads' && !!target && e.iface === target.ref);
          if (ok) report(id).confirmed++;
          else add(report(id), { kind: 'queue', what: h.v, op: 'serves', file: f.path, line: h.l });
        } else {
          put(started, id, h.v);
          if (!target) continue;
          const ok = mine.some((e) => e.iface === target.ref || e.to === target.node);
          dep(id, target.node, 'queue', ok, f.path, h.v);
          if (ok) report(id).confirmed++;
          else if (!family(id).includes(target.node)) add(report(id), { kind: 'queue', what: target.ref, op: 'starts', file: f.path, line: h.l });
        }
      } else if (h.k === 'workflow') {
        put(kinds, id, 'workflow');
        const name = kebab(h.v.replace(/Workflow$/, ''));
        const target = [...ifaces.values()].find((i) => i.id === name || i.id === kebab(h.v));
        if (!target || family(id).includes(target.node)) continue;
        const ok = mine.some((e) => e.iface === target.ref || e.to === target.node);
        dep(id, target.node, 'workflow', ok, f.path, h.v);
        if (ok) report(id).confirmed++;
        else add(report(id), { kind: 'workflow', what: target.ref, op: 'starts', file: f.path, line: h.l });
      } else if (h.k === 'http') {
        put(kinds, id, 'http');
        httpCalls.set(id, [...(httpCalls.get(id) ?? []), h.v]);
        const target = [...ifaces.values()].find((i) => i.route && i.via !== 'pgmq' && pathEndsWith(routePath(i.route), h.v));
        if (!target || family(id).includes(target.node)) continue;
        const ok = mine.some((e) => e.iface === target.ref || e.to === target.node || family(target.node).includes(e.to));
        dep(id, target.node, 'http', ok, f.path, h.v);
        if (ok) report(id).confirmed++;
        else add(report(id), { kind: 'http', what: `${target.ref} (${h.v})`, op: 'calls', file: f.path, line: h.l });
      } else if (h.k === 'route') {
        put(kinds, id, 'route');
        routes.set(id, [...(routes.get(id) ?? []), { op: h.op, path: h.v }]);
        const ok = family(id).some((x) => nodes.get(x)!.interfaces.some((i) => i.route && sameRoute(i.route, h.op, h.v)));
        if (ok) report(id).confirmed++;
        else add(report(id), { kind: 'route', what: `${h.op} ${h.v}`, op: 'serves', file: f.path, line: h.l });
      }
    }
  }

  // The other direction: does the code show what the model declares? An answer is given only
  // where the same kind of thing was recognised in that node's code; otherwise it stays unchecked.
  const unusedNode = (id: string): boolean => [id, ...ancestors(id)].some((x) => nodes.get(x)?.unused);
  for (const i of ifaces.values()) {
    const n = nodes.get(i.node)!;
    if (i.holds) {
      // A store's tables can be checked when the store owns the files that define tables.
      const mine = new Set(family(i.node).flatMap((x) => [...(definedBy.get(x) ?? [])]));
      if (mine.size) i.evidence = mine.has(i.id.replace(/-/g, '_')) ? 'seen' : planned(i.change) ? 'unchecked' : 'unseen';
      continue;
    }
    if (n.kind === 'store' || unusedNode(i.node)) continue;
    let seen: boolean | null = null;
    if (i.route && i.via !== 'pgmq') {
      const found = family(i.node).flatMap((x) => routes.get(x) ?? []);
      if (found.length) seen = found.some((r) => sameRoute(i.route as string, r.op, r.path));
    } else if (i.queue && i.via === 'temporal') {
      const found = across(served, i.node);
      if (found.size) seen = found.has(i.queue);
    }
    if (seen === null) continue;
    i.evidence = seen ? 'seen' : planned(i.change) ? 'unchecked' : 'unseen';
    if (i.evidence === 'unseen') report(i.node).unseen.push({ kind: i.route ? 'route' : 'queue', what: i.ref, op: 'serves' });
  }
  for (const e of edges) {
    const iface = e.iface ? ifaces.get(e.iface) : undefined;
    const n = nodes.get(e.owner)!;
    if (!iface || n.kind === 'store' || unusedNode(e.owner)) continue;
    let seen: boolean | null = null;
    let kind: RuntimeItem['kind'] = 'table';
    if (e.verb === 'reads' || e.verb === 'writes') {
      if (iface.holds) {
        const table = iface.id.replace(/-/g, '_');
        if (across(seenTables, e.owner).has(table)) seen = true;
        else if (tables.has(table) && family(e.owner).some((x) => kinds.get(x)?.has('table'))) seen = false;
      } else if (iface.queue && iface.via === 'temporal') {
        kind = 'queue';
        const found = across(served, e.owner);
        if (found.size) seen = found.has(iface.queue);
      }
    } else if (iface.queue && iface.via === 'temporal') {
      kind = 'queue';
      const found = across(started, e.owner);
      if (found.size) seen = found.has(iface.queue);
    } else if (iface.route && iface.via !== 'pgmq' && iface.route.includes('/api/')) {
      // Outgoing HTTP is recognised only as "/api/..." paths in strings.
      kind = 'http';
      const found = family(e.owner).flatMap((x) => httpCalls.get(x) ?? []);
      if (found.length) seen = found.some((v) => pathEndsWith(routePath(iface.route as string), v));
    }
    if (seen === null) continue;
    e.evidence = seen ? 'seen' : planned(e.change) ? 'unchecked' : 'unseen';
    // The access may go through shared code, so this is reported by "armature drift" and never warned about.
    if (e.evidence === 'unseen') report(e.owner).unseen.push({ kind, what: iface.ref, op: e.verb === 'writes' ? 'write' : e.verb === 'reads' ? 'read' : e.verb });
  }
  return { reports: [...reports.values()].sort((a, b) => b.undeclared.length - a.undeclared.length || a.node.localeCompare(b.node)), deps: [...deps.values()], kinds };
}
