// Pure types shared by the compiler, the CLI and the viewer. No runtime imports.

export type NodeKind =
  | 'actor' | 'app' | 'service' | 'worker' | 'job' | 'agent'
  | 'store' | 'queue' | 'external' | 'library' | 'group'
  /** Third-party software the system runs itself and depends on at run time: a workflow server, a model proxy, a web server. */
  | 'platform';

export const NODE_KINDS: NodeKind[] = [
  'actor', 'app', 'service', 'worker', 'job', 'agent', 'store', 'queue', 'external', 'library', 'group',
];

export type Verb = 'calls' | 'sends' | 'reads' | 'writes';

export type Status =
  | 'retiring' | 'failing' | 'stale' | 'planned' | 'building' | 'verified' | 'built';

export type ChangeState = 'proposed' | 'approved' | 'done' | 'dropped';

export interface Interface {
  id: string;
  ref: string; // node#id
  node: string;
  holds: boolean; // true for store tables
  via?: string;
  route?: string;
  queue?: string;
  takes: string[];
  gives: string[];
  dlq?: string;
  note?: string;
  change?: string;
  retire?: string;
  status: Status;
}

export interface Requirement {
  id: string;
  ref: string; // node:id
  node: string;
  text: string;
  change?: string;
  tests: string[];
  match: string[];
  state: 'verified' | 'failing' | 'unverified';
  evidence: string[]; // test names that matched
}

export type TodoKind = 'task' | 'debt' | 'bug' | 'idea';
export type Priority = 'high' | 'medium' | 'low';

export interface Todo {
  text: string;
  kind: TodoKind;
  priority: Priority;
  owner?: string;
  issue?: number;
  change?: string;
  node: string;
}

export interface Rule {
  text: string;
  from: string; // node id (or "system") that declared it
}

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branch: string;
}

export interface ActivityItem {
  kind: 'commit' | 'pr';
  id: string; // short hash, or #number
  title: string;
  type: string; // Conventional Commits type, or "other"
  scope?: string;
  breaking: boolean;
  date: string;
  author: string;
  state?: 'open' | 'merged' | 'closed';
  url?: string;
}

export interface Activity {
  commits: number;
  prsOpen: number;
  prsMerged: number;
  prsClosed: number;
  byType: Record<string, number>; // commits and PRs together
  authors: number;
  last: string | null;
  weeks: number[]; // items per week, oldest first
  recent: ActivityItem[];
}

export interface CodeMapFile {
  path: string;
  lines: number;
  /** 0..1, relative to the most central file of the repo. */
  rank: number;
  symbols: Array<{ name: string; kind: string; line: number; sig: string; doc?: string }>;
}

export interface CodeMap {
  files: number;
  lines: number;
  exported: number;
  top: CodeMapFile[];
  packages: string[];
}

/** One node's code importing another node's code. */
export interface CodeDep {
  from: string;
  to: string;
  count: number;
  /** declared: a link between the two exists in the model. library: the target is shared code. */
  kind: 'declared' | 'library' | 'undeclared';
  /** What the dependency is: an import, or something the code does at run time. */
  via?: 'import' | 'table' | 'queue' | 'http' | 'workflow';
  samples: Array<{ from: string; to: string; names: string[] }>;
}

export interface DocLink {
  node: string;
  /** declared: named by the node's docs, a change's doc, or the document's own header and [[references]]. inside: the file sits in the node's code. mentions: the text names the node's paths. */
  how: 'declared' | 'inside' | 'mentions';
  count: number;
}

/** What a document is for. Closed set, like node kinds. */
export type DocKind = 'plan' | 'decision' | 'guide' | 'runbook' | 'review' | 'research' | 'note';

export const DOC_KINDS: DocKind[] = ['plan', 'decision', 'guide', 'runbook', 'review', 'research', 'note'];

export type DocRefType = 'node' | 'interface' | 'requirement' | 'shape' | 'flow' | 'change';

/** One element of the model that a document names, in its header or as [[reference]] in its text. */
export interface DocRef {
  /** As written in the document. */
  text: string;
  type: DocRefType;
  /** The resolved reference: node id, node#interface, node:requirement, Shape, flow id or change id. */
  id: string;
  /** The node it belongs to, for nodes, interfaces and requirements. */
  node?: string;
  count: number;
}

