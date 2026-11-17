import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, confirmShapes, findRoot } from './compile.js';
import { MODEL_DIR, modelDir } from './paths.js';
import { ownerOf } from './render.js';
import { watchSources } from './watch.js';
import { activity, docsText, formatProblems, impact, islands, orient, pathText, show, status, techText, todos, traceText, where } from './render.js';
import { approveChange } from './approve.js';
import { newSince, readBaseline, writeBaseline } from './baseline.js';
import { diffModel, diffText } from './diff.js';
import { rename } from './rename.js';
import { exportHtml, serve } from './server.js';
import { hook, install, installTeam, syncRules } from './agent.js';
import { buildCodeIndex, readCodeIndex } from './code.js';
import { codeDeps, codeMap, findSymbol } from './codeview.js';
import { callersText, contextText, driftText, hotspotsText, searchText, testsText } from './context.js';
import { agentText, evalAgent, evalRetrieval, retrievalText } from './eval.js';
import { syncShapeFiles } from './schemas.js';
import { planSummaries, summarize } from './summarize.js';
import { runMcp } from './mcp.js';

const HELP = `armature: read, check and view the architecture model in armature/

Reading
  armature orient                  Short digest of the whole system
  armature show <ref> [--depth n]  A node, node#interface, node~link, Shape, node:requirement, flow or change.
                                A name that means several things takes the kind in front: flow:checkout
  armature where <file>            The node that owns a file, with its rules
  armature impact <ref> [--depth n]   What depends on a node, interface, link or shape, and what lies further along the data
  armature path <node> <node>      How data gets from one node to another along the declared links
  armature trace <Shape|@tag>      Where a shape, or every field tagged @pii, is held and where it leaves the system
  armature diff [git-ref] [--json] What the model declares now against a commit or branch (default HEAD)
  armature status                  Counts per status, changes, todos
  armature docs [ref] [--loose]    Plans and documents about a node, shape, flow or change, or the whole library;
                                --loose lists documents not yet tied to the model
  armature todos [--kind debt]     Tasks, tech debt and bugs noted on nodes, most urgent first
  armature activity [--days n] [--github]   Commits and pull requests per node, by Conventional Commits type

Code graph
  armature index                   Build or refresh the code index (symbols and imports per file)
  armature map [node|file] [--budget n]   Ranked files with exported signatures, for a node, a file or the repo
  armature symbol <name>           Where a symbol is defined and who imports it
  armature deps [node]             Which nodes import which, compared with the declared links
  armature context "<task>" [--files a,b] [--budget n]   What an agent needs for a task: nodes, rules, data, ranked files, tests
  armature search "<words>"        Files ranked by how well they match, with matching symbols
  armature callers <symbol>        Where a symbol is used: files, enclosing functions, nodes, tests
  armature tests <file|node|symbol>   Test files that exercise it
  armature drift [node]            What the code does at run time that the model does not declare, the reverse,
                                and which nodes the check could not read at all
  armature hotspots [node]         Files that change most and are largest
  armature shapes [--sync]         Shapes whose fields differ from the code; --sync rewrites them from the code
  armature summarize [--node n] [--limit n] [--yes]   One-line file summaries by a model (costs money; asks first)
  armature eval retrieval [--n 60] Score the context pack against past commits (free)
  armature eval agent <tasks.yaml> Run real sessions with and without the tooling (costs money)

Checking
  armature islands [node]           Dead code: files no entry point reaches, by node
  armature tech [id]               Technologies from armature/tech.yaml and who uses them
  armature check [--json] [--annotate] [--only errors|wrong|incomplete] [--new] [--fail-on wrong|warnings]
                                Errors, then warnings where the model is wrong, then where it is incomplete.
                                Exits 1 on errors. --annotate adds GitHub Actions annotations.
                                --new shows only warnings that are not in the baseline; --fail-on makes
                                warnings of that kind exit 1 too. --update-baseline records today's warnings
  armature confirm [Shape...]      Record shape sources as read, so later edits flag them stale

Changing the model
  armature approve <change> [--by name]   Approve a change and record who approved which elements. A person runs this
  armature rename <ref> <new>      Rename a node (new is its full id, so this also moves it), interface, link,
                                requirement, shape, flow or change, and rewrite every reference to it

Viewing
  armature view [--port n] [--github]   Local diagram with live reload
  armature export [file] [--github]     One self-contained HTML file
  armature build                        Write armature/.cache/graph.json

Setup
  armature init                    Create an empty armature/ folder here
  armature install --team [--marketplace owner/repo] [--ref r] [--no-ci]
                                Wire the repo for the team: enable the armature plugin in .claude/settings.json,
                                rule files, CI workflow. Everything it writes is meant to be committed
  armature install                 Wire only this machine: hooks, MCP server and skills with local paths
  armature sync-rules [--check]    Regenerate .claude/rules/armature-*.md; --check exits 1 when they are out of date
  armature mcp                     Run the MCP server on stdio

Options
  --root <dir>                  Repo to work on (default: nearest folder containing armature/system.yaml)
`;

