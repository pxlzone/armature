// Pure types shared by the compiler, the CLI and the viewer. No runtime imports.

export type NodeKind =
  | 'actor' | 'app' | 'service' | 'worker' | 'job' | 'agent'
  | 'store' | 'queue' | 'external' | 'library' | 'group'
  /** Third-party software the system runs itself and depends on at run time: a workflow server, a model proxy, a web server. */
  | 'platform';

export const NODE_KINDS: NodeKind[] = [
  'actor', 'app', 'service', 'worker', 'job', 'agent', 'store', 'queue', 'external', 'library', 'group', 'platform',
];

/** Transports the viewer has an icon for. `via` is an open list; these are the known ones. */
export const VIA_KINDS = ['http', 'grpc', 'ws', 'webhook', 'mcp', 'sql', 'bolt', 'redis', 'pgmq', 'temporal', 'kafka', 'cron', 'cli', 'sdk', 'smtp', 'imap', 'in-process'];

export type Verb = 'calls' | 'sends' | 'reads' | 'writes';

export type Status =
  | 'retiring' | 'failing' | 'stale' | 'planned' | 'building' | 'verified' | 'built';

export type ChangeState = 'proposed' | 'approved' | 'done' | 'dropped';

/**
 * Whether the code index saw what the model declares.
 * seen: a detector found it. unseen: a detector that works on this node's code did not find it.
 * unchecked: no detector covers it (a language or library the index does not read), so nothing is known.
 */
export type Evidence = 'seen' | 'unseen' | 'unchecked';

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
  /** The change that alters this interface. It exists today and stays built. */
  modify?: string;
  retire?: string;
  /** Who may call it: none, user, service, admin, or the name of a scheme. Declared, not seen in code. */
  auth?: string;
  /** The nodes that may link to it (callers and senders; writers, for a table). Absent: anyone. */
  only?: string[];
  status: Status;
  evidence: Evidence;
}

/** Where data with a tag may leave the system, from `data:` in system.yaml. Keys are tags without the @. */
export type DataPolicy = Record<string, { leaves: string[] }>;

/** One read of an environment variable in a node's code. */
export interface EnvRead {
  name: string;
  file: string;
  line: number;
}

export interface Requirement {
  id: string;
  ref: string; // node:id
  node: string;
  text: string;
  /** `security`: a statement about who may get or change what. Entry points that reach sensitive data need one. */
  kind?: 'security';
  change?: string;
  modify?: string;
  tests: string[];
  match: string[];
  /** What else the requirement is about: interfaces, links, shapes or flows, as resolved references. */
  covers: string[];
  state: 'verified' | 'failing' | 'unverified';
  /** True when the only passing tests are in a report older than the code they tested. */
  outdated?: boolean;
  evidence: string[]; // test names that matched
  /** Set when a person read the node's files and recorded the requirement as true, and no file changed since. */
  confirmed?: { by: string; at: string };
  /** Hash of the text and the node's files. Filled only where a confirmation needs it. */
  filesHash?: string;
}