export interface DocInfo {
  path: string;
  title: string;
  summary: string;
  /** From the header. Absent on documents that are not part of the model yet. */
  kind?: DocKind;
  /** True when the document belongs to the model: it lives in the documents folder or its header has kind, about or change. */
  model: boolean;
  /** A "Status:" line typed near the top, when the document has one. Plans should not: see `state`. */
  status?: string;
  /** Computed for plans from their changes, for example "approved, 2 of 5 built". */
  state?: string;
  outline: string[];
  words: number;
  size: number;
  /** Changes whose plan this document is. */
  changes: string[];
  links: DocLink[];
  /** Model elements the document names. */
  refs: DocRef[];
  /** References that resolve to nothing in the model. */
  broken: string[];
  /** Nothing ties it to the model: no header, no node lists it, no change names it. */
  loose: boolean;
}

export interface GNode {
  id: string;
  name: string;
  kind: NodeKind;
  role: string;
  description?: string;
  parent: string | null;
  children: string[];
  depth: number;
  tech: string[];
  hub: boolean;
  color?: string;
  image?: string;
  code: string[];
  tests: string[];
  files: number;
  testFiles: number;
  interfaces: Interface[];
  rules: Rule[]; // own + inherited
  ownRules: number;
  requirements: Requirement[];
  todos: Todo[];
  change?: string;
  retire?: string;
  status: Status;
  statusWhy: string;
  coverage: number | null; // 0..100
  testSummary: TestSummary | null;
  prs: PullRequest[];
  scopes: string[]; // Conventional Commits scopes that mean this node
  activity: Activity | null;
  codeMap: CodeMap | null;
  /** Test files that import this node's code, directly or through an index file. */
  testedBy: string[];
  /** Other nodes whose files change in the same commits, with how many commits. */
  coChange: Array<{ node: string; n: number }>;
  /** This node's most often changed files. */
  hot: Array<{ path: string; changes: number }>;
  runtime: RuntimeReport | null;
  /** Documents about this node itself, strongest link first. */
  docs: Array<{ path: string; how: DocLink['how']; count: number }>;
  source: string; // model file, relative to repo root
  /** Declared dead: code nothing reaches, kept on the map as a grey node with no links. */
  unused: boolean;
  /** Shared plumbing the viewer can hide: a library, unless it or an ancestor says `shared: false`. */
  shared: boolean;
  /** Container or compose service names this node runs as. */
  deploy: string[];
  /** Where those services are defined, per compose file. */
  deployment: DeployedAs[];
  /** Files under this node that no entry point reaches. */
  dead: DeadFile[];
}

export interface DeployedAs {
  service: string;
  env: string;
  file: string;
  image?: string;
  command?: string;
}

export interface DeadFile {
  path: string;
  lines: number;
}

/** One technology the system is made of: a framework, database, runtime, SDK or tool. From armature/tech.yaml. */
export interface Tech {
  id: string;
  name: string;
  category: 'runtime' | 'framework' | 'library' | 'database' | 'messaging' | 'ai' | 'protocol' | 'tool' | 'platform';
  url?: string;
  version?: string;
  note?: string;
  files: string[];
  /** Nodes whose tech list names it. */
  usedBy: string[];
  /** Files its globs own. */
  fileCount: number;
}

export interface Coverage {
  /** Files git knows about (tracked, or new and not ignored). */
  files: number;
  /** Owned by a node's code or tests. */
  owned: number;
  /** Owned by a technology in tech.yaml (tool configuration and the like). */
  tech: number;
  /** Written documents (Markdown, and anything under docs/): placed in the document library. */
  docs: number;
  /** Skipped by a built-in rule: lockfiles, generated output, build output. */
  builtin: number;
  /** Skipped by the project's ignore list. */
  ignored: number;
  unowned: number;
  /** Per top-level folder, largest gaps first. */
  byDir: Array<{ dir: string; files: number; unowned: number }>;
}

export interface Deployment {
  files: Array<{ file: string; env: string; services: Array<{ name: string; image?: string; command?: string; node: string | null }> }>;
}

export interface Snapshot {
  commit?: string;
  branch?: string;
  /** Uncommitted changes, including an untracked armature/ folder. */
  dirty: boolean;
  at: string;
}

