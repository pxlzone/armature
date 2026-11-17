#!/usr/bin/env node
import { existsSync } from 'node:fs';
const built = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(built)) {
  console.error('armature is not built yet. Run "npm install && npm run build" in its repo folder.');
  process.exit(1);
}
await import(built.href);
