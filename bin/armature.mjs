#!/usr/bin/env node
import { existsSync } from 'node:fs';
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
  let cwd;
  try {
    cwd = JSON.parse(text).cwd;
  } catch {
    /* no input, or not JSON */
  }
  const flag = process.argv.indexOf('--root');
  // The same order the hook itself uses to find the repo.
  const start = [flag > 0 ? process.argv[flag + 1] : undefined, cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()].find((x) => typeof x === 'string' && x);
  const hasModel = (start) => {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, 'armature', 'system.yaml'))) return true;
      if (path.dirname(dir) === dir) return false;
    }
  };
  if (!hasModel(start)) process.exit(0);
}

const built = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(built)) {
  console.error('armature is not built yet. Run "npm install && npm run build" in its repo folder.');
  process.exit(1);
}
await import(built.href);