export interface Edge {
  id: string;
  from: string; // node the data leaves
  to: string; // node the data arrives at
  owner: string; // node whose file declares the link
  verb: Verb;
  async: boolean;
  via?: string;
  iface?: string; // node#interface, when precise
  shapes: string[]; // data moving from -> to
  returns: string[]; // data coming back, for calls
  note?: string;
  change?: string;
  retire?: string;
  status: Status;
  /** Set on edges synthesised from imports for the Code lens. */
  code?: { count: number; kind: CodeDep['kind']; via?: CodeDep['via'] };
}

export interface ShapeField {
  name: string;
  type: string;
  tags: string[];
}

export interface RuntimeItem {
  kind: 'table' | 'queue' | 'http' | 'route' | 'workflow';
  what: string;
  op?: string;
  file?: string;
  line?: number;
}

/** What the code does at run time, compared with what the model declares. */
export interface RuntimeReport {
  node: string;
  /** In the code, not in the model. */
  undeclared: RuntimeItem[];
  /** In the model, not seen in the code (only for tables and queues, which are detected reliably). */
  unseen: RuntimeItem[];
  /** Declared and seen. */
  confirmed: number;
}

export interface Shape {
  id: string;
  fields: ShapeField[];
  source?: string;
  note?: string;
  change?: string;
  stale: boolean;
  bound: boolean; // source resolves and hash is confirmed
  /** Set when the fields were read from code (the model's own field list is then only a fallback). */
  fromCode?: 'drizzle' | 'zod' | 'pydantic' | 'sql' | 'ts';
  /** Field names that differ between the model file and the code. */
  drift?: { onlyModel: string[]; onlyCode: string[] };
  file: string;
}

export interface FlowStep {
  text: string;
  from: string;
  to: string;
  iface?: string;
  edge: string | null;
  note?: string;
}

export interface Flow {
  id: string;
  title: string;
  headline: string;
  trigger?: string;
  change?: string;
  steps: FlowStep[];
}

export interface Change {
  id: string;
  title: string;
  state: ChangeState;
  order: number;
  /** The plan document: `doc:` on the change, or the first plan whose header names the change. */
  doc?: string;
  /** Every document tied to the change, the plan first. */
  docs: string[];
  issue?: number | null;
  why?: string;
  doneWhen: string[];
  nodes: string[];
  edges: string[];
  interfaces: string[];
  requirements: string[];
  shapes: string[];
  flows: string[];
  progress: { total: number; built: number; reqTotal: number; reqVerified: number };
}

/** Warnings fall in two groups: the model says something the code contradicts, or the model leaves something out. */
export type WarningGroup = 'wrong' | 'incomplete';

export interface Problem {
  level: 'error' | 'warning';
  code: string;
  message: string;
  ref?: string;
  file?: string;
  /** Warnings only. */
  group?: WarningGroup;
}

