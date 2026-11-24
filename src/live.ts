// What agent sessions are doing right now, for the viewer. The hooks append one line per step to
// armature/.cache/live.jsonl; the viewer server reads the file back as sessions and the parts they touch.
// The file is local and never committed. It holds file paths, the first words of a prompt and the
// name of a command, never a whole command: a command line can carry a secret.
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_DIR } from './paths.js';
import { ownerOf } from './render.js';
import { git } from './repo.js';
import type { Graph, Live, LiveFile, LiveKind, LiveSession, LiveStep } from './types.js';

export type { Live, LiveFile, LiveKind, LiveSession, LiveStep };

/** One line of the log. Keep in step with the "note" hook in bin/armature.mjs, which writes `read` lines itself. */
export interface LiveEvent {
  t: number;
  s: string;
  k: LiveKind;
  file?: string;
  text?: string;
}

export const LIVE_FILE = 'live.jsonl';
const MAX_BYTES = 256 * 1024;
/** A session that has been silent this long is no longer shown. */
const SHOWN_FOR = 30 * 60 * 1000;
/** A turn with no step for this long is taken to have ended without saying so. */
const STALLED_AFTER = 15 * 60 * 1000;
/** Steps older than this are not counted. */
const COUNTED_FOR = 12 * 60 * 60 * 1000;
const STEPS = 24;

export const liveFile = (root: string): string => path.join(root, MODEL_DIR, '.cache', LIVE_FILE);

const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** The program a command runs and its first argument: "npm test", "git status". Enough to say what is running, and no more. */
export function commandName(command: string): string {
  const words = command.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const safe = (w: string | undefined): string => (w && /^[\w./:@-]{1,40}$/.test(w) ? w : '');
  const program = safe(words[0]?.split('/').pop());
  const arg = words[1]?.startsWith('-') ? '' : safe(words[1]);
  return [program, arg].filter(Boolean).join(' ');
}

/** Records one step of a session. Never throws: a log that cannot be written must not stop a hook. */
export function noteLive(root: string, session: unknown, kind: LiveKind, more: { file?: string; text?: string } = {}): void {
  const s = typeof session === 'string' ? session : '';
  if (!s) return;
  try {
    const file = liveFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ev: LiveEvent = { t: Date.now(), s, k: kind };
    if (more.file) ev.file = more.file;
    if (more.text) ev.text = clip(more.text, 140);
    // Past its size, the older half goes.
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* first line */
    }
    if (size > MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
    }
    fs.appendFileSync(file, `${JSON.stringify(ev)}\n`);
  } catch {
    /* best effort */
  }
}

function readEvents(root: string): LiveEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(liveFile(root), 'utf8');
  } catch {
    return [];
  }
  const out: LiveEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as LiveEvent;
      if (typeof e.t === 'number' && typeof e.s === 'string' && typeof e.k === 'string') out.push(e);
    } catch {
      /* a line cut short by two hooks writing at once */
    }
  }
  return out;
}

const inside = (id: string, anc: string): boolean => id === anc || id.startsWith(`${anc}.`);

