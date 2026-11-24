#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Hooks run around tool calls in every repo the developer opens. In a repo with no model there
// is nothing to do, so find that out before loading the CLI, which costs a few hundred milliseconds.
if (process.argv[2] === 'hook') {
  const text = await new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const giveUp = setTimeout(() => resolve(data), 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(giveUp);
      resolve(data);
    });
  });
  // The CLI reads the hook's input from here: stdin can be read only once.
  globalThis.__ARMATURE_STDIN__ = text;
  let input = {};
  try {
    input = JSON.parse(text) ?? {};
  } catch {
    /* no input, or not JSON */
  }
  const cwd = input.cwd;
  const flag = process.argv.indexOf('--root');
  // The same order the hook itself uses to find the repo.
  const start = [flag > 0 ? process.argv[flag + 1] : undefined, cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()].find((x) => typeof x === 'string' && x);
  const modelRoot = (start) => {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, 'armature', 'system.yaml'))) return dir;
      if (path.dirname(dir) === dir) return null;
    }
  };
  const root = modelRoot(start);
  if (!root) process.exit(0);
  // "note" runs after every file the agent reads, so it is answered here: one line for the viewer
  // (src/live.ts reads it), and the CLI is never loaded.
  if (process.argv[3] === 'note') {
    const file = input.tool_input?.file_path;
    if (typeof input.session_id === 'string' && input.session_id && typeof file === 'string' && file) {
      try {
        const cache = path.join(root, 'armature', '.cache');
        mkdirSync(cache, { recursive: true });
        appendFileSync(path.join(cache, 'live.jsonl'), `${JSON.stringify({ t: Date.now(), s: input.session_id, k: 'read', file })}\n`);
      } catch {
        /* best effort */
      }
    }
    process.exit(0);
  }
}

const cli = new URL('../dist/cli.mjs', import.meta.url);
if (!existsSync(cli)) {
  console.error('The armature plugin is incomplete: dist/cli.mjs is missing. Reinstall the plugin.');
  process.exit(1);
}
await import(cli.href);
