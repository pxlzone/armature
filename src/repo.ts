// Facts read from the repository: file list, git state, source hashes, test and coverage reports.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { XMLParser } from 'fast-xml-parser';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage', '.venv', '__pycache__']);

export function git(root: string, args: string[]): string | null {
  try {
    // Without quotePath=false git prints non-ASCII paths quoted and escaped, and they match no file.
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function walk(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, rel, out);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
}

export interface RepoInfo {
  files: string[];
  hasGit: boolean;
  hasRemote: boolean;
  branch?: string;
}

export function readRepo(root: string): RepoInfo {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside && inside.trim() === 'true') {
    const listed = git(root, ['ls-files', '-co', '--exclude-standard']);
    if (listed !== null) {
      const files = listed.split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
      const remotes = git(root, ['remote']) ?? '';
      const branch = (git(root, ['branch', '--show-current']) ?? '').trim() || undefined;
      return { files, hasGit: true, hasRemote: remotes.trim().length > 0, branch };
    }
  }
  const files: string[] = [];
  walk(root, '', files);
  return { files, hasGit: false, hasRemote: false };
}

export function changedFiles(root: string): string[] {
  const out = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (out === null) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).split(' -> ').pop() as string)
    .map((f) => f.replace(/^"|"$/g, ''));
}

export function matcher(globs: string[]): (file: string) => boolean {
  if (globs.length === 0) return () => false;
  const pos = globs.filter((g) => !g.startsWith('!'));
  const neg = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  const isMatch = picomatch(pos, { dot: true, ignore: neg });
  return (file: string) => isMatch(file);
}

