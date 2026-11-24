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

function openBrowser(url: string): void {
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
