// A baseline of the warnings a repo has today, so a check can fail on new ones without first
// clearing the old ones. Warnings never block by themselves; with a baseline, "armature check
// --new --fail-on wrong" stops the model from getting worse.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCodeIndex } from './code.js';
import { compile } from './compile.js';
import YAML from 'yaml';
import { MODEL_DIR } from './paths.js';
import type { Graph, Problem } from './types.js';

export const BASELINE_FILE = 'baseline.json';

/** What makes two warnings the same one: the code and what it is about. The message is left out, because it carries counts. */
const keyOf = (p: Problem): string => `${p.code}|${p.ref ?? ''}|${p.file ?? ''}`;

export function readBaseline(root: string): Record<string, number> | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, MODEL_DIR, BASELINE_FILE), 'utf8'));
    return data && typeof data.warnings === 'object' ? data.warnings : null;
  } catch {
    return null;
  }
}

/** Records today's warnings. Returns how many. */
export function writeBaseline(root: string, problems: Problem[]): number {
  const warnings: Record<string, number> = {};
  for (const p of problems) if (p.level === 'warning') warnings[keyOf(p)] = (warnings[keyOf(p)] ?? 0) + 1;
  const sorted = Object.fromEntries(Object.entries(warnings).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(root, MODEL_DIR, BASELINE_FILE), `${JSON.stringify({ written: new Date().toISOString().slice(0, 10), warnings: sorted }, null, 2)}\n`);
  return Object.values(warnings).reduce((a, b) => a + b, 0);
}

/** Errors, and the warnings the baseline does not already hold. */
export function newSince(problems: Problem[], baseline: Record<string, number>): Problem[] {
  const left = { ...baseline };
  return problems.filter((p) => {
    if (p.level !== 'warning') return true;
    const k = keyOf(p);
    if ((left[k] ?? 0) > 0) {
      left[k]--;
      return false;
    }
    return true;
  });
}

/**
 * Errors, and the warnings that were not there in `then`. A warning that sums up several things
 * (undeclared routes of a node, requirements with no test) is new again when it lists something
 * it did not list before, and then says only what was added.
 */
export function newSinceRun(now: Problem[], then: Problem[]): Problem[] {
  const left = new Map<string, Problem[]>();
  for (const p of then) if (p.level === 'warning') left.set(keyOf(p), [...(left.get(keyOf(p)) ?? []), p]);
  const out: Problem[] = [];
  for (const p of now) {
    const old = p.level === 'warning' ? left.get(keyOf(p))?.shift() : undefined;
    if (!old) out.push(p);
    else if (p.items) {
      const had = new Set(old.items ?? []);
      const fresh = p.items.filter((x) => !had.has(x));
      if (fresh.length) out.push({ ...p, items: fresh, message: `${p.message} New here: ${fresh.slice(0, 8).join(', ')}${fresh.length > 8 ? `, … (${fresh.length} in all)` : ''}.` });
    }
  }
  return out;
}

/**
 * What the check said at a git ref: the whole repo as it was, checked out beside this one, indexed
 * and compiled the same way. Null when that commit has no model; a string when the ref cannot be read.
 * Test reports under the cache folder are copied across, so both sides read the same ones.
 */
export async function problemsAt(root: string, ref: string): Promise<Problem[] | null | string> {
  const run = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let commit: string;
  let prefix: string;
  try {
    commit = run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    prefix = run(['rev-parse', '--show-prefix']);
  } catch {
    return `"${ref}" is not a commit, branch or tag in this repo.`;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-since-'));
  const tree = path.join(dir, 'tree');
  try {
    run(['worktree', 'add', '--detach', '--force', tree, commit]);
    const there = path.join(tree, prefix);
    if (!fs.existsSync(path.join(there, MODEL_DIR, 'system.yaml'))) return null;
    // Test reports are not committed. With the same ones on both sides, what a report says (a title
    // no test has, a pass older than the code) is compared like with like, not counted as new.
    const reports = path.join(root, MODEL_DIR, '.cache', 'reports');
    if (fs.existsSync(reports)) fs.cpSync(reports, path.join(there, MODEL_DIR, '.cache', 'reports'), { recursive: true, preserveTimestamps: true });
    await buildCodeIndex(there).catch(() => undefined);
    const g: Graph = compile(there);
    return g.problems;
  } catch (e: any) {
    return `Cannot check out "${ref}" to compare with: ${String(e?.message ?? e).split('\n')[0]}`;
  } finally {
    try {
      run(['worktree', 'remove', '--force', tree]);
    } catch {
      /* never added */
    }
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      run(['worktree', 'prune']);
    } catch {
      /* not a repo */
    }
  }
}

/** Removes the entries at these positions from `accept:` in system.yaml, keeping comments. Returns how many went. */
export function pruneAccepts(root: string, positions: number[]): number {
  if (!positions.length) return 0;
  const file = path.join(root, MODEL_DIR, 'system.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const list = doc.get('accept');
  if (!YAML.isSeq(list)) return 0;
  let gone = 0;
  for (const i of [...new Set(positions)].sort((a, b) => b - a)) {
    if (i < 0 || i >= list.items.length) continue;
    list.items.splice(i, 1);
    gone++;
  }
  if (list.items.length === 0) doc.delete('accept');
  if (gone) fs.writeFileSync(file, doc.toString());
  return gone;
}
