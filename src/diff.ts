// What changed in the model between a git ref and the working tree, in the model's own terms:
// nodes, interfaces, links, shapes and their fields, flows, requirements, rules, changes.
// For a pull request this is the review a diagram cannot give: "this adds a link from api to stripe".
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from './compile.js';
import { LEGACY_DIR, MODEL_DIR, modelDir } from './paths.js';
import { guardsOf, weakenedBetween } from './security.js';
import type { Graph } from './types.js';

type Facts = Map<string, Record<string, string>>;

const join = (list: string[]): string => list.join(', ');
const tags = (x: { change?: string; modify?: string; retire?: string }): Record<string, string> => ({
  ...(x.change ? { change: x.change } : {}),
  ...(x.modify ? { modify: x.modify } : {}),
  ...(x.retire ? { retire: x.retire } : {}),
});

/** Everything a model declares, as flat facts. Computed status and anything read from code is left out. */
export function declared(g: Graph): Facts {
  const out: Facts = new Map();
  const drop = (o: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));
  for (const n of g.nodes) {
    out.set(`node ${n.id}`, drop({
      kind: n.kind, role: n.role, code: join(n.code), tests: join(n.tests), deploy: join(n.deploy),
      rules: n.rules.filter((r) => r.from === n.id).map((r) => r.text).join(' | '),
      never: join(n.never.filter((b) => b.from === n.id).map((b) => b.node)),
      client: n.client && !(n.parent && g.nodes.find((p) => p.id === n.parent)?.client) ? 'yes' : '',
      protect: n.protect && !(n.parent && g.nodes.find((p) => p.id === n.parent)?.protect) ? 'yes' : '',
      secrets: join(n.secrets), ...tags(n),
    }));
    for (const i of n.interfaces) {
      out.set(`interface ${i.ref}`, drop({ via: i.via ?? '', route: i.route ?? '', queue: i.queue ?? '', [i.holds ? 'shape' : 'takes']: join(i.takes), gives: join(i.gives), auth: i.auth ?? '', only: join(i.only ?? []), ...tags(i) }));
    }
    for (const q of n.requirements) out.set(`requirement ${q.ref}`, drop({ text: q.text, kind: q.kind ?? '', tests: join(q.tests), match: join(q.match), covers: join(q.covers), ...tags(q) }));
  }
  for (const e of g.edges) {
    const target = e.verb === 'reads' ? e.iface ?? e.from : e.iface ?? e.to;
    // A link has no name of its own unless it is given one, so it is known by who does what to what.
    out.set(`link ${e.ref ?? e.id.replace(/>/g, ' ')}`, drop({ what: `${e.owner} ${e.verb} ${target}`, via: e.via ?? '', carries: join(e.shapes), returns: join(e.returns), ...tags(e) }));
  }
  for (const s of g.shapes) {
    out.set(`shape ${s.id}`, drop({ source: s.source ?? '', ...Object.fromEntries(s.fields.map((f) => [`field ${f.name}`, [f.type, ...f.tags.map((t) => `@${t}`)].join(' ')])), ...tags(s) }));
  }
  for (const f of g.flows) out.set(`flow ${f.id}`, drop({ headline: f.headline, trigger: f.trigger ?? '', steps: f.steps.map((s) => s.text.trim()).join(' ; '), ...tags(f) }));
  for (const c of g.changes) out.set(`change ${c.id}`, drop({ title: c.title, state: c.state, after: join(c.after) }));
  return out;
}

export interface ModelDiff {
  ref: string;
  added: Array<{ what: string; facts: Record<string, string> }>;
  removed: string[];
  changed: Array<{ what: string; from: Record<string, string>; to: Record<string, string> }>;
  /** What the model guarded at `ref` and no longer does, and what it lets through now that it did not. */
  weakened: string[];
}

/** Copies a model folder (never its cache) somewhere it can be compiled on its own, without the code. */
function isolate(from: string, name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-diff-'));
  fs.cpSync(from, path.join(dir, name), { recursive: true, filter: (src) => path.basename(src) !== '.cache' });
  return dir;
}

