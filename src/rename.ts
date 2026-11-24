// Renames one thing in the model and rewrites every reference to it: in node files, flows, shapes,
// changes, the lock files and the documents. A rename is mechanical, so the tool does it; an agent
// repairing references by hand is slower and misses some.
import fs from 'node:fs';
import path from 'node:path';
import YAML, { isPair, isScalar, visit, type Scalar } from 'yaml';
import { compile, LOCK_FILE } from './compile.js';
import { REF, splitHeader } from './docs.js';
import { APPROVALS_FILE, MODEL_DIR, readApprovals } from './paths.js';
import { findNode, refIndexOf, resolveRef, shortestNodeRef, type RefIndex } from './refs.js';
import type { DocRefType, Graph } from './types.js';

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const VERBS = ['calls', 'sends', 'reads', 'writes'];
const TAGS = ['change', 'modify', 'retire'];

interface Rename {
  type: DocRefType;
  /** Canonical reference before: full node id, node#interface, node~link, node:requirement, Shape, flow or change id. */
  from: string;
  /** The same reference after. */
  to: string;
}

/** Rewrites references written against the old model so they name the same things in the new one. */
class Rewriter {
  private oldIds: string[];
  private newIds: string[];
  constructor(private ix: RefIndex, private ren: Rename) {
    this.oldIds = ix.nodeIds;
    this.newIds = ix.nodeIds.map((id) => this.mapNode(id));
  }

  /** A node id after the rename: the node itself and everything inside it move together. */
  mapNode(id: string): string {
    if (this.ren.type !== 'node') return id;
    if (id === this.ren.from) return this.ren.to;
    return id.startsWith(`${this.ren.from}.`) ? `${this.ren.to}${id.slice(this.ren.from.length)}` : id;
  }

  /** A node reference, full or short. Left as written when it still names the same node. */
  node(text: string): string {
    const id = findNode(this.oldIds, text).id;
    if (!id) return text;
    const want = this.mapNode(id);
    if (findNode(this.newIds, text).id === want) return text;
    return text === id ? want : shortestNodeRef(this.newIds, want);
  }

  /** node#interface, node~link or node:requirement: the node part, and the name after it when that is what is renamed. */
  private part(text: string, sep: string, type: DocRefType): string {
    const at = text.indexOf(sep);
    const full = findNode(this.oldIds, text.slice(0, at)).id;
    if (!full) return text;
    const name = text.slice(at + 1);
    const renamed = this.ren.type === type && `${full}${sep}${name}` === this.ren.from ? this.ren.to.slice(this.ren.to.indexOf(sep) + 1) : name;
    return `${this.node(text.slice(0, at))}${sep}${renamed}`;
  }

  /** A link target: a node, or node#interface. */
  target(text: string): string {
    return text.includes('#') ? this.part(text, '#', 'interface') : this.node(text);
  }

  shape(text: string): string {
    return this.ren.type === 'shape' && text === this.ren.from ? this.ren.to : text;
  }

  /** A field type: the shape's name wherever it stands as a whole word ("Order[]", "map<string,Order>"). */
  fieldType(text: string): string {
    return this.ren.type === 'shape' ? text.replace(new RegExp(`\\b${this.ren.from}\\b`, 'g'), this.ren.to) : text;
  }

  change(text: string): string {
    return this.ren.type === 'change' && text === this.ren.from ? this.ren.to : text;
  }

  /** Any reference, as documents and `covers:` write them. */
  any(text: string): string {
    if (text.includes('#')) return this.part(text, '#', 'interface');
    if (text.includes('~')) return this.part(text, '~', 'link');
    if (text.includes(':')) {
      const at = text.indexOf(':');
      const [kind, name] = [text.slice(0, at), text.slice(at + 1)];
      // "flow:checkout" and the like, unless it is a requirement on a node that happens to be called that.
      if (['node', 'shape', 'flow', 'change'].includes(kind) && !this.ix.reqs.has(`${findNode(this.oldIds, kind).id}:${name}`)) {
        if (kind === 'node') return `node:${this.node(name)}`;
        return `${kind}:${this.ren.type === kind && name === this.ren.from ? this.ren.to : name}`;
      }
      return this.part(text, ':', 'requirement');
    }
    const r = resolveRef(this.ix, text);
    if (!r) return text;
    if (r.type === 'node') return this.node(text);
    if (r.type === 'shape') return this.ren.type === 'shape' && r.id === this.ren.from ? `${this.ren.to}${text.slice(this.ren.from.length)}` : text;
    return this.ren.type === r.type && r.id === this.ren.from ? this.ren.to : text;
  }

