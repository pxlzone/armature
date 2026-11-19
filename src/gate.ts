// The planning gate: cheap checks that run before an agent writes a file, runs a shell command
// or presents a plan, so new work goes through the model and not around it.
//
// It reads only the YAML it needs, because it runs before a tool call. What it cannot see before
// the fact (a script that writes files, a tool it does not know), the checker reports afterwards:
// "built-unapproved", "scope-changed", "unrecorded-approval".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { matcher, readRepo } from './repo.js';
import { APPROVALS_FILE, CONFIRMED_FILE, docsDir, MODEL_DIR, newPlanPath, readApprovals } from './paths.js';
import { type Guards, noGuards, optOut, tagGuard, weakenedBetween } from './security.js';

/**
 * Files that are system code or define the system: source in any language, schemas, infrastructure
 * and scripts. Anything else (configuration, data, documents) passes the gate.
 */
export const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro|py|go|rs|rb|java|kt|scala|swift|m|mm|c|h|cc|cpp|hpp|cs|php|ex|exs|dart|lua|sql|proto|graphql|gql|prisma|tf|sh|bash)$/i;
/** A test by its file name, wherever it sits. */
const TEST_NAME = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|(^|\/)conftest\.py$/;
/** The same built-in skips the coverage check uses: build output and generated files. The model folder is added per repo. */
const BUILTIN = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/generated/**', '**/*.gen.*'];
/**
 * The model files that carry guards, as paths inside the model folder: nodes (protect, client, never,
 * auth, only, requirements, and the globs that say which files a node owns), shapes (the tags the data
 * policy reads), system.yaml (the data policy, ignore, accept, the gate) and tech.yaml (the files a
 * technology places outside the gate).
 */
const GUARD_FILE = /^(?:nodes\/.+|shapes\/.+|system|tech)\.ya?ml$/;
/** The Claude Code settings of the repo: where the hooks and the plugin are switched on. */
const SETTINGS_FILE = /^\.claude\/settings(\.local)?\.json$/;

export interface GateDecision {
  decision: 'deny' | 'ask';
  reason: string;
  /** Set when the question is whether to approve this change. */
  approves?: string;
}

/** What a file-writing tool was asked to do, whichever tool it is (Edit, Write, MultiEdit, or an MCP file tool). */
export interface WriteInput {
  file_path?: string;
  path?: string;
  destination?: string;
  /** The file a move takes its content from (MCP move_file). */
  source?: string;
  notebook_path?: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  edits?: Array<{ old_string?: string; new_string?: string; oldText?: string; newText?: string; replace_all?: boolean }>;
}

/** The change that stands behind a node: the one that adds it or alters it, its own or inherited. */
interface Tag {
  id: string;
  how: 'add' | 'modify';
}

interface OwnNode {
  id: string;
  code: (f: string) => boolean;
  tests: (f: string) => boolean;
  /** The change that adds or alters the node, as an id. Kept for callers that only need the id. */
  change?: string;
  tag?: Tag;
  /** `protect: true` on it or an ancestor: editing its files needs an approved change that alters it. */
  protect: boolean;
  /** `client: true` on it or an ancestor: code that runs on the user's device. */
  client: boolean;
}

export interface Ownership {
  /** False when system.yaml says `gate: off`, or when no node owns code yet (a model being started). */
  on: boolean;
  nodes: OwnNode[];
  changes: Map<string, string>;
  /** Tool files, ignored files and built-in skips: placed without a node. */
  placed: (f: string) => boolean;
}

/** Files as an edit would leave them, by absolute path: the text a file would hold, or null for one that would be gone. */
type Overlay = Map<string, string | null>;

