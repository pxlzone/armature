import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodeIndex } from '../src/code.js';
import { compile } from '../src/compile.js';
import { islands } from '../src/render.js';

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-islands-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

const base = {
  'armature/system.yaml': 'name: Demo\nheadline: test\n',
  'armature/nodes/worker.yaml': 'kind: worker\nrole: runs jobs\ncode: ["worker/**"]\ndeploy: [worker]\n',
  'worker/package.json': JSON.stringify({ name: 'worker', private: true, scripts: { once: 'tsx src/run-once.ts && tsx src/second.ts' } }),
  'worker/src/main.ts': "import { helper } from './helper';\nexport const x = helper;\n",
  'worker/src/helper.ts': 'export const helper = 1;\n',
  'worker/src/run-once.ts': "import './helper';\n",
  'worker/src/second.ts': 'export {};\n',
  'worker/src/temporal.ts': 'const w = { workflowsPath: path.resolve(__dirname, "./workflows.ts") };\n',
  'worker/src/workflows.ts': 'export async function wf() {}\n',
  'worker/src/dead.ts': "import { lonely } from './dead-helper';\nexport const d = lonely;\n",
  'worker/src/dead-helper.ts': 'export const lonely = 2;\n',
  'worker/src/by-hand.ts': 'export {};\n',
  'scraper/main.py': 'app = 1\n',
  'scraper/Dockerfile': 'FROM python:3.12\nCMD ["uvicorn", "main:app", "--port", "8000"]\n',
  'docker-compose.yml': 'services:\n  worker:\n    command: npx tsx src/main.ts\n    build: ./worker\n  worker2:\n    image: x\n    command: npx tsx src/temporal.ts\n    build: ./worker\n  scraper:\n    build: ./scraper\n  redis:\n    image: redis:7\n',
  'pnpm-lock.yaml': 'lock\n',
  'README.md': '# demo\n',
  'notes.txt': 'loose file\n',
};

describe('coverage, deployment and dead code', () => {
  it('finds entry points and reports only truly dead files', async () => {
    const root = repo(base);
    await buildCodeIndex(root);
    const g = compile(root);
    const dead = g.dead.map((d) => d.path).sort();
    // Reached: script chain (run-once, second), container command (main -> helper), workflowsPath, uvicorn module.
    expect(dead).toEqual(['worker/src/by-hand.ts', 'worker/src/dead-helper.ts', 'worker/src/dead.ts']);
    expect(g.problems.some((p) => p.code === 'dead-code' && p.ref === 'worker')).toBe(true);
    expect(islands(g)).toContain('worker/src/dead.ts');
  });

  it('accepts entry lists and unused nodes, and flags an unused node that is reached or linked', async () => {
    const root = repo({
      ...base,
      'armature/nodes/worker.yaml': 'kind: worker\nrole: runs jobs\ncode: ["worker/**"]\nentry: [worker/src/by-hand.ts]\ndeploy: [worker]\n',
      'armature/nodes/dead.yaml': 'kind: library\nrole: dead code\nunused: true\ncode: [worker/src/dead.ts, worker/src/dead-helper.ts, worker/src/second.ts]\ncalls:\n  - to: worker\n',
    });
    await buildCodeIndex(root);
    const g = compile(root);
    expect(g.problems.filter((p) => p.code === 'dead-code')).toEqual([]);
    expect(g.problems.find((p) => p.code === 'unused-reachable')?.message).toContain('worker/src/second.ts');
    expect(g.problems.some((p) => p.code === 'unused-linked')).toBe(true);
    expect(g.nodes.find((n) => n.id === 'dead')!.unused).toBe(true);
  });

  it('places every file and ties containers to nodes', async () => {
    const root = repo({
      ...base,
      'armature/system.yaml': 'name: Demo\nheadline: test\nignore:\n  - notes.txt\n',
      'armature/tech.yaml': 'tech:\n  - { id: docker, name: Docker, category: tool, files: ["**/Dockerfile*", "docker-compose.yml"] }\n',
      'armature/nodes/ghost.yaml': 'kind: platform\nrole: missing container\ndeploy: [nowhere]\ntech: [temporal]\n',
    });
    await buildCodeIndex(root);
    const g = compile(root);
    const codes = (c: string) => g.problems.filter((p) => p.code === c);
    expect(g.coverage.builtin).toBe(1); // pnpm-lock.yaml
    expect(g.coverage.docs).toBe(1); // README.md
    expect(g.coverage.tech).toBe(2); // Dockerfile and compose file
    expect(g.coverage.ignored).toBe(1); // notes.txt
    expect(g.unowned).toEqual(['scraper/main.py']);
    expect(codes('ignore-reason')).toHaveLength(1);
    expect(codes('deploy-missing')[0].message).toContain('nowhere');
    expect(codes('undeployed').map((p) => p.message)).toEqual(expect.arrayContaining([expect.stringContaining('"scraper"'), expect.stringContaining('"redis"')]));
    expect(codes('unknown-tech')[0].message).toContain('temporal');
    expect(g.nodes.find((n) => n.id === 'worker')!.deployment.map((d) => d.service)).toEqual(['worker']);
    expect(g.snapshot.dirty).toBe(true);
  });

  it('treats libraries as shared plumbing unless they or a parent say shared: false', () => {
    const root = repo({
      'armature/system.yaml': 'name: Demo\nheadline: test\n',
      'armature/nodes/docs.yaml': 'kind: group\nrole: documents\n',
      'armature/nodes/docs/engine.yaml': 'kind: library\nrole: document engine\nshared: false\n',
      'armature/nodes/docs/engine/invoice.yaml': 'kind: library\nrole: invoice layout\n',
      'armature/nodes/util.yaml': 'kind: library\nrole: shared helpers\n',
    });
    const g = compile(root);
    const shared = (id: string) => g.nodes.find((n) => n.id === id)!.shared;
    expect(shared('docs.engine')).toBe(false);
    expect(shared('docs.engine.invoice')).toBe(false);
    expect(shared('util')).toBe(true);
    expect(shared('docs')).toBe(false);
  });

  it('reads SQL table names from code but not from prose', async () => {
    const root = repo({
      'armature/system.yaml': 'name: Demo\nheadline: test\n',
      'src/a.ts': 'export const text = "Names and codes from Acme Holdings.";\nexport const q = sql`SELECT id FROM companies WHERE x = 1`;\nexport const r = `select * from "Officers"`;\n',
    });
    await buildCodeIndex(root);
    const { readCodeIndex } = await import('../src/code.js');
    const tables = readCodeIndex(root)!.files['src/a.ts'].hints.filter((h) => h.k === 'table').map((h) => h.v).sort();
    expect(tables).toEqual(['companies', 'officers']);
  });
});
