// The files plugin/ is built from. build-plugin.mjs records their hash in plugin/source.sha256,
// and a test compares it, so a change released without "npm run build:plugin" fails npm test.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const INPUTS = ['src', 'viewer/src', 'viewer/index.html', 'viewer/vite.config.ts', 'skills', 'schemas', 'bin/armature.mjs', 'scripts/build-plugin.mjs', 'scripts/vite.cli.config.ts', 'package.json', 'package-lock.json'];

export function pluginInputsHash(root) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).isDirectory()) for (const e of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, e));
    else files.push(rel);
  };
  for (const i of INPUTS) walk(i);
  const h = crypto.createHash('sha256');
  // Line endings are normalised, so a checkout on Windows hashes the same.
  for (const f of files) h.update(`${f}\0`).update(fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  return h.digest('hex');
}