function parseYaml(text: string): any {
  try {
    const data = YAML.parse(text);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function readYaml(file: string, overlay?: Overlay): any {
  const over = overlay?.get(file);
  if (over === null) return {};
  if (over !== undefined) return parseYaml(over);
  try {
    return parseYaml(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** What a folder holds, with the overlay's files put in and the ones it removes taken out. */
function listDir(dir: string, overlay?: Overlay): Array<{ name: string; file: boolean }> {
  const out = new Map<string, boolean>();
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isFile() || e.isDirectory()) out.set(e.name, e.isFile());
  } catch {
    /* not there */
  }
  for (const [p, text] of overlay ?? []) {
    if (!p.startsWith(dir + path.sep)) continue;
    const [first, ...rest] = p.slice(dir.length + 1).split(path.sep);
    if (rest.length) {
      if (text !== null && !out.has(first)) out.set(first, false);
    } else if (text === null) out.delete(first);
    else out.set(first, true);
  }
  return [...out].map(([name, file]) => ({ name, file }));
}

const list = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');

/**
 * Who owns which paths, and which changes are approved. Read straight from the YAML.
 * With an overlay, read as the model would stand after an edit that has not been made yet.
 */
export function readOwnership(root: string, overlay?: Overlay): Ownership {
  const mdir = MODEL_DIR;
  const arch = path.join(root, mdir);
  const sys = readYaml(path.join(arch, 'system.yaml'), overlay);
  const nodes: OwnNode[] = [];
  type Inherit = { tag: Tag | undefined; protect: boolean; client: boolean };
  const add = (id: string, data: any, up: Inherit): Inherit => {
    const tag: Tag | undefined = typeof data.change === 'string' ? { id: data.change, how: 'add' } : typeof data.modify === 'string' ? { id: data.modify, how: 'modify' } : up.tag;
    const protect = data.protect === true || (up.protect && data.protect !== false);
    const client = data.client === true || (up.client && data.client !== false);
    nodes.push({ id, code: matcher(list(data.code)), tests: matcher(list(data.tests)), change: tag?.id, tag, protect, client });
    return { tag, protect, client };
  };
  let anyCode = false;
  const walk = (dir: string, prefix: string, inherited: Inherit): void => {
    const entries = listDir(dir, overlay);
    const own = new Map<string, Inherit>();
    for (const e of entries) {
      if (!e.file || !/\.ya?ml$/.test(e.name) || e.name.startsWith('_')) continue;
      const base = e.name.replace(/\.ya?ml$/, '');
      const data = readYaml(path.join(dir, e.name), overlay);
      if (list(data.code).length) anyCode = true;
      own.set(base, add(prefix ? `${prefix}.${base}` : base, data, inherited));
    }
    for (const e of entries) {
      if (e.file) continue;
      const id = prefix ? `${prefix}.${e.name}` : e.name;
      const sub = path.join(dir, e.name);
      const inSub = listDir(sub, overlay);
      const groupFile = ['_group.yaml', '_group.yml'].find((n) => inSub.some((x) => x.file && x.name === n));
      let up = own.get(e.name) ?? inherited;
      if (groupFile) {
        const data = readYaml(path.join(sub, groupFile), overlay);
        if (list(data.code).length) anyCode = true;
        up = add(id, data, inherited);
      }
      walk(sub, id, up);
    }
  };
  walk(path.join(arch, 'nodes'), '', { tag: undefined, protect: false, client: false });
  // Deepest node first, then by id, so the most specific owner wins and the compiler agrees on ties.
  nodes.sort((a, b) => b.id.split('.').length - a.id.split('.').length || a.id.localeCompare(b.id));

  const changes = new Map<string, string>();
  for (const f of listDir(path.join(arch, 'changes'), overlay)) {
    if (!f.file || !/\.ya?ml$/.test(f.name)) continue;
    changes.set(f.name.replace(/\.ya?ml$/, ''), String(readYaml(path.join(arch, 'changes', f.name), overlay).state ?? 'proposed'));
  }
  const tech = readYaml(path.join(arch, 'tech.yaml'), overlay);
  const techFiles = (Array.isArray(tech.tech) ? tech.tech : []).flatMap((t: any) => list(t?.files));
  const ignored = (Array.isArray(sys.ignore) ? sys.ignore : []).map((x: any) => (typeof x === 'string' ? x : String(x?.path ?? ''))).filter(Boolean);
  return { on: sys.gate !== 'off' && anyCode, nodes, changes, placed: matcher([`${mdir}/**`, ...BUILTIN, ...techFiles, ...ignored]) };
}

/** True unless the model's system.yaml says `gate: off`. */
export function gateOn(root: string): boolean {
  return readYaml(path.join(root, MODEL_DIR, 'system.yaml')).gate !== 'off';
}

/** The file a write is aimed at, whichever tool asks. */
export function targetOf(input: WriteInput | undefined): string | undefined {
  return input?.file_path ?? input?.path ?? input?.destination ?? input?.notebook_path;
}

/** The text a file would hold after the write, or null when the edit cannot be replayed from what the hook was given. */
function resultOf(root: string, before: string, input: WriteInput): string | null {
  if (typeof input.content === 'string') return input.content;
  const edits = input.edits ?? (input.new_string !== undefined ? [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }] : []);
  if (!edits.length) {
    // A move brings the content of the file it moves.
    if (typeof input.source !== 'string') return null;
    try {
      return fs.readFileSync(path.resolve(root, input.source), 'utf8');
    } catch {
      return null;
    }
  }
  let text = before;
  for (const e of edits) {
    const from = e.old_string ?? e.oldText;
    const to = e.new_string ?? e.newText ?? '';
    if (typeof from !== 'string' || !from || !text.includes(from)) return null;
    text = e.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
  }
  return text;
}

/** Everything the write adds, for the cases where the result cannot be replayed. */
function writtenText(input: WriteInput): string {
  return [input.content, input.new_string, ...(input.edits ?? []).flatMap((e) => [e.new_string, e.newText])].filter((x): x is string => typeof x === 'string').join('\n');
}

function yamlValue(text: string, key: string): string {
  try {
    const data = YAML.parse(text);
    if (data && typeof data === 'object' && data[key] !== undefined) return String(data[key]);
  } catch {
    /* fall through to the line match */
  }
  return text.match(new RegExp(`^\\s*${key}:\\s*["']?([A-Za-z]+)`, 'm'))?.[1] ?? '';
}

/** A test file, which the gate lets through: named as one, or inside a test folder that is already there. */
function isTestPath(root: string, rel: string): boolean {
  if (TEST_NAME.test(rel)) return true;
  const m = rel.match(/^((?:.*\/)?(?:__tests__|tests?|e2e))\//);
  return !!m && fs.existsSync(path.join(root, m[1]));
}

/**
 * Decides whether a write may go ahead.
 *  - Approving a change, finishing one that was never approved, switching the gate off and
 *    editing the approval record all ask the person: those decisions are theirs.
 *  - A new source file must belong to a node. The node must already be part of the system, or
 *    belong to a change a person approved, as one of the elements they approved.
 * Returns null when the gate has nothing to say.
 */
export function writeGate(root: string, input: WriteInput): GateDecision | null {
  const target = targetOf(input);
  if (!target) return null;
  const abs = path.resolve(root, target);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return null;

  const mdir = MODEL_DIR;
  const before = fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : '';
  const after = resultOf(root, before, input);
  // A write the gate was given no text for (a tool whose input it does not know): it cannot say what the file will hold.
  const blind = after === null && !writtenText(input).trim();

  // Moving the approval record away removes it as surely as editing it.
  const from = typeof input.source === 'string' ? path.relative(root, path.resolve(root, input.source)).replace(/\\/g, '/') : '';
  if (from === `${mdir}/${APPROVALS_FILE}`) {
    return { decision: 'ask', reason: `This moves ${from}, the record of what a person approved. Allow it only to remove that record.` };
  }
  // So does moving any other file: a protected file is taken out of its node, a model file takes its guards with it.
  if (from && !from.startsWith('..') && fs.existsSync(path.resolve(root, from))) {
    const gone = removalGate(root, [path.resolve(root, from)], 'This moves');
    if (gone) return gone;
  }

  const change = rel.startsWith(`${mdir}/changes/`) ? rel.slice(mdir.length + 9).match(/^([^/]+)\.ya?ml$/)?.[1] : undefined;
  if (change) {
    const was = before ? yamlValue(before, 'state') || 'proposed' : '';
    if (blind && was !== 'approved' && was !== 'done') {
      return { decision: 'ask', approves: change, reason: `This writes change "${change}" in a way the gate cannot read, so it may approve it.${elementsNote(root, change)}` };
    }
    // Without the result, go by what the write adds: "state: approved", or the bare word replacing another.
    const added = writtenText(input);
    const guess = /^\s*(?:state:\s*)?["']?(approved|done)\b["']?\s*$/m.exec(added)?.[1] ?? '';
    const now = after !== null ? yamlValue(after, 'state') : guess;
    if (now === 'approved' && was !== 'approved') {
      return {
        decision: 'ask',
        approves: change,
        reason: `This approves change "${change}". Allow it only if you reviewed the plan and want it built.${elementsNote(root, change)}`,
      };
    }
    if (now === 'done' && was !== 'approved' && was !== 'done') {
      return {
        decision: 'ask',
        reason: `This marks change "${change}" done, and it was never approved (it is ${was || 'new'}).`,
      };
    }
    return null;
  }
  if (rel === `${mdir}/${APPROVALS_FILE}`) {
    return { decision: 'ask', reason: `This edits ${rel}, the record of what a person approved. "armature approve" writes it, not a hand.` };
  }
  if (rel === `${mdir}/${CONFIRMED_FILE}`) {
    return { decision: 'ask', reason: `This edits ${rel}, the record of requirements a person read against the code. "armature confirm" writes it, not a hand.` };
  }
  if (rel === `${mdir}/system.yaml`) {
    const was = yamlValue(before, 'gate');
    if (blind && was !== 'off') {
      return { decision: 'ask', reason: `This writes ${rel} in a way the gate cannot read, so it may switch the planning gate off.` };
    }
    const now = after !== null ? yamlValue(after, 'gate') : /^\s*gate:\s*["']?off\b/m.test(writtenText(input)) ? 'off' : was;
    if (now === 'off' && was !== 'off') {
      return { decision: 'ask', reason: 'This sets "gate: off": the planning gate goes off for everyone who works in this repo.' };
    }
    return after !== null ? weakenAsk(rel, modelWeakened(root, rel, before, after)) : null;
  }
  // Taking a guard out of the model, or letting more through, is the person's call.
  if (after !== null && rel.startsWith(`${mdir}/`) && GUARD_FILE.test(rel.slice(mdir.length + 1))) return weakenAsk(rel, modelWeakened(root, rel, before, after));
  if (after !== null && SETTINGS_FILE.test(rel)) return weakenAsk(rel, weakened(rel, before, after));

  if (rel.startsWith(`${mdir}/`)) return null;
  if (fs.existsSync(abs)) return protectGate(root, rel);
  if (!CODE_FILE.test(rel) || isTestPath(root, rel)) return null;
  const own = readOwnership(root);
  if (!own.on || own.placed(rel)) return null;
  const owner = own.nodes.find((n) => n.code(rel)) ?? own.nodes.find((n) => n.tests(rel));
  if (!owner) {
    return {
      decision: 'deny',
      reason:
        `"${rel}" would be a new source file that no node in the architecture model owns. Put it in the model first, then write it:\n` +
        `- If it belongs to an existing part of the system, widen that node's "code:" globs in ${mdir}/nodes/ (run "armature where <a neighbouring file>" to find the node).\n` +
        `- If it is a new part of the system, plan it as a change (armature-design skill): ${mdir}/changes/<id>.yaml with "state: proposed", a node whose "code:" globs cover this path and which carries "change: <id>", and the plan in ${newPlanPath(docsDir(root), mdir)}. Then ask the person to approve it.\n` +
        `- If it is not system code (a one-off script, a fixture), add it to "ignore:" in ${mdir}/system.yaml with a reason.\n` +
        `Run "armature check" after editing ${mdir}/.`,
    };
  }
  const tag = owner.tag;
  const state = tag ? own.changes.get(tag.id) : undefined;
  const role = tag?.how === 'modify' ? `the node "${owner.id}", which change "${tag.id}" alters` : `the planned node "${owner.id}", part of change "${tag?.id}"`;
  if (tag && state === 'proposed') {
    return {
      decision: 'deny',
      reason:
        `"${rel}" belongs to ${role}, which is still proposed. Code is written only for approved changes. ` +
        `Ask the person to review the change (armature view, Work lens) and approve it; do not approve it yourself.`,
    };
  }
  if (tag && state === 'dropped') {
    return { decision: 'deny', reason: `"${rel}" belongs to the node "${owner.id}", part of change "${tag.id}", which was dropped. Do not build it; ask the person what they want instead.` };
  }
  if (tag && state === 'approved') {
    // The person approved a list of elements. A node that joined the change afterwards is not on it.
    const rec = readApprovals(root)[tag.id];
    const elements = rec?.elements ?? [];
    const names = (how: string, id: string): RegExp => new RegExp(`^(?:${how}) node ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`);
    const self = elements.some((e) => names('add|modify', owner.id).test(e));
    // "modify:" on a node covers what is inside it, and the record lists only the node that
    // carries the tag: a node inside it is covered by that entry.
    const around = tag.how === 'modify' && owner.id.split('.').slice(0, -1).some((_, i, all) => elements.some((e) => names('modify', all.slice(0, i + 1).join('.')).test(e)));
    if (rec && !self && !around) {
      return {
        decision: 'deny',
        reason:
          `"${rel}" belongs to the node "${owner.id}", which joined change "${tag.id}" after ${rec.by || 'the person'} approved it. ` +
          `The approval covers the elements the change had then. Ask the person to approve it again ("armature approve ${tag.id}"); do not run that yourself.`,
      };
    }
    // Covered only through the node around it: altering that node adds no new node, so this one
    // must already be part of the system, which the check below settles.
    if (!rec || self) return null;
  }
  // No open change stands behind the node. It can take new files only if it is already part of the system.
  if (!readRepo(root).files.some((f) => owner.code(f) || owner.tests(f))) {
    return {
      decision: 'deny',
      reason:
        `"${rel}" would be the first file of the node "${owner.id}", which has no code yet and is not part of an approved change. ` +
        `A new part of the system is planned first: create ${mdir}/changes/<id>.yaml with "state: proposed", tag the node "change: <id>", write the plan in ${newPlanPath(docsDir(root), mdir)}, and ask the person to approve it.`,
    };
  }
  return null;
}

/**
 * An edit to an existing file of a protected node: allowed only under an approved change that adds
 * or alters the node (or one around it), as one of the elements the person approved.
 */
export function protectGate(root: string, rel: string, own: Ownership = readOwnership(root)): GateDecision | null {
  if (!CODE_FILE.test(rel) || isTestPath(root, rel) || !own.on) return null;
  // The node's claim comes first, as it does for the compiler: a technology's "files:" or an
  // "ignore:" entry places a file nobody owns, and does not take one out of a protected node.
  const owner = own.nodes.find((n) => n.code(rel));
  if (!owner?.protect) return null;
  const mdir = MODEL_DIR;
  const tag = owner.tag;
  const state = tag ? own.changes.get(tag.id) : undefined;
  const plan =
    `Plan the edit as a change: ${mdir}/changes/<id>.yaml with "state: proposed", "modify: <id>" on "${owner.id}" (or on the node around it), and the plan in ${newPlanPath(docsDir(root), mdir)}. ` +
    'Then ask the person to approve it; do not approve it yourself.';
  if (!tag || state === undefined || state === 'done') {
    return { decision: 'deny', reason: `"${rel}" belongs to "${owner.id}", which is protected (protect: true): its files change only under an approved change that alters it, and none is open. ${plan}` };
  }
  if (state !== 'approved') {
    return { decision: 'deny', reason: `"${rel}" belongs to "${owner.id}", which is protected (protect: true). The change behind it, "${tag.id}", is ${state}: its files change only once a person approves it.${state === 'proposed' ? ' Ask the person to review and approve it.' : ''}` };
  }
  const rec = readApprovals(root)[tag.id];
  const ids = owner.id.split('.').map((_, i, all) => all.slice(0, i + 1).join('.'));
  const listed = (e: string): boolean => ids.some((id) => new RegExp(`^(?:add|modify) node ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`).test(e));
  if (!rec || !(rec.elements ?? []).some(listed)) {
    return { decision: 'deny', reason: `"${rel}" belongs to "${owner.id}", which is protected (protect: true). Change "${tag.id}" is approved, but ${rec ? `the approval ${rec.by || 'the person'} gave does not list the node` : 'nothing records who approved it'}. Ask the person to approve it again ("armature approve ${tag.id}"); do not run that yourself.` };
  }
  return null;
}

/** The node a file under nodes/ declares: nodes/a/b.yaml is a.b, nodes/a/_group.yaml is a. */
function nodeIdOf(rel: string): string {
  const tail = rel.replace(/^.*?\bnodes\//, '').replace(/\.ya?ml$/, '').replace(/\/_group$/, '');
  return tail.split('/').join('.');
}

/** What a node file inherits from the nodes around it. */
interface Inherited {
  protect: boolean;
  client: boolean;
}

/** True when a "files:" glob of a technology could place a source file: one that ends in a plain extension matches only files of that kind. */
function mayHoldCode(glob: string): boolean {
  const ext = /\.[A-Za-z0-9]+$/.exec(glob.split('/').pop() ?? '');
  return !ext || CODE_FILE.test(`x${ext[0]}`);
}

/** What one model or settings file guards, and what it lets through. */
function guardsOfFile(rel: string, text: string, up: Inherited = { protect: false, client: false }): Guards {
  const out = noGuards();
  const { guards, allowances } = out;
  if (!text.trim()) return out;
  if (/\.json$/.test(rel)) {
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      return out;
    }
    for (const m of JSON.stringify(data?.hooks ?? {}).matchAll(/armature\.mjs\\?"? hook ([\w-]+)/g)) guards.add(`hook ${m[1]}`);
    for (const [k, on] of Object.entries<any>(data?.enabledPlugins ?? {})) {
      if (!/^armature@/.test(k)) continue;
      if (on) guards.add(`plugin ${k}`);
      // Written as off, it overrides a settings file that has it on.
      else allowances.add(`plugin ${k} switched off`);
    }
    if (data?.disableAllHooks === true) allowances.add('disableAllHooks');
    return out;
  }
  let data: any;
  try {
    data = YAML.parse(text);
  } catch {
    return out;
  }
  if (!data || typeof data !== 'object') return out;
  const ofNode = (id: string, d: any, around: Inherited): void => {
    if (!d || typeof d !== 'object') return;
    if (d.protect === true) guards.add(`protect ${id}`);
    if (d.client === true) guards.add(`client ${id}`);
    // Both pass to the nodes inside. One that says "false" steps out of what the node around it set.
    if (d.protect === false && around.protect) allowances.add(optOut('protect', id));
    if (d.client === false && around.client) allowances.add(optOut('client', id));
    for (const b of Array.isArray(d.never) ? d.never : []) {
      const to = typeof b === 'string' ? b : b?.to;
      if (to) guards.add(`never ${id} -> ${to}`);
    }
    for (const i of [...(Array.isArray(d.accepts) ? d.accepts : []), ...(Array.isArray(d.holds) ? d.holds : [])]) {
      if (!i || typeof i !== 'object' || !i.id) continue;
      const ref = `${id}#${i.id}`;
      if (i.auth !== undefined && i.auth !== null) out.auth.set(ref, String(i.auth));
      if (list(i.only).length) out.only.set(ref, list(i.only));
    }
    for (const q of Array.isArray(d.requirements) ? d.requirements : []) if (q?.id) guards.add(`requirement ${id}:${q.id}${q.kind === 'security' ? ' (security)' : ''}`);
  };
  if (/(^|\/)system\.ya?ml$/.test(rel)) {
    for (const x of [...(Array.isArray(data.actors) ? data.actors : []), ...(Array.isArray(data.externals) ? data.externals : [])]) if (x?.id) ofNode(String(x.id), x, { protect: false, client: false });
    for (const [t, p] of Object.entries<any>(data.data && typeof data.data === 'object' ? data.data : {})) {
      guards.add(`data policy @${t}`);
      for (const l of list(p?.leaves)) allowances.add(`@${t} may leave to ${l}`);
    }
    for (const x of Array.isArray(data.ignore) ? data.ignore : []) {
      const p = typeof x === 'string' ? x : x?.path;
      if (p) allowances.add(`ignore ${p}`);
    }
    for (const a of Array.isArray(data.accept) ? data.accept : []) {
      if (a?.code) allowances.add(`accept ${[a.code, a.ref, a.file, a.match ? `"${a.match}"` : ''].filter(Boolean).join(' ')}`);
    }
    return out;
  }
  if (/(^|\/)tech\.ya?ml$/.test(rel)) {
    // A technology's "files:" are placed without a node, like an "ignore:" entry: the gate lets new files there through.
    for (const t of Array.isArray(data.tech) ? data.tech : []) for (const g of list(t?.files)) if (mayHoldCode(g)) allowances.add(`files of ${t?.id ?? 'a technology'}: ${g}`);
    return out;
  }
  if (/(^|\/)shapes\//.test(rel)) {
    // A tag on a field is what the data policy and "open-entry" read.
    for (const [id, sh] of Object.entries<any>(data)) {
      for (const [name, spec] of Object.entries<any>(sh?.fields && typeof sh.fields === 'object' ? sh.fields : {})) {
        for (const w of String(spec).trim().split(/\s+/).slice(1)) if (w.startsWith('@') && w !== '@planned') guards.add(tagGuard(w.slice(1), id, name));
      }
    }
    return out;
  }
  ofNode(nodeIdOf(rel), data, up);
  return out;
}

/** What an edit to a model or settings file takes away: guards it removes and allowances it adds. */
export function weakened(rel: string, before: string, after: string, up?: Inherited): string[] {
  return weakenedBetween(guardsOfFile(rel, before, up), guardsOfFile(rel, after, up));
}

/** What the node around a node file passes down to it: nodes/a/b.yaml sits inside a, when a is a node. */
function inheritedBy(own: Ownership, rel: string): Inherited {
  const ids = nodeIdOf(rel).split('.');
  for (let k = ids.length - 1; k > 0; k--) {
    const around = own.nodes.find((n) => n.id === ids.slice(0, k).join('.'));
    if (around) return { protect: around.protect, client: around.client };
  }
  return { protect: false, client: false };
}

/**
 * What an edit to a model file takes away, read two ways: the guards the file itself declares, and
 * the existing source files that a protected node owns now and would not own afterwards. The second
 * catches what no single line shows: narrower "code:" globs, or another node whose globs take the files.
 */
function modelWeakened(root: string, rel: string, before: string, after: string): string[] {
  // Which files a node owns, and whether they are protected, is said in node files only.
  if (!/(^|\/)nodes\//.test(rel)) return weakened(rel, before, after);
  const now = readOwnership(root);
  const lost = weakened(rel, before, after, inheritedBy(now, rel));
  const claim = (text: string): string => {
    const d = parseYaml(text);
    return JSON.stringify([list(d.code), d.protect ?? null]);
  };
  const guarded = now.nodes.filter((n) => n.protect);
  if (!now.on || !guarded.length || claim(before) === claim(after)) return lost;
  const then = readOwnership(root, new Map([[path.resolve(root, rel), after]]));
  const held = (own: Ownership, f: string): boolean => own.on && !!own.nodes.find((n) => n.code(f))?.protect;
  const out = readRepo(root).files.filter((f) => CODE_FILE.test(f) && guarded.some((n) => n.code(f)) && held(now, f) && !held(then, f) && !isTestPath(root, f));
  if (out.length) lost.push(`no longer protected: ${out.slice(0, 3).join(', ')}${out.length > 3 ? `, and ${out.length - 3} more` : ''}`);
  return lost;
}

/**
 * Taking a file or a folder away, by a move or a delete. Removing part of the model, or the settings
 * that switch the hooks on, asks the person; removing a file of a protected node is refused like an
 * edit of it. Returns null when nothing guarded goes.
 */
function removalGate(root: string, paths: string[], doing: string, own?: () => Ownership): GateDecision | null {
  const mdir = MODEL_DIR;
  const model = path.join(root, mdir);
  const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + path.sep);
  const rels = (p: string): string => path.relative(root, p).replace(/\\/g, '/') || '.';
  let ask: GateDecision | null = null;
  for (const p of paths) {
    // The model, or part of it that carries guards: the whole folder, a folder of nodes, shapes or flows, or one of their files.
    const inModel = under(p, model) ? path.relative(model, p).replace(/\\/g, '/') : null;
    if (under(model, p) || (inModel !== null && /^(?:nodes|shapes|flows)(?:\/|$)|^(?:system|tech)\.ya?ml$/.test(inModel))) {
      ask ??= { decision: 'ask', reason: `${doing} ${rels(p)}, ${inModel === null ? 'which holds' : 'part of'} the architecture model. The boundaries, auth and requirements it carries go with it.` };
    }
    // Nothing else is kept inside the model folder. A folder around it may hold the rest as well.
    if (inModel !== null) continue;
    for (const name of ['.claude/settings.json', '.claude/settings.local.json']) {
      const file = path.join(root, name);
      if (!under(file, p) || !fs.existsSync(file)) continue;
      const lost = weakened(name, fs.readFileSync(file, 'utf8'), '');
      if (lost.length) ask ??= weakenAsk(name, lost, `${doing} ${name}, which weakens`);
    }
    // Files of a protected node: the path itself, what a folder holds, or what a pattern matches.
    if (rels(p).startsWith('..')) continue;
    const ownership = (own ?? (() => readOwnership(root)))();
    if (!ownership.on || !ownership.nodes.some((n) => n.protect)) continue;
    const rel = rels(p);
    const isFile = fs.existsSync(p) && fs.statSync(p).isFile();
    const match = /[*?[{]/.test(rel) ? matcher([rel]) : null;
    const files = isFile ? [rel] : readRepo(root).files.filter((f) => (match ? match(f) : rel === '.' || f.startsWith(`${rel}/`)));
    for (const f of files) {
      const verdict = protectGate(root, f, ownership);
      if (verdict) return { decision: 'deny', reason: `${doing} ${f}.\n${verdict.reason}` };
    }
  }
  return ask;
}

/** How many lost guards a question lists: the permission prompt is a small window, and the rest is cut off. */
const ASK_ITEMS = 5;

function weakenAsk(rel: string, lost: string[], lead = `This edit to ${rel} weakens`): GateDecision | null {
  if (!lost.length) return null;
  return {
    decision: 'ask',
    reason:
      `${lead} what the model guards:\n${lost.slice(0, ASK_ITEMS).map((x) => `- ${x}`).join('\n')}${lost.length > ASK_ITEMS ? `\n- and ${lost.length - ASK_ITEMS} more` : ''}`,
  };
}

/** One line on what a change holds, for the question put to the person. Empty when it cannot be worked out. */
function elementsNote(root: string, change: string): string {
  try {
    const mdir = MODEL_DIR;
    const hits: string[] = [];
    const scan = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '.cache' && e.name !== 'docs' && e.name !== 'changes') scan(p);
        } else if (/\.ya?ml$/.test(e.name)) {
          const n = (fs.readFileSync(p, 'utf8').match(new RegExp(`(?:^|[\\s{,])(?:change|modify|retire):\\s*["']?${change.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*(?=[,}]|$)`, 'gm')) ?? []).length;
          if (n) hits.push(`${path.relative(path.join(root, mdir), p).replace(/\\/g, '/')} (${n})`);
        }
      }
    };
    scan(path.join(root, mdir));
    return hits.length
      ? ` "armature show ${change}" lists what it holds (${hits.length} ${hits.length === 1 ? 'file' : 'files'}).`
      : ' Nothing is tagged with it yet, so there is nothing to review.';
  } catch {
    return '';
  }
}

/** Words of a shell command, with quoted strings kept whole. */
function shellWords(text: string): string[] {
  return text.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+(?:"(?:[^"\\]|\\.)*"|'[^']*')?/g) ?? [];
}

const unquote = (w: string): string => w.replace(/^(['"])(.*)\1$/, '$2');

/** A path as the shell reads it from `dir`: "~" is the home folder, not a folder here. Null for another user's home. */
function shellPath(dir: string, w: string): string | null {
  if (w === '~' || w.startsWith('~/')) return path.join(os.homedir(), w.slice(1));
  if (w.startsWith('~')) return null;
  return path.resolve(dir, w);
}

/**
 * Every path a command names, each read from the folder the command stands in at that point
 * ("cd" is followed). Text inside quotes counts too: a script given inline names its files there.
 */
function shellPaths(command: string, cwd: string): string[] {
  const out: string[] = [];
  let dir = cwd;
  for (const part of command.split(/&&|\|\||;|\n|\|/)) {
    const words = shellWords(part.trim().replace(/^[({]\s*/, '')).map(unquote);
    if ((words[0] === 'cd' || words[0] === 'pushd') && words[1]) dir = shellPath(dir, words[1]) ?? dir;
    for (const token of part.split(/[\s'"`()=<>,]+/)) {
      if (!token || token.startsWith('-') || token.includes('$')) continue;
      const p = shellPath(dir, token);
      if (p) out.push(p);
    }
  }
  return out;
}

/** Files a shell command would create, as far as a reading of the command can tell: redirects, tee, touch, cp, mv. */
export function shellTargets(command: string, cwd: string): string[] {
  // Heredoc bodies are file content, not commands.
  const text = command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '$3');
  const out: string[] = [];
  let dir = cwd;
  for (const part of text.split(/&&|\|\||;|\n|\|/)) {
    const words = shellWords(part.trim());
    if (!words.length) continue;
    const bare = words.map(unquote);
    if (bare[0] === 'cd' && bare[1]) {
      dir = shellPath(dir, bare[1]) ?? dir;
      continue;
    }
    const add = (w: string | undefined): void => {
      const p = w && !/[$*?`]/.test(w) && w !== '/dev/null' ? shellPath(dir, w) : null;
      if (p) out.push(p);
    };
    // Redirects: "> file", ">> file", ">file".
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (/^['"]/.test(w)) continue;
      const m = w.match(/^\d?>>?(.*)$/);
      if (m && !m[1].startsWith('&')) add(m[1] ? unquote(m[1]) : bare[i + 1]);
    }
    const cmd = bare[0] === 'git' && bare[1] === 'mv' ? 'mv' : bare[0] === 'sudo' ? bare[1] : bare[0];
    const args = bare.slice(bare[0] === 'git' || bare[0] === 'sudo' ? 2 : 1).filter((a) => !a.startsWith('-') && !/^\d?>/.test(a));
    if (cmd === 'touch' || cmd === 'tee') args.forEach(add);
    // In-place editors: every argument that names a file is a target.
    else if ((cmd === 'sed' || cmd === 'perl' || cmd === 'yq' || cmd === 'truncate') && (cmd === 'truncate' || bare.some((a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a === '--inplace'))) {
      for (const a of bare.slice(1)) if (a && !a.startsWith('-') && fs.existsSync(path.resolve(dir, a)) && fs.statSync(path.resolve(dir, a)).isFile()) add(a);
    }
    else if ((cmd === 'cp' || cmd === 'mv' || cmd === 'install' || cmd === 'ln') && args.length >= 2) {
      const dest = args[args.length - 1];
      const destAbs = shellPath(dir, dest);
      const isDir = dest.endsWith('/') || (!!destAbs && fs.existsSync(destAbs) && fs.statSync(destAbs).isDirectory());
      if (isDir) for (const src of args.slice(0, -1)) add(path.join(dest, path.basename(src)));
      else add(dest);
    }
  }
  return [...new Set(out)];
}

/**
 * Paths a shell command takes away, as far as a reading of it can tell: what rm, rmdir, unlink and
 * shred name (also behind sudo, git or xargs), and what mv moves from.
 */
export function shellRemovals(command: string, cwd: string): { deleted: string[]; moved: string[] } {
  const deleted: string[] = [];
  const moved: string[] = [];
  let dir = cwd;
  for (const part of command.split(/&&|\|\||;|\n|\|/)) {
    const bare = shellWords(part.trim().replace(/^[({]\s*/, '').replace(/\s*\)$/, '')).map(unquote);
    if (!bare.length) continue;
    if ((bare[0] === 'cd' || bare[0] === 'pushd') && bare[1]) {
      dir = shellPath(dir, bare[1]) ?? dir;
      continue;
    }
    const named = (words: string[]): string[] => words.filter((a) => !a.startsWith('-') && !a.includes('$') && !/^\d?[<>]/.test(a)).map((a) => shellPath(dir, a)).filter((x): x is string => !!x);
    // The word that is the command: past "sudo" and the like, "git", and the tools that run another command.
    let at = 0;
    while (at < bare.length && (/^(?:sudo|command|exec|time|nice|nohup|env)$/.test(bare[at]) || /^[A-Za-z_]\w*=/.test(bare[at]))) at++;
    if (bare[at] === 'git') at++;
    else if (bare[at] === 'xargs') {
      at++;
      while (at < bare.length && bare[at].startsWith('-')) at += /^-[InPLsdE]$/.test(bare[at]) ? 2 : 1;
    } else if (bare[at] === 'find') {
      // "find <where> -delete" and "find <where> -exec rm" remove what is found: taken as everything under <where>.
      const exec = bare.findIndex((w) => w === '-exec' || w === '-execdir' || w === '-ok');
      if (bare.includes('-delete') || (exec >= 0 && /^(?:rm|rmdir|unlink|shred)$/.test(bare[exec + 1] ?? ''))) {
        const where = bare.slice(at + 1);
        const end = where.findIndex((w) => /^[-(!]/.test(w));
        deleted.push(...named(end < 0 ? where : where.slice(0, end)));
      }
      continue;
    }
    const cmd = bare[at] ?? '';
    if (/^(?:rm|rmdir|unlink|shred)$/.test(cmd)) deleted.push(...named(bare.slice(at + 1)));
    else if (cmd === 'mv') moved.push(...named(bare.slice(at + 1)).slice(0, -1));
  }
  return { deleted, moved };
}

/**
 * Decides whether a shell command may run: the same rules as a write, for what a command plainly
 * does. Reading a command is not parsing a shell; a script that writes files gets past this, and
 * the checker reports what it left behind.
 */
export function bashGate(root: string, command: string, cwd: string = root): GateDecision | null {
  if (!command || !command.trim()) return null;
  const mdir = MODEL_DIR;
  // A question for the person is kept until the whole command is read: something it does further on
  // may be refused outright, and an answer to the question must not carry that through.
  let question: GateDecision | null = null;
  const ask = (reason: string): void => {
    question ??= { decision: 'ask', reason };
  };
  // The command by its name, or the CLI file the launcher loads, run directly.
  if (/(?:\barmature(?:\.mjs)?|\b(?:dist|src)\/cli\.(?:mjs|js|ts))["']?\s+(?:--root\s+\S+\s+)?approve\b/.test(command)) {
    ask('This runs "armature approve". Allow it only if you reviewed the plan and want it built.');
  }
  // Confirming a requirement says a person read the code and found it true: only that person can say so.
  if (/(?:\barmature(?:\.mjs)?|\b(?:dist|src)\/cli\.(?:mjs|js|ts))["']?\s+(?:--root\s+\S+\s+)?confirm\b[^|;&\n]*\s["']?[\w.-]+:[\w-]+/.test(command)) {
    ask('This runs "armature confirm" on a requirement: it records that you read the code and found the requirement true, with no test. Allow it only if you did.');
  }
  // The viewer approves for the person looking at it; a command that calls it approves in their place.
  if (/(?:\blocalhost|\b127\.0\.0\.1|\[::1\]|\b0\.0\.0\.0)(?::\d+)?\/approve\b|x-armature-token|__ARMATURE_APPROVE__/i.test(command)) {
    ask('This calls the viewer to approve a change. Allow it only if you reviewed the plan and want it built.');
  }
  const writes =
    /(?:^|[^<>&|\d-])>{1,2}(?!&)|\b(?:sed|perl)\b[^|;&\n]*\s(?:-[A-Za-z]*i|--in-place)|\btee\b|\b(?:mv|cp|rm|truncate|dd|install|sponge)\b|\byq\b[^|;&\n]*\s(?:-i|--inplace)|\bawk\b[^|;&\n]*\s-i\s*inplace|\b(?:python3?|node|ruby|deno|bun|tsx)\b/.test(command);
  // The files the command names, wherever it stands: "changes/mail.yaml" from inside the model folder is the same file.
  const named = writes ? shellPaths(command, cwd).map((p) => path.relative(root, p).replace(/\\/g, '/')) : [];
  const isRecord = (rel: string): boolean => {
    if (rel === `${mdir}/${APPROVALS_FILE}` || rel === `${mdir}/${CONFIRMED_FILE}`) return true;
    const name = rel.startsWith(`${mdir}/changes/`) ? rel.slice(mdir.length + 9) : '';
    return !!name && !name.includes('/') && (/\.ya?ml$/.test(name) || /[*?[{]/.test(name));
  };
  const touched = named.find(isRecord) ?? new RegExp(`${mdir}/(?:changes/[^\\s'"]+\\.ya?ml|${APPROVALS_FILE.replace(/\./g, '\\.')})`).exec(command)?.[0];
  if (touched && writes) {
    ask(`This command writes to ${touched}, which records what a person approved.`);
  }
  const system = named.includes(`${mdir}/system.yaml`) || new RegExp(`${mdir}/system\\.ya?ml`).test(command);
  // As YAML ("gate: off") or as an assignment a tool such as yq takes (.gate = "off").
  if (writes && system && /\bgate["']?\s*[:=]\s*["']?off\b/.test(command) && gateOn(root)) {
    ask('This command sets "gate: off": the planning gate goes off for everyone who works in this repo.');
  }
  // The model as it stands, read once and only if something needs it.
  let held: Ownership | null = null;
  const own = (): Ownership => (held ??= readOwnership(root));
  // What the command takes away: part of the model, the settings that switch the hooks on, files of a protected node.
  const gone = shellRemovals(command, cwd);
  for (const [paths, doing] of [[gone.deleted, 'This command deletes'], [gone.moved, 'This command moves']] as const) {
    const verdict = paths.length ? removalGate(root, paths, doing, own) : null;
    if (verdict?.decision === 'deny') return verdict;
    if (verdict) question ??= verdict;
  }
  // A delete the reading above did not place (behind a tool it does not know), by the model file it names.
  const modelFile = new RegExp(`(?:^|[\\s'"/])${mdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:nodes/[^\\s'"]+|system|tech|shapes/[^\\s'"]+|flows/[^\\s'"]+)\\.ya?ml`);
  if (/\b(?:git\s+)?rm\b/.test(command) && modelFile.test(command)) {
    ask(`This command deletes part of the architecture model under ${mdir}/, with the boundaries, auth and requirements it carries.`);
  }
  for (const target of shellTargets(command, cwd)) {
    const rel = path.relative(root, target).replace(/\\/g, '/');
    // Files that carry guards are written with the file tools, new or not: a write from the shell hides
    // what it adds and what it takes away, and a new settings file can switch the hooks off.
    if ((rel.startsWith(`${mdir}/`) && GUARD_FILE.test(rel.slice(mdir.length + 1))) || SETTINGS_FILE.test(rel)) {
      return { decision: 'deny', reason: `This command writes ${rel} from the shell, where the gate cannot see what it adds or takes away. Make the edit with the file tools (Edit or Write) instead${/\/nodes\//.test(rel) ? '; "armature rename" moves or renames a node' : ''}.` };
    }
    if (fs.existsSync(target)) {
      const verdict = protectGate(root, rel, own());
      if (verdict) return { decision: 'deny', reason: `This command would change ${rel}.\n${verdict.reason}` };
      continue;
    }
    const verdict = writeGate(root, { file_path: target, content: '' });
    if (verdict?.decision === 'deny') return { decision: 'deny', reason: `This command would create ${path.relative(root, target).replace(/\\/g, '/')}.\n${verdict.reason}` };
  }
  return question;
}

/** The body of the "Model change" section of a plan, or null when the plan has none. */
function modelChangeSection(plan: string): string | null {
  const head = /^\s{0,3}(?:#{1,6}\s*|\*\*\s*)model change[^\n]*/im.exec(plan);
  if (!head) return null;
  // Text on the heading line after the title counts ("**Model change:** None. The fix …").
  const sameLine = head[0].replace(/^\s{0,3}(?:#{1,6}\s*|\*\*\s*)model change/i, '');
  const rest = plan.slice(head.index + head[0].length);
  const next = rest.search(/^\s{0,3}(?:#{1,6}\s|\*\*[^*\n]+\*\*\s*$)/m);
  return `${sameLine}\n${next < 0 ? rest : rest.slice(0, next)}`;
}

/** What a plan must contain before it is presented: how the work changes the model, or that it does not, and why. */
export function planGate(plan: string, dir: string = MODEL_DIR, planPath = newPlanPath(`${dir}/docs`, dir), root?: string): string | null {
  if (!plan || !plan.trim()) return null;
  const section = modelChangeSection(plan);
  if (section === null) {
    return (
      `This repo plans in its architecture model (${dir}/). Add a section headed "Model change" to the plan, then present it again. In that section, either:\n` +
      `- list what the work adds to or changes in the model: the change id (${dir}/changes/<id>.yaml), new nodes with the "code:" globs where their files will live, new or changed interfaces, links, shapes, flows and requirements, and the plan document (${planPath}); or\n` +
      '- write "None", with one line on why no node, interface, link, shape or requirement changes.\n' +
      'Make writing those model files the first step of the plan, before any code. Run "armature impact <ref>" on what the work touches if you have not yet.'
    );
  }
  const body = section.replace(/[*_`:>#-]/g, ' ').trim();
  if (!/^none\b/i.test(body)) return null;
  // "None" is a claim. It needs its reason, and it must not sit beside steps that add to the system.
  if (body.split(/\s+/).length < 4) {
    return 'The "Model change" section says "None" and gives no reason. Add one line on why no node, interface, link, shape or requirement changes, then present the plan again.';
  }
  if (root) {
    const made: string[] = [];
    // What the repo holds, read once and only if a path needs it: it tells a new file from a short name for an old one.
    let held: { files: string[]; dirs: string[] } | null = null;
    const repo = (): { files: string[]; dirs: string[] } => {
      if (!held) {
        const files = readRepo(root).files;
        held = { files, dirs: [...new Set(files.map((f) => path.posix.dirname(f)))] };
      }
      return held;
    };
    for (const m of plan.matchAll(/[\w@.\-/]+\/[\w@.\-/]+\.[A-Za-z]+\b/g)) {
      const file = m[0].replace(/^\.\//, '');
      if (made.includes(file) || !CODE_FILE.test(file) || fs.existsSync(path.resolve(root, file))) continue;
      // A package or a module path, not a file of this repo: "@scope/pkg/x.js", "github.com/org/x.go", "pkg/x.js" from node_modules.
      const first = file.split('/')[0];
      if (first && !fs.existsSync(path.join(root, first)) && (first.startsWith('@') || first.indexOf('.') > 0 || fs.existsSync(path.join(root, 'node_modules', first)))) continue;
      // A file that exists, named by the end of its path ("api/server.ts" for packages/server/src/api/server.ts).
      if (repo().files.some((f) => f.endsWith(`/${file}`))) continue;
      // A new file named the same way is judged in each folder its path could mean.
      const dir = path.posix.dirname(file);
      const homes = repo().dirs.filter((d) => d.endsWith(`/${dir}`)).slice(0, 20);
      const places = [file, ...homes.map((h) => `${h}/${path.posix.basename(file)}`)];
      if (places.every((p) => writeGate(root, { file_path: p, content: '' })?.decision === 'deny')) made.push(file);
    }
    if (made.length) {
      return (
        `The "Model change" section says "None", but the plan creates ${made.slice(0, 5).join(', ')}${made.length > 5 ? ', …' : ''}, which ${made.length === 1 ? 'is a new source file' : 'are new source files'} the model has no place for ` +
        `(no node owns ${made.length === 1 ? 'it' : 'them'}, or the node is not built or approved yet). That is a model change: list the node and its "code:" globs, or the change that adds it, in the section and present the plan again.`
      );
    }
  }
  return null;
}

/** What to tell an agent that has just entered plan mode. */
export function planModeNote(dir: string = MODEL_DIR, planPath = newPlanPath(`${dir}/docs`, dir)): string {
  return (
    `You are planning. In this repo a plan is a change to the architecture model in ${dir}/:\n` +
    '1. Run "armature context" for the task and "armature impact <ref>" on every node, interface and shape the work touches.\n' +
    `2. Give the plan a "Model change" section: the change id, new nodes with their "code:" globs, new or changed interfaces, links, shapes, flows and requirements, and the plan document ${planPath}. If the work changes none of these, write "None" and why.\n` +
    `3. Make the first step after approval writing those files: the planned elements tagged "change: <id>" (or "modify: <id>" for what exists and changes), the plan document with a header (kind: plan, change: <id>), and ${dir}/changes/<id>.yaml with "state: proposed". Run "armature check". Then set "state: approved" as the last edit: the person is asked to confirm it, and what the change holds at that moment is what they approve. Code comes after.\n` +
    '4. Keep what must hold in view: "armature impact <node>" lists boundaries, auth, allow-lists, data policy, secrets and rules. If the work adds an entry point, sends tagged data out of the system or needs a credential, run "armature surface" and the armature-threat skill, and put the answers in the model: "auth:" and "only:" on interfaces, "secrets:" on nodes, a requirement of kind security for each entry point that reaches sensitive data.\n' +
    'The armature-design skill has the format. A plan without the "Model change" section is sent back, and approval is refused while the change has security errors.'
  );
}

/** One line for every later plan in a session: the full note was given once, and the rules have not changed. */
export function planReminder(dir: string = MODEL_DIR): string {
  return `Planning again: the plan needs its "Model change" section (or "None" and why), planned elements go in ${dir}/ as a proposed change before any code, and "armature impact <node>" lists what must hold.`;
}

/** A shorter pointer for a prompt that asks for a plan or a design outside plan mode. */
export function planningNote(dir: string = MODEL_DIR, planPath = newPlanPath(`${dir}/docs`, dir)): string {
  return (
    'This prompt asks for a plan or a design. In this repo that is a change in the architecture model, not a loose document: follow the armature-design skill ' +
    `(${dir}/changes/<id>.yaml with "state: proposed", planned elements tagged with it, and the plan in ${planPath}), run "armature check", then ask the person to review it in "armature view" before any code. ` +
    'Check "armature impact <node>" for what must hold, and "armature surface" if the work adds an entry point, sends tagged data out or needs a credential.'
  );
}

export const PLANNING_WORDS = /\b(plan|design|propose|proposal|architect|architecture for|spec out|roadmap)\b/i;
