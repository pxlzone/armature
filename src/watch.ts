// Calls back, debounced, when source files under the repo change.
import fs from 'node:fs';

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|sql)$/;
const SKIP = /(^|[\\/])(node_modules|\.git|dist|build|\.next|\.turbo|coverage|\.venv|__pycache__|armature|arch)([\\/]|$)/;

export function watchSources(root: string, onChange: () => unknown, delayMs = 1500): () => void {
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_e, file) => {
      const f = String(file ?? '');
      if (!SOURCE.test(f) || SKIP.test(f)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void onChange(), delayMs);
    });
  } catch {
    /* recursive watching is not available here; the index is still refreshed on each command */
  }
  return () => watcher?.close();
}
