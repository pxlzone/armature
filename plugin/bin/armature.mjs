#!/usr/bin/env node
import { existsSync } from 'node:fs';
const cli = new URL('../dist/cli.mjs', import.meta.url);
if (!existsSync(cli)) {
  console.error('The armature plugin is incomplete: dist/cli.mjs is missing. Reinstall the plugin.');
  process.exit(1);
}
await import(cli.href);