/** The model as it was at a git ref, compiled on its own. Null when the ref has no model. */
function modelAt(root: string, ref: string): Graph | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-diff-'));
  try {
    for (const name of [modelDir(root), MODEL_DIR, LEGACY_DIR]) {
      try {
        const tar = execFileSync('git', ['archive', '--format=tar', ref, '--', name], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
        execFileSync('tar', ['-x', '-C', dir], { input: tar, stdio: ['pipe', 'ignore', 'ignore'] });
        if (fs.existsSync(path.join(dir, name, 'system.yaml'))) return compile(dir);
      } catch {
        /* the ref has no such folder */
      }
    }
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The declared model now against the declared model at `ref` (a commit, a branch, a tag). */
export function diffModel(root: string, ref: string): ModelDiff | string {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    return `"${ref}" is not a commit, branch or tag in this repo.`;
  }
  const then = modelAt(root, ref);
  // The working tree's model is compiled the same way, apart from the code, so only what the files declare is compared.
  const here = isolate(path.join(root, modelDir(root)), modelDir(root));
  let now: Graph;
  try {
    now = compile(here);
  } finally {
    fs.rmSync(here, { recursive: true, force: true });
  }
  const a = then ? declared(then) : new Map();
  const b = declared(now);
  const diff: ModelDiff = { ref, added: [], removed: [], changed: [], weakened: [] };
  if (then) diff.weakened.push(...weakenedBetween(guardsOf(then), guardsOf(now)));
  for (const [what, facts] of b) {
    const old = a.get(what);
    if (!old) diff.added.push({ what, facts });
    else if (JSON.stringify(old) !== JSON.stringify(facts)) diff.changed.push({ what, from: old, to: facts });
  }
  for (const what of a.keys()) if (!b.has(what)) diff.removed.push(what);
  return diff;
}

const ORDER = ['node', 'interface', 'link', 'shape', 'flow', 'requirement', 'change'];
const rank = (what: string): number => ORDER.indexOf(what.split(' ')[0]);
const byKind = <T>(list: T[], key: (x: T) => string): T[] => [...list].sort((x, y) => rank(key(x)) - rank(key(y)) || key(x).localeCompare(key(y)));

function summary(what: string, f: Record<string, string>): string {
  const kind = what.split(' ')[0];
  if (kind === 'node') return `${what} (${f.kind}): ${f.role ?? ''}${f.code ? `  [${f.code}]` : ''}`;
  if (kind === 'interface') return `${what}${f.via ? ` via ${f.via}` : ''}${f.route ? ` ${f.route}` : ''}${f.queue ? ` queue ${f.queue}` : ''}${f.takes ? ` takes ${f.takes}` : ''}${f.shape ? ` holds ${f.shape}` : ''}${f.gives ? ` gives ${f.gives}` : ''}`;
  if (kind === 'link') return `link ${f.what}${f.via ? ` via ${f.via}` : ''}${f.carries ? `: ${f.carries}` : ''}${f.returns ? ` => ${f.returns}` : ''}`;
  if (kind === 'shape') return `${what}: ${Object.keys(f).filter((k) => k.startsWith('field ')).map((k) => k.slice(6)).join(', ') || 'no fields'}`;
  if (kind === 'flow') return `${what}: ${f.headline ?? ''}`;
  if (kind === 'requirement') return `${what}: ${f.text ?? ''}`;
  return `${what} [${f.state}] ${f.title ?? ''}`;
}

export function diffText(d: ModelDiff | string): string {
  if (typeof d === 'string') return d;
  if (!d.added.length && !d.removed.length && !d.changed.length && !d.weakened.length) return `The model declares the same things as at ${d.ref}.`;
  const out = [`Model changes since ${d.ref}: ${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed.`];
  // Weakening a guard is the part a reviewer must not miss, so it comes first.
  if (d.weakened.length) out.push(`Guards removed (${d.weakened.length}): review these before merging.`, ...d.weakened.map((w) => `! ${w}`), '');
  for (const a of byKind(d.added, (x) => x.what)) out.push(`+ ${summary(a.what, a.facts)}${a.facts.change ? `  (change ${a.facts.change})` : ''}`);
  for (const c of byKind(d.changed, (x) => x.what)) {
    out.push(`~ ${c.what}`);
    for (const k of new Set([...Object.keys(c.from), ...Object.keys(c.to)])) {
      const [was, is] = [c.from[k], c.to[k]];
      if (was === is) continue;
      out.push(was === undefined ? `    + ${k}: ${is}` : is === undefined ? `    - ${k}: ${was}` : `    ${k}: was ${was}; now ${is}`);
    }
  }
  for (const r of byKind(d.removed, (x) => x)) out.push(`- ${r}`);
  return out.join('\n');
}
