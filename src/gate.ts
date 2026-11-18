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
import { APPROVALS_FILE, docsDir, MODEL_DIR, modelDir, newPlanPath, readApprovals } from './paths.js';

/**
 * Files that are system code or define the system: source in any language, schemas, infrastructure
 * and scripts. Anything else (configuration, data, documents) passes the gate.
 */
export const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro|py|go|rs|rb|java|kt|scala|swift|m|mm|c|h|cc|cpp|hpp|cs|php|ex|exs|dart|lua|sql|proto|graphql|gql|prisma|tf|sh|bash)$/i;
/** A test by its file name, wherever it sits. */
const TEST_NAME = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|(^|\/)conftest\.py$/;
/** The same built-in skips the coverage check uses: build output and generated files. The model folder is added per repo. */
const BUILTIN = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/generated/**', '**/*.gen.*'];

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
}

export interface Ownership {
  /** False when system.yaml says `gate: off`, or when no node owns code yet (a model being started). */
  on: boolean;
  nodes: OwnNode[];
  changes: Map<string, string>;
  /** Tool files, ignored files and built-in skips: placed without a node. */
  placed: (f: string) => boolean;
}

function readYaml(file: string): any {
  try {
    const data = YAML.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

const list = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');

/** Who owns which paths, and which changes are approved. Read straight from the YAML. */
export function readOwnership(root: string): Ownership {
  const mdir = modelDir(root);
  const arch = path.join(root, mdir);
  const sys = readYaml(path.join(arch, 'system.yaml'));
  const nodes: OwnNode[] = [];
  const add = (id: string, data: any, inherited: Tag | undefined): Tag | undefined => {
    const tag: Tag | undefined = typeof data.change === 'string' ? { id: data.change, how: 'add' } : typeof data.modify === 'string' ? { id: data.modify, how: 'modify' } : inherited;
    nodes.push({ id, code: matcher(list(data.code)), tests: matcher(list(data.tests)), change: tag?.id, tag });
    return tag;
  };
  let anyCode = false;
  const walk = (dir: string, prefix: string, inherited: Tag | undefined): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const own = new Map<string, Tag | undefined>();
    for (const e of entries) {
      if (!e.isFile() || !/\.ya?ml$/.test(e.name) || e.name.startsWith('_')) continue;
      const base = e.name.replace(/\.ya?ml$/, '');
      const data = readYaml(path.join(dir, e.name));
      if (list(data.code).length) anyCode = true;
      own.set(base, add(prefix ? `${prefix}.${base}` : base, data, inherited));
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const id = prefix ? `${prefix}.${e.name}` : e.name;
      const sub = path.join(dir, e.name);
      const groupFile = ['_group.yaml', '_group.yml'].map((n) => path.join(sub, n)).find((p) => fs.existsSync(p));
      let tag = own.has(e.name) ? own.get(e.name) : inherited;
      if (groupFile) {
        const data = readYaml(groupFile);
        if (list(data.code).length) anyCode = true;
        tag = add(id, data, inherited);
      }
      walk(sub, id, tag);
    }
  };
  walk(path.join(arch, 'nodes'), '', undefined);
  // Deepest node first, then by id, so the most specific owner wins and the compiler agrees on ties.
  nodes.sort((a, b) => b.id.split('.').length - a.id.split('.').length || a.id.localeCompare(b.id));

  const changes = new Map<string, string>();
  try {
    for (const f of fs.readdirSync(path.join(arch, 'changes'))) {
      if (!/\.ya?ml$/.test(f)) continue;
      changes.set(f.replace(/\.ya?ml$/, ''), String(readYaml(path.join(arch, 'changes', f)).state ?? 'proposed'));
    }
  } catch {
    /* no changes yet */
  }
  const tech = readYaml(path.join(arch, 'tech.yaml'));
  const techFiles = (Array.isArray(tech.tech) ? tech.tech : []).flatMap((t: any) => list(t?.files));
  const ignored = (Array.isArray(sys.ignore) ? sys.ignore : []).map((x: any) => (typeof x === 'string' ? x : String(x?.path ?? ''))).filter(Boolean);
  return { on: sys.gate !== 'off' && anyCode, nodes, changes, placed: matcher([`${mdir}/**`, ...BUILTIN, ...techFiles, ...ignored]) };
}

/** True unless the model's system.yaml says `gate: off`. */
export function gateOn(root: string): boolean {
  return readYaml(path.join(root, modelDir(root), 'system.yaml')).gate !== 'off';
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

  const mdir = modelDir(root);
  const before = fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : '';
  const after = resultOf(root, before, input);
  // A write the gate was given no text for (a tool whose input it does not know): it cannot say what the file will hold.
  const blind = after === null && !writtenText(input).trim();

  // Moving the approval record away removes it as surely as editing it.
  const from = typeof input.source === 'string' ? path.relative(root, path.resolve(root, input.source)).replace(/\\/g, '/') : '';
  if (from === `${mdir}/${APPROVALS_FILE}`) {
    return { decision: 'ask', reason: `This moves ${from}, the record of which elements of a change a person approved. Without it, nothing holds a change to what was approved. Allow it only if you mean to remove that record.` };
  }

  const change = rel.startsWith(`${mdir}/changes/`) ? rel.slice(mdir.length + 9).match(/^([^/]+)\.ya?ml$/)?.[1] : undefined;
  if (change) {
    const was = before ? yamlValue(before, 'state') || 'proposed' : '';
    if (blind && was !== 'approved' && was !== 'done') {
      return { decision: 'ask', approves: change, reason: `This writes change "${change}" in a way the gate cannot read, so it may set it to approved. Approving a change is a person's decision: allow it only if you know what this write puts in the file.${elementsNote(root, change)}` };
    }
    // Without the result, go by what the write adds: "state: approved", or the bare word replacing another.
    const added = writtenText(input);
    const guess = /^\s*(?:state:\s*)?["']?(approved|done)\b["']?\s*$/m.exec(added)?.[1] ?? '';
    const now = after !== null ? yamlValue(after, 'state') : guess;
    if (now === 'approved' && was !== 'approved') {
      return {
        decision: 'ask',
        approves: change,
        reason: `This sets change "${change}" to approved. Approving a change is a person's decision: allow it only if you have reviewed the plan (armature view, Work lens) and want it built.${elementsNote(root, change)}`,
      };
    }
    if (now === 'done' && was !== 'approved' && was !== 'done') {
      return {
        decision: 'ask',
        reason: `This sets change "${change}" to done, and it was never approved (it is ${was || 'new'}). Marking unapproved work as finished is a person's decision: allow it only if you want this change counted as built.`,
      };
    }
    return null;
  }
  if (rel === `${mdir}/${APPROVALS_FILE}`) {
    return { decision: 'ask', reason: `${rel} records which elements of a change a person approved. It is written by "armature approve <change>", not by hand. Allow this edit only if you mean to change that record.` };
  }
  if (rel === `${mdir}/system.yaml`) {
    const was = yamlValue(before, 'gate');
    if (blind && was !== 'off') {
      return { decision: 'ask', reason: `This writes ${rel} in a way the gate cannot read, so it may set "gate: off" and switch the planning gate off for everyone who works in this repo. Allow it only if you know what this write puts in the file.` };
    }
    const now = after !== null ? yamlValue(after, 'gate') : /^\s*gate:\s*["']?off\b/m.test(writtenText(input)) ? 'off' : was;
    if (now === 'off' && was !== 'off') {
      return { decision: 'ask', reason: 'This sets "gate: off" in system.yaml, which switches the planning gate off for everyone who works in this repo: new source files would no longer need a node or an approved change. Allow it only if that is what you want.' };
    }
    return null;
  }

  if (rel.startsWith(`${mdir}/`) || fs.existsSync(abs)) return null;
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

/** One line on what a change holds, for the question put to the person. Empty when it cannot be worked out. */
function elementsNote(root: string, change: string): string {
  try {
    const mdir = modelDir(root);
    const hits: string[] = [];
    const scan = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '.cache' && e.name !== 'docs' && e.name !== 'changes') scan(p);
        } else if (/\.ya?ml$/.test(e.name)) {
          const n = (fs.readFileSync(p, 'utf8').match(new RegExp(`^\\s*(?:-\\s*)?(?:change|modify|retire):\\s*["']?${change}["']?\\s*$`, 'gm')) ?? []).length;
          if (n) hits.push(`${path.relative(path.join(root, mdir), p).replace(/\\/g, '/')} (${n})`);
        }
      }
    };
    scan(path.join(root, mdir));
    return hits.length
      ? ` It tags ${hits.slice(0, 8).join(', ')}${hits.length > 8 ? `, and ${hits.length - 8} more files` : ''}; "armature show ${change}" lists every element.`
      : ' Nothing is tagged with it yet, so there is nothing to review: the planned elements should be written first.';
  } catch {
    return '';
  }
}