  /** A flow step: "a -> b#interface", or one named link. */
  step(text: string): string {
    const m = text.match(/^(\s*)(\S+)(\s*->\s*)(\S+)(\s*)$/);
    return m ? `${m[1]}${this.target(m[2])}${m[3]}${this.target(m[4])}${m[5]}` : text.includes('~') ? this.part(text.trim(), '~', 'link') : text;
  }

  /** One line of an approval record: "add node x [globs]", "modify interface x#y", "retire link a>calls>b#c". */
  element(text: string): string {
    const m = text.match(/^(\w+) (\w+) (\S+)(.*)$/);
    if (!m) return text;
    const [, how, kind, ref, rest] = m;
    const fixed =
      kind === 'node' ? this.mapNode(ref)
      : kind === 'interface' ? this.part(ref, '#', 'interface')
      : kind === 'requirement' ? this.part(ref, ':', 'requirement')
      // A named link is node~name. One with no name is known by its ends, "a>calls>b#c", with "~2" after it when two links share them.
      : kind === 'link' ? (!ref.includes('>') ? this.part(ref, '~', 'link') : ref.split('>').map((p, i) => (i === 1 ? p : this.target(p.replace(/~\d+$/, '')) + (p.match(/~\d+$/)?.[0] ?? ''))).join('>'))
      : kind === 'shape' ? this.shape(ref)
      : this.ren.type === kind && ref === this.ren.from ? this.ren.to : ref;
    return `${how} ${kind} ${fixed}${rest}`;
  }
}

/** The keys above a scalar in a YAML document, outermost first. A value's own key is the last. */
function keysAbove(trail: readonly unknown[]): string[] {
  return trail.filter(isPair).map((p) => (isScalar(p.key) ? String(p.key.value) : ''));
}

/** The node an inline entry of system.yaml declares, read from the entry the scalar sits in. */
function inlineNodeOf(trail: readonly unknown[]): string | null {
  for (let i = 0; i < trail.length; i++) {
    const p = trail[i];
    if (!isPair(p) || !isScalar(p.key) || !['actors', 'externals'].includes(String(p.key.value))) continue;
    const item = trail[i + 2] as { get?: (k: string) => unknown } | undefined;
    const id = item?.get?.('id');
    const parent = item?.get?.('parent');
    return typeof id === 'string' ? (typeof parent === 'string' ? `${parent}.${id}` : id) : null;
  }
  return null;
}

type Kind = 'node' | 'system' | 'flow' | 'shapes' | 'change';

