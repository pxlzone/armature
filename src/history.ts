// Change history from git: which files change together, which change most, and the recent intent.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_DIR } from './paths.js';
import { parseConventional } from './repo.js';

export interface HistoryCommit {
  hash: string;
  date: string;
  subject: string;
  files: string[];
}

export interface FileHistory {
  changes: number;
  last: string;
  subjects: string[];
}

export interface History {
  head: string;
  commits: HistoryCommit[];
  files: Record<string, FileHistory>;
}

const MAX_COMMITS = 2000;
/** Commits touching more files than this are bulk edits (formatting, renames); they say nothing about coupling. */
export const MAX_FILES_PER_COMMIT = 30;

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Reads (and caches by HEAD) the last commits with the files each one changed. */
export function readHistory(root: string): History | null {
  const head = git(root, ['rev-parse', 'HEAD'])?.trim();
  if (!head) return null;
  const cache = path.join(root, MODEL_DIR, '.cache', 'history.json');
  try {
    const h = JSON.parse(fs.readFileSync(cache, 'utf8')) as History;
    if (h.head === head) return h;
  } catch {
    /* rebuild */
  }
  const out = git(root, ['log', '--no-merges', `--max-count=${MAX_COMMITS}`, '--name-only', '--format=%x1e%h%x1f%aI%x1f%s']);
  if (out === null) return null;
  const commits: HistoryCommit[] = [];
  for (const block of out.split('\x1e')) {
    if (!block.trim()) continue;
    const [first, ...rest] = block.split('\n');
    const [hash, date, subject] = first.split('\x1f');
    if (!hash) continue;
    commits.push({ hash, date, subject, files: rest.map((l) => l.trim()).filter(Boolean) });
  }
  const files: Record<string, FileHistory> = {};
  for (const c of commits) {
    for (const f of c.files) {
      const h = (files[f] ??= { changes: 0, last: c.date, subjects: [] });
      h.changes++;
      if (h.subjects.length < 3) h.subjects.push(parseConventional(c.subject).conventional ? c.subject : c.subject.slice(0, 120));
    }
  }
  const h: History = { head, commits, files };
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(h));
  return h;
}

/**
 * Files that change together with a file: for each partner, how many commits touched both and the share
 * of the file's commits that also touched the partner. `skip` leaves out commits (used by the evaluation).
 */
export function coChange(h: History, file: string, keep: (f: string) => boolean, skip?: Set<string>, limit = 6): Array<{ path: string; n: number; share: number }> {
  let own = 0;
  const pairs = new Map<string, number>();
  for (const c of h.commits) {
    if (skip?.has(c.hash) || c.files.length > MAX_FILES_PER_COMMIT || !c.files.includes(file)) continue;
    own++;
    for (const f of c.files) if (f !== file && keep(f)) pairs.set(f, (pairs.get(f) ?? 0) + 1);
  }
  return [...pairs]
    .filter(([, n]) => n >= 2)
    .map(([p, n]) => ({ path: p, n, share: n / Math.max(1, own) }))
    .sort((a, b) => b.share - a.share || b.n - a.n)
    .slice(0, limit);
}

/** Files that change often and are big: where bugs and merge conflicts tend to collect. */
export function hotspots(h: History, lines: (f: string) => number | undefined, limit = 20): Array<{ path: string; changes: number; lines: number; score: number }> {
  return Object.entries(h.files)
    .map(([p, v]) => ({ path: p, changes: v.changes, lines: lines(p) ?? 0 }))
    .filter((x) => x.lines > 0)
    .map((x) => ({ ...x, score: x.changes * Math.log2(2 + x.lines) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
