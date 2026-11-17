// The planning gate: cheap checks that run before an agent writes a file or presents a plan,
// so new work goes through the model and not around it.
//
// It reads only the YAML it needs, never the whole repository, because it runs before a tool call.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { matcher } from './repo.js';
import { TEST_FILE } from './code.js';
import { docsDir, MODEL_DIR, modelDir, newPlanPath } from './paths.js';

/** Files that are system code. Anything else (configuration, data, documents) passes the gate. */
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|cs|php|sql)$/i;
/** The same built-in skips the coverage check uses: build output and generated files. The model folder is added per repo. */
const BUILTIN = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/generated/**', '**/*.gen.*'];

export interface GateDecision {
  decision: 'deny' | 'ask';
  reason: string;
}

interface OwnNode {
  id: string;
  code: (f: string) => boolean;
  tests: (f: string) => boolean;
  change?: string;
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
  const add = (id: string, data: any, inherited: string | undefined): string | undefined => {
    const change = typeof data.change === 'string' ? data.change : inherited;
    nodes.push({ id, code: matcher(list(data.code)), tests: matcher(list(data.tests)), change });
    return change;
  };
  let anyCode = false;
  const walk = (dir: string, prefix: string, inherited: string | undefined): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const own = new Map<string, string | undefined>();
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
      let change = own.has(e.name) ? own.get(e.name) : inherited;
      if (groupFile) {
        const data = readYaml(groupFile);
        if (list(data.code).length) anyCode = true;
        change = add(id, data, inherited);
      }
      walk(sub, id, change);
    }
  };
  walk(path.join(arch, 'nodes'), '', undefined);
  // Deepest node first, so the most specific owner wins.
  nodes.sort((a, b) => b.id.split('.').length - a.id.split('.').length);

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

const APPROVES = /^\s*state:\s*["']?approved\b/m;

/**
 * Decides whether a Write or Edit may go ahead.
 *  - Setting a change to `approved` always asks the person: approval is theirs.
 *  - A new source file must belong to a node, and that node's change must be approved.
 * Returns null when the gate has nothing to say.
 */
export function writeGate(root: string, input: { file_path?: string; content?: string; new_string?: string; edits?: Array<{ new_string?: string }> }): GateDecision | null {
  if (!input?.file_path) return null;
  const abs = path.resolve(root, input.file_path);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return null;

  const mdir = modelDir(root);
  const change = rel.startsWith(`${mdir}/changes/`) ? rel.slice(mdir.length + 9).match(/^([^/]+)\.ya?ml$/)?.[1] : undefined;
  if (change) {
    const next = [input.content, input.new_string, ...(input.edits ?? []).map((e) => e.new_string)].filter((x): x is string => typeof x === 'string').join('\n');
    if (!APPROVES.test(next)) return null;
    const current = fs.existsSync(abs) ? String(readYaml(abs).state ?? '') : '';
    if (current === 'approved') return null;
    return {
      decision: 'ask',
      reason: `This sets change "${change}" to approved. Approving a change is a person's decision: allow it only if you have reviewed the plan (armature view, Work lens) and want it built.`,
    };
  }

  if (rel.startsWith(`${mdir}/`) || fs.existsSync(abs)) return null;
  if (!CODE_FILE.test(rel) || TEST_FILE.test(rel)) return null;
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
  const state = owner.change ? own.changes.get(owner.change) : undefined;
  if (owner.change && state === 'proposed') {
    return {
      decision: 'deny',
      reason:
        `"${rel}" belongs to the planned node "${owner.id}", part of change "${owner.change}", which is still proposed. Code is written only for approved changes. ` +
        `Ask the person to review the change (armature view, Work lens) and approve it; do not approve it yourself.`,
    };
  }
  if (owner.change && state === 'dropped') {
    return { decision: 'deny', reason: `"${rel}" belongs to the node "${owner.id}", part of change "${owner.change}", which was dropped. Do not build it; ask the person what they want instead.` };
  }
  return null;
}

/** What a plan must contain before it is presented: how the work changes the model, or that it does not. */
export function planGate(plan: string, dir: string = MODEL_DIR, planPath = newPlanPath(`${dir}/docs`, dir)): string | null {
  if (!plan || !plan.trim()) return null;
  if (/^\s{0,3}(?:#{1,6}\s*|\*\*\s*)model change/im.test(plan)) return null;
  return (
    `This repo plans in its architecture model (${dir}/). Add a section headed "Model change" to the plan, then present it again. In that section, either:\n` +
    `- list what the work adds to or changes in the model: the change id (${dir}/changes/<id>.yaml), new nodes with the "code:" globs where their files will live, new or changed interfaces, links, shapes, flows and requirements, and the plan document (${planPath}); or\n` +
    '- write "None", with one line on why no node, interface, link, shape or requirement changes.\n' +
    'Make writing those model files the first step of the plan, before any code. Run "armature impact <ref>" on what the work touches if you have not yet.'
  );
}

/** What to tell an agent that has just entered plan mode. */
export function planModeNote(dir: string = MODEL_DIR, planPath = newPlanPath(`${dir}/docs`, dir)): string {
  return (
    `You are planning. In this repo a plan is a change to the architecture model in ${dir}/:\n` +
    '1. Run "armature context" for the task and "armature impact <ref>" on every node, interface and shape the work touches.\n' +
    `2. Give the plan a "Model change" section: the change id, new nodes with their "code:" globs, new or changed interfaces, links, shapes, flows and requirements, and the plan document ${planPath}. If the work changes none of these, write "None" and why.\n` +
    `3. Make the first step after approval writing those files: ${dir}/changes/<id>.yaml, the planned elements tagged "change: <id>", and the plan document with a header (kind: plan, change: <id>). Then "armature check". Code comes after.\n` +
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