/** Rewrites one YAML file of the model. Returns the new text, or null when nothing in it changes. */
function rewriteYaml(text: string, kind: Kind, rw: Rewriter, ren: Rename, self: string | null): string | null {
  const doc = YAML.parseDocument(text);
  let touched = false;
  const set = (node: Scalar, value: string): void => {
    if (value === String(node.value)) return;
    node.value = value;
    touched = true;
  };
  visit(doc, {
    Scalar(key, node, trail) {
      if (typeof node.value !== 'string') return;
      const keys = keysAbove(trail);
      const last = keys[keys.length - 1] ?? '';
      const v = node.value;
      if (key === 'key') {
        // The name of a shape is the key it is declared under.
        if (kind === 'shapes' && keys.length === 1) set(node, rw.shape(v));
        return;
      }
      if (TAGS.includes(last) || (kind === 'change' && last === 'after')) return set(node, rw.change(v));
      if (kind === 'shapes') {
        if (keys.includes('fields')) set(node, rw.fieldType(v));
        return;
      }
      if (kind === 'flow') {
        if (last === 'steps' || last === 'step') set(node, rw.step(v));
        return;
      }
      if (kind === 'change') return;
      // The data policy names the nodes tagged data may go to.
      if (kind === 'system' && keys[0] === 'data' && last === 'leaves') return set(node, rw.node(v));
      // A node file, or an inline node in system.yaml.
      const here = kind === 'system' ? inlineNodeOf(trail) : self;
      if (kind === 'system' && !here) return;
      if (['takes', 'gives', 'shape'].includes(last)) return set(node, rw.shape(v));
      if (VERBS.includes(last)) return set(node, rw.target(v));
      if (last === 'to' && keys.some((k) => VERBS.includes(k))) return set(node, rw.target(v));
      if (last === 'never' || (last === 'to' && keys.includes('never')) || last === 'parent') return set(node, rw.node(v));
      if (last === 'covers') return set(node, rw.any(v));
      const owned = (sep: string): boolean => `${here}${sep}${v}` === ren.from;
      const tail = (sep: string): string => ren.to.slice(ren.to.indexOf(sep) + 1);
      if (last === 'holds' && ren.type === 'interface' && owned('#')) return set(node, tail('#'));
      if (last !== 'id') return;
      if (keys.includes('accepts') || keys.includes('holds')) {
        if (ren.type === 'interface' && owned('#')) set(node, tail('#'));
      } else if (keys.includes('requirements')) {
        if (ren.type === 'requirement' && owned(':')) set(node, tail(':'));
      } else if (keys.some((k) => VERBS.includes(k))) {
        if (ren.type === 'link' && owned('~')) set(node, tail('~'));
      } else if (ren.type === 'node' && here === ren.from) {
        // The id of the node itself: a file's own "id:", or an inline node's.
        set(node, ren.to.split('.').pop() as string);
      }
    },
  });
  return touched ? doc.toString({ lineWidth: 0, flowCollectionPadding: false }) : null;
}

/** Rewrites the header (about, change) and the [[references]] of one document. Text inside code is left alone. */
function rewriteDoc(text: string, rw: Rewriter): string | null {
  const { front, body } = splitHeader(text);
  let head = text.slice(0, text.length - body.length);
  if (front) {
    const doc = YAML.parseDocument(front);
    let touched = false;
    visit(doc, {
      Scalar(key, node, trail) {
        if (key === 'key' || (typeof node.value !== 'string' && typeof node.value !== 'number')) return;
        const top = keysAbove(trail)[0];
        const v = String(node.value);
        const next = top === 'about' ? rw.any(v) : top === 'change' ? rw.change(v) : v;
        if (next !== v) {
          node.value = next;
          touched = true;
        }
      },
    });
    // As a function, so a "$" in the header (a title with "US$") is text and not a replacement pattern.
    if (touched) head = head.replace(front, () => doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\n$/, ''));
  }
  const parts = body.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/);
  const prose = parts.map((part, i) => (i % 2 ? part : part.replace(new RegExp(REF.source, 'g'), (whole, ref: string) => whole.replace(ref, rw.any(ref)))));
  const next = head + prose.join('');
  return next === text ? null : next;
}

const NAMES: Record<DocRefType, string> = { node: 'node', interface: 'interface', link: 'link', requirement: 'requirement', shape: 'shape', flow: 'flow', change: 'change' };

