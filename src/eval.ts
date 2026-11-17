// Two ways to measure whether the tooling helps.
// Retrieval: replay past commits as tasks and check whether the context pack finds the files that commit changed. Free.
// Agent: run real coding sessions with and without the tooling and compare tokens, tool calls and test results. Costs money.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { words, type CodeIndex } from './code.js';
import { modelDir } from './paths.js';
import { contextPack, FileSearch } from './context.js';
import { readHistory, MAX_FILES_PER_COMMIT } from './history.js';
import { parseConventional } from './repo.js';
import type { Graph } from './types.js';

// ---- retrieval -------------------------------------------------------------------

export interface RetrievalTask {
  hash: string;
  task: string;
  truth: string[];
}

type Variant = 'grep' | 'bm25' | 'bm25+nodes' | 'bm25+nodes+graph' | 'full';
const VARIANTS: Variant[] = ['grep', 'bm25', 'bm25+nodes', 'bm25+nodes+graph', 'full'];

/** Past commits with a descriptive Conventional Commits subject that changed 1 to 15 indexed source files. */
export function retrievalTasks(root: string, idx: CodeIndex, limit: number, skip = 0): RetrievalTask[] {
  const h = readHistory(root);
  if (!h) return [];
  const out: RetrievalTask[] = [];
  for (const c of h.commits) {
    const cc = parseConventional(c.subject);
    if (!cc.conventional || !['feat', 'fix', 'refactor', 'perf'].includes(cc.type)) continue;
    if (c.files.length > MAX_FILES_PER_COMMIT) continue;
    const truth = c.files.filter((f) => idx.files[f] && !idx.files[f].test && idx.files[f].lang !== 'sql');
    if (truth.length < 1 || truth.length > 15) continue;
    if (words(cc.description).length < 3) continue;
    if (skip > 0) {
      skip--;
      continue;
    }
    out.push({ hash: c.hash, task: `${cc.scope ? `${cc.scope}: ` : ''}${cc.description}`, truth });
    if (out.length >= limit) break;
  }
  return out;
}