function parse(argv: string[]): { cmd: string; args: string[]; flags: Record<string, string | boolean> } {
  const [cmd = 'help', ...rest] = argv;
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const valued = new Set(['root', 'depth', 'port', 'kind', 'days', 'budget', 'files', 'node', 'limit', 'n', 'skip', 'marketplace', 'ref', 'only', 'fail-on', 'by']);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (valued.has(key)) flags[key] = rest[++i] ?? '';
      else flags[key] = true;
    } else args.push(a);
  }
  return { cmd, args, flags };
}

function needRoot(flags: Record<string, string | boolean>): string {
  const start = typeof flags.root === 'string' ? flags.root : process.cwd();
  const root = findRoot(start);
  if (!root) {
    console.error(`No ${MODEL_DIR}/system.yaml found in "${path.resolve(start)}" or above it. Run "armature init" to create one.`);
    process.exit(2);
  }
  return root;
}

function init(dir: string): void {
  const arch = path.join(dir, MODEL_DIR);
  if (fs.existsSync(path.join(arch, 'system.yaml'))) {
    console.log(`${MODEL_DIR}/system.yaml already exists. Nothing changed.`);
    return;
  }
  for (const d of ['nodes', 'shapes', 'flows', 'changes', 'docs']) fs.mkdirSync(path.join(arch, d), { recursive: true });
  fs.writeFileSync(
    path.join(arch, 'system.yaml'),
    `name: ${path.basename(dir)}\nheadline: One sentence that says what this system does.\n\n# People who use the system.\nactors: []\n\n# Third-party systems it talks to.\nexternals: []\n\n# Guidance for anyone, person or agent, who edits this repo.\nrules: []\n`,
  );
  fs.writeFileSync(path.join(arch, '.gitignore'), '.cache/\n');
  console.log(`Created ${MODEL_DIR}/ with an empty system.yaml. Add nodes under ${MODEL_DIR}/nodes/, then run "armature check".`);
}