/** What each warning code means, and which group it belongs to. Data only, shared with the viewer. */
export const WARNING_INFO: Record<string, { group: WarningGroup; what: string }> = {
  'runtime-drift': { group: 'wrong', what: 'The code reads or writes tables, starts queues or workflows, or serves or calls routes that the model does not declare, or a declared table link never appears in the code.' },
  'undeclared-import': { group: 'wrong', what: 'A node imports code from another node with no link between them.' },
  'shape-fields': { group: 'wrong', what: 'A shape lists fields that differ from the schema in the code it was read from.' },
  'stale-shape': { group: 'wrong', what: 'The source of a shape changed since someone confirmed it.' },
  'source-symbol': { group: 'wrong', what: 'A shape points at a symbol that is not in its source file.' },
  verb: { group: 'wrong', what: 'A link reads from or writes to something that is not a store.' },
  reference: { group: 'wrong', what: 'The model names a document, test file, requirement or type that does not exist.' },
  type: { group: 'wrong', what: 'A shape field uses a type that is not known.' },
  'no-test-match': { group: 'wrong', what: 'A requirement expects a test that is not in the latest test report.' },
  dropped: { group: 'wrong', what: 'A change is dropped, but elements still carry it.' },
  report: { group: 'wrong', what: 'A test or coverage report could not be read.' },
  'deploy-missing': { group: 'wrong', what: 'A node says it runs as a container that no compose file defines.' },
  'unused-reachable': { group: 'wrong', what: 'A node is marked unused, but an entry point reaches its code.' },
  'legacy-folder': { group: 'incomplete', what: 'The model is still in arch/, the earlier name of the folder. Rename it to armature/.' },
  'unused-linked': { group: 'wrong', what: 'A node is marked unused but still has links to other nodes.' },
  'doc-reference': { group: 'wrong', what: 'A document names a node, interface, shape, requirement, flow or change that is not in the model. The part was renamed or removed, or the reference is mistyped.' },
  'doc-header': { group: 'wrong', what: 'A document in the documents folder (armature/docs/, or the folder docs: names in system.yaml) has no kind, or names a kind that is not known.' },
  'typed-status': { group: 'incomplete', what: 'A plan document types its status by hand. The status of a plan is computed from its change; remove the line.' },
  'loose-doc': { group: 'incomplete', what: 'Documents are not tied to the model. Give each a header (kind, about) or list it under a node\'s docs. "armature docs --loose" lists them with the nodes they mention.' },
  'dead-code': { group: 'incomplete', what: 'Code files that no entry point reaches sit in a live node. Move them to an unused node, list them as entry points, or delete them.' },
  undeployed: { group: 'incomplete', what: 'A compose service is not claimed by any node.' },
  'unknown-tech': { group: 'incomplete', what: 'A node names a technology that armature/tech.yaml does not list.' },
  'ignore-reason': { group: 'incomplete', what: 'An ignore entry gives no reason.' },
  'no-shape': { group: 'incomplete', what: 'A link does not say what data it carries.' },
  'no-requirement': { group: 'incomplete', what: 'A node owns code but states no requirement that must keep holding.' },
  'no-code': { group: 'incomplete', what: 'A service has no code globs, so it cannot be tied to files.' },
  'coarse-link': { group: 'incomplete', what: 'A link points at a whole node instead of one of its interfaces.' },
  unowned: { group: 'incomplete', what: 'Source files belong to no node.' },
  unconfirmed: { group: 'incomplete', what: 'A shape read from code was never confirmed by a person.' },
  'empty-change': { group: 'incomplete', what: 'A planned change has no elements tagged with it yet.' },
};

export const GROUP_TITLE: Record<WarningGroup, string> = {
  wrong: 'Model disagrees with the code',
  incomplete: 'Model is incomplete',
};

export function warningGroup(code: string): WarningGroup {
  return WARNING_INFO[code]?.group ?? 'incomplete';
}

export interface Graph {
  version: 1;
  generatedAt: string;
  root: string; // repo root, absolute
  system: {
    name: string;
    /** The folder that holds the model: armature, or arch in a repo not renamed yet. */
    dir: string;
    /** The folder that holds the documents: `docs:` in system.yaml, or armature/docs. */
    docs: string;
    headline: string;
    description?: string;
    budget: number;
    hasGit: boolean;
    hasRemote: boolean;
    branch?: string;
    reports: { junit: number; lcov: number };
  };
  nodes: GNode[];
  edges: Edge[];
  shapes: Shape[];
  flows: Flow[];
  changes: Change[];
  problems: Problem[];
  unowned: string[];
  code: { files: number; symbols: number; builtAt: string } | null;
  codeDeps: CodeDep[];
  docs: DocInfo[];
  runtime: RuntimeReport[];
  coverage: Coverage;
  deployment: Deployment;
  tech: Tech[];
  snapshot: Snapshot;
  /** Code files no entry point reaches, by owning node (null when no node owns them). */
  dead: Array<{ path: string; lines: number; node: string | null }>;
  /** Document texts, present only in a static export. */
  docTexts?: Record<string, string>;
  activity: {
    days: number;
    commits: number;
    conventional: number; // commits whose subject follows Conventional Commits
    prs: number; // 0 when pull requests were not loaded
    prsLoaded: boolean;
    byType: Record<string, number>;
    unmatchedScopes: Array<{ scope: string; count: number }>;
    unmapped: number; // items that reached no node
  } | null;
}

export const STATUS_ORDER: Status[] = [
  'retiring', 'failing', 'stale', 'planned', 'building', 'verified', 'built',
];
