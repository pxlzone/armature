// The document library: every Markdown file in the repo, with its title, outline and summary,
// tied to the model. A document joins the model through its header (kind, about, change) and
// through [[references]] in its text, which are resolved like any other reference in the model.
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import YAML from 'yaml';
import type { Change, DocInfo, DocKind, DocLink, DocRef, GNode } from './types.js';
import { DOC_KINDS } from './types.js';

const MAX_SCAN = 1024 * 1024;
// Test fixtures hold Markdown as data for tests, not documents about the system.
const SKIP = /(^|\/)(node_modules|dist|build|\.next|\.turbo|vendor|\.claude\/worktrees|\.claude\/rules|fixtures|__fixtures__|testdata)\//;
/** Files every repo has, which describe the repo as a whole and need no header. */
const COMMON = /(^|\/)(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|AGENTS|CLAUDE)\.mdx?$/i;

export function isDocPath(file: string): boolean {
  return /\.mdx?$/i.test(file) && !SKIP.test(`/${file}`) && !/^(armature|arch)\/\.cache\//.test(file);
}

function staticPrefix(glob: string): string {
  const cut = glob.search(/[*?[{]/);
  if (cut < 0) return glob.replace(/\/+$/, '');
  const raw = glob.slice(0, cut);
  // "apps/api/**" -> "apps/api"; "apps/api/src/*.ts" -> "apps/api/src"; "src/lib/qu*" -> "src/lib"
  return (raw.endsWith('/') ? raw : raw.slice(0, raw.lastIndexOf('/') + 1)).replace(/\/+$/, '');
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || /^(#|```|\||<|---|>|!\[)/.test(t) || /^[-*] /.test(t) && t.split('\n').length > 3) continue;
    const text = t.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, ref, label) => label || ref).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ');
    if (text.length < 25) continue;
    return text.length > 280 ? `${text.slice(0, 279)}…` : text;
  }
  return '';
}

/** Splits a Markdown file into its YAML header and its body. A header that does not parse counts as empty. */
export function splitHeader(text: string): { front: string; header: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { front: '', header: {}, body: text };
  let header: unknown = {};
  try {
    header = YAML.parse(m[1]) ?? {};
  } catch {
    header = {};
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) header = {};
  return { front: m[1], header: header as Record<string, unknown>, body: text.slice(m[0].length) };
}