export function expand(root: string, files: string[], globs: string[]): string[] {
  const m = matcher(globs);
  const hits = files.filter(m);
  // Reports are often gitignored, so also try the globs as literal paths.
  for (const g of globs) {
    if (!/[*?[{]/.test(g) && fs.existsSync(path.join(root, g)) && !hits.includes(g)) hits.push(g);
  }
  return hits;
}

/** Hash of the text a `file#symbol` pointer refers to. Null when the file is missing. */
export function sourceHash(root: string, source: string): { hash: string | null; found: boolean; symbolFound: boolean } {
  const [file, symbol] = source.split('#');
  const abs = path.join(root, file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { hash: null, found: false, symbolFound: false };
  const text = fs.readFileSync(abs, 'utf8');
  let region = text;
  let symbolFound = !symbol;
  if (symbol) {
    const lines = text.split('\n');
    const word = new RegExp(`(^|[^A-Za-z0-9_])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`);
    const decl = /^\s*(export\s|const\s|let\s|type\s|interface\s|class\s|enum\s|function\s|def\s|create\s+table|model\s|message\s)/i;
    let start = lines.findIndex((l) => word.test(l) && decl.test(l));
    if (start < 0) start = lines.findIndex((l) => word.test(l));
    if (start >= 0) {
      symbolFound = true;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^(export\s|const\s|type\s|interface\s|class\s|enum\s|function\s|def\s|create\s|model\s|message\s)/i.test(lines[i])) {
          end = i;
          break;
        }
      }
      region = lines.slice(start, end).join('\n').trim();
    }
  }
  return { hash: createHash('sha256').update(region).digest('hex').slice(0, 16), found: true, symbolFound };
}

export interface TestCase {
  name: string;
  file: string;
  state: 'passed' | 'failed' | 'skipped';
  /** When the report holding this case was written (ms). */
  at?: number;
}

function arr<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function relFile(root: string, f: string): string {
  if (!f) return '';
  let p = f.replace(/\\/g, '/');
  if (path.isAbsolute(p)) p = path.relative(root, p).replace(/\\/g, '/');
  return p.replace(/^\.\//, '');
}

export function readJunit(root: string, file: string): TestCase[] {
  const xml = fs.readFileSync(path.join(root, file), 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
  const doc = parser.parse(xml);
  const out: TestCase[] = [];
  const visit = (suite: any, inherited: string, trail: string[]): void => {
    if (!suite || typeof suite !== 'object') return;
    const sname = String(suite['@name'] ?? '');
    const sfile = suite['@file'] ?? suite['@filepath'] ?? (/\.[a-z]{1,4}$/i.test(sname) ? sname : inherited);
    const nextTrail = sname && sname !== sfile ? [...trail, sname] : trail;
    for (const c of arr<any>(suite.testcase)) {
      const cls = String(c['@classname'] ?? '');
      const f = c['@file'] ?? (/[/\\].*\.[a-z]{1,4}$/i.test(cls) ? cls : sfile);
      const state: TestCase['state'] = c.failure !== undefined || c.error !== undefined ? 'failed' : c.skipped !== undefined ? 'skipped' : 'passed';
      const label = [...nextTrail, String(c['@name'] ?? '')].filter(Boolean).join(' > ');
      out.push({ name: label, file: relFile(root, String(f ?? '')), state });
    }
    for (const s of arr<any>(suite.testsuite)) visit(s, String(sfile ?? ''), nextTrail);
  };
  const rootEl = doc.testsuites ?? doc;
  for (const s of arr<any>(rootEl.testsuite)) visit(s, '', []);
  if (rootEl.testcase) visit(rootEl, '', []);
  return out;
}

export interface FileCoverage {
  file: string;
  found: number;
  hit: number;
}

export function readLcov(root: string, file: string): FileCoverage[] {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const out: FileCoverage[] = [];
  let cur: FileCoverage | null = null;
  let da = { found: 0, hit: 0 };
  let explicit = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      cur = { file: relFile(root, line.slice(3)), found: 0, hit: 0 };
      da = { found: 0, hit: 0 };
      explicit = false;
    } else if (!cur) {
      continue;
    } else if (line.startsWith('DA:')) {
      da.found++;
      if (Number(line.slice(3).split(',')[1]) > 0) da.hit++;
    } else if (line.startsWith('LF:')) {
      cur.found = Number(line.slice(3));
      explicit = true;
    } else if (line.startsWith('LH:')) {
      cur.hit = Number(line.slice(3));
    } else if (line === 'end_of_record') {
      if (!explicit) {
        cur.found = da.found;
        cur.hit = da.hit;
      }
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

export interface Conventional {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
  conventional: boolean;
}

/** Reads a subject line as a Conventional Commit: type(scope)!: description. */
export function parseConventional(subject: string): Conventional {
  const clean = subject.replace(/\s*\(#\d+\)\s*$/, '').trim();
  const m = clean.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/);
  if (!m) return { type: 'other', breaking: false, description: clean, conventional: false };
  return { type: m[1].toLowerCase(), scope: m[2]?.trim().toLowerCase(), breaking: m[3] === '!', description: m[4], conventional: true };
}

export interface CommitInfo {
  hash: string;
  date: string;
  author: string;
  subject: string;
  files: string[];
}

/** Non-merge commits of the last `days` days on the current branch, newest first, with the paths each changed. */
export function readCommits(root: string, days: number, max = 1500): CommitInfo[] {
  const out = git(root, ['log', `--since=${days}.days`, '--no-merges', `--max-count=${max}`, '--name-only', '--format=%x1e%h%x1f%aI%x1f%an%x1f%s']);
  if (!out) return [];
  const commits: CommitInfo[] = [];
  for (const block of out.split('\x1e')) {
    if (!block.trim()) continue;
    const [head, ...rest] = block.split('\n');
    const [hash, date, author, subject] = head.split('\x1f');
    if (!hash || !subject) continue;
    commits.push({ hash, date, author, subject, files: rest.map((l) => l.trim()).filter(Boolean) });
  }
  return commits;
}

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  branch: string;
  files: string[];
  state: 'open' | 'merged' | 'closed';
  date: string;
  author: string;
}

/** Recent pull requests, any state, with their changed paths. Cached for ten minutes under armature/.cache. */
export function readPullRequests(root: string, cacheDir: string): PrInfo[] {
  const cacheFile = path.join(cacheDir, 'prs.json');
  try {
    const st = fs.statSync(cacheFile);
    if (Date.now() - st.mtimeMs < 10 * 60 * 1000) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    /* no cache */
  }
  let prs: PrInfo[] = [];
  try {
    const out = execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', '150', '--json', 'number,title,url,headRefName,state,createdAt,mergedAt,author,files'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 45000,
      maxBuffer: 64 * 1024 * 1024,
    });
    prs = (JSON.parse(out) as any[]).map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      branch: p.headRefName,
      files: (p.files ?? []).map((f: any) => f.path),
      state: p.state === 'MERGED' ? 'merged' : p.state === 'OPEN' ? 'open' : 'closed',
      date: p.mergedAt ?? p.createdAt,
      author: p.author?.login ?? '',
    }));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(prs));
  } catch {
    prs = [];
  }
  return prs;
}
