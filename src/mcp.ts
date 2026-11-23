// MCP server: the same read-only answers as the CLI, for agents.
import { surfaceText } from './security.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildCodeIndex, readCodeIndex } from './code.js';
import { codeDeps, codeMap, findSymbol } from './codeview.js';
import { callersText, contextText, driftText, searchText, testsText } from './context.js';
import fs from 'node:fs';
import path from 'node:path';
import { compile as compileNow, findRoot, type CompileOptions } from './compile.js';
import { hotspotsText } from './context.js';
import { diffModel, diffText } from './diff.js';
import { MODEL_DIR } from './paths.js';
import { git } from './repo.js';
import { activity, docsText, formatProblems, impact, islands, orient, pathText, show, status, tagsText, techText, todos, traceText, where } from './render.js';
import type { Graph } from './types.js';

// An agent asks several things in a row, and each answer needs the compiled model. Compiling reads
// the whole repo, so the last result is kept for as long as nothing it was read from has changed.
const kept = new Map<string, { print: string; at: number; graph: Graph }>();
const KEEP_FOR = 60_000;

/** A cheap summary of everything a compile reads. Null when it cannot be had (no git), which means: compile. */
function fingerprint(root: string): string | null {
  const head = git(root, ['rev-parse', 'HEAD']);
  const status = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (head === null || status === null) return null;
  const parts = [head.trim(), status];
  const stamp = (file: string): void => {
    try {
      const st = fs.statSync(file);
      parts.push(`${file}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${file}:gone`);
    }
  };
  // A file that already differs from the commit can change again without its status line changing.
  for (const line of status.split('\n').filter(Boolean)) stamp(path.join(root, (line.slice(3).split(' -> ').pop() as string).replace(/^"|"$/g, '')));
  // What git ignores and a compile still reads: the code index, test and coverage reports.
  const cache = path.join(root, MODEL_DIR, '.cache');
  for (const dir of [cache, path.join(cache, 'reports')]) {
    try {
      for (const f of fs.readdirSync(dir)) stamp(path.join(dir, f));
    } catch {
      /* not there */
    }
  }
  stamp(path.join(root, 'coverage', 'lcov.info'));
  return parts.join('\n');
}

export function compile(root: string, opts: CompileOptions = {}): Graph {
  const key = `${root}|${JSON.stringify(opts)}`;
  const print = fingerprint(root);
  const hit = kept.get(key);
  if (print !== null && hit && hit.print === print && Date.now() - hit.at < KEEP_FOR) return hit.graph;
  const graph = compileNow(root, opts);
  // The index may have been rebuilt just before this call; take the fingerprint after compiling so it is included.
  const after = fingerprint(root);
  if (after !== null) kept.set(key, { print: after, at: Date.now(), graph });
  return graph;
}

/** The version of the tool this server belongs to. */
const VERSION: string = (() => {
  // From source the version is in package.json; in the plugin it is in the plugin manifest.
  for (const file of ['../package.json', '../.claude-plugin/plugin.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8')).version;
      if (typeof v === 'string') return v;
    } catch {
      /* try the next */
    }
  }
  return '0.0.0';
})();

