// Shows the person the change they are asked to approve, as a diagram, next to the approval prompt.
// The prompt itself is plain text, so the hook starts (or reuses) a local viewer and has it opened on
// the change in the Work lens. A hook cannot reach the browser pane of the Claude desktop app, only
// the agent can, so the agent is asked first and the default browser is the fallback.
// Best effort: if nothing can be opened, the prompt still asks.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_DIR } from './paths.js';

const RUNNING = 'viewer.json';
/** A viewer the hook started stops after this long with no page open. */
export const IDLE_MINUTES = 30;
/** The same change is not opened again in a new tab within this time. */
export const REOPEN_AFTER = 10 * 60 * 1000;
/** A page the agent just opened is given this long to load before the hook opens one itself. */
const SETTLE_TRIES = 6;
const SETTLE_PAUSE = 300;

const runningFile = (root: string): string => path.join(root, MODEL_DIR, '.cache', RUNNING);

type Running = { url: string; pid: number };

/** Called by "armature view" once it listens, so a hook can find it. */
export function noteViewer(root: string, url: string): void {
  const file = runningFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ url, pid: process.pid } satisfies Running));
  const forget = (): void => {
    try {
      const now = JSON.parse(fs.readFileSync(file, 'utf8')) as Running;
      if (now.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
  process.once('exit', forget);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => process.exit(0));
}

function readRunning(root: string): Running | null {
  try {
    const r = JSON.parse(fs.readFileSync(runningFile(root), 'utf8')) as Running;
    if (typeof r.url !== 'string' || typeof r.pid !== 'number') return null;
    process.kill(r.pid, 0); // throws when the process is gone
    return r;
  } catch {
    return null;
  }
}

/** Off in CI and tests, and when the person turned it off. */
export function openingAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.CI && !env.VITEST && !['1', 'true', 'yes'].includes(String(env.ARMATURE_NO_OPEN ?? '').toLowerCase());
}

/** The session view of one session: the page made for a pane beside the agent. */
export function sessionUrl(base: string, session: string): string {
  return `${base.replace(/\/$/, '')}/?view=session${session ? `&session=${encodeURIComponent(session)}` : ''}`;
}

/** The address of the viewer for this repo, started when none runs. Null when none could be started. */
export function ensureViewer(root: string): string | null {
  return (readRunning(root) ?? startViewer(root))?.url ?? null;
}

/** What the viewer has open: pages on the session view, pages of any kind, and when each change was last opened. */
export interface Watching {
  session: number;
  pages: number;
  shown: Record<string, number>;
}

/** What is open in the viewer right now. Null when the viewer does not answer in time. */
export async function watchers(base: string): Promise<Watching | null> {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/watchers`, { signal: AbortSignal.timeout(800) });
    const w = (await res.json()) as { session?: unknown; pages?: unknown; shown?: unknown };
    if (typeof w.session !== 'number') return null;
    // A viewer of an older version only counts session views.
    return { session: w.session, pages: typeof w.pages === 'number' ? w.pages : w.session, shown: w.shown && typeof w.shown === 'object' ? (w.shown as Record<string, number>) : {} };
  } catch {
    return null;
  }
}

export interface ProgressDeps {
  allowed: () => boolean;
  viewer: (root: string) => string | null;
  watchers: (base: string) => Promise<Watching | null>;
  open: (url: string) => void;
  pause: (ms: number) => Promise<void>;
}

const defaults: ProgressDeps = { allowed: openingAllowed, viewer: ensureViewer, watchers, open: openBrowser, pause: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * True once the viewer shows what `seen` looks for. The agent repeats its edit right after it
 * opens the page, so the page may still be loading: ask a few times before giving up.
 * Also true when the viewer stops answering, so that nothing is opened on a guess.
 */
async function settles(base: string, seen: (w: Watching) => boolean, deps: ProgressDeps): Promise<boolean> {
  for (let i = 0; i < SETTLE_TRIES; i++) {
    if (i) await deps.pause(SETTLE_PAUSE);
    const w = await deps.watchers(base);
    if (!w || seen(w)) return true;
  }
  return false;
}

/**
 * The person watches a session on the diagram, so the progress view is open before the session's
 * first edit. `first` is true on that edit: with no session view open, the edit is sent back once
 * with the address to open. On a later edit, if the viewer still has no page open at all, the hook
 * opens it in the default browser, once (`fallback`). A page of any kind counts there: the person
 * has the diagram in front of them, and a second window in another browser is not wanted.
 * Returns the reason to send the edit back, or null to let it through.
 */
export async function progressGate(root: string, session: string, first: boolean, fallback: () => boolean, deps: ProgressDeps = defaults): Promise<string | null> {
  if (!session || !deps.allowed()) return null;
  if (!first && !fallback()) return null;
  const base = deps.viewer(root);
  if (!base) return null;
  const url = sessionUrl(base, session);
  if (!first) {
    if (!(await settles(base, (w) => w.pages > 0, deps))) deps.open(url);
    return null;
  }
  // A viewer that does not answer must not hold an edit back.
  if ((await deps.watchers(base))?.session !== 0) return null;
  return (
    `Armature shows the person what this session does on the diagram, so the progress view is opened before the first edit: ${url}\n` +
    `- In the Claude desktop app: open that address in the browser pane (the preview_start tool with "url", not a server name: the address must keep "?view=session"), and leave it open.\n` +
    `- With no browser tool: say so in one line and go on. The next edit opens it in the person's default browser.\n` +
    `Then make this edit again. This is asked once per session.`
  );
}

/**
 * The diagram of a change is in front of the person when they are asked to approve it.
 * If the viewer has not shown the change lately, the approving edit is sent back once (`first`)
 * for the agent to open it in the browser pane; when it comes again and the change is still not
 * shown, the hook opens the default browser. Returns the page's address (null when no viewer
 * could be reached) and, when the edit is to be sent back, the reason.
 */
export async function changeGate(root: string, change: string, first: () => boolean, deps: ProgressDeps = defaults): Promise<{ url: string | null; send?: string }> {
  if (!deps.allowed()) return { url: null };
  const base = deps.viewer(root);
  if (!base) return { url: null };
  const url = changeUrl(base, change);
  const shown = (w: Watching): boolean => Date.now() - (w.shown[change] ?? 0) < REOPEN_AFTER;
  const now = await deps.watchers(base);
  if (!now || shown(now)) return { url };
  if (first()) {
    return {
      url,
      send:
        `This is not a refusal. The person approves change "${change}" on its diagram, so it is opened before they are asked: ${url}\n` +
        `- In the Claude desktop app: open that address in the browser pane (the preview_start tool with "url").\n` +
        `- With no browser tool: say so in one line and go on. It opens in the person's default browser.\n` +
        `Then make this edit again, unchanged. The person is asked then.`,
    };
  }
  if (!(await settles(base, shown, deps))) deps.open(url);
  return { url };
}

export function changeUrl(base: string, change: string): string {
  return `${base.replace(/\/$/, '')}/?lens=work&change=${encodeURIComponent(change)}`;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startViewer(root: string): Running | null {
  const cli = process.argv[1];
  if (!cli) return null;
  try {
    const child = spawn(process.execPath, [cli, 'view', '--root', root, '--idle', String(IDLE_MINUTES)], { cwd: root, detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    return null;
  }
  // The viewer writes its address once it listens; a hook cannot wait long.
  for (let waited = 0; waited < 4000; waited += 100) {
    sleep(100);
    const r = readRunning(root);
    if (r) return r;
  }
  return null;
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* no browser to open */
  }
}
