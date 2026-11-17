// Text answers drawn from the code index, shaped for an agent's context: ranked files,
// signatures without bodies, and a budget.
import { importersOf, rankFiles, type CodeFile, type CodeIndex } from './code.js';
import { ownerOf } from './render.js';
import type { GNode, Graph } from './types.js';

function resolveNode(g: Graph, ref: string): GNode | null {
  const exact = g.nodes.find((n) => n.id === ref);
  if (exact) return exact;
  const hits = g.nodes.filter((n) => n.id.endsWith(`.${ref}`));
  return hits.length === 1 ? hits[0] : null;
}

function inside(id: string, anc: string): boolean {
  return id === anc || id.startsWith(`${anc}.`);
}

function symbolLines(f: CodeFile, max: number, exportedOnly: boolean): string[] {
  const list = f.symbols.filter((s) => (exportedOnly ? s.exported : true) && s.kind !== 'reexport');
  const out = list.slice(0, max).map((s) => `  ${s.exported ? 'export ' : ''}${s.sig}  :${s.line}${s.doc ? `  // ${s.doc}` : ''}`);
  if (list.length > max) out.push(`  … ${list.length - max} more`);
  return out;
}

const NO_INDEX = 'No code index yet. Run "armature index" first.';

/**
 * A repo map for one node (or the whole system): its files, most central first, each with the
 * signatures of what it exports. Stops at the budget, which is in characters (about four per token).
 */
export function codeMap(g: Graph, idx: CodeIndex | null, ref: string | undefined, budget = 6000): string {
  if (!idx) return NO_INDEX;
  const rank = rankFiles(idx);
  const owned = new Map<string, GNode>();
  for (const f of Object.keys(idx.files)) {
    const n = ownerOf(g, f);
    if (n && n.code.length) owned.set(f, n);
  }
  let scope: GNode | null = null;
  if (ref) {
    const file = idx.files[ref.replace(/^\.\//, '')];
    if (file) return fileCard(g, idx, file.path);
    scope = resolveNode(g, ref);
    if (!scope) return `Nothing named "${ref}". Give a node id or a file path.`;
  }
  const files = Object.values(idx.files)
    .filter((f) => (scope ? owned.has(f.path) && inside(owned.get(f.path)!.id, scope.id) : true))
    .sort((a, b) => (rank.get(b.path) ?? 0) - (rank.get(a.path) ?? 0) || b.symbols.length - a.symbols.length);
  if (files.length === 0) return scope ? `No indexed source files belong to "${scope.id}".` : 'The index is empty.';
  const out: string[] = [];
  out.push(scope ? `Code map of ${scope.id} (${scope.role}): ${files.length} files, most central first.` : `Code map of the repo: ${files.length} files, most central first.`);
  let used = out[0].length;
  let shown = 0;
  for (const f of files) {
    const node = owned.get(f.path);
    const head = `${f.path} (${f.lines} lines)${!scope || (node && node.id !== scope.id) ? ` [${node?.id ?? 'no node'}]` : ''}`;
    const body = symbolLines(f, shown < 8 ? 10 : 4, true);
    const block = [head, ...body];
    const size = block.reduce((n, l) => n + l.length + 1, 0);
    if (used + size > budget && shown > 0) break;
    out.push(...block);
    used += size;
    shown++;
  }
  if (shown < files.length) out.push(`… ${files.length - shown} more files. Ask for one with "armature map <file>", or raise --budget.`);
  return out.join('\n');
}

/** Everything about one file: its symbols, what it imports, and who imports it. */
export function fileCard(g: Graph, idx: CodeIndex | null, file: string): string {
  if (!idx) return NO_INDEX;
  const f = idx.files[file];
  if (!f) return `"${file}" is not in the code index.`;
  const node = ownerOf(g, file);
  const out = [`${f.path} (${f.lang}, ${f.lines} lines)${node ? ` belongs to node ${node.id}` : ' belongs to no node'}`];
  if (f.symbols.length) {
    out.push('symbols:');
    out.push(...symbolLines(f, 40, false));
  }
  const local = f.imports.filter((i) => i.file);
  if (local.length) {
    out.push('imports from this repo:');
    for (const i of local) {
      const o = ownerOf(g, i.file as string);
      out.push(`  ${i.file}${o && o.id !== node?.id ? ` [${o.id}]` : ''}: ${i.names.join(', ')}`);
    }
  }
  const pkgs = [...new Set(f.imports.filter((i) => i.pkg).map((i) => i.pkg as string))];
  if (pkgs.length) out.push(`packages: ${pkgs.join(', ')}`);
  const users = importersOf(idx, file);
  if (users.length) {
    out.push(`imported by ${users.length} file${users.length === 1 ? '' : 's'}:`);
    for (const u of users.slice(0, 25)) {
      const o = ownerOf(g, u.file);
      out.push(`  ${u.file}${o && o.id !== node?.id ? ` [${o.id}]` : ''}: ${u.names.join(', ')}`);
    }
    if (users.length > 25) out.push(`  … ${users.length - 25} more`);
  }
  return out.join('\n');
}

/** Where a symbol is defined, and which files import it. */
export function findSymbol(g: Graph, idx: CodeIndex | null, name: string): string {
  if (!idx) return NO_INDEX;
  const exact: Array<{ f: CodeFile; s: CodeFile['symbols'][number] }> = [];
  const loose: typeof exact = [];
  const lower = name.toLowerCase();
  for (const f of Object.values(idx.files)) {
    for (const s of f.symbols) {
      if (s.kind === 'reexport') continue;
      if (s.name === name) exact.push({ f, s });
      else if (s.name.toLowerCase().includes(lower)) loose.push({ f, s });
    }
  }
  const hits = exact.length ? exact : loose;
  if (hits.length === 0) return `No top-level symbol matches "${name}".`;
  const out: string[] = [exact.length ? `${exact.length} definition${exact.length === 1 ? '' : 's'} of ${name}:` : `No exact match. ${loose.length} symbols contain "${name}":`];
  for (const { f, s } of hits.slice(0, 15)) {
    const node = ownerOf(g, f.path);
    out.push(`${f.path}:${s.line}${node ? ` [${node.id}]` : ''}`);
    out.push(`  ${s.exported ? 'export ' : ''}${s.sig}${s.doc ? `  // ${s.doc}` : ''}`);
    if (!exact.length) continue;
    const users = importersOf(idx, f.path).filter((u) => u.names.includes(s.name) || u.names.includes('*'));
    if (users.length) {
      const byNode = new Map<string, number>();
      for (const u of users) {
        const id = ownerOf(g, u.file)?.id ?? 'no node';
        byNode.set(id, (byNode.get(id) ?? 0) + 1);
      }
      out.push(`  imported by ${users.length} file${users.length === 1 ? '' : 's'}: ${[...byNode].map(([id, c]) => `${id} (${c})`).join(', ')}`);
      for (const u of users.slice(0, 8)) out.push(`    ${u.file}`);
      if (users.length > 8) out.push(`    … ${users.length - 8} more`);
    } else if (s.exported) out.push('  not imported by any indexed file');
  }
  if (hits.length > 15) out.push(`… ${hits.length - 15} more`);
  return out.join('\n');
}

/** Which other nodes a node's code imports, and which import it, compared with the declared links. */
export function codeDeps(g: Graph, ref: string | undefined): string {
  if (!g.code) return NO_INDEX;
  const scope = ref ? resolveNode(g, ref) : null;
  if (ref && !scope) return `Nothing named "${ref}".`;
  const mine = g.codeDeps.filter((d) => !scope || inside(d.from, scope.id) || inside(d.to, scope.id));
  if (mine.length === 0) return scope ? `No imports cross the boundary of "${scope.id}".` : 'No imports cross node boundaries.';
  const line = (d: Graph['codeDeps'][number]): string => `  ${d.from} -> ${d.to}: ${d.count} import${d.count === 1 ? '' : 's'} [${d.kind}]  e.g. ${d.samples[0].from} imports ${d.samples[0].names.join(', ') || '*'} from ${d.samples[0].to}`;
  const out: string[] = [];
  if (scope) {
    const outgoing = mine.filter((d) => inside(d.from, scope.id) && !inside(d.to, scope.id));
    const incoming = mine.filter((d) => inside(d.to, scope.id) && !inside(d.from, scope.id));
    out.push(`Code dependencies of ${scope.id}, from imports:`);
    if (outgoing.length) out.push('its code imports:', ...outgoing.map(line));
    if (incoming.length) out.push('imported by:', ...incoming.map(line));
  } else {
    const und = mine.filter((d) => d.kind === 'undeclared');
    out.push(`${mine.length} node-to-node import dependencies: ${mine.filter((d) => d.kind === 'declared').length} match a declared link, ${mine.filter((d) => d.kind === 'library').length} go to shared libraries, ${und.length} are undeclared.`);
    if (und.length) out.push('undeclared:', ...und.slice(0, 40).map(line));
  }
  out.push('declared = the model has a link between the two nodes; library = the target is shared code; undeclared = the model does not know about it.');
  return out.join('\n');
}