/** A node whose code this node must not import and that no link of it may reach. */
export interface Boundary {
  node: string;
  why?: string;
  /** The node that declared it; children inherit it. */
  from: string;
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

export type DocRefType = 'node' | 'interface' | 'link' | 'requirement' | 'shape' | 'flow' | 'change';

/** One element of the model that a document names, in its header or as [[reference]] in its text. */
export interface DocRef {
  /** As written in the document. */
  text: string;
  type: DocRefType;
  /** The resolved reference: node id, node#interface, node~link, node:requirement, Shape, flow id or change id. */
  id: string;
  /** The node it belongs to, for nodes, interfaces, links and requirements. */
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
  /** Bare names that could be more than one kind of thing, with the kinds: "refunds (node, flow:refunds)". */
  ambiguous: string[];
  /** Documents this one replaces (decisions). */
  supersedes: string[];
  /** The document that replaced this one. */
  supersededBy?: string;
  /** Nothing ties it to the model: no header, no node lists it, no change names it. */
  loose: boolean;
}

/** One file of a node, as the viewer draws it inside the node. */
export interface GFile {
  path: string;
  lines?: number;
  /** Top-level symbols the code index found. */
  symbols?: number;
  test?: boolean;
  /** Files of this repo it imports. */
  imports?: string[];
}

export interface GNode {
  /** Set by the viewer on the blocks it draws for a node's files. `more` stands for that many files not drawn one by one. */
  file?: GFile & { more?: number };
  id: string;
  name: string;
  kind: NodeKind;
  role: string;
  description?: string;
  parent: string | null;
  children: string[];
  depth: number;
  tech: string[];
  /** Free labels a team gives the node (legacy, critical, public). Its own only: nothing is inherited. */
  tags: string[];
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
  /** The change that alters this node. It exists today and keeps its status. */
  modify?: string;
  retire?: string;
  /** Nodes this one must never import code from or link to: its own and inherited ones. */
  never: Boundary[];
  /** Code that runs on the user's device (a browser, mobile or desktop app). Its own or inherited. */
  client: boolean;
  /** Editing its existing files needs an approved change that modifies it. Its own or inherited. */
  protect: boolean;
  /** Credentials this node holds, by environment variable name. */
  secrets: string[];
  /** Reads of environment variables in its code that look like credentials or that it declares. */
  env: EnvRead[];
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
  /** The link's own id, when it has one. */
  name?: string;
  /** owner~name, the reference of a named link. */
  ref?: string;
  change?: string;
  modify?: string;
  retire?: string;
  status: Status;
  evidence: Evidence;
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
  /** In the model, not seen in the code, where a detector works on this node's code. */
  unseen: RuntimeItem[];
  /** Declared and seen. */
  confirmed: number;
}

/** What the code index could check for one node. A node with no kinds was not checked at all. */
export interface DetectorCoverage {
  node: string;
  /** Files the node owns. */
  files: number;
  /** Of those, files in a language the index reads. */
  indexed: number;
  /** What was recognised in its code: route, http, queue, workflow, table. */
  kinds: string[];
}

export interface Shape {
  id: string;
  fields: ShapeField[];
  source?: string;
  note?: string;
  change?: string;
  /** The change that alters this shape. Fields only the model lists are then planned, not drift. */
  modify?: string;
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
  /** The step is the answer to a call: data moves against the link's direction. */
  reply?: boolean;
  note?: string;
}

export interface Flow {
  id: string;
  title: string;
  headline: string;
  trigger?: string;
  change?: string;
  modify?: string;
  steps: FlowStep[];
  /** Requirements that cover the flow (`covers:` on a requirement). */
  requirements: string[];
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
  /** Changes that must be done before this one. */
  after: string[];
  /** Of those, the ones not done yet. */
  waits: string[];
  /** Everything the change adds, alters or retires, one line each. This is what a person approves. */
  elements: string[];
  /** Who approved which elements, from approvals.lock.json. Null when nothing is recorded. */
  approval: { by: string; at: string; added: string[]; removed: string[] } | null;
  progress: { total: number; built: number; reqTotal: number; reqVerified: number };
  /** What the change does to security, for the person reviewing it. Set by the viewer server and the export, on changes that wait for approval. */
  security?: { lines: string[]; errors: string[] };
  /** When the plan was proposed: the first commit of its file, or the file's own date while it is not committed. Set where `security` is. */
  proposedAt?: string;
}

/** Why a change waits for a person: never approved, altered since it was approved, or approved with no record of it. Null when it does not wait. */
export function awaitingApproval(c: Change): 'proposed' | 'scope-changed' | 'unrecorded' | null {
  if (c.state === 'proposed') return 'proposed';
  if (c.state !== 'approved') return null;
  if (!c.approval) return 'unrecorded';
  return c.approval.added.length || c.approval.removed.length ? 'scope-changed' : null;
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
  /** For a warning that sums up several things (files, routes, requirements): each of them, so two runs can be compared thing by thing. */
  items?: string[];
}

/** What each warning code means, and which group it belongs to. Data only, shared with the viewer. */
export const WARNING_INFO: Record<string, { group: WarningGroup; what: string }> = {
  'runtime-drift': { group: 'wrong', what: 'The code reads or writes tables, starts queues or workflows, or serves or calls routes that the model does not declare, or a declared table link never appears in the code.' },
  'undeclared-import': { group: 'wrong', what: 'A node imports code from another node with no link between them.' },
  'shape-fields': { group: 'wrong', what: 'A shape lists fields that differ from the schema in the code it was read from.' },
  'stale-shape': { group: 'wrong', what: 'The source of a shape changed since someone confirmed it.' },
  'source-symbol': { group: 'wrong', what: 'A shape points at a symbol that is not in its source file.' },
  verb: { group: 'wrong', what: 'A link reads from something that is neither a store nor a queue, or writes to something that is not a store.' },
  reference: { group: 'wrong', what: 'The model names a document, test file, requirement or type that does not exist.' },
  type: { group: 'wrong', what: 'A shape field uses a type that is not known.' },
  'no-test-match': { group: 'wrong', what: 'A requirement expects a test that is not in the latest test report.' },
  dropped: { group: 'wrong', what: 'A change is dropped, but elements still carry it.' },
  report: { group: 'wrong', what: 'A test or coverage report could not be read.' },
  'deploy-missing': { group: 'wrong', what: 'A node says it runs as a container that no compose file defines.' },
  'unused-reachable': { group: 'wrong', what: 'A node is marked unused, but an entry point reaches its code.' },
  'not-in-code': { group: 'wrong', what: 'The model declares a route or a queue on a node whose code registers others of the same kind, and this one is not among them.' },
  overlap: { group: 'wrong', what: 'Two nodes that are not parent and child claim the same files. Each file goes to one of them, so the other owns less than its globs say.' },
  'built-unapproved': { group: 'wrong', what: 'A node has code, but the change that adds it is still proposed: the code was written before a person approved the change.' },
  'done-untested': { group: 'wrong', what: 'A change is marked done, but one of its requirements names no test, so no test report can ever verify it.' },
  'stale-confirmation': { group: 'wrong', what: 'A requirement was confirmed by a person reading the code, and the files of its node changed since. Read them again, then run "armature confirm <node:requirement>".' },
  'untested-requirement': { group: 'incomplete', what: 'Requirements of a node with code name no test: no "tests:", no "match:", and no test title tagged "[req node:id]". They stay unverified whatever the tests do.' },
  'unread-node': { group: 'incomplete', what: 'A node owns files, none in a language the code index reads (configuration, for instance), so its links, interfaces and requirements are not checked against them.' },
  'no-auth': { group: 'incomplete', what: 'An entry point (an interface an actor, an outside system or a client links to) does not say who may call it. Add "auth:".' },
  'no-security-requirement': { group: 'incomplete', what: 'An entry point reaches sensitive data and no requirement of kind security covers it.' },
  'undeclared-secret': { group: 'incomplete', what: 'A node\'s code reads an environment variable that looks like a credential, and its "secrets:" does not list it.' },
  'scope-changed': { group: 'wrong', what: 'Elements were added to or removed from a change after a person approved it. It needs approving again: "armature approve <change>".' },
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
  'unrecorded-approval': { group: 'incomplete', what: 'A change is approved, but nothing records who approved which elements. Run "armature approve <change>".' },
  'done-unchecked': { group: 'incomplete', what: 'A change is marked done and nothing here can prove it: there is no test report, the report is older than the code, or the change has no element a check can see.' },
  'outdated-report': { group: 'incomplete', what: 'A test report is older than the code it tested, so its passes do not count. Run the tests again.' },
  'ambiguous-reference': { group: 'incomplete', what: 'A document names something that could be a node, a shape, a flow or a change. Write the kind in front: [[flow:checkout]].' },
  'ambiguous-step': { group: 'incomplete', what: 'A flow step matches more than one link. Give the link an id and write the step as node~id.' },
  'accept-reason': { group: 'incomplete', what: 'An accepted warning gives no reason.' },
  'stale-accept': { group: 'incomplete', what: 'An accept entry in system.yaml matches no warning any more. Remove it.' },
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
    /** `at` is when the newest test report was written. */
    reports: { junit: number; lcov: number; at?: string };
    /** Where tagged data may leave the system. */
    data: DataPolicy;
    /** Paths the project leaves out of the system, with the reason. */
    ignore: Array<{ path: string; why?: string }>;
    /** Warnings the team keeps, from `accept:`. */
    accepts: Array<{ code: string; ref?: string; file?: string; match?: string; why?: string }>;
    /** Positions in the `accept:` list of entries that match no warning any more. */
    idleAccepts: number[];
    /** False when system.yaml says `gate: off`. */
    gate: boolean;
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
  /** Per node with code: what the code index could check. */
  detectors: DetectorCoverage[];
  /** Warnings dropped because system.yaml accepts them, with a reason. */
  accepted: number;
  coverage: Coverage;
  deployment: Deployment;
  tech: Tech[];
  snapshot: Snapshot;
  /** Code files no entry point reaches, by owning node (null when no node owns them). */
  dead: Array<{ path: string; lines: number; node: string | null }>;
  /** Document texts, present only in a static export. */
  docTexts?: Record<string, string>;
  /** The files of each node that has code, for the viewer to draw inside it. Present when asked for. */
  files?: Record<string, GFile[]>;
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

// What agent sessions are doing right now: read from the hooks' log by src/live.ts, drawn by the viewer.
export type LiveKind = 'start' | 'prompt' | 'read' | 'editing' | 'edited' | 'run' | 'stop';

export interface LiveStep {
  at: string;
  kind: LiveKind;
  /** The part that owns the file, when one does. */
  node?: string;
  file?: string;
  text?: string;
}

/** A file a session read or edited. The line counts are what git sees against the last commit, when asked for. */
export interface LiveFile {
  path: string;
  edits: number;
  /** Lines added and removed since the last commit. Absent when git was not asked, or says nothing about the file. */
  added?: number;
  removed?: number;
  /** A file git does not track yet: every line of it is new. */
  fresh?: boolean;
}

export interface LiveSession {
  id: string;
  startedAt: string;
  lastAt: string;
  /** A turn is open and something happened lately. */
  working: boolean;
  /** The first words of the latest prompt. */
  prompt?: string;
  /** The latest step that names a file or a command. */
  now?: LiveStep;
  /** The part the session was last in. It stays while a command runs. */
  part?: string;
  /** Parts the session read or edited: the edited ones first, then the latest touched. */
  nodes: Array<{ id: string; edits: number; reads: number; files: LiveFile[]; lastAt: string }>;
  /** Changes not done yet that plan a part this session edited. */
  changes: string[];
  /** The latest steps, newest first. */
  steps: LiveStep[];
}

export interface Live {
  at: string;
  sessions: LiveSession[];
}