export const REF = /\[\[\s*([A-Za-z0-9][A-Za-z0-9_.#:~-]*)\s*(?:\|[^[\]\n]*)?\]\]/g;

/** Every [[reference]] in the prose of a document. Code blocks and inline code are skipped. */
export function inlineRefs(body: string): string[] {
  const prose = body.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '');
  return [...prose.matchAll(REF)].map((m) => m[1]);
}

function strings(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter(Boolean);
}

/** `also` lists the other things a bare name could mean, each written so that it resolves to exactly that. */
export type DocResolver = (text: string) => (Omit<DocRef, 'text' | 'count'> & { also?: string[] }) | null;

export interface DocIssue {
  code: string;
  message: string;
  file: string;
}

/** A document that nothing ties to the model: no header, no node lists it, no change names it. */
export function isLoose(d: Pick<DocInfo, 'path' | 'model' | 'changes' | 'links'>): boolean {
  if (d.model || d.changes.length) return false;
  if (COMMON.test(d.path) || d.path.split('/').some((p) => p.startsWith('.'))) return false;
  return !d.links.some((l) => l.how !== 'mentions');
}

/** The status of a plan, from the changes it explains. */
function planState(changes: Change[]): string | undefined {
  if (!changes.length) return undefined;
  const one = (c: Change): string => {
    const p = c.progress;
    const parts: string[] = [c.state];
    if (c.state !== 'dropped' && p.total) parts.push(`${p.built} of ${p.total} built`);
    if (c.state !== 'dropped' && p.reqTotal) parts.push(`${p.reqVerified} of ${p.reqTotal} requirements verified`);
    return parts.join(', ');
  };
  return changes.length === 1 ? one(changes[0]) : changes.map((c) => `${c.id}: ${one(c)}`).join('; ');
}

/**
 * Reads every document and links it to nodes in three ways, strongest first:
 * declared (a node's `docs:`, a change's `doc:`, or the document's own header and [[references]]),
 * inside (the file sits in a node's code), and mentions (the text names a path the node owns).
 */
export function collectDocs(
  root: string,
  files: string[],
  nodes: Map<string, GNode>,
  changes: Change[],
  declared: Map<string, string[]>,
  resolve: DocResolver = () => null,
  /** Where model documents live: every Markdown file under it needs a kind. */
  home = 'armature/docs',
): { docs: DocInfo[]; issues: DocIssue[] } {
  const docFiles = files.filter(isDocPath);
  const issues: DocIssue[] = [];
  // Path prefixes each node owns, longest first, so a mention goes to the most specific node.
  const prefixes: Array<{ prefix: string; node: string }> = [];
  for (const n of nodes.values()) {
    for (const g of n.code) {
      if (g.startsWith('!')) continue;
      const p = staticPrefix(g);
      if (p.includes('/') && p.length >= 6) prefixes.push({ prefix: p, node: n.id });
    }
  }
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  const codeMatch = [...nodes.values()].filter((n) => n.code.length).map((n) => ({
    n,
    m: picomatch(n.code.filter((c) => !c.startsWith('!')), { dot: true, ignore: n.code.filter((c) => c.startsWith('!')).map((c) => c.slice(1)) }),
  })).sort((a, b) => b.n.depth - a.n.depth);

  const changeById = new Map(changes.map((c) => [c.id, c]));
  const docsByChange = new Map<string, Change[]>();
  for (const c of changes) if (c.doc) docsByChange.set(c.doc.replace(/^\.\//, ''), [...(docsByChange.get(c.doc.replace(/^\.\//, '')) ?? []), c]);

  const out: DocInfo[] = [];
  for (const file of docFiles) {
    let text = '';
    let size = 0;
    try {
      const st = fs.statSync(path.join(root, file));
      size = st.size;
      const fd = fs.openSync(path.join(root, file), 'r');
      const buf = Buffer.alloc(Math.min(size, MAX_SCAN));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const { front, header, body } = splitHeader(text);
    const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const fmTitle = front.match(/^(?:title|name):\s*["']?(.+?)["']?\s*$/m)?.[1];
    const title = (h1 ?? fmTitle ?? path.basename(file).replace(/\.mdx?$/i, '').replace(/[-_]/g, ' ')).replace(/[`*]/g, '');
    const outline = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].replace(/[`*]/g, '').trim()).slice(0, 30);
    const fmDesc = front.match(/^(?:description|summary):\s*["']?(.+?)["']?\s*$/m)?.[1];
    const summary = fmDesc ?? firstParagraph(body.replace(/^#\s+.+$/m, ''));
    const status = body.slice(0, 1500).match(/\bStatus(?:\*\*)?\s*:\s*(?:\*\*)?\s*([^\n]+)/i)?.[1]?.replace(/[`*]/g, '').replace(/\s*See .*$/i, '').trim().slice(0, 160);

    // The header: what the document is, and which parts of the model it is about.
    const inHome = file.startsWith(`${home}/`);
    const kindRaw = typeof header.kind === 'string' ? header.kind.trim() : undefined;
    const kind = DOC_KINDS.includes(kindRaw as DocKind) ? (kindRaw as DocKind) : undefined;
    const about = strings(header.about);
    const headerChanges = strings(header.change);
    const model = inHome || !!kind || about.length > 0 || headerChanges.length > 0 || strings(header.supersedes).length > 0;
    if (model && !kind && (inHome || kindRaw)) {
      issues.push({
        code: 'doc-header',
        file,
        message: kindRaw ? `"${file}" has kind "${kindRaw}"; the kinds are ${DOC_KINDS.join(', ')}.` : `"${file}" has no kind in its header. Add "kind:" with one of ${DOC_KINDS.join(', ')}.`,
      });
    }

    const links = new Map<string, DocLink>();
    const link = (node: string, how: DocLink['how'], count = 1): void => {
      const prev = links.get(node);
      const rank = { declared: 3, inside: 2, mentions: 1 } as const;
      if (!prev) links.set(node, { node, how, count });
      else {
        prev.count += count;
        if (rank[how] > rank[prev.how]) prev.how = how;
      }
    };
    for (const id of declared.get(file) ?? []) if (nodes.has(id)) link(id, 'declared');

    // References the document itself makes: the header's "about", then [[names]] in the text.
    const refs = new Map<string, DocRef>();
    const broken = new Set<string>();
    const ambiguous = new Set<string>();
    for (const t of [...about, ...inlineRefs(body)]) {
      const found = resolve(t);
      if (!found) {
        if (model) broken.add(t);
        continue;
      }
      const { also, ...hit } = found;
      if (model && also?.length) ambiguous.add(`${t} (read as the ${hit.type}; also ${also.join(', ')})`);
      const key = `${hit.type} ${hit.id}`;
      const prev = refs.get(key);
      if (prev) prev.count++;
      else refs.set(key, { text: t, ...hit, count: 1 });
      if (hit.node && nodes.has(hit.node)) link(hit.node, 'declared');
    }
    // A decision that replaces an earlier one names it: a path from the repo root, or a file beside this one.
    const supersedes = strings(header.supersedes).map((x) => {
      const clean = x.replace(/^\.\//, '');
      const beside = path.posix.join(path.posix.dirname(file), clean);
      return !files.includes(clean) && files.includes(beside) ? beside : clean;
    });

    const plans = [...(docsByChange.get(file) ?? [])];
    for (const id of headerChanges) {
      const c = changeById.get(id);
      if (!c) broken.add(id);
      else if (!plans.includes(c)) plans.push(c);
    }
    for (const c of plans) for (const id of new Set([...c.nodes, ...c.interfaces.map((r) => r.split('#')[0]), ...c.requirements.map((r) => r.split(':')[0]), ...c.edges.map((e) => e.split('>')[0])])) {
      if (nodes.has(id)) link(id, 'declared');
    }
    const owner = codeMatch.find((x) => x.m(file));
    if (owner) link(owner.n.id, 'inside');
    if (prefixes.length) {
      const counts = new Map<string, number>();
      for (const m of text.matchAll(/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@[\]()-]+)+/g)) {
        const ref = m[0].replace(/[.,)]+$/, '').replace(/^\.\//, '');
        const hit = prefixes.find((p) => ref === p.prefix || ref.startsWith(`${p.prefix}/`) || (p.prefix.endsWith(ref) && ref.includes('/') && ref.length >= 12));
        if (hit) counts.set(hit.node, (counts.get(hit.node) ?? 0) + 1);
      }
      for (const [id, c] of counts) link(id, 'mentions', c);
    }
    const rank = { declared: 3, inside: 2, mentions: 1 } as const;
    const sorted = [...links.values()].sort((a, b) => rank[b.how] - rank[a.how] || b.count - a.count);
    out.push({
      path: file,
      title,
      summary,
      kind,
      model,
      status,
      state: planState(plans),
      outline,
      words: Math.round(body.split(/\s+/).length),
      size,
      changes: plans.map((c) => c.id),
      links: sorted,
      refs: [...refs.values()],
      broken: [...broken],
      ambiguous: [...ambiguous],
      supersedes,
      loose: isLoose({ path: file, model, changes: plans.map((c) => c.id), links: sorted }),
    });
  }
  const byPath = new Map(out.map((d) => [d.path, d]));
  for (const d of out) {
    for (const old of d.supersedes) {
      const target = byPath.get(old);
      if (target) target.supersededBy = d.path;
      else issues.push({ code: 'doc-reference', file: d.path, message: `"${d.path}" supersedes "${old}", which is not a document in the repo.` });
    }
  }
  return { docs: out.sort((a, b) => a.path.localeCompare(b.path)), issues };
}

/** Reads one document for the viewer. Refuses anything that is not a Markdown file inside the repo. */
export function readDoc(root: string, file: string): string | null {
  if (!isDocPath(file) || file.includes('\0')) return null;
  const abs = path.resolve(root, file);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