const ask = (reason: string): GateDecision => ({ decision: 'ask', reason });

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
 * Decides whether a shell command may run: the same rules as a write, for what a command plainly
 * does. Reading a command is not parsing a shell; a script that writes files gets past this, and
 * the checker reports what it left behind.
 */
export function bashGate(root: string, command: string, cwd: string = root): GateDecision | null {
  if (!command || !command.trim()) return null;
  const mdir = modelDir(root);
  // The command by its name, or the CLI file the launcher loads, run directly.
  if (/(?:\barmature(?:\.mjs)?|\b(?:dist|src)\/cli\.(?:mjs|js|ts))["']?\s+(?:--root\s+\S+\s+)?approve\b/.test(command)) {
    return ask('This runs "armature approve", which records that a person approved a change. Approving a change is your decision: allow it only if you have reviewed the plan and want it built.');
  }
  const writes =
    /(?:^|[^<>&|\d-])>{1,2}(?!&)|\b(?:sed|perl)\b[^|;&\n]*\s(?:-[A-Za-z]*i|--in-place)|\btee\b|\b(?:mv|cp|rm|truncate|dd|install|sponge)\b|\byq\b[^|;&\n]*\s(?:-i|--inplace)|\bawk\b[^|;&\n]*\s-i\s*inplace|\b(?:python3?|node|ruby|deno|bun|tsx)\b/.test(command);
  // The files the command names, wherever it stands: "changes/mail.yaml" from inside the model folder is the same file.
  const named = writes ? shellPaths(command, cwd).map((p) => path.relative(root, p).replace(/\\/g, '/')) : [];
  const isRecord = (rel: string): boolean => {
    if (rel === `${mdir}/${APPROVALS_FILE}`) return true;
    const name = rel.startsWith(`${mdir}/changes/`) ? rel.slice(mdir.length + 9) : '';
    return !!name && !name.includes('/') && (/\.ya?ml$/.test(name) || /[*?[{]/.test(name));
  };
  const touched = named.find(isRecord) ?? new RegExp(`${mdir}/(?:changes/[^\\s'"]+\\.ya?ml|${APPROVALS_FILE.replace(/\./g, '\\.')})`).exec(command)?.[0];
  if (touched && writes) {
    return ask(`This command writes to ${touched}. Approving a change, and the record of what was approved, are a person's decisions: allow it only if you know what it changes there.`);
  }
  const system = named.includes(`${mdir}/system.yaml`) || new RegExp(`${mdir}/system\\.ya?ml`).test(command);
  // As YAML ("gate: off") or as an assignment a tool such as yq takes (.gate = "off").
  if (writes && system && /\bgate["']?\s*[:=]\s*["']?off\b/.test(command) && gateOn(root)) {
    return ask('This command sets "gate: off" in system.yaml, which switches the planning gate off for everyone who works in this repo. Allow it only if that is what you want.');
  }
  for (const target of shellTargets(command, cwd)) {
    if (fs.existsSync(target)) continue;
    const verdict = writeGate(root, { file_path: target, content: '' });
    if (verdict?.decision === 'deny') return { decision: 'deny', reason: `This command would create ${path.relative(root, target).replace(/\\/g, '/')}.\n${verdict.reason}` };
  }
  return null;
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
    'The armature-design skill has the format. A plan without the "Model change" section is sent back.'
  );
}

/** A shorter pointer for a prompt that asks for a plan or a design outside plan mode. */
export function planningNote(dir: string = MODEL_DIR, planPath = newPlanPath(`${dir}/docs`, dir)): string {
  return (
    'This prompt asks for a plan or a design. In this repo that is a change in the architecture model, not a loose document: follow the armature-design skill ' +
    `(${dir}/changes/<id>.yaml with "state: proposed", planned elements tagged with it, and the plan in ${planPath}), run "armature check", then ask the person to review it in "armature view" before any code.`
  );
}

export const PLANNING_WORDS = /\b(plan|design|propose|proposal|architect|architecture for|spec out|roadmap)\b/i;
