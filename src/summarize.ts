// One-line summaries of source files, written by a model through the claude CLI and cached by
// content hash, so a file is summarised again only when it changes. Opt-in: it costs money and
// sends code to the model provider.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodeIndex } from './code.js';
import { MODEL_DIR } from './paths.js';
import { readSummaries } from './context.js';

const BATCH = 15;

function claudeBin(): string | null {
  const env = process.env.ARMATURE_CLAUDE_BIN;
  if (env) return env;
  for (const p of [path.join(os.homedir(), '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (fs.existsSync(p)) return p;
  const r = spawnSync('which', ['claude'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export interface SummarizePlan {
  files: string[];
  batches: number;
  cached: number;
}

/** Which files would be summarised: not tests, not tiny, not already summarised at their current content. */
export function planSummaries(root: string, idx: CodeIndex, only?: (f: string) => boolean, limit = 400): SummarizePlan {
  const have = readSummaries(root);
  const todo = Object.values(idx.files)
    .filter((f) => !f.test && f.lang !== 'sql' && f.lines >= 15 && (!only || only(f.path)))
    .filter((f) => have[f.path]?.hash !== f.hash)
    .sort((a, b) => b.symbols.length - a.symbols.length)
    .slice(0, limit)
    .map((f) => f.path);
  return { files: todo, batches: Math.ceil(todo.length / BATCH), cached: Object.keys(have).length };
}

export function summarize(root: string, idx: CodeIndex, plan: SummarizePlan, log: (s: string) => void): number {
  const bin = claudeBin();
  if (!bin) throw new Error('The claude CLI was not found. Install Claude Code, or point ARMATURE_CLAUDE_BIN at it.');
  const store = readSummaries(root);
  const file = path.join(root, MODEL_DIR, '.cache', 'summaries.json');
  let done = 0;
  for (let i = 0; i < plan.files.length; i += BATCH) {
    const batch = plan.files.slice(i, i + BATCH);
    const parts = batch.map((p) => {
      const f = idx.files[p];
      const head = fs.readFileSync(path.join(root, p), 'utf8').split('\n').slice(0, 80).join('\n');
      const sigs = f.symbols.filter((s) => s.exported).slice(0, 15).map((s) => s.sig).join('\n');
      return `=== ${p}\nExported:\n${sigs}\nStart of file:\n${head}`;
    });
    const prompt = `For each file below, write one sentence (at most 20 words) saying what it does and why it exists, for a developer deciding whether to open it. Answer with only a JSON object mapping each file path to its sentence.\n\n${parts.join('\n\n')}`;
    const r = spawnSync(bin, ['-p', '--output-format', 'json', '--model', process.env.ARMATURE_SUMMARY_MODEL ?? 'haiku'], { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 });
    if (r.status !== 0) {
      log(`batch ${i / BATCH + 1}: the claude CLI failed (${(r.stderr || '').slice(0, 200)})`);
      continue;
    }
    let text = '';
    try {
      text = JSON.parse(r.stdout).result ?? r.stdout;
    } catch {
      text = r.stdout;
    }
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    let map: Record<string, string> = {};
    try {
      map = json ? JSON.parse(json) : {};
    } catch {
      log(`batch ${i / BATCH + 1}: could not read the answer`);
      continue;
    }
    for (const p of batch) {
      const s = map[p];
      if (typeof s === 'string' && s.trim()) {
        store[p] = { hash: idx.files[p].hash, text: s.trim().slice(0, 240) };
        done++;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store));
    log(`batch ${i / BATCH + 1} of ${plan.batches}: ${done} summaries so far`);
  }
  return done;
}