/** What `to` must look like for each kind of thing, and the full reference it makes. Returns an error text or the target. */
function targetFor(g: Graph, ix: RefIndex, type: DocRefType, from: string, to: string): { to: string } | string {
  const taken = (ref: string): string | null => (resolveRef(ix, ref) && ref !== from ? `"${ref}" already exists.` : null);
  if (type === 'node') {
    if (!to.split('.').every((s) => SLUG.test(s))) return `"${to}" is not a node id: lowercase letters, digits and dashes, with dots between levels.`;
    if (ix.nodeIds.includes(to)) return `Node "${to}" already exists.`;
    if (to.startsWith(`${from}.`)) return `A node cannot move inside itself.`;
    const parent = to.includes('.') ? to.slice(0, to.lastIndexOf('.')) : null;
    if (parent && !ix.nodeIds.includes(parent)) return `"${parent}" is not a node. Create the group first (a folder with _group.yaml), then move the node into it.`;
    return { to };
  }
  if (type === 'shape') return /^[A-Z][A-Za-z0-9]*$/.test(to) ? (taken(`shape:${to}`) ?? { to }) : `"${to}" is not a shape name: PascalCase letters and digits.`;
  if (!SLUG.test(to)) return `"${to}" is not a valid name: lowercase letters, digits and dashes.`;
  if (type === 'flow' || type === 'change') return taken(`${type}:${to}`) ?? { to };
  const sep = type === 'interface' ? '#' : type === 'link' ? '~' : ':';
  const full = `${from.slice(0, from.indexOf(sep))}${sep}${to}`;
  void g;
  return taken(full) ?? { to: full };
}

/**
 * Renames a node (or moves it: the new id is its full dotted path), an interface, a named link,
 * a requirement, a shape, a flow or a change, and rewrites every reference. `to` is the new name
 * alone, except for a node, where it is the whole new id.
 */
