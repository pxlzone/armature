// Reads armature/ and the repository, and produces one resolved graph with computed status.
import fs from 'node:fs';
import path from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import YAML from 'yaml';
import picomatch from 'picomatch';
import type {
  Activity, ActivityItem, Boundary, Change, CodeDep, Coverage, Deployment, DetectorCoverage, DocInfo, Edge, Flow, FlowStep, GNode, Graph, Interface, NodeKind, Problem, Requirement, Rule, Shape, Snapshot, Status, Tech, Verb,
} from './types.js';
import { warningGroup } from './types.js';
import { expand, git, matcher, parseConventional, readCommits, readJunit, readLcov, readPullRequests, readRepo, sourceHash, type TestCase } from './repo.js';

import { rankFiles, readCodeIndex, TEST_FILE } from './code.js';
import { analyzeRuntime } from './runtime.js';
import { readHistory } from './history.js';
import { sameName, schemaFor } from './schemas.js';
import { collectDocs, type DocResolver } from './docs.js';
import { DEFAULT_COMPOSE, looseDockerCommands, readCompose } from './deploy.js';
import { reach } from './reach.js';
import { cleanDocsSetting, hasModel, LEGACY_DIR, MODEL_DIR, modelDir, readApprovals } from './paths.js';
import { findNode, nodeProblem, resolveRef, type RefIndex } from './refs.js';

export { APPROVALS_FILE, LEGACY_DIR, MODEL_DIR, modelDir, readApprovals } from './paths.js';
export const LOCK_FILE = 'shapes.lock.json';
const SCHEMA_ID = 'https://armature.local/armature.schema.json';
const BUILTIN_TYPES = new Set(['string', 'int', 'float', 'bool', 'uuid', 'timestamp', 'date', 'money', 'email', 'url', 'json', 'bytes']);
const CODE_KINDS = new Set<NodeKind>(['app', 'service', 'worker', 'job', 'agent', 'library']);
/** Files no node needs to own: lockfiles, generated and build output. The model folder is added per repo. */
const BUILTIN_SKIP = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/generated/**', '**/*.gen.*', '**/.gitkeep',
  '**/{pnpm-lock.yaml,package-lock.json,npm-shrinkwrap.json,yarn.lock,bun.lock,bun.lockb,poetry.lock,uv.lock,Cargo.lock,Gemfile.lock,composer.lock,go.sum}',
];

export interface CompileOptions {
  /** Load pull requests through the gh CLI. */
  github?: boolean;
  /** Read recent commits for the activity view. Off by default: it costs one git log. */
  activity?: boolean;
  days?: number;
}

/**
 * Warnings that say a change went past its approval. What the planning gate cannot stop before the
 * fact is reported by these afterwards, so no `accept:` entry may silence them.
 */
const NEVER_ACCEPTED = new Set(['scope-changed', 'unrecorded-approval', 'built-unapproved']);

/** In armature/.cache: the requirements that failed in the last test report the compiler read. */
export const FAILED_FILE = 'failing.json';

function readFailures(file: string): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data?.requirements) ? data.requirements.filter((x: unknown): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rememberFailures(file: string, refs: string[]): void {
  const next = [...refs].sort();
  if (JSON.stringify(readFailures(file)) === JSON.stringify(next)) return;
  try {
    if (next.length === 0) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ requirements: next }, null, 2)}\n`);
    }
  } catch {
    /* a checkout that cannot be written to: the memory helps, the check does not need it */
  }
}

const isInside = (id: string, anc: string): boolean => id === anc || id.startsWith(`${anc}.`);

/**
 * The literal start of a glob: a file that does not begin with it cannot match. Empty when there is
 * none, or when the text of the glob is not what it matches: an escape ("app/\[id\]/**") or an
 * extglob changes its meaning, and the matcher drops a leading "./".
 */
function fixedStart(glob: string): string {
  if (/[(\\]/.test(glob)) return '';
  const plain = glob.replace(/^(?:\.\/)+/, '');
  const cut = plain.search(/[*?[{]/);
  return cut < 0 ? plain : plain.slice(0, cut);
}

export function findRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (hasModel(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function toArr<T>(v: T | T[] | undefined | null): T[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

let validators: Record<string, ValidateFunction> | null = null;
function getValidators(): Record<string, ValidateFunction> {
  if (validators) return validators;
  const schema = JSON.parse(fs.readFileSync(new URL('../schemas/armature.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
  ajv.addSchema(schema);
  const get = (name: string): ValidateFunction => ajv.getSchema(`${SCHEMA_ID}#/$defs/${name}`) as ValidateFunction;
  validators = { system: get('system'), node: get('node'), shapes: get('shapes'), flow: get('flow'), change: get('change'), tech: get('tech') };
  return validators;
}

interface RawNode {
  id: string;
  file: string;
  parent: string | null;
  data: any;
  defaultKind: NodeKind | null;
}

function slugOk(s: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(s);
}

function titleOf(id: string): string {
  return (id.split('.').pop() as string).replace(/[-_]/g, ' ');
}