/** The sessions seen lately, the busiest first, with the parts of the model they touched. */
export function readLive(root: string, g: Graph, now = Date.now(), opts: { changes?: boolean } = {}): Live {
  const bySession = new Map<string, LiveEvent[]>();
  for (const e of readEvents(root)) {
    if (now - e.t > COUNTED_FOR) continue;
    bySession.set(e.s, [...(bySession.get(e.s) ?? []), e]);
  }
  const sessions: LiveSession[] = [];
  for (const [id, events] of bySession) {
    events.sort((a, b) => a.t - b.t);
    const last = events[events.length - 1];
    if (now - last.t > SHOWN_FOR) continue;
    const nodes = new Map<string, { id: string; edits: number; reads: number; files: LiveFile[]; lastAt: string; seq: number }>();
    const steps: LiveStep[] = [];
    let prompt: string | undefined;
    for (const e of events) {
      const at = new Date(e.t).toISOString();
      const step: LiveStep = { at, kind: e.k };
      if (e.text) step.text = e.text;
      if (e.k === 'prompt') prompt = e.text;
      if (e.file) {
        const rel = path.relative(root, path.resolve(root, e.file)).replace(/\\/g, '/');
        // A file outside the repo says nothing about the model, and its path is not ours to show.
        if (rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith(`${MODEL_DIR}/.cache/`)) continue;
        step.file = rel;
        const owner = ownerOf(g, rel);
        if (owner) {
          step.node = owner.id;
          const n = nodes.get(owner.id) ?? { id: owner.id, edits: 0, reads: 0, files: [], lastAt: at, seq: 0 };
          if (e.k === 'edited') n.edits++;
          else if (e.k === 'read') n.reads++;
          let f = n.files.find((x) => x.path === rel);
          if (!f) n.files.push((f = { path: rel, edits: 0 }));
          if (e.k === 'edited') f.edits++;
          n.lastAt = at;
          n.seq = steps.length;
          nodes.set(owner.id, n);
        }
      }
      steps.push(step);
    }
    // Edited parts first, then the latest touched: several steps can share one millisecond, so the order of the log decides.
    const touched = [...nodes.values()].sort((a, b) => Number(b.edits > 0) - Number(a.edits > 0) || b.seq - a.seq);
    const edited = touched.filter((n) => n.edits > 0).map((n) => n.id);
    const working = last.k !== 'stop' && now - last.t < STALLED_AFTER;
    // "edited" follows "editing" for the same file: the step to show is the latest that names a file or a command.
    const current = [...steps].reverse().find((s) => s.file || s.kind === 'run');
    sessions.push({
      id,
      startedAt: new Date(events[0].t).toISOString(),
      lastAt: new Date(last.t).toISOString(),
      working,
      prompt,
      now: current,
      part: [...steps].reverse().find((s) => s.node)?.node,
      // Edited files first, the latest last touched first; a part that was only read keeps a few of its files.
      nodes: touched.map(({ seq: _seq, ...n }) => ({ ...n, files: [...n.files].reverse().sort((a, b) => Number(b.edits > 0) - Number(a.edits > 0)).slice(0, 12) })),
      changes: g.changes.filter((c) => c.state !== 'done' && c.state !== 'dropped' && c.nodes.some((x) => edited.some((y) => inside(x, y) || inside(y, x)))).map((c) => c.id),
      steps: steps.slice(-STEPS).reverse(),
    });
  }
  sessions.sort((a, b) => Number(b.working) - Number(a.working) || b.lastAt.localeCompare(a.lastAt));
  if (opts.changes) {
    // How much each edited file differs from the last commit: the size of the work, not only that it happened.
    const edited = sessions.flatMap((s) => s.nodes.flatMap((n) => n.files.filter((f) => f.edits > 0)));
    const sizes = fileChanges(root, [...new Set(edited.map((f) => f.path))]);
    for (const f of edited) Object.assign(f, sizes.get(f.path));
  }
  return { at: new Date(now).toISOString(), sessions };
}

const MAX_DIFF = 400 * 1024;

/** Lines added and removed in each file since the last commit. A file git does not track counts as all new. */
export function fileChanges(root: string, files: string[]): Map<string, { added: number; removed: number; fresh?: boolean }> {
  const out = new Map<string, { added: number; removed: number; fresh?: boolean }>();
  if (!files.length) return out;
  for (const line of (git(root, ['diff', '--numstat', 'HEAD', '--', ...files]) ?? '').split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m) out.set(m[3], { added: Number(m[1]) || 0, removed: Number(m[2]) || 0 });
  }
  for (const f of (git(root, ['ls-files', '--others', '--exclude-standard', '--', ...files]) ?? '').split('\n').filter(Boolean)) {
    let lines = 0;
    try {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      lines = text ? text.replace(/\n$/, '').split('\n').length : 0;
    } catch {
      /* gone again */
    }
    out.set(f, { added: lines, removed: 0, fresh: true });
  }
  return out;
}

/**
 * What changed in one file since the last commit, as a unified diff. Only for a file a session shown
 * in `live` edited: the page asks by path, and this must not read any file it is asked for.
 * Null when the file is not one of those.
 */
export function fileDiff(root: string, live: Live, file: string): string | null {
  const known = live.sessions.some((s) => s.nodes.some((n) => n.files.some((f) => f.path === file && f.edits > 0)));
  if (!known) return null;
  const cut = (text: string): string => (text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n… the rest is left out: the change is larger than ${MAX_DIFF / 1024} KB.\n` : text);
  const untracked = !!git(root, ['ls-files', '--others', '--exclude-standard', '--', file])?.trim();
  if (untracked) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      return '';
    }
    const lines = text.replace(/\n$/, '').split('\n');
    return cut(`@@ -0,0 +1,${lines.length} @@ new file\n${lines.map((l) => `+${l}`).join('\n')}\n`);
  }
  return cut(git(root, ['diff', 'HEAD', '--', file]) ?? '');
}