/** What a plain text search would find: files ranked by how often the task's words occur in them. */
function grepRank(idx: CodeIndex, task: string): string[] {
  const q = [...new Set(words(task))];
  return Object.values(idx.files)
    .filter((f) => !f.test)
    .map((f) => ({ p: f.path, s: q.reduce((n, w) => n + (f.terms?.[w] ? 1 + Math.log(1 + f.terms[w]) : 0), 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);
}

export interface RetrievalReport {
  tasks: number;
  k: number[];
  variants: Record<string, { recall: Record<number, number>; hit: Record<number, number>; mrr: number }>;
  examples: Array<{ task: string; truth: string[]; found: string[] }>;
}

export function evalRetrieval(g: Graph, idx: CodeIndex, root: string, limit = 60, skip = 0): RetrievalReport {
  const tasks = retrievalTasks(root, idx, limit, skip);
  const ks = [5, 10, 20];
  const h = readHistory(root);
  const search = new FileSearch(idx, {});
  const res: RetrievalReport['variants'] = {};
  const examples: RetrievalReport['examples'] = [];
  for (const v of VARIANTS) {
    const recall: Record<number, number> = Object.fromEntries(ks.map((k) => [k, 0]));
    const hit: Record<number, number> = Object.fromEntries(ks.map((k) => [k, 0]));
    let mrr = 0;
    for (const t of tasks) {
      let ranked: string[];
      if (v === 'grep') ranked = grepRank(idx, t.task);
      else if (v === 'bm25') ranked = search.rank(t.task, (f) => !f.test).map((r) => r.path);
      else {
        const use = { nodes: true, graph: v !== 'bm25+nodes', cochange: v === 'full' };
        // The commit itself must not count as co-change evidence for its own files.
        ranked = contextPack(g, idx, root, t.task, { budget: 100000, history: h, skipCommits: new Set([t.hash]), summaries: {}, use }).files.filter((f) => !idx.files[f.path]?.test).map((f) => f.path);
      }
      for (const k of ks) {
        const top = new Set(ranked.slice(0, k));
        const found = t.truth.filter((f) => top.has(f)).length;
        recall[k] += found / t.truth.length;
        if (found) hit[k]++;
      }
      const first = ranked.findIndex((f) => t.truth.includes(f));
      if (first >= 0) mrr += 1 / (first + 1);
      if (v === 'full' && examples.length < 5) examples.push({ task: t.task, truth: t.truth.slice(0, 4), found: ranked.slice(0, 5) });
    }
    const n = Math.max(1, tasks.length);
    res[v] = { recall: Object.fromEntries(ks.map((k) => [k, recall[k] / n])), hit: Object.fromEntries(ks.map((k) => [k, hit[k] / n])), mrr: mrr / n };
  }
  return { tasks: tasks.length, k: ks, variants: res, examples };
}

export function retrievalText(r: RetrievalReport): string {
  const pct = (x: number): string => `${Math.round(x * 100)}%`.padStart(5);
  const out = [`Retrieval on ${r.tasks} past commits: the task is the commit subject, the answer is the source files it changed.`, ''];
  out.push(`${'ranking'.padEnd(20)} ${r.k.map((k) => `recall@${k}`.padStart(10)).join('')} ${r.k.map((k) => `hit@${k}`.padStart(8)).join('')}   MRR`);
  for (const [v, m] of Object.entries(r.variants)) {
    out.push(`${v.padEnd(20)} ${r.k.map((k) => pct(m.recall[k]).padStart(10)).join('')} ${r.k.map((k) => pct(m.hit[k]).padStart(8)).join('')}  ${m.mrr.toFixed(2)}`);
  }
  out.push('', 'recall@k: share of the changed files found in the top k. hit@k: share of tasks with at least one changed file in the top k.');
  out.push('grep is plain word counting, as an agent searching would do. bm25 weighs rare words, names and paths. nodes adds the model; graph adds the import graph; full adds co-change history (with the commit itself left out).');
  out.push('Caveat: the index is of today\'s code, which already contains each change, so all rankings are somewhat optimistic.');
  return out.join('\n');
}

// ---- live agent sessions -----------------------------------------------------------

export interface AgentTask {
  id: string;
  prompt: string;
  /** A shell command run in the copy afterwards; exit 0 counts as success. */
  check?: string;
  maxTurns?: number;
}

export interface AgentRun {
  task: string;
  variant: 'bare' | 'armature';
  ok: boolean | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  tools: Record<string, number>;
  filesRead: number;
  seconds: number;
  error?: string;
}

function claudeBin(): string | null {
  const env = process.env.ARMATURE_CLAUDE_BIN;
  if (env) return env;
  for (const p of [path.join(os.homedir(), '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (fs.existsSync(p)) return p;
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** Copies the repo into a scratch folder (a local clone, so the original is never touched), with or without the tooling. */
function prepare(root: string, variant: AgentRun['variant'], cliBin: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `armature-eval-${variant}-`));
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', root, dir], { stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['checkout', '--quiet', head], { cwd: dir, stdio: 'ignore' });
  if (variant === 'armature') {
    // The model may be uncommitted; copy it over, then wire Claude Code in the copy only.
    fs.cpSync(path.join(root, modelDir(root)), path.join(dir, modelDir(root)), { recursive: true, filter: (src) => !src.includes(`${path.sep}.cache`) });
    execFileSync('node', [cliBin, 'install', '--root', dir], { stdio: 'ignore' });
  } else {
    fs.rmSync(path.join(dir, modelDir(root)), { recursive: true, force: true });
  }
  return dir;
}

function runClaude(bin: string, cwd: string, task: AgentTask): Promise<Omit<AgentRun, 'task' | 'variant' | 'ok'>> {
  const started = Date.now();
  const extra = (process.env.ARMATURE_CLAUDE_ARGS ?? '').split(' ').filter(Boolean);
  const args = ['-p', task.prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(task.maxTurns ?? 40), '--permission-mode', 'acceptEdits', ...extra];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const tools: Record<string, number> = {};
    const read = new Set<string>();
    const res = { turns: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, tools, filesRead: 0, seconds: 0 } as Omit<AgentRun, 'task' | 'variant' | 'ok'>;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content ?? []) {
            if (c.type !== 'tool_use') continue;
            tools[c.name] = (tools[c.name] ?? 0) + 1;
            if (c.name === 'Read' && c.input?.file_path) read.add(c.input.file_path);
          }
        }
        if (ev.type === 'result') {
          const u = ev.usage ?? {};
          res.turns = ev.num_turns ?? 0;
          res.inputTokens = u.input_tokens ?? 0;
          res.outputTokens = u.output_tokens ?? 0;
          res.cacheRead = u.cache_read_input_tokens ?? 0;
          res.cacheWrite = u.cache_creation_input_tokens ?? 0;
          res.costUsd = ev.total_cost_usd ?? 0;
          if (ev.is_error) res.error = String(ev.result ?? 'error').slice(0, 300);
        }
      }
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      res.filesRead = read.size;
      res.seconds = Math.round((Date.now() - started) / 1000);
      if (code !== 0 && !res.error) res.error = `exit ${code}: ${err.slice(0, 300)}`;
      resolve(res);
    });
  });
}