export function compile(root: string, opts: CompileOptions = {}): Graph {
  const problems: Problem[] = [];
  const err = (code: string, message: string, ref?: string, file?: string): void => {
    problems.push({ level: 'error', code, message, ref, file });
  };
  const warn = (code: string, message: string, ref?: string, file?: string): void => {
    problems.push({ level: 'warning', code, message, ref, file, group: warningGroup(code) });
  };
  const mdir = modelDir(root);
  const archAbs = path.join(root, mdir);
  const rel = (abs: string): string => path.relative(root, abs).replace(/\\/g, '/');
  const v = getValidators();

  const loadYaml = (abs: string, kind: keyof ReturnType<typeof getValidators>): any | null => {
    const file = rel(abs);
    let data: any;
    try {
      data = YAML.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e: any) {
      err('yaml', `Cannot parse YAML: ${String(e.message).split('\n')[0]}`, undefined, file);
      return null;
    }
    if (data === null || data === undefined) data = {};
    const validate = v[kind];
    if (!validate(data)) {
      const seen = new Set<string>();
      for (const e of validate.errors ?? []) {
        if (e.keyword === 'oneOf' || e.keyword === 'allOf') continue;
        const extra = e.keyword === 'additionalProperties' ? ` "${(e.params as any).additionalProperty}"` : '';
        const msg = `${e.instancePath || '/'} ${e.message}${extra}`;
        if (seen.has(msg)) continue;
        seen.add(msg);
        err('schema', msg, undefined, file);
      }
    }
    return data;
  };
  const yamlFiles = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  };

  // ---- system -------------------------------------------------------------
  const sys = loadYaml(path.join(archAbs, 'system.yaml'), 'system') ?? {};
  const budget: number = typeof sys.budget === 'number' ? sys.budget : 12;
  // Where documents live: `docs:` in system.yaml, or the docs folder inside the model.
  const docsHome = cleanDocsSetting(sys.docs) ?? `${mdir}/docs`;
  if (sys.docs !== undefined && !cleanDocsSetting(sys.docs)) err('schema', `docs: "${sys.docs}" is not a folder inside the repo.`, undefined, `${mdir}/system.yaml`);
  else if (sys.docs !== undefined && !fs.existsSync(path.join(root, docsHome))) warn('reference', `docs: "${docsHome}" in system.yaml names a folder that does not exist.`, undefined, `${mdir}/system.yaml`);
  if (mdir === LEGACY_DIR) {
    warn('legacy-folder', `The model is in ${LEGACY_DIR}/, the folder's earlier name. Rename it with "git mv ${LEGACY_DIR} ${MODEL_DIR}", then fix the paths that still start with ${LEGACY_DIR}/ (this check lists them).`, undefined, LEGACY_DIR);
  }

  // ---- raw nodes ----------------------------------------------------------
  const raws: RawNode[] = [];
  const walkNodes = (dirAbs: string, prefix: string, parent: string | null): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    const files = entries.filter((e) => e.isFile() && /\.ya?ml$/.test(e.name) && !e.name.startsWith('_'));
    const dirs = entries.filter((e) => e.isDirectory());
    const defined = new Set<string>();
    for (const f of files) {
      const base = f.name.replace(/\.ya?ml$/, '');
      const id = prefix ? `${prefix}.${base}` : base;
      const abs = path.join(dirAbs, f.name);
      if (!slugOk(base)) err('id', `File name "${base}" is not a valid id (lowercase letters, digits, dashes).`, id, rel(abs));
      const data = loadYaml(abs, 'node');
      if (!data) continue;
      if (data.id && data.id !== base) err('id', `id "${data.id}" does not match file name "${base}".`, id, rel(abs));
      raws.push({ id, file: rel(abs), parent, data, defaultKind: null });
      defined.add(base);
    }
    for (const d of dirs) {
      const id = prefix ? `${prefix}.${d.name}` : d.name;
      const abs = path.join(dirAbs, d.name);
      if (!slugOk(d.name)) err('id', `Folder name "${d.name}" is not a valid id.`, id, rel(abs));
      const groupFile = ['_group.yaml', '_group.yml'].map((n) => path.join(abs, n)).find((p) => fs.existsSync(p));
      if (groupFile) {
        if (defined.has(d.name)) err('id', `Node "${id}" is defined twice: as a file and as a folder with _group.yaml.`, id, rel(groupFile));
        const data = loadYaml(groupFile, 'node');
        if (data) {
          if (data.id && data.id !== d.name) err('id', `id "${data.id}" does not match folder name "${d.name}".`, id, rel(groupFile));
          raws.push({ id, file: rel(groupFile), parent, data, defaultKind: 'group' });
        }
      } else if (!defined.has(d.name)) {
        err('missing-group', `Folder "${rel(abs)}" has no _group.yaml and no sibling ${d.name}.yaml.`, id, rel(abs));
        raws.push({ id, file: rel(abs), parent, data: { role: '' }, defaultKind: 'group' });
      }
      walkNodes(abs, id, id);
    }
  };
  walkNodes(path.join(archAbs, 'nodes'), '', null);
  for (const [key, kind] of [['actors', 'actor'], ['externals', 'external']] as const) {
    for (const data of toArr<any>(sys[key])) {
      if (!data || typeof data !== 'object' || !data.id) continue;
      const parent: string | null = data.parent ?? null;
      const id = parent ? `${parent}.${data.id}` : data.id;
      raws.push({ id, file: `${mdir}/system.yaml`, parent, data, defaultKind: kind });
    }
  }

  const nodes = new Map<string, GNode>();
  const rawById = new Map<string, RawNode>();
  for (const r of raws) {
    if (nodes.has(r.id)) {
      err('duplicate', `Node id "${r.id}" is declared more than once.`, r.id, r.file);
      continue;
    }
    const d = r.data;
    const kind: NodeKind = d.kind ?? r.defaultKind ?? 'service';
    if (!d.kind && !r.defaultKind) err('schema', 'Node needs a "kind".', r.id, r.file);
    rawById.set(r.id, r);
    nodes.set(r.id, {
      id: r.id,
      name: d.name ?? titleOf(r.id),
      kind,
      role: d.role ?? '',
      description: d.description,
      parent: r.parent,
      children: [],
      depth: r.id.split('.').length - 1,
      tech: toArr<string>(d.tech),
      hub: d.hub === true,
      color: d.color,
      image: d.image,
      code: toArr<string>(d.code),
      tests: toArr<string>(d.tests),
      files: 0,
      testFiles: 0,
      interfaces: [],
      rules: [],
      ownRules: toArr(d.rules).length,
      requirements: [],
      todos: toArr<any>(d.todos).map((t) => (typeof t === 'string'
        ? { text: t, kind: 'task' as const, priority: 'medium' as const, node: r.id }
        : { text: t.text ?? '', kind: t.kind ?? 'task', priority: t.priority ?? 'medium', owner: t.owner, issue: t.issue, change: t.change, node: r.id })),
      change: d.change,
      modify: d.modify,
      retire: d.retire,
      never: [],
      status: 'built',
      statusWhy: '',
      coverage: null,
      testSummary: null,
      prs: [],
      scopes: toArr<string>(d.scopes).map((x) => x.toLowerCase()),
      activity: null,
      codeMap: null,
      testedBy: [],
      coChange: [],
      hot: [],
      runtime: null,
      docs: [],
      source: r.file,
      unused: d.unused === true,
      shared: kind === 'library' && d.shared !== false,
      deploy: toArr<string>(d.deploy),
      deployment: [],
      dead: [],
    });
  }
  for (const n of nodes.values()) {
    if (n.parent) {
      const p = nodes.get(n.parent);
      if (p) p.children.push(n.id);
      else {
        err('reference', `Parent "${n.parent}" of node "${n.id}" does not exist.`, n.id, n.source);
        n.parent = null;
      }
    }
  }
  // `shared: false` on a library or any ancestor makes it a domain's own part, never hidden as plumbing.
  for (const n of nodes.values()) {
    if (!n.shared) continue;
    for (let p: string | null = n.parent; p; p = nodes.get(p)?.parent ?? null) {
      if (rawById.get(p)?.data.shared === false) {
        n.shared = false;
        break;
      }
    }
  }
  const ids = [...nodes.keys()];
  const resolveNode = (ref: string): string | null => findNode(ids, ref).id;
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    let cur = nodes.get(id)?.parent ?? null;
    while (cur) {
      out.push(cur);
      cur = nodes.get(cur)?.parent ?? null;
    }
    return out;
  };

  // ---- changes ------------------------------------------------------------
  const changes = new Map<string, Change>();
  for (const abs of yamlFiles(path.join(archAbs, 'changes'))) {
    const data = loadYaml(abs, 'change');
    if (!data) continue;
    const id = path.basename(abs).replace(/\.ya?ml$/, '');
    if (data.id && data.id !== id) err('id', `id "${data.id}" does not match file name "${id}".`, id, rel(abs));
    changes.set(id, {
      id,
      title: data.title ?? id,
      state: data.state ?? 'proposed',
      order: typeof data.order === 'number' ? data.order : 999,
      doc: typeof data.doc === 'string' ? data.doc.replace(/^\.\//, '') : undefined,
      docs: [],
      issue: data.issue ?? null,
      why: data.why,
      doneWhen: toArr<string>(data.done_when),
      nodes: [], edges: [], interfaces: [], requirements: [], shapes: [], flows: [],
      after: toArr<string>(data.after), waits: [], elements: [], approval: null,
      progress: { total: 0, built: 0, reqTotal: 0, reqVerified: 0 },
    });
    if (data.doc && !fs.existsSync(path.join(root, data.doc))) warn('reference', `Change doc "${data.doc}" does not exist.`, id, rel(abs));
  }
  // Order between changes: `after` names the ones that must be done first.
  for (const c of changes.values()) {
    for (const a of c.after) if (!changes.has(a)) err('reference', `Change "${c.id}" comes after "${a}", which does not exist.`, c.id);
    c.after = c.after.filter((a) => changes.has(a) && a !== c.id);
    c.waits = c.after.filter((a) => changes.get(a)!.state !== 'done');
  }
  {
    const mark = new Map<string, 1 | 2>();
    const visit = (id: string, trail: string[]): void => {
      if (mark.get(id) === 2) return;
      if (mark.get(id) === 1) {
        err('cycle', `Changes wait for each other: ${[...trail.slice(trail.indexOf(id)), id].join(' -> ')}.`, id);
        return;
      }
      mark.set(id, 1);
      for (const a of changes.get(id)!.after) visit(a, [...trail, id]);
      mark.set(id, 2);
    };
    for (const id of changes.keys()) visit(id, []);
  }
  const checkChange = (id: string | undefined, ref: string, file: string): void => {
    if (id && !changes.has(id)) err('reference', `Change "${id}" does not exist.`, ref, file);
  };
  /** True while the element's change exists and is not finished. */
  const open = (id: string | undefined): boolean => {
    if (!id) return false;
    const c = changes.get(id);
    return !c || c.state !== 'done';
  };

  // ---- shapes -------------------------------------------------------------
  const codeIdx = readCodeIndex(root);
  const shapes = new Map<string, Shape>();
  const pendingTypes: Shape[] = [];
  let lock: Record<string, { source: string; hash: string }> = {};
  try {
    lock = JSON.parse(fs.readFileSync(path.join(archAbs, LOCK_FILE), 'utf8'));
  } catch {
    lock = {};
  }
  for (const abs of yamlFiles(path.join(archAbs, 'shapes'))) {
    const data = loadYaml(abs, 'shapes');
    if (!data) continue;
    for (const [id, raw] of Object.entries<any>(data)) {
      if (shapes.has(id)) {
        err('duplicate', `Shape "${id}" is declared more than once.`, id, rel(abs));
        continue;
      }
      const s = raw ?? {};
      const fields = Object.entries<string>(s.fields ?? {}).map(([name, spec]) => {
        const parts = String(spec).trim().split(/\s+/);
        return { name, type: parts[0], tags: parts.slice(1).filter((p) => p.startsWith('@')).map((p) => p.slice(1)) };
      });
      const shape: Shape = { id, fields, source: s.source, note: s.note, change: s.change, modify: s.modify, stale: false, bound: false, file: rel(abs) };
      checkChange(s.change, id, rel(abs));
      checkChange(s.modify, id, rel(abs));
      const fromCode = codeIdx && s.source ? schemaFor(codeIdx, s.source) : null;
      if (fromCode) {
        // The code is the truth: its fields replace the hand-written ones, keeping the model's tags (such as @pii).
        const declared = shape.fields;
        shape.fields = fromCode.fields.map((f) => ({ name: f.name, type: f.type, tags: declared.find((d) => sameName(d.name, f.name))?.tags ?? [] }));
        pendingTypes.push(shape);
        shape.fromCode = fromCode.kind;
        shape.bound = true;
        let onlyModel = declared.filter((d) => !fromCode.fields.some((f) => sameName(f.name, d.name))).map((d) => d.name);
        const onlyCode = fromCode.fields.filter((f) => !declared.some((d) => sameName(d.name, f.name))).map((f) => f.name);
        if (open(s.modify)) {
          // A change is altering the shape: fields only the model lists are planned, and are kept beside the code's.
          for (const d of declared) if (onlyModel.includes(d.name)) shape.fields.push({ ...d, tags: [...d.tags, 'planned'] });
          onlyModel = [];
        }
        if (declared.length && (onlyModel.length || onlyCode.length)) {
          shape.drift = { onlyModel, onlyCode };
          warn('shape-fields', `Shape "${id}" lists fields the code does not have (${onlyModel.slice(0, 5).join(', ') || 'none'}) or misses fields it has (${onlyCode.slice(0, 5).join(', ') || 'none'}). The code's fields are used; run "armature shapes --sync" to rewrite the file.`, id, rel(abs));
        }
      } else if (s.source) {
        const h = sourceHash(root, s.source);
        if (!h.found) {
          if (open(s.change)) {
            /* a planned shape may point at a file that does not exist yet */
          } else err('reference', `Shape "${id}" source "${s.source}" does not exist.`, id, rel(abs));
        } else {
          if (!h.symbolFound) warn('source-symbol', `Shape "${id}": symbol not found in "${s.source}", hashing the whole file.`, id, rel(abs));
          const locked = lock[id];
          if (!locked || locked.source !== s.source) {
            warn('unconfirmed', `Shape "${id}" has a source that was never confirmed. Check the fields, then run "armature confirm ${id}".`, id, rel(abs));
          } else if (locked.hash !== h.hash) {
            shape.stale = true;
            warn('stale-shape', `Shape "${id}" is stale: "${s.source}" changed since it was confirmed. Re-read it, fix the fields, then run "armature confirm ${id}".`, id, rel(abs));
          } else {
            shape.bound = true;
          }
        }
      }
      shapes.set(id, shape);
    }
  }
  // Field types from code that name something other than a shape: a named union becomes its values, anything else json.
  {
    const enums = new Map<string, string>();
    for (const f of Object.values(codeIdx?.files ?? {})) for (const [k, v] of Object.entries(f.enums ?? {})) if (!enums.has(k)) enums.set(k, v);
    for (const s of pendingTypes) {
      for (const f of s.fields) {
        f.type = f.type.replace(/(?<![A-Za-z(|])([A-Z][A-Za-z0-9]*)(?=\[|\?|$)/g, (m) => (shapes.has(m) ? m : enums.get(m) ?? 'json'));
      }
    }
  }

  for (const s of shapes.values()) {
    for (const f of s.fields) {
      const names = f.type.replace(/enum\([^)]*\)/g, '').match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
      for (const nme of names) {
        if (nme === 'map' || BUILTIN_TYPES.has(nme)) continue;
        if (/^[A-Z]/.test(nme) && !shapes.has(nme)) warn('reference', `Shape "${s.id}" field "${f.name}" uses unknown type "${nme}".`, s.id, s.file);
        else if (!/^[A-Z]/.test(nme)) warn('type', `Shape "${s.id}" field "${f.name}" uses unknown type "${nme}".`, s.id, s.file);
      }
    }
  }
  const shapeList = (val: unknown, ref: string, file: string): string[] => {
    const out = toArr<string>(val as any);
    for (const s of out) if (!shapes.has(s)) err('reference', `Shape "${s}" does not exist.`, ref, file);
    return out;
  };

  // ---- interfaces, requirements, rules ------------------------------------
  const ifaces = new Map<string, Interface>();
  const reqs = new Map<string, Requirement>();
  for (const n of nodes.values()) {
    const d = rawById.get(n.id)!.data;
    checkChange(n.change, n.id, n.source);
    checkChange(n.retire, n.id, n.source);
    checkChange(n.modify, n.id, n.source);
    const add = (i: Interface): void => {
      if (ifaces.has(i.ref)) err('duplicate', `Interface "${i.ref}" is declared more than once.`, i.ref, n.source);
      checkChange(i.change, i.ref, n.source);
      checkChange(i.modify, i.ref, n.source);
      checkChange(i.retire, i.ref, n.source);
      ifaces.set(i.ref, i);
      n.interfaces.push(i);
    };
    for (const a of toArr<any>(d.accepts)) {
      if (!a?.id) continue;
      const ref = `${n.id}#${a.id}`;
      add({
        id: a.id, ref, node: n.id, holds: false, via: a.via, route: a.route, queue: a.queue,
        takes: shapeList(a.takes, ref, n.source), gives: shapeList(a.gives, ref, n.source),
        dlq: a.dlq, note: a.note, change: a.change, modify: a.modify, retire: a.retire, status: 'built', evidence: 'unchecked',
      });
    }
    for (const h of toArr<any>(d.holds)) {
      const o = typeof h === 'string' ? { id: h } : h;
      if (!o?.id) continue;
      const ref = `${n.id}#${o.id}`;
      add({
        id: o.id, ref, node: n.id, holds: true, takes: shapeList(o.shape, ref, n.source), gives: [],
        note: o.note, change: o.change, modify: o.modify, retire: o.retire, status: 'built', evidence: 'unchecked',
      });
    }
    for (const r of toArr<any>(d.requirements)) {
      if (!r?.id) continue;
      const ref = `${n.id}:${r.id}`;
      if (reqs.has(ref)) err('duplicate', `Requirement "${ref}" is declared more than once.`, ref, n.source);
      checkChange(r.change, ref, n.source);
      checkChange(r.modify, ref, n.source);
      const q: Requirement = { id: r.id, ref, node: n.id, text: r.text ?? '', change: r.change, modify: r.modify, tests: toArr<string>(r.tests), match: toArr<string>(r.match), covers: toArr<string>(r.covers), state: 'unverified', evidence: [] };
      reqs.set(ref, q);
      n.requirements.push(q);
    }
  }
  const sysRules: Rule[] = toArr<any>(sys.rules).map((r) => ({ text: typeof r === 'string' ? r : r.text, from: 'system' }));
  const byDepth = [...nodes.values()].sort((a, b) => a.depth - b.depth);
  for (const n of byDepth) {
    const own: Rule[] = toArr<any>(rawById.get(n.id)!.data.rules).map((r) => ({ text: typeof r === 'string' ? r : r.text, from: n.id }));
    const inherited = n.parent ? nodes.get(n.parent)!.rules : sysRules;
    n.rules = [...inherited, ...own];
  }
  // Boundaries: nodes this one must never touch. Checked against links and imports further down.
  const ownNever = new Map<string, Boundary[]>();
  for (const n of byDepth) {
    const own: Boundary[] = [];
    for (const item of toArr<any>(rawById.get(n.id)!.data.never)) {
      const o = typeof item === 'string' ? { to: item } : item;
      if (!o?.to) continue;
      const target = resolveNode(String(o.to));
      if (!target) err('reference', `${n.id} never "${o.to}": ${nodeProblem(ids, String(o.to))}`, n.id, n.source);
      else if (isInside(target, n.id) || isInside(n.id, target)) err('boundary', `"${n.id}" cannot rule out "${target}": one is inside the other.`, n.id, n.source);
      else own.push({ node: target, why: o.why, from: n.id });
    }
    if (own.length) ownNever.set(n.id, own);
    n.never = [...(n.parent ? nodes.get(n.parent)!.never : []), ...own];
  }

  // ---- links --------------------------------------------------------------
  const edges: Edge[] = [];
  const edgeIds = new Set<string>();
  /** Named links: node~name to the edge id. */
  const linkRefs = new Map<string, string>();
  const noShape = new Map<string, string[]>();
  for (const n of nodes.values()) {
    const d = rawById.get(n.id)!.data;
    for (const verb of ['calls', 'sends', 'reads', 'writes'] as Verb[]) {
      for (const item of toArr<any>(d[verb])) {
        const l = typeof item === 'string' ? { to: item } : item;
        if (!l?.to) continue;
        const [nodeRef, ifaceId] = String(l.to).split('#');
        const target = resolveNode(nodeRef);
        if (!target) {
          err('reference', `${n.id} ${verb} "${l.to}": ${nodeProblem(ids, nodeRef)}`, n.id, n.source);
          continue;
        }
        let iface: Interface | undefined;
        if (ifaceId) {
          iface = ifaces.get(`${target}#${ifaceId}`);
          if (!iface) {
            err('reference', `${n.id} ${verb} "${l.to}": interface "${ifaceId}" does not exist on "${target}".`, n.id, n.source);
          }
        }
        const label = `${n.id} ${verb} ${l.to}`;
        checkChange(l.change, label, n.source);
        checkChange(l.modify, label, n.source);
        checkChange(l.retire, label, n.source);
        const tnode = nodes.get(target)!;
        const store = verb === 'reads' || verb === 'writes';
        // Reading from a queue is consuming from it: the consumer's code does it, so the consumer declares it.
        const consumes = verb === 'reads' && tnode.kind === 'queue';
        if (store && tnode.kind !== 'store' && !consumes) {
          warn('verb', `${label}: "${target}" is a ${tnode.kind}, not a store.${verb === 'writes' && tnode.kind === 'queue' ? ' Publishing to a queue is "sends".' : ''}`, n.id, n.source);
        }
        let takes: string[];
        let gives: string[] = [];
        if (store) {
          takes = l.shape !== undefined ? shapeList(l.shape, label, n.source) : iface?.takes ?? [];
        } else {
          takes = l.takes !== undefined ? shapeList(l.takes, label, n.source) : iface?.takes ?? [];
          gives = verb === 'calls' ? (l.gives !== undefined ? shapeList(l.gives, label, n.source) : iface?.gives ?? []) : [];
        }
        const via: string | undefined = l.via ?? iface?.via;
        const from = verb === 'reads' ? target : n.id;
        const to = verb === 'reads' ? n.id : target;
        let id = `${n.id}>${verb}>${target}${ifaceId ? `#${ifaceId}` : ''}`;
        for (let k = 2; edgeIds.has(id); k++) id = `${n.id}>${verb}>${target}${ifaceId ? `#${ifaceId}` : ''}~${k}`;
        edgeIds.add(id);
        const name: string | undefined = typeof l.id === 'string' ? l.id : undefined;
        const ref = name ? `${n.id}~${name}` : undefined;
        if (ref) {
          if (linkRefs.has(ref)) err('duplicate', `Link "${ref}" is declared more than once.`, ref, n.source);
          linkRefs.set(ref, id);
        }
        edges.push({
          id, from, to, owner: n.id, verb,
          async: verb === 'sends' || consumes,
          via, iface: iface?.ref, shapes: takes, returns: gives, note: l.note, name, ref,
          change: l.change, modify: l.modify, retire: l.retire, status: 'built', evidence: 'unchecked',
        });
        if (n.kind !== 'actor') {
          if (!ifaceId) warn('coarse-link', `${label}: points at a node, not an interface.`, n.id, n.source);
          // A call that only brings something back carries data too.
          else if (takes.length === 0 && gives.length === 0 && !store) noShape.set(n.id, [...(noShape.get(n.id) ?? []), String(l.to)]);
        }
      }
    }
  }

  for (const [id, targets] of noShape) {
    const shown = targets.slice(0, 3).join(', ');
    warn('no-shape', `"${id}": ${targets.length} link${targets.length === 1 ? '' : 's'} with no shape (${shown}${targets.length > 3 ? ', …' : ''}).`, id, nodes.get(id)!.source);
  }

  // ---- repository facts ---------------------------------------------------
  const repo = readRepo(root);
  const owner = new Map<string, string>();
  // Deepest node first, then by id, so a file always goes to the same node. The planning gate sorts the same way.
  const codeNodes = [...nodes.values()].filter((n) => n.code.length > 0).sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id));
  const codeMatch = new Map<string, (f: string) => boolean>();
  const testMatch = new Map<string, (f: string) => boolean>();
  const codeStart = new Map<string, string[] | null>();
  for (const n of nodes.values()) {
    if (n.code.length) {
      codeMatch.set(n.id, matcher(n.code));
      const starts = n.code.filter((g) => !g.startsWith('!')).map(fixedStart);
      codeStart.set(n.id, starts.every(Boolean) ? starts : null);
    }
    if (n.tests.length) testMatch.set(n.id, matcher(n.tests));
  }
  const claims = (id: string, f: string): boolean => {
    const starts = codeStart.get(id);
    return (!starts || starts.some((p) => f.startsWith(p))) && codeMatch.get(id)!(f);
  };
  const testOwned = new Set<string>();
  /** Files per node, code and tests: what a test report has to be newer than. */
  const filesOf = new Map<string, string[]>();
  const fileList = (id: string): string[] => {
    let list = filesOf.get(id);
    if (!list) filesOf.set(id, (list = []));
    return list;
  };
  const overlaps = new Map<string, { count: number; sample: string }>();
  for (const f of repo.files) {
    let won: GNode | null = null;
    for (const n of codeNodes) {
      if (!claims(n.id, f)) continue;
      if (!won) {
        won = n;
        owner.set(f, n.id);
        n.files++;
        fileList(n.id).push(f);
      } else if (!isInside(won.id, n.id)) {
        // A second node claims the file, and it is not a parent of the first.
        const key = `${won.id}|${n.id}`;
        const o = overlaps.get(key) ?? { count: 0, sample: f };
        o.count++;
        overlaps.set(key, o);
      }
    }
    for (const [id, m] of testMatch) {
      if (m(f)) {
        nodes.get(id)!.testFiles++;
        testOwned.add(f);
        fileList(id).push(f);
      }
    }
  }
  for (const [key, o] of overlaps) {
    const [a, b] = key.split('|');
    warn('overlap', `"${a}" and "${b}" both claim ${o.count} file${o.count === 1 ? '' : 's'} (${o.sample}${o.count > 1 ? ', …' : ''}). They go to "${a}". Give them to one node, or move shared code to a library node.`, b, nodes.get(b)!.source);
  }
  const deadGlobs = new Map<string, string[]>();
  for (const n of nodes.values()) {
    // A node still being built by an open change may have globs with no files yet.
    if (n.files === 0 || open(n.change)) continue;
    const dead = n.code.filter((g) => {
      if (g.startsWith('!')) return false;
      const m = picomatch(g, { dot: true });
      return !repo.files.some((f) => m(f));
    });
    if (dead.length) deadGlobs.set(n.id, dead);
  }
  // ---- technologies (armature/tech.yaml) --------------------------------------
  const techFile = path.join(archAbs, 'tech.yaml');
  const tech: Tech[] = [];
  const hasTechFile = fs.existsSync(techFile);
  if (hasTechFile) {
    const data = loadYaml(techFile, 'tech');
    const seen = new Set<string>();
    for (const t of toArr<any>(data?.tech)) {
      if (seen.has(t.id)) err('duplicate', `Technology "${t.id}" is listed twice in tech.yaml.`, t.id, rel(techFile));
      seen.add(t.id);
      tech.push({ id: t.id, name: t.name, category: t.category, url: t.url, version: t.version, note: t.note, files: toArr<string>(t.files), usedBy: [], fileCount: 0 });
    }
    const byId = new Map(tech.map((t) => [t.id, t]));
    for (const n of nodes.values()) {
      const unknown = n.tech.filter((id) => !byId.has(id));
      for (const id of n.tech) byId.get(id)?.usedBy.push(n.id);
      if (unknown.length) warn('unknown-tech', `"${n.id}" names technologies that tech.yaml does not list: ${unknown.join(', ')}.`, n.id, n.source);
    }
  }

  // ---- coverage: every file in the repo belongs somewhere -----------------
  const isBuiltin = matcher([`${mdir}/**`, ...BUILTIN_SKIP]);
  const ignoreEntries = toArr<any>(sys.ignore).map((x) => (typeof x === 'string' ? { path: x, why: '' } : { path: String(x.path), why: String(x.why ?? '') }));
  const noReason = ignoreEntries.filter((x) => !x.why.trim());
  if (noReason.length) warn('ignore-reason', `${noReason.length} ignore entr${noReason.length === 1 ? 'y gives' : 'ies give'} no reason: ${noReason.slice(0, 5).map((x) => x.path).join(', ')}${noReason.length > 5 ? ', …' : ''}. Write them as { path, why }.`, undefined, `${mdir}/system.yaml`);
  const isIgnored = matcher(ignoreEntries.map((x) => x.path));
  const techMatch = tech.filter((t) => t.files.length).map((t) => ({ t, m: matcher(t.files) }));
  const coverage: Coverage = { files: 0, owned: 0, tech: 0, docs: 0, builtin: 0, ignored: 0, unowned: 0, byDir: [] };
  const isDoc = matcher(['**/*.{md,mdx}', 'docs/**']);
  const unowned: string[] = [];
  const dirStats = new Map<string, { files: number; unowned: number }>();
  for (const f of repo.files) {
    if (f.startsWith(`${mdir}/`)) continue;
    coverage.files++;
    const top = f.includes('/') ? f.split('/')[0] : '.';
    const st = dirStats.get(top) ?? { files: 0, unowned: 0 };
    st.files++;
    dirStats.set(top, st);
    if (owner.has(f) || testOwned.has(f)) coverage.owned++;
    else if (isBuiltin(f)) coverage.builtin++;
    else {
      const t = techMatch.find((x) => x.m(f));
      if (t) {
        coverage.tech++;
        t.t.fileCount++;
      } else if (isDoc(f)) coverage.docs++;
      else if (isIgnored(f)) coverage.ignored++;
      else {
        coverage.unowned++;
        st.unowned++;
        unowned.push(f);
      }
    }
  }
  coverage.byDir = [...dirStats].map(([dir, v]) => ({ dir, ...v })).sort((a, b) => b.unowned - a.unowned || b.files - a.files);
  if (unowned.length) {
    const dirs = new Map<string, number>();
    for (const f of unowned) {
      const parts = f.split('/');
      const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? parts[0] : '.';
      dirs.set(key, (dirs.get(key) ?? 0) + 1);
    }
    for (const [dir, count] of [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      warn('unowned', `${count} file${count === 1 ? '' : 's'} under "${dir}" belong to no node.`, undefined, dir);
    }
  }

  // ---- deployment: compose services and the nodes that run as them ---------
  const compose = readCompose(root, repo.files, toArr<string>(sys.compose).length ? toArr<string>(sys.compose) : DEFAULT_COMPOSE);
  const claimedBy = new Map<string, string>();
  for (const n of nodes.values()) for (const s of n.deploy) claimedBy.set(s, n.id);
  const serviceNames = new Set(compose.map((s) => s.name));
  for (const s of compose) {
    const id = claimedBy.get(s.name);
    if (id) nodes.get(id)!.deployment.push({ service: s.name, env: s.env, file: s.file, image: s.image, command: s.command });
  }
  for (const n of nodes.values()) {
    const missing = n.deploy.filter((s) => !serviceNames.has(s));
    if (missing.length) warn('deploy-missing', `"${n.id}" says it runs as ${missing.join(', ')}, which no compose file defines.`, n.id, n.source);
  }
  const unclaimed = new Map<string, string[]>();
  for (const s of compose) if (!claimedBy.has(s.name)) unclaimed.set(s.name, [...(unclaimed.get(s.name) ?? []), s.file]);
  for (const [name, inFiles] of unclaimed) warn('undeployed', `Compose service "${name}" (${inFiles.join(', ')}) is not claimed by any node. Add it to a node's deploy list.`, undefined, inFiles[0]);
  const deployment: Deployment = { files: [] };
  for (const s of compose) {
    let entry = deployment.files.find((x) => x.file === s.file);
    if (!entry) deployment.files.push((entry = { file: s.file, env: s.env, services: [] }));
    entry.services.push({ name: s.name, image: s.image, command: s.command, node: claimedBy.get(s.name) ?? null });
  }

  // ---- test and coverage reports ------------------------------------------
  const expandFs = (glob: string): string[] => {
    const hits = expand(root, repo.files, [glob]);
    const dir = path.dirname(glob);
    if (!/[*?[{]/.test(dir)) {
      try {
        const m = picomatch(path.basename(glob), { dot: true });
        for (const f of fs.readdirSync(path.join(root, dir))) {
          const p = dir === '.' ? f : `${dir}/${f}`;
          if (m(f) && !hits.includes(p)) hits.push(p);
        }
      } catch {
        /* directory does not exist */
      }
    }
    return hits;
  };
  const junitGlobs = toArr<string>(sys.reports?.junit).length ? toArr<string>(sys.reports.junit) : [`${mdir}/.cache/reports/*.xml`];
  const lcovGlobs = toArr<string>(sys.reports?.lcov).length ? toArr<string>(sys.reports.lcov) : [`${mdir}/.cache/reports/*.info`, 'coverage/lcov.info'];
  const junitFiles = [...new Set(junitGlobs.flatMap(expandFs))];
  const lcovFiles = [...new Set(lcovGlobs.flatMap(expandFs))];
  const cases: TestCase[] = [];
  let newestReport = 0;
  for (const f of junitFiles) {
    try {
      const at = fs.statSync(path.join(root, f)).mtimeMs;
      newestReport = Math.max(newestReport, at);
      cases.push(...readJunit(root, f).map((c) => ({ ...c, at })));
    } catch (e: any) {
      warn('report', `Cannot read JUnit report: ${String(e.message).split('\n')[0]}`, undefined, f);
    }
  }
  // A report proves something about code only when it was written after that code last changed.
  const newestMemo = new Map<string, number>();
  const newest = (id: string): number => {
    const hit = newestMemo.get(id);
    if (hit !== undefined) return hit;
    let t = 0;
    for (const [nid, list] of filesOf) {
      if (!isInside(nid, id)) continue;
      for (const f of list) {
        try {
          t = Math.max(t, fs.statSync(path.join(root, f)).mtimeMs);
        } catch {
          /* removed since the file list was read */
        }
      }
    }
    newestMemo.set(id, t);
    return t;
  };
  const proof = new Map<string, { failed: boolean; fresh: boolean; old: boolean }>();
  const note = (q: Requirement, c: TestCase): void => {
    const p = proof.get(q.ref) ?? { failed: false, fresh: false, old: false };
    const current = (c.at ?? Infinity) >= newest(q.node);
    if (c.state === 'failed') p.failed = true;
    else if (c.state === 'passed' && current) p.fresh = true;
    else if (c.state === 'passed') p.old = true;
    proof.set(q.ref, p);
    q.evidence.push(`${c.state}${c.state === 'passed' && !current ? ' (report older than the code)' : ''}: ${c.name}`);
  };
  const nodeOfTest = (file: string): string | null => {
    if (!file) return null;
    let best: GNode | null = null;
    for (const [id, m] of testMatch) {
      const n = nodes.get(id)!;
      if (m(file) && (!best || n.depth > best.depth)) best = n;
    }
    return best ? best.id : owner.get(file) ?? null;
  };
  for (const c of cases) {
    const id = nodeOfTest(c.file);
    if (id) {
      const n = nodes.get(id)!;
      n.testSummary ??= { passed: 0, failed: 0, skipped: 0, failures: [] };
      n.testSummary[c.state]++;
      if (c.state === 'failed' && n.testSummary.failures.length < 20) n.testSummary.failures.push(c.name);
    }
    for (const m of c.name.matchAll(/\[req ([^\]\s]+)\]/g)) {
      let q = reqs.get(m[1]);
      if (!q) {
        const [nref, slug] = m[1].split(':');
        const nid = resolveNode(nref);
        q = nid ? reqs.get(`${nid}:${slug}`) : undefined;
      }
      if (!q) {
        warn('reference', `Test "${c.name}" tags unknown requirement "${m[1]}".`, undefined, c.file);
        continue;
      }
      note(q, c);
    }
  }
  for (const q of reqs.values()) {
    const inFiles = q.tests.length ? matcher(q.tests) : null;
    if (inFiles && !repo.files.some(inFiles)) warn('reference', `Requirement "${q.ref}" lists tests that match no file.`, q.ref);
    if (inFiles || q.match.length) {
      // `tests` narrows by file, `match` narrows by test title. Either alone is enough.
      const hits = cases.filter((c) => (!inFiles || inFiles(c.file)) && (q.match.length === 0 || q.match.some((m) => c.name.includes(m))));
      for (const c of hits) note(q, c);
      if (q.match.length && cases.length > 0 && hits.length === 0 && !open(q.change)) {
        warn('no-test-match', `Requirement "${q.ref}": no test title in the latest report contains ${q.match.map((m) => `"${m}"`).join(' or ')}.`, q.ref);
      }
    }
    // A failure stands until a newer run says otherwise; a pass counts only while the report is newer than the code.
    const p = proof.get(q.ref);
    if (p?.failed) q.state = 'failing';
    else if (p?.fresh) q.state = 'verified';
    else if (p?.old) q.outdated = true;
  }
  // A failure is remembered. With a report to read, the memory is brought up to date; with none,
  // what failed last time still fails, so removing the report does not turn it into "nothing to check".
  const failedFile = path.join(archAbs, '.cache', FAILED_FILE);
  if (cases.length > 0) rememberFailures(failedFile, [...reqs.values()].filter((q) => q.state === 'failing').map((q) => q.ref));
  else {
    for (const ref of readFailures(failedFile)) {
      const q = reqs.get(ref);
      if (!q) continue;
      q.state = 'failing';
      q.evidence.push('failed: in the last test report seen, which is no longer there. Run the tests again.');
    }
  }
  const outdated = [...reqs.values()].filter((q) => q.outdated);
  if (outdated.length) {
    const where = [...new Set(outdated.map((q) => q.node))];
    warn('outdated-report', `${outdated.length} requirement${outdated.length === 1 ? '' : 's'} of ${where.slice(0, 6).join(', ')}${where.length > 6 ? ', …' : ''} passed in a test report that is older than the code, so ${outdated.length === 1 ? 'it counts' : 'they count'} as unverified. Run the tests again.`);
  }
  const cov = new Map<string, { found: number; hit: number }>();
  for (const f of lcovFiles) {
    try {
      for (const r of readLcov(root, f)) {
        const id = owner.get(r.file);
        if (!id) continue;
        const c = cov.get(id) ?? { found: 0, hit: 0 };
        c.found += r.found;
        c.hit += r.hit;
        cov.set(id, c);
      }
    } catch (e: any) {
      warn('report', `Cannot read lcov report: ${String(e.message).split('\n')[0]}`, undefined, f);
    }
  }

  // ---- commits and pull requests ---------------------------------------------
  // An item reaches a node through the files it changed, or through its Conventional Commits scope.
  let activitySummary: Graph['activity'] = null;
  const prList = opts.github && repo.hasRemote ? readPullRequests(root, path.join(archAbs, '.cache')) : [];
  for (const pr of prList) {
    if (pr.state !== 'open') continue;
    const touched = new Set<string>();
    for (const f of pr.files) {
      const id = owner.get(f);
      if (id) touched.add(id);
    }
    for (const id of touched) nodes.get(id)!.prs.push({ number: pr.number, title: pr.title, url: pr.url, branch: pr.branch });
  }
  if (opts.activity && repo.hasGit) {
    // Which nodes change together, and each node's most changed files.
    const hist = readHistory(root);
    if (hist) {
      const pairCount = new Map<string, number>();
      for (const c of hist.commits) {
        if (c.files.length > 30) continue;
        const touched = [...new Set(c.files.map((f) => owner.get(f)).filter((x): x is string => !!x))];
        for (const a of touched) for (const b of touched) if (a !== b) pairCount.set(`${a}|${b}`, (pairCount.get(`${a}|${b}`) ?? 0) + 1);
      }
      for (const [key, n] of pairCount) {
        if (n < 3) continue;
        const [a, b] = key.split('|');
        nodes.get(a)!.coChange.push({ node: b, n });
      }
      for (const n of nodes.values()) n.coChange = n.coChange.sort((x, y) => y.n - x.n).slice(0, 6);
      for (const [f, v] of Object.entries(hist.files)) {
        const id = owner.get(f);
        if (id) nodes.get(id)!.hot.push({ path: f, changes: v.changes });
      }
      for (const n of nodes.values()) n.hot = n.hot.sort((x, y) => y.changes - x.changes).slice(0, 5);
    }

    const days = opts.days ?? (typeof sys.activity_days === 'number' ? sys.activity_days : 90);
    const since = Date.now() - days * 86400000;
    const scopeIndex = new Map<string, string[]>();
    const addScope = (scope: string, id: string): void => {
      const list = scopeIndex.get(scope) ?? [];
      if (!list.includes(id)) list.push(id);
      scopeIndex.set(scope, list);
    };
    for (const n of nodes.values()) {
      for (const sc of n.scopes) addScope(sc, n.id);
    }
    // Without an explicit alias, a scope means the node whose id or last id segment equals it.
    for (const n of nodes.values()) {
      const last = n.id.split('.').pop() as string;
      if (!scopeIndex.has(n.id)) addScope(n.id, n.id);
      if (!scopeIndex.has(last)) addScope(last, n.id);
    }
    const perNode = new Map<string, ActivityItem[]>();
    const byType: Record<string, number> = {};
    const unmatched = new Map<string, number>();
    let conventional = 0;
    let unmapped = 0;
    const place = (item: ActivityItem, files: string[]): void => {
      const direct = new Set<string>();
      for (const f of files) {
        const id = owner.get(f);
        if (id) direct.add(id);
      }
      if (item.scope) {
        const hits = scopeIndex.get(item.scope);
        if (hits) hits.forEach((id) => direct.add(id));
        else if (direct.size === 0) unmatched.set(item.scope, (unmatched.get(item.scope) ?? 0) + 1);
      }
      if (direct.size === 0) unmapped++;
      const all = new Set<string>();
      for (const id of direct) {
        all.add(id);
        ancestors(id).forEach((a) => all.add(a));
      }
      for (const id of all) perNode.set(id, [...(perNode.get(id) ?? []), item]);
      byType[item.type] = (byType[item.type] ?? 0) + 1;
    };
    const commits = readCommits(root, days);
    for (const c of commits) {
      const cc = parseConventional(c.subject);
      if (cc.conventional) conventional++;
      place({ kind: 'commit', id: c.hash, title: cc.description, type: cc.type, scope: cc.scope, breaking: cc.breaking, date: c.date, author: c.author }, c.files);
    }
    const recentPrs = prList.filter((pr) => pr.state === 'open' || new Date(pr.date).getTime() >= since);
    for (const pr of recentPrs) {
      const cc = parseConventional(pr.title);
      place({ kind: 'pr', id: `#${pr.number}`, title: cc.description, type: cc.type, scope: cc.scope, breaking: cc.breaking, date: pr.date, author: pr.author, state: pr.state, url: pr.url }, pr.files);
    }
    const weeksN = Math.max(1, Math.ceil(days / 7));
    for (const [id, items] of perNode) {
      const a: Activity = { commits: 0, prsOpen: 0, prsMerged: 0, prsClosed: 0, byType: {}, authors: 0, last: null, weeks: new Array(weeksN).fill(0), recent: [] };
      const authors = new Set<string>();
      for (const it of items) {
        if (it.kind === 'commit') a.commits++;
        else if (it.state === 'open') a.prsOpen++;
        else if (it.state === 'merged') a.prsMerged++;
        else a.prsClosed++;
        a.byType[it.type] = (a.byType[it.type] ?? 0) + 1;
        if (it.author) authors.add(it.author);
        const t = new Date(it.date).getTime();
        const w = weeksN - 1 - Math.floor((Date.now() - t) / (7 * 86400000));
        if (w >= 0 && w < weeksN) a.weeks[w]++;
        if (!a.last || it.date > a.last) a.last = it.date;
      }
      a.authors = authors.size;
      a.recent = [...items].sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 12);
      nodes.get(id)!.activity = a;
    }
    activitySummary = {
      days,
      commits: commits.length,
      conventional,
      prs: recentPrs.length,
      prsLoaded: !!opts.github && repo.hasRemote,
      byType,
      unmatchedScopes: [...unmatched].map(([scope, count]) => ({ scope, count })).sort((x, y) => y.count - x.count).slice(0, 12),
      unmapped,
    };
  }

  // ---- code graph -----------------------------------------------------------
  // The index is built by "armature index"; here it is only read and tied to nodes.
  const codeDeps: CodeDep[] = [];
  const deadFiles: Graph['dead'] = [];
  let reachEntries = new Map<string, string>();
  const runtimeReports: Graph['runtime'] = [];
  const detectors: DetectorCoverage[] = [];
  let codeSummary: Graph['code'] = null;
  const cidx = codeIdx;
  if (cidx) {
    const rank = rankFiles(cidx);
    const maxRank = Math.max(1e-9, ...rank.values());
    const byNode = new Map<string, string[]>();
    let symbolCount = 0;
    for (const f of Object.values(cidx.files)) {
      symbolCount += f.symbols.length;
      const id = owner.get(f.path);
      if (!id) continue;
      for (const n of [id, ...ancestors(id)]) byNode.set(n, [...(byNode.get(n) ?? []), f.path]);
    }
    for (const [id, paths] of byNode) {
      const list = paths.map((pth) => cidx.files[pth]);
      const pkgs = new Map<string, number>();
      for (const f of list) for (const i of f.imports) if (i.pkg) pkgs.set(i.pkg, (pkgs.get(i.pkg) ?? 0) + 1);
      nodes.get(id)!.codeMap = {
        files: list.length,
        lines: list.reduce((n, f) => n + f.lines, 0),
        exported: list.reduce((n, f) => n + f.symbols.filter((x) => x.exported).length, 0),
        top: [...list]
          .sort((a, b) => (rank.get(b.path) ?? 0) - (rank.get(a.path) ?? 0) || b.symbols.length - a.symbols.length)
          .slice(0, 6)
          .map((f) => ({
            path: f.path,
            lines: f.lines,
            rank: (rank.get(f.path) ?? 0) / maxRank,
            symbols: f.symbols.filter((x) => x.exported).slice(0, 6).map((x) => ({ name: x.name, kind: x.kind, line: x.line, sig: x.sig, doc: x.doc })),
          })),
        packages: [...pkgs].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name]) => name),
      };
    }
    const linked = new Set<string>();
    for (const e of edges) {
      linked.add(`${e.from}|${e.to}`);
      linked.add(`${e.to}|${e.from}`);
    }
    const pairs = new Map<string, CodeDep>();
    for (const f of Object.values(cidx.files)) {
      const a = owner.get(f.path);
      if (!a) continue;
      for (const i of f.imports) {
        const b = i.file ? owner.get(i.file) : undefined;
        if (!b || b === a) continue;
        const key = `${a}|${b}`;
        let dep = pairs.get(key);
        if (!dep) {
          const kind: CodeDep['kind'] = linked.has(key) ? 'declared' : nodes.get(b)!.kind === 'library' ? 'library' : 'undeclared';
          dep = { from: a, to: b, count: 0, kind, samples: [] };
          pairs.set(key, dep);
        }
        dep.count++;
        if (dep.samples.length < 3) dep.samples.push({ from: f.path, to: i.file as string, names: i.names.slice(0, 4) });
      }
    }
    codeDeps.push(...[...pairs.values()].sort((x, y) => y.count - x.count));
    const undeclared = new Map<string, CodeDep[]>();
    for (const d of codeDeps) if (d.kind === 'undeclared') undeclared.set(d.from, [...(undeclared.get(d.from) ?? []), d]);
    for (const [id, deps] of undeclared) {
      const listed = deps.slice(0, 4).map((d) => `${d.to} (${d.count})`).join(', ');
      warn('undeclared-import', `"${id}" imports code from ${listed}${deps.length > 4 ? ', …' : ''} with no link declared. Declare the link, move the shared code to a library node, or fix the code globs.`, id, nodes.get(id)!.source);
    }
    // Tests that import a node's code: directly, or through an index file that re-exports it.
    const importers = new Map<string, string[]>();
    for (const f of Object.values(cidx.files)) for (const i of f.imports) if (i.file) importers.set(i.file, [...(importers.get(i.file) ?? []), f.path]);
    const testsOf = (file: string): Set<string> => {
      const out = new Set<string>();
      for (const u of importers.get(file) ?? []) {
        if (cidx.files[u]?.test || TEST_FILE.test(u)) out.add(u);
        else if (/(^|\/)index\.[cm]?[jt]sx?$/.test(u)) for (const v of importers.get(u) ?? []) if (cidx.files[v]?.test) out.add(v);
      }
      return out;
    };
    for (const [id, paths] of byNode) {
      const t = new Set<string>();
      for (const pth of paths) if (!cidx.files[pth].test) for (const x of testsOf(pth)) t.add(x);
      nodes.get(id)!.testedBy = [...t].sort();
    }
    const rt = analyzeRuntime(cidx, nodes, edges, ifaces, owner, ancestors, open);
    runtimeReports.push(...rt.reports);
    // What could be checked at all, per node: a node the index cannot read is unknown, not clean.
    const indexedBy = new Map<string, number>();
    for (const f of Object.values(cidx.files)) {
      const id = owner.get(f.path);
      if (id) indexedBy.set(id, (indexedBy.get(id) ?? 0) + 1);
    }
    for (const n of nodes.values()) {
      if (n.files === 0 || n.kind === 'store' || n.unused) continue;
      detectors.push({ node: n.id, files: n.files, indexed: indexedBy.get(n.id) ?? 0, kinds: [...(rt.kinds.get(n.id) ?? [])].sort() });
    }
    for (const r of rt.reports) nodes.get(r.node)!.runtime = r;
    codeDeps.push(...rt.deps);
    for (const r of rt.reports) {
      if (r.undeclared.length === 0) continue;
      const items = r.undeclared.slice(0, 5).map((u) => `${u.kind} ${u.what}${u.op ? ` (${u.op})` : ''}`).join(', ');
      warn('runtime-drift', `"${r.node}" does ${r.undeclared.length} thing${r.undeclared.length === 1 ? '' : 's'} at run time the model does not declare: ${items}${r.undeclared.length > 5 ? ', …' : ''}. See "armature drift ${r.node}".`, r.node, nodes.get(r.node)!.source);
    }
    codeSummary = { files: Object.keys(cidx.files).length, symbols: symbolCount, builtAt: cidx.builtAt };

    // Reachability: code no entry point reaches is dead. A node marked unused holds it on purpose.
    const usedDockerfiles = new Set(compose.map((s) => s.dockerfile).filter((x): x is string => !!x));
    const entryGlobs = [...toArr<string>(sys.entry), ...[...rawById.values()].flatMap((r) => toArr<string>(r.data.entry))];
    const r = reach({ root, files: repo.files, idx: cidx, compose, dockerCommands: looseDockerCommands(root, repo.files, usedDockerfiles), entryGlobs });
    const unusedHere = (id: string): boolean => [id, ...ancestors(id)].some((x) => nodes.get(x)?.unused);
    for (const p of r.dead) {
      if (isIgnored(p) || isBuiltin(p)) continue;
      const id = owner.get(p) ?? null;
      const lines = cidx.files[p]?.lines ?? 0;
      deadFiles.push({ path: p, lines, node: id });
      if (id) nodes.get(id)!.dead.push({ path: p, lines });
    }
    for (const n of nodes.values()) {
      if (n.dead.length && !unusedHere(n.id)) {
        const lines = n.dead.reduce((a, d) => a + d.lines, 0);
        warn('dead-code', `"${n.id}": ${n.dead.length} file${n.dead.length === 1 ? '' : 's'} (${lines} lines) that no entry point reaches: ${n.dead.slice(0, 4).map((d) => d.path).join(', ')}${n.dead.length > 4 ? ', …' : ''}. See "armature islands ${n.id}".`, n.id, n.source);
      }
      if (n.unused) {
        const live = [...owner].filter(([f, id]) => isInside(id, n.id) && r.reachable.has(f)).map(([f]) => f);
        if (live.length) warn('unused-reachable', `"${n.id}" is marked unused, but entry points reach ${live.length} of its files: ${live.slice(0, 4).join(', ')}${live.length > 4 ? ', …' : ''}.`, n.id, n.source);
      }
    }
    reachEntries = r.entries;
  }
  for (const n of nodes.values()) {
    if (!n.unused) continue;
    const linked = edges.filter((e) => isInside(e.from, n.id) || isInside(e.to, n.id));
    if (linked.length) warn('unused-linked', `"${n.id}" is marked unused but has ${linked.length} link${linked.length === 1 ? '' : 's'}. Dead code takes part in no flow; remove the links.`, n.id, n.source);
  }

  // ---- boundaries: what a node must never touch, checked against links and against the code ----
  for (const [id, own] of ownNever) {
    for (const b of own) {
      const hits: string[] = [];
      for (const e of edges) {
        const other = e.owner === e.from ? e.to : e.from;
        if (isInside(e.owner, id) && isInside(other, b.node)) hits.push(`${e.owner} ${e.verb} ${e.iface ?? other}`);
      }
      for (const d of codeDeps) {
        if (!isInside(d.from, id) || !isInside(d.to, b.node)) continue;
        hits.push(`${d.from} ${!d.via || d.via === 'import' ? 'imports code of' : `uses a ${d.via} of`} ${d.to} (${d.count} time${d.count === 1 ? '' : 's'}${d.samples[0] ? `, e.g. ${d.samples[0].from}` : ''})`);
      }
      if (hits.length) {
        err('boundary', `"${id}" must never touch "${b.node}"${b.why ? ` (${b.why})` : ''}, but: ${hits.slice(0, 4).join('; ')}${hits.length > 4 ? `; and ${hits.length - 4} more` : ''}.`, id, nodes.get(id)!.source);
      }
    }
  }

  // ---- status -------------------------------------------------------------
  const staleShapesOf = (n: GNode): string[] => {
    const used = new Set<string>();
    for (const i of n.interfaces) [...i.takes, ...i.gives].forEach((s) => used.add(s));
    for (const e of edges) if (e.owner === n.id) [...e.shapes, ...e.returns].forEach((s) => used.add(s));
    return [...used].filter((s) => shapes.get(s)?.stale);
  };
  const leafStatus = (n: GNode): [Status, string] => {
    if (n.retire) return ['retiring', `Marked for retirement by change "${n.retire}".`];
    const failingReq = n.requirements.find((q) => q.state === 'failing');
    if (failingReq) return ['failing', `Requirement "${failingReq.ref}" has a failing test.`];
    if (n.testSummary && n.testSummary.failed > 0) return ['failing', `${n.testSummary.failed} linked test${n.testSummary.failed === 1 ? '' : 's'} failed.`];
    const stale = staleShapesOf(n);
    if (stale.length) return ['stale', `Shape ${stale.join(', ')} changed in the code since it was confirmed.`];
    if (deadGlobs.has(n.id)) return ['stale', `Code glob ${deadGlobs.get(n.id)!.join(', ')} matches nothing.`];
    if (n.code.length === 0) {
      if (open(n.change)) return ['planned', `Part of change "${n.change}", which is not done.`];
      return ['built', CODE_KINDS.has(n.kind) ? 'No code globs declared.' : 'Declared; this kind of node has no code of its own here.'];
    }
    if (n.files === 0) return ['planned', 'No file matches its code globs.'];
    if (open(n.change)) return ['building', `Files exist, and change "${n.change}" is not done.`];
    const active = n.requirements.filter((q) => !open(q.change));
    if (active.length > 0 && active.every((q) => q.state === 'verified')) return ['verified', `All ${active.length} requirement${active.length === 1 ? ' has' : 's have'} a passing test.`];
    if (active.length === 0) return ['built', 'Files exist. No requirement declared yet.'];
    const missing = active.filter((q) => q.state !== 'verified').length;
    return ['built', `Files exist. ${missing} of ${active.length} requirement${active.length === 1 ? '' : 's'} not verified.`];
  };
  for (const n of [...nodes.values()].sort((a, b) => b.depth - a.depth)) {
    if (n.children.length === 0 || n.code.length > 0) {
      [n.status, n.statusWhy] = leafStatus(n);
      const c = cov.get(n.id);
      if (c && c.found > 0) n.coverage = Math.round((c.hit / c.found) * 100);
      if (n.children.length === 0) continue;
    }
    const kids = n.children.map((c) => nodes.get(c)!);
    const has = (s: Status): boolean => kids.some((k) => k.status === s);
    const all = (s: Status): boolean => kids.every((k) => k.status === s);
    const own = n.code.length > 0 ? n.status : null;
    if (n.retire) [n.status, n.statusWhy] = ['retiring', `Marked for retirement by change "${n.retire}".`];
    else if (has('failing') || own === 'failing') [n.status, n.statusWhy] = ['failing', 'A node inside is failing.'];
    else if (has('stale') || own === 'stale') [n.status, n.statusWhy] = ['stale', 'A node inside is stale.'];
    else if (all('planned') && (own === null || own === 'planned')) [n.status, n.statusWhy] = ['planned', 'Everything inside is planned.'];
    else if (has('planned') || has('building') || own === 'building') [n.status, n.statusWhy] = ['building', 'Some nodes inside are planned or being built.'];
    else if (all('verified')) [n.status, n.statusWhy] = ['verified', 'Everything inside is verified.'];
    else [n.status, n.statusWhy] = ['built', 'Everything inside is built.'];
    let found = 0;
    let hit = 0;
    const stack = [n.id];
    while (stack.length) {
      const id = stack.pop() as string;
      const c = cov.get(id);
      if (c) {
        found += c.found;
        hit += c.hit;
      }
      stack.push(...nodes.get(id)!.children);
    }
    if (found > 0) n.coverage = Math.round((hit / found) * 100);
  }
  for (const i of ifaces.values()) {
    const n = nodes.get(i.node)!;
    i.status = i.retire ? 'retiring' : open(i.change) || n.status === 'planned' ? 'planned' : 'built';
  }
  // An interface is "built" because nothing says it is planned. Where the code can be read, check that claim.
  const absent = new Map<string, Interface[]>();
  for (const i of ifaces.values()) if (i.evidence === 'unseen' && !i.holds && i.status === 'built') absent.set(i.node, [...(absent.get(i.node) ?? []), i]);
  for (const [id, list] of absent) {
    const named = list.slice(0, 5).map((i) => `${i.ref} (${i.route ?? `queue ${i.queue}`})`).join(', ');
    warn('not-in-code', `"${id}" declares ${named}${list.length > 5 ? ', …' : ''}, which its code does not register, though it registers others. Fix the model, or tag ${list.length === 1 ? 'it' : 'them'} with the change that adds ${list.length === 1 ? 'it' : 'them'}.`, id, nodes.get(id)!.source);
  }
  for (const e of edges) {
    const a = nodes.get(e.from)!;
    const b = nodes.get(e.to)!;
    const iface = e.iface ? ifaces.get(e.iface) : undefined;
    e.status = e.retire ? 'retiring' : open(e.change) || a.status === 'planned' || b.status === 'planned' || iface?.status === 'planned' ? 'planned' : 'built';
  }

  // ---- flows --------------------------------------------------------------
  const flows: Flow[] = [];
  const within = (id: string, anc: string): boolean => id === anc || id.startsWith(`${anc}.`);
  for (const abs of yamlFiles(path.join(archAbs, 'flows'))) {
    const data = loadYaml(abs, 'flow');
    if (!data) continue;
    const id = path.basename(abs).replace(/\.ya?ml$/, '');
    if (data.id && data.id !== id) err('id', `id "${data.id}" does not match file name "${id}".`, id, rel(abs));
    checkChange(data.change, id, rel(abs));
    checkChange(data.modify, id, rel(abs));
    const steps: FlowStep[] = [];
    for (const item of toArr<any>(data.steps)) {
      const text: string = typeof item === 'string' ? item : item?.step ?? '';
      const note: string | undefined = typeof item === 'string' ? undefined : item?.note;
      // A step may name one link outright: "billing~refund-card".
      const named = text.trim().match(/^([^\s~]+)~(\S+)$/);
      if (named) {
        const nid = resolveNode(named[1]);
        const e = nid ? edges.find((x) => x.id === linkRefs.get(`${nid}~${named[2]}`)) : undefined;
        if (!e) err('reference', `Flow "${id}" step "${text}": there is no link "${text.trim()}". Give a link an "id:" to name it.`, id, rel(abs));
        else steps.push({ text, from: e.from, to: e.to, iface: e.iface, edge: e.id, note });
        continue;
      }
      const m = text.match(/^\s*(\S+)\s*->\s*(\S+)\s*$/);
      if (!m) {
        err('flow-step', `Flow "${id}": cannot read step "${text}". Write "a -> b#interface".`, id, rel(abs));
        continue;
      }
      const [aRef, aIface] = m[1].split('#');
      const [bRef, bIface] = m[2].split('#');
      const a = resolveNode(aRef);
      const b = resolveNode(bRef);
      if (!a || !b) {
        err('reference', `Flow "${id}" step "${text}": ${nodeProblem(ids, !a ? aRef : bRef)}`, id, rel(abs));
        continue;
      }
      const wantIface = bIface ? `${b}#${bIface}` : aIface ? `${a}#${aIface}` : undefined;
      const pick = (exact: boolean): Edge[] =>
        edges.filter((e) =>
          (exact ? e.from === a && e.to === b : within(e.from, a) && within(e.to, b)) && (!wantIface || e.iface === wantIface));
      let found = pick(true);
      if (!found.length) found = pick(false);
      let edge: Edge | undefined = found[0];
      let reply = false;
      if (!edge) {
        // The answer to a call travels against its link: "api -> web" after web calls api.
        const back = (exact: boolean): Edge | undefined =>
          edges.find((e) => e.verb === 'calls' && (exact ? e.from === b && e.to === a : within(e.from, b) && within(e.to, a)) && (!wantIface || e.iface === wantIface));
        edge = back(true) ?? back(false);
        reply = !!edge;
      }
      if (!edge) err('flow-step', `Flow "${id}" step "${text}" matches no declared link.`, id, rel(abs));
      else if (wantIface && found.length > 1 && new Set(found.map((e) => `${e.verb} ${e.shapes.join(',')}`)).size > 1) {
        warn('ambiguous-step', `Flow "${id}" step "${text}" matches ${found.length} links that carry different data (${found.map((e) => e.shapes.join(', ') || 'no shape').join(' / ')}). Give the one you mean an "id:" and write the step as node~id.`, id, rel(abs));
      }
      steps.push({ text, from: a, to: b, iface: wantIface, edge: edge?.id ?? null, ...(reply ? { reply } : {}), note });
    }
    flows.push({ id, title: data.title ?? titleOf(id), headline: data.headline ?? '', trigger: data.trigger, change: data.change, modify: data.modify, steps, requirements: [] });
  }

  // ---- references that can name anything: requirement `covers`, and documents further down ----
  const refIx: RefIndex = {
    nodeIds: ids,
    ifaces: new Set(ifaces.keys()),
    reqs: new Set(reqs.keys()),
    links: linkRefs,
    shapes: new Map([...shapes.values()].map((sh) => [sh.id, sh.fields.map((f) => f.name)])),
    flows: new Set(flows.map((f) => f.id)),
    changes: new Set(changes.keys()),
  };
  const COVERABLE = ['interface', 'link', 'shape', 'flow'];
  for (const q of reqs.values()) {
    const out: string[] = [];
    for (const t of q.covers) {
      let r = resolveRef(refIx, t);
      // A bare name that is also a node or a change means the flow or the shape here.
      if (r && !COVERABLE.includes(r.type)) r = r.also.map((x) => resolveRef(refIx, x)).find((x) => x && COVERABLE.includes(x.type)) ?? null;
      if (!r) {
        warn('reference', `Requirement "${q.ref}" covers "${t}", which is not an interface, a link, a shape or a flow in the model.`, q.ref, nodes.get(q.node)!.source);
        continue;
      }
      out.push(r.id);
      if (r.type === 'flow') flows.find((f) => f.id === r!.id)!.requirements.push(q.ref);
    }
    q.covers = out;
  }

  // ---- changes: membership, progress, the "done" gate ----------------------
  // An element joins a change three ways: `change` adds it, `modify` alters it, `retire` removes it.
  // A node added by a change brings everything inside it along.
  const addedBy = (n: GNode): string | undefined => {
    for (let cur: GNode | undefined = n; cur; cur = cur.parent ? nodes.get(cur.parent) : undefined) if (cur.change) return cur.change;
    return undefined;
  };
  const join = <T>(list: (c: Change) => T[], item: T, what: string, tags: { change?: string; modify?: string; retire?: string }): void => {
    for (const [how, id] of [['add', tags.change], ['modify', tags.modify], ['retire', tags.retire]] as const) {
      const c = id ? changes.get(id) : undefined;
      if (!c) continue;
      c.elements.push(`${how} ${what}`);
      if (how !== 'retire' && !list(c).includes(item)) list(c).push(item);
    }
  };
  for (const n of nodes.values()) join((c) => c.nodes, n.id, `node ${n.id}${n.code.length ? ` [${n.code.join(', ')}]` : ''}`, { change: addedBy(n), modify: n.modify, retire: n.retire });
  for (const e of edges) join((c) => c.edges, e.id, `link ${e.ref ?? e.id}`, e);
  for (const i of ifaces.values()) join((c) => c.interfaces, i.ref, `interface ${i.ref}`, i);
  for (const q of reqs.values()) join((c) => c.requirements, q.ref, `requirement ${q.ref}`, q);
  for (const sh of shapes.values()) join((c) => c.shapes, sh.id, `shape ${sh.id}`, sh);
  for (const f of flows) join((c) => c.flows, f.id, `flow ${f.id}`, f);
  const approvals = readApprovals(root);
  for (const c of changes.values()) {
    c.elements.sort();
    const codeful = c.nodes.map((id) => nodes.get(id)!).filter((n) => n.code.length > 0);
    const builtNodes = codeful.filter((n) => n.files > 0);
    const rq = c.requirements.map((r) => reqs.get(r)!);
    c.progress = { total: codeful.length, built: builtNodes.length, reqTotal: rq.length, reqVerified: rq.filter((q) => q.state === 'verified').length };
    const size = c.elements.length;
    if (size === 0 && c.state !== 'dropped') warn('empty-change', `Change "${c.id}" has no elements. Tag elements with "change: ${c.id}".`, c.id);

    // What the person approved, against what the change holds now.
    const rec = approvals[c.id];
    if (rec && (c.state === 'approved' || c.state === 'done')) {
      const was = new Set(rec.elements ?? []);
      const now = new Set(c.elements);
      c.approval = { by: String(rec.by ?? ''), at: String(rec.at ?? ''), added: c.elements.filter((x) => !was.has(x)), removed: [...was].filter((x) => !now.has(x)) };
      if (c.state === 'approved' && (c.approval.added.length || c.approval.removed.length)) {
        const parts = [c.approval.added.length ? `added: ${c.approval.added.slice(0, 4).join('; ')}${c.approval.added.length > 4 ? '; …' : ''}` : '', c.approval.removed.length ? `removed: ${c.approval.removed.slice(0, 4).join('; ')}${c.approval.removed.length > 4 ? '; …' : ''}` : ''].filter(Boolean);
        warn('scope-changed', `Change "${c.id}" is not what ${c.approval.by || 'the person'} approved (${parts.join('. ')}). Ask for it to be approved again: "armature approve ${c.id}".`, c.id);
      }
    } else if (c.state === 'approved') {
      warn('unrecorded-approval', `Change "${c.id}" is approved, but nothing records who approved which elements. Run "armature approve ${c.id}".`, c.id);
    }

    // Code written before anyone approved the change.
    if (c.state === 'proposed') {
      const early = c.nodes.map((id) => nodes.get(id)!).filter((n) => addedBy(n) === c.id && n.files > 0);
      if (early.length) {
        warn('built-unapproved', `Change "${c.id}" is still proposed, but ${early.map((n) => `"${n.id}"`).join(', ')} already ${early.length === 1 ? 'has' : 'have'} code. Ask the person to approve the change; if a node existed before it, tag it "modify: ${c.id}" in place of "change:".`, c.id);
      }
    }

    if (c.state === 'done') {
      for (const a of c.waits) err('not-done', `Change "${c.id}" is marked done, but it comes after "${a}", which is not done.`, c.id);
      for (const n of codeful) if (n.files === 0) err('not-done', `Change "${c.id}" is marked done, but node "${n.id}" has no code.`, c.id);
      const mine = c.interfaces.map((r) => ifaces.get(r)!);
      for (const i of mine) if (i.evidence === 'unseen') err('not-done', `Change "${c.id}" is marked done, but interface "${i.ref}" is not in the code of "${i.node}".`, c.id);
      // A requirement blocks "done" when a current report says it fails or has no test. With no
      // report at all (a fresh checkout, CI without a test step) nothing can be said either way.
      let unproven = 0;
      for (const q of rq) {
        if (q.state === 'verified') continue;
        if (q.state === 'failing' || (cases.length > 0 && !q.outdated)) err('not-done', `Change "${c.id}" is marked done, but requirement "${q.ref}" is not verified.`, c.id);
        else unproven++;
      }
      if (unproven) {
        warn('done-unchecked', `Change "${c.id}" is marked done, but ${unproven} of its requirements cannot be checked here: ${cases.length ? 'the test report is older than the code' : 'there is no test report'}. Run the tests with a JUnit reporter.`, c.id);
      } else if (size > 0 && codeful.length === 0 && rq.length === 0 && !mine.some((i) => i.evidence === 'seen')) {
        warn('done-unchecked', `Change "${c.id}" is marked done, but nothing in it can be checked: it has no node with code, no requirement, and no interface the code index can see. Give it a requirement with a test.`, c.id);
      }
    }
    if (c.state === 'dropped' && size > 0) warn('dropped', `Change "${c.id}" is dropped but ${size} element${size === 1 ? '' : 's'} still carry it.`, c.id);
  }

  // ---- documents ------------------------------------------------------------
  const declaredDocs = new Map<string, string[]>();
  for (const n of nodes.values()) {
    for (const d of toArr<string>(rawById.get(n.id)!.data.docs)) {
      const hits = /[*?[{]/.test(d) ? (() => { const m = picomatch(d, { dot: true }); return repo.files.filter((f) => m(f)); })() : [d.replace(/^\.\//, '')];
      if (hits.length === 0 || (!/[*?[{]/.test(d) && !fs.existsSync(path.join(root, hits[0])))) warn('reference', `"${n.id}" lists doc "${d}", which does not exist.`, n.id, n.source);
      for (const h of hits) declaredDocs.set(h, [...(declaredDocs.get(h) ?? []), n.id]);
    }
  }
  // A document names parts of the model in its header and as [[references]]; they resolve like any other reference.
  const resolveDocRef: DocResolver = (text) => {
    const r = resolveRef(refIx, text);
    return r ? { type: r.type, id: r.id, node: r.node, also: r.also } : null;
  };
  // A path the project ignores is not part of the system, and neither are the documents under it (generated copies, vendored text).
  const { docs, issues: docIssues } = collectDocs(root, repo.files.filter((f) => !isIgnored(f)), nodes, [...changes.values()], declaredDocs, resolveDocRef, docsHome);
  for (const d of docs) for (const l of d.links) nodes.get(l.node)!.docs.push({ path: d.path, how: l.how, count: l.count });
  const rankHow = { declared: 3, inside: 2, mentions: 1 } as const;
  for (const n of nodes.values()) n.docs.sort((a, b) => rankHow[b.how] - rankHow[a.how] || b.count - a.count);
  for (const i of docIssues) warn(i.code, i.message, undefined, i.file);
  for (const d of docs) {
    if (d.broken.length) {
      warn('doc-reference', `"${d.path}" names ${d.broken.map((b) => `[[${b}]]`).join(', ')}, which ${d.broken.length === 1 ? 'is' : 'are'} not in the model.`, undefined, d.path);
    }
    if (d.ambiguous.length) {
      warn('ambiguous-reference', `"${d.path}" uses names that mean more than one thing: ${d.ambiguous.join('; ')}. The first meaning is used; write the kind in front to say which, as in [[flow:checkout]].`, undefined, d.path);
    }
    if (d.changes.length && d.status) {
      warn('typed-status', `"${d.path}" types its status by hand ("${d.status.slice(0, 60)}"). It is the plan of ${d.changes.join(', ')}, so its status is computed (${d.state}). Remove the line.`, undefined, d.path);
    }
  }
  // Each change knows its documents; the plan comes first and stands in for a missing "doc:".
  for (const c of changes.values()) {
    const own = docs.filter((d) => d.changes.includes(c.id));
    const first = (d: DocInfo): number => (d.path === c.doc ? 0 : d.kind === 'plan' ? 1 : 2);
    c.docs = own.sort((a, b) => first(a) - first(b) || a.path.localeCompare(b.path)).map((d) => d.path);
    if (!c.doc && c.docs.length) c.doc = c.docs[0];
  }
  const loose = docs.filter((d) => d.loose);
  if (loose.length) {
    const dirs = new Map<string, number>();
    for (const d of loose) {
      const parts = d.path.split('/');
      const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? parts[0] : '.';
      dirs.set(key, (dirs.get(key) ?? 0) + 1);
    }
    for (const [dir, count] of [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      warn('loose-doc', `${count} document${count === 1 ? '' : 's'} under "${dir}" ${count === 1 ? 'is' : 'are'} not tied to the model. Give each a header (kind, about), or list it under a node's "docs:".`, undefined, dir);
    }
  }

  // ---- remaining checks ---------------------------------------------------
  const top = [...nodes.values()].filter((n) => !n.parent);
  if (top.length > budget) err('budget', `The system view has ${top.length} nodes; the budget is ${budget}. Group some of them.`);
  if (top.filter((n) => n.hub).length > 1) err('hub', 'More than one hub in the system view.');
  for (const n of nodes.values()) {
    if (n.children.length > budget) err('budget', `"${n.id}" has ${n.children.length} children; the budget is ${budget}. Group some of them.`, n.id, n.source);
    if (n.children.filter((c) => nodes.get(c)!.hub).length > 1) err('hub', `More than one hub inside "${n.id}".`, n.id, n.source);
    const words = n.role.trim().split(/\s+/).filter(Boolean).length;
    if (words === 0) err('role', `"${n.id}" needs a role line.`, n.id, n.source);
    else if (words > 5) err('role', `"${n.id}" role line has ${words} words; the limit is five.`, n.id, n.source);
    if (deadGlobs.has(n.id)) err('dead-glob', `"${n.id}": code glob ${deadGlobs.get(n.id)!.join(', ')} matches nothing.`, n.id, n.source);
    if (CODE_KINDS.has(n.kind) && n.children.length === 0 && n.code.length === 0 && !open(n.change)) {
      warn('no-code', `"${n.id}" is a ${n.kind} with no code globs, so it cannot be tied to files.`, n.id, n.source);
    }
    // Libraries, stores (their migrations) and platforms (their configuration) need no requirement of their own.
    if (n.files > 0 && n.requirements.length === 0 && n.children.length === 0 && !['library', 'store', 'platform'].includes(n.kind)) {
      warn('no-requirement', `"${n.id}" has code and no requirement.`, n.id, n.source);
    }
  }

  // ---- accepted warnings: looked at by the team and kept, each with a reason ------------
  let accepted = 0;
  const accepts = toArr<any>(sys.accept).filter((a) => a && typeof a === 'object' && typeof a.code === 'string');
  if (accepts.length) {
    const used = new Set<number>();
    const under = (file: string | undefined, where: string): boolean => !!file && (file === where || file.startsWith(`${where.replace(/\/+$/, '')}/`));
    for (const a of accepts.filter((x) => NEVER_ACCEPTED.has(x.code))) {
      err('accept', `accept: "${a.code}" cannot be accepted. It says a change is not what a person approved, and only an approval answers it: "armature approve <change>". Remove the entry.`, typeof a.ref === 'string' ? a.ref : undefined, `${mdir}/system.yaml`);
    }
    const kept = problems.filter((p) => {
      if (p.level !== 'warning' || NEVER_ACCEPTED.has(p.code)) return true;
      const i = accepts.findIndex((a) => a.code === p.code && (!a.ref || a.ref === p.ref) && (!a.file || under(p.file, String(a.file))) && (!a.match || p.message.includes(String(a.match))));
      if (i < 0) return true;
      used.add(i);
      accepted++;
      return false;
    });
    problems.length = 0;
    problems.push(...kept);
    const describe = (a: any): string => [a.code, a.ref, a.file, a.match ? `"${a.match}"` : ''].filter(Boolean).join(' ');
    const idle = accepts.filter((a, i) => !used.has(i) && !NEVER_ACCEPTED.has(a.code));
    if (idle.length) warn('stale-accept', `${idle.length} accept entr${idle.length === 1 ? 'y matches' : 'ies match'} no warning any more: ${idle.slice(0, 5).map(describe).join(', ')}${idle.length > 5 ? ', …' : ''}. Remove ${idle.length === 1 ? 'it' : 'them'}.`, undefined, `${mdir}/system.yaml`);
    const bare = accepts.filter((a) => !String(a.why ?? '').trim());
    if (bare.length) warn('accept-reason', `${bare.length} accept entr${bare.length === 1 ? 'y gives' : 'ies give'} no reason: ${bare.slice(0, 5).map(describe).join(', ')}${bare.length > 5 ? ', …' : ''}.`, undefined, `${mdir}/system.yaml`);
  }

  const order = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    system: {
      name: sys.name ?? path.basename(root),
      dir: mdir,
      docs: docsHome,
      headline: sys.headline ?? '',
      description: sys.description,
      budget,
      hasGit: repo.hasGit,
      hasRemote: repo.hasRemote,
      branch: repo.branch,
      reports: { junit: junitFiles.length, lcov: lcovFiles.length, ...(newestReport ? { at: new Date(newestReport).toISOString() } : {}) },
    },
    nodes: order,
    edges,
    shapes: [...shapes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    flows,
    changes: [...changes.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    problems,
    unowned: unowned.slice(0, 300),
    coverage,
    deployment,
    tech,
    snapshot: snapshotOf(root),
    dead: deadFiles,
    activity: activitySummary,
    code: codeSummary,
    codeDeps,
    docs,
    runtime: runtimeReports,
    detectors,
    accepted,
  };
}

/** The commit the model was compiled against, so an export is a dated copy of the project. */
function snapshotOf(root: string): Snapshot {
  const commit = git(root, ['rev-parse', '--short=12', 'HEAD'])?.trim() || undefined;
  const branch = git(root, ['branch', '--show-current'])?.trim() || undefined;
  const status = git(root, ['status', '--porcelain', '--untracked-files=normal']);
  return { commit, branch, dirty: !!status && status.trim().length > 0, at: new Date().toISOString() };
}

/** Records the current hash of each shape's source so later edits to the source flag it stale. */
export function confirmShapes(root: string, only: string[]): { confirmed: string[]; missing: string[] } {
  const graph = compile(root);
  const lockPath = path.join(root, modelDir(root), LOCK_FILE);
  let lock: Record<string, { source: string; hash: string }> = {};
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    lock = {};
  }
  const confirmed: string[] = [];
  const missing: string[] = [];
  const known = new Set(graph.shapes.map((s) => s.id));
  for (const id of only) if (!known.has(id)) missing.push(id);
  for (const s of graph.shapes) {
    if (!s.source) continue;
    if (only.length && !only.includes(s.id)) continue;
    const h = sourceHash(root, s.source);
    if (!h.hash) {
      missing.push(s.id);
      continue;
    }
    lock[s.id] = { source: s.source, hash: h.hash };
    confirmed.push(s.id);
  }
  for (const id of Object.keys(lock)) if (!known.has(id)) delete lock[id];
  const sorted = Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(lockPath, `${JSON.stringify(sorted, null, 2)}\n`);
  return { confirmed, missing };
}