async function main(): Promise<void> {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'init':
      init(typeof flags.root === 'string' ? path.resolve(flags.root) : process.cwd());
      return;
    case 'hook':
      await hook(args[0] ?? '', typeof flags.root === 'string' ? flags.root : undefined);
      return;
    case 'mcp':
      await runMcp(typeof flags.root === 'string' ? flags.root : undefined);
      return;
  }
  const root = needRoot(flags);
  switch (cmd) {
    case 'orient':
      console.log(orient(compile(root)));
      return;
    case 'show':
      if (!args[0]) return fail('Usage: armature show <ref>');
      console.log(show(compile(root), args[0], Number(flags.depth) || 1));
      return;
    case 'where': {
      if (!args[0]) return fail('Usage: armature where <file>');
      // An absolute path, or one relative to where you stand inside the repo; otherwise relative to the repo root.
      const fromCwd = path.resolve(args[0]);
      const rel = path.isAbsolute(args[0]) || (fromCwd.startsWith(root + path.sep) && fs.existsSync(fromCwd))
        ? path.relative(root, fromCwd)
        : args[0];
      console.log(where(compile(root), rel.replace(/\\/g, '/')));
      return;
    }
    case 'impact':
      if (!args[0]) return fail('Usage: armature impact <ref> [--depth n]');
      console.log(impact(compile(root), args[0], Number(flags.depth) || 3));
      return;
    case 'path':
      if (!args[1]) return fail('Usage: armature path <node> <node>');
      console.log(pathText(compile(root), args[0], args[1]));
      return;
    case 'trace':
      if (!args[0]) return fail('Usage: armature trace <Shape|@tag>');
      await buildCodeIndex(root);
      console.log(traceText(compile(root), args[0]));
      return;
    case 'diff': {
      const d = diffModel(root, args[0] ?? 'HEAD');
      console.log(flags.json ? JSON.stringify(d, null, 2) : diffText(d));
      if (typeof d === 'string') process.exit(2);
      return;
    }
    case 'approve':
      if (!args[0]) return fail('Usage: armature approve <change> [--by name]');
      console.log(approveChange(root, args[0], typeof flags.by === 'string' ? flags.by : undefined));
      return;
    case 'rename': {
      if (!args[1]) return fail('Usage: armature rename <ref> <new name>');
      console.log(rename(root, args[0], args[1]));
      // Rule files are named after node ids and quote the model: bring them along when the repo has them.
      if (fs.existsSync(path.join(root, '.claude', 'rules'))) {
        const r = syncRules(root);
        if (r.written || r.removed) console.log(`Rule files: ${r.written} written, ${r.removed} removed.`);
      }
      return;
    }
    case 'status':
      console.log(status(compile(root, { github: flags.github === true })));
      return;
    case 'index': {
      const r = await buildCodeIndex(root);
      console.log(`Indexed ${r.files} files (${r.parsed} parsed, ${r.reused} unchanged) in ${r.ms} ms.`);
      if (flags.watch) {
        console.log('Watching for changes (Ctrl+C to stop).');
        watchSources(root, async () => {
          const again = await buildCodeIndex(root);
          console.log(`${new Date().toLocaleTimeString()} re-indexed ${again.parsed} changed file${again.parsed === 1 ? '' : 's'} in ${again.ms} ms.`);
        });
        await new Promise(() => undefined);
      }
      return;
    }
    case 'context': {
      const task = args.join(' ');
      if (!task) return fail('Usage: armature context "<task>" [--files a,b] [--budget n]');
      await buildCodeIndex(root);
      const files = typeof flags.files === 'string' ? flags.files.split(',').map((f) => f.trim()).filter(Boolean) : [];
      console.log(contextText(compile(root), readCodeIndex(root), root, task, { budget: Number(flags.budget) || 6000, files }));
      return;
    }
    case 'search':
      if (!args.length) return fail('Usage: armature search "<words>"');
      await buildCodeIndex(root);
      console.log(searchText(compile(root), readCodeIndex(root), root, args.join(' '), Number(flags.limit) || 15));
      return;
    case 'callers':
      if (!args[0]) return fail('Usage: armature callers <symbol>');
      await buildCodeIndex(root);
      console.log(callersText(compile(root), readCodeIndex(root), args[0]));
      return;
    case 'tests':
      if (!args[0]) return fail('Usage: armature tests <file|node|symbol>');
      await buildCodeIndex(root);
      console.log(testsText(compile(root), readCodeIndex(root), args[0]));
      return;
    case 'drift':
      await buildCodeIndex(root);
      console.log(driftText(compile(root), args[0]));
      return;
    case 'hotspots':
      await buildCodeIndex(root);
      console.log(hotspotsText(compile(root), readCodeIndex(root), root, args[0]));
      return;
    case 'shapes': {
      await buildCodeIndex(root);
      if (flags.sync) {
        const changed = await syncShapeFiles(path.join(root, modelDir(root)), readCodeIndex(root)!, args);
        console.log(changed.length ? `Rewrote the fields of ${changed.length} shape${changed.length === 1 ? '' : 's'} from code: ${changed.join(', ')}` : 'Every shape with a readable source already matches the code.');
        return;
      }
      const g = compile(root);
      const fromCode = g.shapes.filter((s) => s.fromCode).length;
      const withSource = g.shapes.filter((s) => s.source).length;
      console.log(`${g.shapes.length} shapes: ${fromCode} take their fields from code, ${withSource - fromCode} have a source the index cannot read, ${g.shapes.length - withSource} have no source.`);
      for (const s of g.shapes.filter((x) => x.drift)) console.log(`  ${s.id}: model only ${s.drift!.onlyModel.join(', ') || '-'}; code only ${s.drift!.onlyCode.join(', ') || '-'}`);
      if (g.shapes.some((x) => x.drift)) console.log('Run "armature shapes --sync" to rewrite these from the code.');
      return;
    }
    case 'summarize': {
      await buildCodeIndex(root);
      const idx = readCodeIndex(root)!;
      const g = compile(root);
      const node = typeof flags.node === 'string' ? flags.node : undefined;
      const plan = planSummaries(root, idx, node ? (f) => { const n = ownerOf(g, f); return !!n && (n.id === node || n.id.startsWith(`${node}.`)); } : undefined, Number(flags.limit) || 400);
      if (!plan.files.length) {
        console.log(`Nothing to summarise (${plan.cached} files already have a current summary).`);
        return;
      }
      if (!flags.yes) {
        console.log(`This would summarise ${plan.files.length} files in ${plan.batches} calls to the claude CLI (model ${process.env.ARMATURE_SUMMARY_MODEL ?? 'haiku'}). It sends the start of each file to the model and costs money. Run again with --yes to go ahead.`);
        return;
      }
      const n = summarize(root, idx, plan, (s) => console.log(s));
      console.log(`Wrote ${n} summaries to ${modelDir(root)}/.cache/summaries.json.`);
      return;
    }
    case 'eval': {
      await buildCodeIndex(root);
      if (args[0] === 'retrieval') {
        console.log(retrievalText(evalRetrieval(compile(root), readCodeIndex(root)!, root, Number(flags.n) || 60, Number(flags.skip) || 0)));
        return;
      }
      if (args[0] === 'agent') {
        if (!args[1]) return fail('Usage: armature eval agent <tasks.yaml>');
        if (!flags.yes) {
          console.log('This runs two real Claude Code sessions per task, in throwaway copies of the repo, and costs money. Run again with --yes to go ahead.');
          return;
        }
        const runs = await evalAgent(root, path.resolve(args[1]), fileURLToPath(new URL('../bin/armature.mjs', import.meta.url)), (s) => console.log(s));
        console.log(agentText(runs));
        return;
      }
      return fail('Usage: armature eval retrieval | armature eval agent <tasks.yaml>');
    }
    case 'map':
      await buildCodeIndex(root);
      console.log(codeMap(compile(root), readCodeIndex(root), args[0], Number(flags.budget) || 6000));
      return;
    case 'symbol':
      if (!args[0]) return fail('Usage: armature symbol <name>');
      await buildCodeIndex(root);
      console.log(findSymbol(compile(root), readCodeIndex(root), args[0]));
      return;
    case 'deps':
      await buildCodeIndex(root);
      console.log(codeDeps(compile(root), args[0]));
      return;
    case 'docs':
      console.log(docsText(compile(root), args[0], { loose: flags.loose === true }));
      return;
    case 'activity':
      console.log(activity(compile(root, { activity: true, github: flags.github === true, days: Number(flags.days) || undefined })));
      return;
    case 'islands':
      console.log(islands(compile(root), args[0]));
      return;
    case 'tech':
      console.log(techText(compile(root), args[0]));
      return;
    case 'todos':
      console.log(todos(compile(root), typeof flags.kind === 'string' ? flags.kind : undefined));
      return;
    case 'check': {
      const g = compile(root);
      const only = typeof flags.only === 'string' ? flags.only : null;
      if (only && only !== 'wrong' && only !== 'incomplete' && only !== 'errors') return fail('--only takes errors, wrong or incomplete.');
      const failOn = typeof flags['fail-on'] === 'string' ? flags['fail-on'] : null;
      if (failOn && failOn !== 'wrong' && failOn !== 'warnings') return fail('--fail-on takes wrong or warnings.');
      if (flags['update-baseline']) {
        const n = writeBaseline(root, g.problems);
        console.log(`Wrote ${modelDir(root)}/baseline.json: ${n} warning${n === 1 ? ' is' : 's are'} the baseline now. "armature check --new" shows only what comes after; commit the file.`);
        return;
      }
      // With --new, warnings the baseline already holds are set aside: the question is whether the model got worse.
      let pool = g.problems;
      let known = 0;
      if (flags.new) {
        const base = readBaseline(root);
        if (!base) return fail(`No baseline yet. Run "armature check --update-baseline" first.`);
        pool = newSince(g.problems, base);
        known = g.problems.length - pool.length;
      }
      const shown = only ? pool.filter((p) => (only === 'errors' ? p.level === 'error' : p.level === 'warning' && p.group === only)) : pool;
      if (flags.json) console.log(JSON.stringify(shown, null, 2));
      else {
        console.log(formatProblems(shown, g.accepted));
        if (known) console.log(`${known} warning${known === 1 ? '' : 's'} already in the baseline ${known === 1 ? 'is' : 'are'} not shown.`);
      }
      if (flags.annotate) {
        // GitHub Actions workflow commands: each problem shows on the pull request at its file.
        const esc = (t: string): string => t.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
        // Wrong shows as a warning on the pull request; incomplete as a quieter notice.
        for (const p of shown) {
          const kind = p.level === 'error' ? 'error' : p.group === 'wrong' ? 'warning' : 'notice';
          console.log(`::${kind} ${p.file ? `file=${p.file},` : ''}title=armature ${p.code}${p.group ? ` (${p.group})` : ''}::${esc(p.message)}`);
        }
      }
      if (g.problems.some((p) => p.level === 'error')) process.exit(1);
      if (failOn && pool.some((p) => p.level === 'warning' && (failOn === 'warnings' || p.group === 'wrong'))) process.exit(1);
      return;
    }
    case 'confirm': {
      const r = confirmShapes(root, args);
      console.log(r.confirmed.length ? `Confirmed ${r.confirmed.length}: ${r.confirmed.join(', ')}` : 'No shape with a source to confirm.');
      if (r.missing.length) console.log(`Not found or source missing: ${r.missing.join(', ')}`);
      return;
    }
    case 'build': {
      const g = compile(root, { github: flags.github === true, activity: true });
      const dir = path.join(root, modelDir(root), '.cache');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(g, null, 2));
      console.log(`Wrote ${modelDir(root)}/.cache/graph.json (${g.nodes.length} nodes, ${g.edges.length} links).`);
      return;
    }
    case 'view': {
      await buildCodeIndex(root).catch(() => undefined);
      const url = await serve(root, Number(flags.port) || 4747, flags.github === true);
      console.log(`Viewer for ${path.basename(root)} at ${url}  (Ctrl+C to stop; reloads when armature/ changes)`);
      return;
    }
    case 'export': {
      await buildCodeIndex(root).catch(() => undefined);
      const out = exportHtml(root, args[0] ?? path.join(root, modelDir(root), '.cache', 'architecture.html'), flags.github === true);
      console.log(`Wrote ${out}`);
      return;
    }
    case 'sync-rules': {
      const r = syncRules(root, { dryRun: flags.check === true });
      if (flags.check) {
        if (r.stale.length === 0) return void console.log('Rule files match the model.');
        console.log(`Rule files are out of date. Run "armature sync-rules" and commit:\n${r.stale.map((f) => `  ${f}`).join('\n')}`);
        process.exit(1);
      }
      console.log(`Rule files: ${r.written} written, ${r.removed} removed (.claude/rules/armature-*.md).`);
      return;
    }
    case 'install': {
      const lines = flags.team
        ? installTeam(root, { marketplace: typeof flags.marketplace === 'string' ? flags.marketplace : undefined, ref: typeof flags.ref === 'string' ? flags.ref : undefined, ci: flags['no-ci'] !== true })
        : install(root);
      for (const line of lines) console.log(line);
      return;
    }
    default:
      fail(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

function fail(msg: string): void {
  console.error(msg);
  process.exit(2);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