export function rename(root: string, from: string, to: string): string {
  const g = compile(root);
  const ix = refIndexOf(g);
  const r = resolveRef(ix, from);
  if (!r) return `Nothing named "${from}".`;
  const target = targetFor(g, ix, r.type, r.id, to);
  if (typeof target === 'string') return target;
  const ren: Rename = { type: r.type, from: r.id, to: target.to };
  const rw = new Rewriter(ix, ren);
  const mdir = MODEL_DIR;
  const arch = path.join(root, mdir);
  const rel = (abs: string): string => path.relative(root, abs).replace(/\\/g, '/');

  const node = r.type === 'node' ? g.nodes.find((n) => n.id === ren.from)! : null;
  const inline = !!node && node.source === `${mdir}/system.yaml`;
  if (inline && (ren.to.includes('.') ? ren.to.slice(0, ren.to.lastIndexOf('.')) : '') !== (node!.parent ?? '')) {
    return `"${ren.from}" is declared inline in ${mdir}/system.yaml. It can be renamed, but to move it, edit its "parent:" there.`;
  }

  // 1. Rewrite the YAML of the model.
  const writes = new Map<string, string>();
  const yamlIn = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (/\.ya?ml$/.test(e.name)) out.push(path.join(d, e.name));
      }
    };
    walk(dir);
    return out;
  };
  const nodeIdOf = (abs: string): string => {
    const parts = path.relative(path.join(arch, 'nodes'), abs).replace(/\\/g, '/').replace(/\.ya?ml$/, '').split('/');
    if (parts[parts.length - 1] === '_group') parts.pop();
    return parts.join('.');
  };
  const each = (files: string[], kind: Kind, self: (abs: string) => string | null): void => {
    for (const abs of files) {
      const next = rewriteYaml(fs.readFileSync(abs, 'utf8'), kind, rw, ren, self(abs));
      if (next !== null) writes.set(abs, next);
    }
  };
  each(yamlIn(path.join(arch, 'nodes')), 'node', nodeIdOf);
  each([path.join(arch, 'system.yaml')].filter((p) => fs.existsSync(p)), 'system', () => null);
  each(yamlIn(path.join(arch, 'flows')), 'flow', () => null);
  each(yamlIn(path.join(arch, 'shapes')), 'shapes', () => null);
  each(yamlIn(path.join(arch, 'changes')), 'change', () => null);

  // 2. Documents: headers and [[references]].
  for (const d of g.docs) {
    const abs = path.join(root, d.path);
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const next = rewriteDoc(text, rw);
    if (next !== null) writes.set(abs, next);
  }

  // 3. The records the tool keeps: confirmed shapes and approvals.
  if (r.type === 'shape') {
    const lockPath = path.join(arch, LOCK_FILE);
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (lock[ren.from]) {
        lock[ren.to] = lock[ren.from];
        delete lock[ren.from];
        writes.set(lockPath, `${JSON.stringify(Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
      }
    } catch {
      /* no lock file */
    }
  }
  const approvals = readApprovals(root);
  if (Object.keys(approvals).length) {
    const next = Object.fromEntries(Object.entries(approvals).map(([id, rec]) => [rw.change(id), { ...rec, elements: (rec.elements ?? []).map((e) => rw.element(e)).sort() }]));
    if (JSON.stringify(next) !== JSON.stringify(approvals)) writes.set(path.join(arch, APPROVALS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  }

  for (const [abs, text] of writes) fs.writeFileSync(abs, text);

  // 4. Move the files whose names carry the id.
  const moved: string[] = [];
  const move = (a: string, b: string): void => {
    if (!fs.existsSync(a)) return;
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    moved.push(`${rel(a)} -> ${rel(b)}`);
  };
  if (node && !inline) {
    const oldBase = path.join(arch, 'nodes', ...ren.from.split('.'));
    const newBase = path.join(arch, 'nodes', ...ren.to.split('.'));
    for (const ext of ['.yaml', '.yml']) move(`${oldBase}${ext}`, `${newBase}${ext}`);
    move(oldBase, newBase);
  } else if (r.type === 'flow' || r.type === 'change') {
    const dir = path.join(arch, r.type === 'flow' ? 'flows' : 'changes');
    for (const ext of ['.yaml', '.yml']) {
      const a = path.join(dir, `${ren.from}${ext}`);
      if (!fs.existsSync(a)) continue;
      // A file may repeat its id inside; it has to match the file name.
      const doc = YAML.parseDocument(fs.readFileSync(a, 'utf8'));
      if (doc.has('id')) {
        doc.set('id', ren.to);
        fs.writeFileSync(a, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
      }
      move(a, path.join(dir, `${ren.to}${ext}`));
    }
  }

  // 5. What the tool does not rewrite: test titles in code. Name them.
  const tagged: string[] = [];
  if (r.type === 'node' || r.type === 'requirement') {
    const mine = (tag: string): boolean => {
      const at = tag.indexOf(':');
      const id = at > 0 ? findNode(ix.nodeIds, tag.slice(0, at)).id : null;
      if (!id) return false;
      return r.type === 'requirement' ? `${id}:${tag.slice(at + 1)}` === ren.from : rw.node(tag.slice(0, at)) !== tag.slice(0, at);
    };
    for (const n of g.nodes) {
      for (const f of n.testedBy) {
        try {
          const text = fs.readFileSync(path.join(root, f), 'utf8');
          if ([...text.matchAll(/\[req ([^\]\s]+)\]/g)].some((m) => mine(m[1])) && !tagged.includes(f)) tagged.push(f);
        } catch {
          /* gone */
        }
      }
    }
  }

  const after = compile(root);
  const errors = after.problems.filter((p) => p.level === 'error').length;
  const out = [`Renamed ${NAMES[r.type]} ${ren.from} to ${ren.to}.`];
  const edited = [...writes.keys()].map(rel).filter((f) => !moved.some((m) => m.startsWith(`${f} `)));
  if (edited.length) out.push(`References rewritten in ${edited.length} file${edited.length === 1 ? '' : 's'}:`, ...edited.sort().map((f) => `  ${f}`));
  if (moved.length) out.push('Moved:', ...moved.map((m) => `  ${m}`));
  if (tagged.length) out.push('Test titles still carry the old name in a [req …] tag. Change them by hand:', ...tagged.map((f) => `  ${f}`));
  if (r.type === 'node') out.push(`Commit scopes that named the node keep working if you add "scopes: [${ren.from.split('.').pop()}]" to it.`);
  out.push(errors ? `armature check now reports ${errors} error${errors === 1 ? '' : 's'}; run it.` : 'armature check reports no errors.');
  return out.join('\n');
}
