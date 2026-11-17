// MCP server: the same read-only answers as the CLI, for agents.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildCodeIndex, readCodeIndex } from './code.js';
import { codeDeps, codeMap, findSymbol } from './codeview.js';
import { callersText, contextText, driftText, searchText, testsText } from './context.js';
import { compile, findRoot } from './compile.js';
import { activity, docsText, formatProblems, impact, islands, orient, show, status, techText, todos, where } from './render.js';

export async function runMcp(rootFlag?: string): Promise<void> {
  const server = new McpServer({ name: 'armature', version: '0.1.0' });
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
      description: 'Full detail for one element of the architecture model. ref is a node id (billing), an interface (billing#charge), a shape (ChargeJob), a requirement (billing:no-double-charge), a flow id or a change id. depth 2 includes child nodes.',
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
      description: 'What depends on a node, an interface (node#interface) or a shape: the links, flows and requirements a change would touch.',
      inputSchema: { ref: z.string() },
    },
    async ({ ref }) => run((root) => impact(compile(root), ref))(),
  );
  server.registerTool(
    'check',
    { description: 'Validate the model under armature/. Returns errors and warnings. Run after every edit to armature/.', inputSchema: {} },
    run((root) => formatProblems(compile(root).problems)),
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
    async ({ node }) => run((root) => islands(compile(root), node))(),
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
    'activity',
    { description: 'Recent commits per node of the architecture model, grouped by Conventional Commits type, busiest nodes first. Shows where work is happening.', inputSchema: {} },
    run((root) => activity(compile(root, { activity: true }))),
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
    { description: 'What the code does at run time (tables read and written, queues, HTTP routes served and called) that the architecture model does not declare, and declared table links not seen in the code.', inputSchema: { ref: z.string().optional() } },
    async ({ ref }) => withIndex((root) => driftText(compile(root), ref))(),
  );

  await server.connect(new StdioServerTransport());
}