export async function evalAgent(root: string, tasksFile: string, cliBin: string, log: (s: string) => void): Promise<AgentRun[]> {
  const bin = claudeBin();
  if (!bin) throw new Error('The claude CLI was not found. Install Claude Code, or point ARMATURE_CLAUDE_BIN at it.');
  const tasks = (YAML.parse(fs.readFileSync(tasksFile, 'utf8')) ?? []) as AgentTask[];
  const runs: AgentRun[] = [];
  for (const t of tasks) {
    for (const variant of ['bare', 'armature'] as const) {
      log(`${t.id} (${variant})…`);
      const dir = prepare(root, variant, cliBin);
      try {
        const r = await runClaude(bin, dir, t);
        let ok: boolean | null = null;
        if (t.check) {
          try {
            execFileSync('sh', ['-c', t.check], { cwd: dir, stdio: 'ignore', timeout: 15 * 60 * 1000 });
            ok = true;
          } catch {
            ok = false;
          }
        }
        runs.push({ task: t.id, variant, ok, ...r });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  const out = path.join(root, modelDir(root), '.cache', 'eval');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `agent-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(runs, null, 2));
  return runs;
}

export function agentText(runs: AgentRun[]): string {
  const out = [`${'task'.padEnd(24)} ${'variant'.padEnd(7)} ${'ok'.padStart(4)} ${'turns'.padStart(6)} ${'tokens in'.padStart(10)} ${'cache read'.padStart(11)} ${'out'.padStart(7)} ${'cost $'.padStart(8)} ${'reads'.padStart(6)} ${'tools'.padStart(6)}`];
  for (const r of runs) {
    const tools = Object.values(r.tools).reduce((a, b) => a + b, 0);
    out.push(`${r.task.slice(0, 24).padEnd(24)} ${r.variant.padEnd(7)} ${(r.ok === null ? '-' : r.ok ? 'yes' : 'no').padStart(4)} ${String(r.turns).padStart(6)} ${String(r.inputTokens).padStart(10)} ${String(r.cacheRead).padStart(11)} ${String(r.outputTokens).padStart(7)} ${r.costUsd.toFixed(2).padStart(8)} ${String(r.filesRead).padStart(6)} ${String(tools).padStart(6)}${r.error ? `  ${r.error.slice(0, 60)}` : ''}`);
  }
  const sum = (v: AgentRun['variant'], k: 'costUsd' | 'turns' | 'filesRead') => runs.filter((r) => r.variant === v).reduce((n, r) => n + r[k], 0);
  out.push('', `totals: bare $${sum('bare', 'costUsd').toFixed(2)}, ${sum('bare', 'turns')} turns, ${sum('bare', 'filesRead')} files read; armature $${sum('armature', 'costUsd').toFixed(2)}, ${sum('armature', 'turns')} turns, ${sum('armature', 'filesRead')} files read.`);
  out.push('One run per task and variant is noisy; repeat tasks before drawing conclusions.');
  return out.join('\n');
}
