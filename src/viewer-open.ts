// Shows the person the change they are asked to approve, as a diagram, next to the approval prompt.
// The prompt itself is plain text, so the hook starts (or reuses) a local viewer and opens it on
// the change in the Work lens. Best effort: if nothing can be opened, the prompt still asks.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_DIR } from './paths.js';

const RUNNING = 'viewer.json';
/** A viewer the hook started stops after this long with no page open. */
export const IDLE_MINUTES = 30;
/** The same change is not opened again in a new tab within this time. */
const REOPEN_AFTER = 10 * 60 * 1000;

const runningFile = (root: string): string => path.join(root, MODEL_DIR, '.cache', RUNNING);

type Running = { url: string; pid: number; opened?: Record<string, number> };

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

/** How many pages show the session view right now. Null when the viewer does not answer in time. */
export async function watchers(base: string): Promise<number | null> {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/watchers`, { signal: AbortSignal.timeout(800) });
    const n = ((await res.json()) as { session?: unknown }).session;
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

export interface ProgressDeps {
  allowed: () => boolean;
  viewer: (root: string) => string | null;
  watchers: (base: string) => Promise<number | null>;
  open: (url: string) => void;
}

/**
 * The person watches a session on the diagram, so the progress view is open before the session's
 * first edit. `first` is true on that edit: with no view open, the edit is sent back once with the
 * address to open. On a later edit, if the agent could not open it, the hook opens it in the
 * default browser, once (`fallback`). Returns the reason to send the edit back, or null to let it through.
 */
export async function progressGate(root: string, session: string, first: boolean, fallback: () => boolean, deps: ProgressDeps = { allowed: openingAllowed, viewer: ensureViewer, watchers, open: openBrowser }): Promise<string | null> {
  if (!session || !deps.allowed()) return null;
  if (!first && !fallback()) return null;
  const base = deps.viewer(root);
  if (!base) return null;
  // A viewer that does not answer must not hold an edit back.
  if ((await deps.watchers(base)) !== 0) return null;
  const url = sessionUrl(base, session);
  if (!first) {
    deps.open(url);
    return null;
  }
  return (
    `Armature shows the person what this session does on the diagram, so the progress view is opened before the first edit: ${url}\n` +
    `- In the Claude desktop app: open that address in the browser pane (the preview_start tool with "url"), and leave it open.\n` +
    `- With no browser tool: say so in one line and go on. The next edit opens it in the person's default browser.\n` +
    `Then make this edit again. This is asked once per session.`
  );
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

/**
 * Opens the change in the viewer for the person to look at while they answer the prompt.
 * Returns the page's address, or null when no viewer could be reached.
 */
export function showChange(root: string, change: string): string | null {
  if (!openingAllowed()) return null;
  const running = readRunning(root) ?? startViewer(root);
  if (!running) return null;
  const url = changeUrl(running.url, change);
  const opened = running.opened ?? {};
  if (!(Date.now() - (opened[change] ?? 0) < REOPEN_AFTER)) {
    openBrowser(url);
    opened[change] = Date.now();
    try {
      fs.writeFileSync(runningFile(root), JSON.stringify({ ...running, opened }));
    } catch {
      /* the next prompt opens it again */
    }
  }
  return url;
}