export async function runMcp(rootFlag?: string): Promise<void> {
  const server = new McpServer({ name: 'armature', version: VERSION });
  const run = (fn: (root: string) => string) => async () => {
    const root = findRoot(rootFlag ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    const text = root ? safe(() => fn(root)) : 'No armature/system.yaml found in this project. Run "armature init" to start a model.';
    return { content: [{ type: 'text' as const, text }] };
  };
  const safe = (fn: () => string): string => {
    try {
      return fn();
    } catch (e: any) {
      return `armature failed: ${String(e?.message ?? e)}`;
    }
  };

  server.registerTool(
    'orient',
    { description: 'Short digest of the whole system from the architecture model in armature/: nodes with roles and status, flows, open changes, and what needs attention. Read this first.', inputSchema: {} },
    run((root) => orient(compile(root))),
  );
  server.registerTool(
    'show',
    {
      description: 'Full detail for one element of the architecture model. ref is a node id (billing), an interface (billing#charge), a named link (billing~refund-card), a shape (ChargeJob), a requirement (billing:no-double-charge), a flow id or a change id. A name that means several things takes the kind in front: flow:checkout, change:checkout, node:checkout. depth 2 includes child nodes.',
      inputSchema: { ref: z.string(), depth: z.number().int().min(1).max(4).optional() },
    },
    async ({ ref, depth }) => run((root) => show(compile(root), ref, depth ?? 1))(),
  );
  server.registerTool(
    'where',
    {
      description: 'The node that owns a source file (path relative to the repo root), with its rules, interfaces and requirements. Use before editing a file you have not touched in this session.',
      inputSchema: { file: z.string() },
    },
    async ({ file }) => run((root) => where(compile(root), file))(),
  );
  server.registerTool(
    'impact',
    {
      description: 'What depends on a node, an interface (node#interface), a named link (node~link) or a shape: the links, flows, requirements and documents a change would touch, the shapes that embed a shape, and for a node what lies further along the data. depth is how many links away to look (default 3).',
      inputSchema: { ref: z.string(), depth: z.number().int().min(1).max(8).optional() },
    },
    async ({ ref, depth }) => run((root) => impact(compile(root), ref, depth ?? 3))(),
  );
  server.registerTool(
    'path',
    {
      description: 'How data gets from one node to another along the declared links, step by step, in the direction the data moves. Use it to answer "does X ever reach Y, and through what".',
      inputSchema: { from: z.string(), to: z.string() },
    },
    async ({ from, to }) => run((root) => pathText(compile(root), from, to))(),
  );
  server.registerTool(
    'trace',
    {
      description: 'Where a data shape is held and where it goes: stores, interfaces, links, and the outside systems it leaves to. Give a Shape name, or a field tag such as @pii to follow every field that carries it.',
      inputSchema: { what: z.string() },
    },
    async ({ what }) => run((root) => traceText(compile(root), what))(),
  );
  server.registerTool(
    'surface',
    {
      description: 'The security surface: entry points (interfaces an actor, an outside system or a client reaches) with their auth and the sensitive data behind them, tagged data leaving the system, secrets and protected nodes. Give a change id to see only what that change adds. Use it while planning work that adds an entry point, sends data out or needs a credential.',
      inputSchema: { change: z.string().optional() },
    },
    async ({ change }) => run((root) => surfaceText(compile(root), change))(),
  );
  server.registerTool(
    'diff',
    {
      description: 'What the model declares now against a git ref (a commit, branch or tag; default HEAD): nodes, interfaces, links, shapes and fields, flows, requirements and changes that were added, changed or removed. Use it to review what a branch does to the architecture.',
      inputSchema: { ref: z.string().optional() },
    },
    async ({ ref }) => run((root) => diffText(diffModel(root, ref ?? 'HEAD')))(),
  );
  server.registerTool(
    'check',
    {
      description: 'Validate the model under armature/. Returns errors and warnings. Run after every edit to armature/. only narrows the answer: errors, wrong (the model disagrees with the code) or incomplete (the model leaves something out). On a large model, ask for errors and wrong first.',
      inputSchema: { only: z.enum(['errors', 'wrong', 'incomplete']).optional() },
    },
    async ({ only }) =>
      run((root) => {
        const g = compile(root);
        return formatProblems(only ? g.problems.filter((p) => (only === 'errors' ? p.level === 'error' : p.level === 'warning' && p.group === only)) : g.problems, g.accepted);
      })(),
  );
  server.registerTool(
    'status',
    { description: 'Counts of nodes per status, requirement verification, changes with progress, and todos.', inputSchema: {} },
    run((root) => status(compile(root))),
  );

  server.registerTool(
    'todos',
    {
      description: 'Tasks, tech debt, bugs and ideas noted on nodes of the architecture model, most urgent first. kind narrows to task, debt, bug or idea.',
      inputSchema: { kind: z.enum(['task', 'debt', 'bug', 'idea']).optional() },
    },
    async ({ kind }) => run((root) => todos(compile(root), kind))(),
  );

  server.registerTool(
    'islands',
    {
      description: 'Dead code: code files that no entry point (package script, container command, route, test, Temporal workflowsPath) reaches, by node. Do not build on these files.',
      inputSchema: { node: z.string().optional() },
    },
    async ({ node }) => withIndex((root) => islands(compile(root), node))(),
  );

  server.registerTool(
    'tech',
    {
      description: 'Technologies the system is made of (frameworks, databases, runtimes, AI SDKs, tools) from armature/tech.yaml, or one technology with the nodes that use it.',
      inputSchema: { id: z.string().optional() },
    },
    async ({ id }) => run((root) => techText(compile(root), id))(),
  );

  server.registerTool(
    'tags',
    {
      description: 'The free labels nodes carry (such as legacy, critical, public) with the nodes under each, or the nodes that carry one tag.',
      inputSchema: { tag: z.string().optional() },
    },
    async ({ tag }) => run((root) => tagsText(compile(root), tag))(),
  );

  server.registerTool(
    'activity',
    { description: 'Recent commits per node of the architecture model, grouped by Conventional Commits type, busiest nodes first. Shows where work is happening. days sets the window (default 90).', inputSchema: { days: z.number().int().min(1).max(730).optional() } },
    async ({ days }) => run((root) => activity(compile(root, { activity: true, ...(days ? { days } : {}) })))(),
  );

  const withIndex = (fn: (root: string) => string) => async () => {
    const root = findRoot(rootFlag ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    if (root) await buildCodeIndex(root).catch(() => undefined);
    return run(fn)();
  };
  server.registerTool(
    'code_map',
    {
      description: 'Repo map from the code index: the files of a node (or the whole repo), most central first, each with the signatures of its exported symbols and no bodies. Give a file path instead to get that file\'s symbols, imports and importers. Use this before reading files, to choose which ones to read. budget is in characters (default 6000).',
      inputSchema: { ref: z.string().optional(), budget: z.number().int().min(500).max(40000).optional() },
    },
    async ({ ref, budget }) => withIndex((root) => codeMap(compile(root), readCodeIndex(root), ref, budget ?? 6000))(),
  );
  server.registerTool(
    'find_symbol',
    {
      description: 'Where a top-level symbol (function, class, const, type) is defined, with its signature, its node, and the files and nodes that import it. Faster and more exact than grep for "where is X defined and who uses it".',
      inputSchema: { name: z.string() },
    },
    async ({ name }) => withIndex((root) => findSymbol(compile(root), readCodeIndex(root), name))(),
  );
  server.registerTool(
    'code_deps',
    {
      description: 'Which other nodes a node\'s code imports and which import it, each marked declared (the model has the link), library, or undeclared. Without a node, lists every undeclared dependency.',
      inputSchema: { ref: z.string().optional() },
    },
    async ({ ref }) => withIndex((root) => codeDeps(compile(root), ref))(),
  );

  server.registerTool(
    'docs',
    {
      description: 'Plans and written documents (Markdown in the repo) about a node and everything inside it: the plan documents of changes that touch it, documents whose header or [[references]] name it, documents inside its code, and documents that mention its files. Also takes a Shape, node#interface, flow or change. Without a ref, lists the whole library; with loose, lists documents not yet tied to the model. Read the listed files for the detail.',
      inputSchema: { ref: z.string().optional(), loose: z.boolean().optional() },
    },
    async ({ ref, loose }) => run((root) => docsText(compile(root), ref, { loose }))(),
  );

  server.registerTool(
    'context',
    {
      description: 'Start here for a task. Returns, within a budget, the parts of the system the task is about with their rules and plans, the data shapes involved, the most relevant files with signatures only, files that usually change with them, tests to run and related documents. Give the task in plain words; add files already in play.',
      inputSchema: { task: z.string(), files: z.array(z.string()).optional(), budget: z.number().int().min(1000).max(40000).optional() },
    },
    async ({ task, files, budget }) => withIndex((root) => contextText(compile(root), readCodeIndex(root), root, task, { files, budget: budget ?? 6000 }))(),
  );
  server.registerTool(
    'search',
    { description: 'Files ranked by how well they match some words (names, paths, comments, summaries), each with matching symbols. Better than grep for "where do we do X".', inputSchema: { query: z.string() } },
    async ({ query }) => withIndex((root) => searchText(compile(root), readCodeIndex(root), root, query))(),
  );
  server.registerTool(
    'callers',
    { description: 'Every use of a top-level function, class, constant or type: file, line, enclosing function, node, and the tests that exercise it. Use before changing a signature.', inputSchema: { symbol: z.string() } },
    async ({ symbol }) => withIndex((root) => callersText(compile(root), readCodeIndex(root), symbol))(),
  );
  server.registerTool(
    'tests_for',
    { description: 'Test files that exercise a file, a node, or a symbol and its callers. Run these after a change.', inputSchema: { ref: z.string() } },
    async ({ ref }) => withIndex((root) => testsText(compile(root), readCodeIndex(root), ref))(),
  );
  server.registerTool(
    'drift',
    { description: 'What the code does at run time (tables read and written, queues, HTTP routes served and called) that the architecture model does not declare; what the model declares that the code does not show; and which nodes could not be checked at all (a language or library the code index does not read). No finding on a node that was not checked means nothing.', inputSchema: { ref: z.string().optional() } },
    async ({ ref }) => withIndex((root) => driftText(compile(root), ref))(),
  );
  server.registerTool(
    'hotspots',
    { description: 'Files that change most often and are largest, for the repo or one node. These are where a change is most likely to conflict or to break something.', inputSchema: { ref: z.string().optional() } },
    async ({ ref }) => withIndex((root) => hotspotsText(compile(root), readCodeIndex(root), root, ref))(),
  );
  server.registerTool(
    'shapes',
    { description: 'Data shapes against the code they point at: how many take their fields from code, and which list fields that differ from the code.', inputSchema: {} },
    withIndex((root) => {
      const g = compile(root);
      const fromCode = g.shapes.filter((s) => s.fromCode).length;
      const withSource = g.shapes.filter((s) => s.source).length;
      const out = [`${g.shapes.length} shapes: ${fromCode} take their fields from code, ${withSource - fromCode} have a source the index cannot read, ${g.shapes.length - withSource} have no source.`];
      for (const s of g.shapes.filter((x) => x.drift)) out.push(`  ${s.id}: model only ${s.drift!.onlyModel.join(', ') || '-'}; code only ${s.drift!.onlyCode.join(', ') || '-'}`);
      if (g.shapes.some((x) => x.drift)) out.push('"armature shapes --sync" rewrites these from the code.');
      return out.join('\n');
    }),
  );

  await server.connect(new StdioServerTransport());
}
