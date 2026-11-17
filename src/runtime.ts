// Compares what the code does at run time (tables it reads and writes, queues it starts or serves,
// HTTP routes it serves and calls) with the links the model declares.
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

export interface RuntimeResult {
  reports: RuntimeReport[];
  deps: CodeDep[];
}

export function analyzeRuntime(
  idx: CodeIndex,
  nodes: Map<string, GNode>,
  edges: Edge[],
  ifaces: Map<string, Interface>,
  owner: Map<string, string>,
  ancestors: (id: string) => string[],
): RuntimeResult {
  // Real table names, and which Drizzle constant names which table.
  const tables = new Set<string>();
  const constToTable = new Map<string, string | null>();
  for (const f of Object.values(idx.files)) {
    for (const [name, s] of Object.entries(f.schemas ?? {})) {
      if (s.kind !== 'drizzle' || !s.table) continue;
      tables.add(s.table);
      constToTable.set(name, constToTable.has(name) && constToTable.get(name) !== s.table ? null : s.table);
    }
    for (const op of f.sql ?? []) if (op.op === 'create') tables.add(op.table);
  }
  const tableIface = new Map<string, Interface>();
  for (const i of ifaces.values()) {
    if (!i.holds) continue;
    tables.add(i.id.replace(/-/g, '_'));
    tableIface.set(i.id.replace(/-/g, '_'), i);
  }
  const family = (id: string): string[] => [id, ...ancestors(id), ...[...nodes.keys()].filter((k) => k.startsWith(`${id}.`))];

  // Declared links, indexed by the declaring node and its relatives.
  const declaredFrom = new Map<string, Edge[]>();
  for (const e of edges) declaredFrom.set(e.owner, [...(declaredFrom.get(e.owner) ?? []), e]);
  const declaredBy = (id: string): Edge[] => family(id).flatMap((x) => declaredFrom.get(x) ?? []);

  const reports = new Map<string, RuntimeReport>();
  const seenTables = new Map<string, Set<string>>();
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
        const iface = tableIface.get(table);
        const seen = seenTables.get(id) ?? new Set<string>();
        seen.add(table);
        seenTables.set(id, seen);
        const ok = mine.some((e) => (e.iface === iface?.ref || (!e.iface && iface && (e.to === iface.node || e.from === iface.node))) && (h.op === 'write' ? e.verb === 'writes' : e.verb === 'reads' || e.verb === 'writes'));
        if (iface) dep(id, iface.node, 'table', ok, f.path, table);
        if (ok) report(id).confirmed++;
        else add(report(id), { kind: 'table', what: iface ? iface.ref : `${table} (not in the model)`, op: h.op, file: f.path, line: h.l });
      } else if (h.k === 'queue') {
        const target = [...ifaces.values()].find((i) => i.queue === h.v);
        if (h.op === 'consume') {
          const ok = family(id).some((x) => nodes.get(x)!.interfaces.some((i) => i.queue === h.v));
          if (ok) report(id).confirmed++;
          else add(report(id), { kind: 'queue', what: h.v, op: 'serves', file: f.path, line: h.l });
        } else if (target) {
          const ok = mine.some((e) => e.iface === target.ref || e.to === target.node);
          dep(id, target.node, 'queue', ok, f.path, h.v);
          if (ok) report(id).confirmed++;
          else if (!family(id).includes(target.node)) add(report(id), { kind: 'queue', what: target.ref, op: 'starts', file: f.path, line: h.l });
        }
      } else if (h.k === 'workflow') {
        const name = kebab(h.v.replace(/Workflow$/, ''));
        const target = [...ifaces.values()].find((i) => i.id === name || i.id === kebab(h.v));
        if (!target || family(id).includes(target.node)) continue;
        const ok = mine.some((e) => e.iface === target.ref || e.to === target.node);
        dep(id, target.node, 'workflow', ok, f.path, h.v);
        if (ok) report(id).confirmed++;
        else add(report(id), { kind: 'workflow', what: target.ref, op: 'starts', file: f.path, line: h.l });
      } else if (h.k === 'http') {
        const target = [...ifaces.values()].find((i) => i.route && i.via !== 'pgmq' && pathEndsWith(routePath(i.route), h.v));
        if (!target || family(id).includes(target.node)) continue;
        const ok = mine.some((e) => e.iface === target.ref || e.to === target.node || family(target.node).includes(e.to));
        dep(id, target.node, 'http', ok, f.path, h.v);
        if (ok) report(id).confirmed++;
        else add(report(id), { kind: 'http', what: `${target.ref} (${h.v})`, op: 'calls', file: f.path, line: h.l });
      } else if (h.k === 'route') {
        const served = family(id).some((x) => nodes.get(x)!.interfaces.some((i) => i.route && pathEndsWith(routePath(i.route), h.v) && (!/^[A-Z]+\s/.test(i.route) || i.route.toUpperCase().startsWith(`${h.op} `))));
        if (served) report(id).confirmed++;
        else add(report(id), { kind: 'route', what: `${h.op} ${h.v}`, op: 'serves', file: f.path, line: h.l });
      }
    }
  }

  // Declared table links whose table never appears in the node's code. Only for nodes that own code.
  for (const n of nodes.values()) {
    if (n.files === 0 || n.kind === 'store') continue;
    const seen = new Set<string>();
    for (const x of family(n.id)) for (const t of seenTables.get(x) ?? []) seen.add(t);
    for (const e of declaredFrom.get(n.id) ?? []) {
      if ((e.verb !== 'reads' && e.verb !== 'writes') || !e.iface || e.status === 'planned') continue;
      const table = e.iface.split('#')[1].replace(/-/g, '_');
      if (!tables.has(table) || seen.has(table)) continue;
      report(n.id).unseen.push({ kind: 'table', what: e.iface, op: e.verb === 'writes' ? 'write' : 'read' });
    }
  }
  return { reports: [...reports.values()].sort((a, b) => b.undeclared.length - a.undeclared.length || a.node.localeCompare(b.node)), deps: [...deps.values()] };
}
