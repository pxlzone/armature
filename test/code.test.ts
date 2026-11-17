import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodeIndex, readCodeIndex } from '../src/code.js';
import { codeDeps, codeMap, findSymbol } from '../src/codeview.js';
import { compile } from '../src/compile.js';

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-code-'));
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('armature/system.yaml', 'name: Shop\nheadline: Sells things.\n');
  write('armature/nodes/api.yaml', 'kind: service\nrole: order API\ncode: [apps/api/**]\nsends: [billing]\n');
  write('armature/nodes/billing.yaml', 'kind: worker\nrole: charges cards\ncode: [apps/billing/**]\n');
  write('armature/nodes/shared.yaml', 'kind: library\nrole: shared types\ncode: [packages/shared/**]\n');
  write('armature/nodes/scraper.yaml', 'kind: service\nrole: fetches pages\ncode: [services/scraper/**]\n');
  write('packages/shared/package.json', '{"name":"@shop/shared"}');
  write('packages/shared/src/index.ts', "export { Order } from './order';\nexport const VERSION = 1;\n");
  write('packages/shared/src/order.ts', '/** One customer order. */\nexport interface Order {\n  id: string;\n}\n');
  write('apps/api/tsconfig.json', '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } },\n}\n');
  write('apps/api/src/server.ts', "import type { Order } from '@shop/shared';\nimport { save } from '@/store.js';\nimport { charge } from '../../billing/src/charge';\nimport express from 'express';\n\n/** Accepts an order and charges it. */\nexport async function checkout(order: Order): Promise<void> {\n  save(order);\n  await charge(order.id);\n}\nconst lazy = () => import('./late');\n");
  write('apps/api/src/store.ts', "export const save = (o: unknown): void => {};\nfunction hidden() {}\nexport default class Store {}\n");
  write('apps/api/src/late.ts', 'export enum Mode { A, B }\nexport type Id = string;\n');
  write('apps/billing/src/charge.ts', "export function charge(id: string): Promise<boolean> {\n  return Promise.resolve(true);\n}\n");
  write('services/scraper/app/main.py', 'import os\nfrom .fetch import get_page\n\ndef run(url):\n    """Fetch one page."""\n    return get_page(url)\n\nclass _Private:\n    pass\n');
  write('services/scraper/app/fetch.py', 'def get_page(url):\n    return url\n');
  return root;
}

describe('code index', () => {
  it('extracts symbols with signatures and resolves relative, alias, workspace and Python imports', async () => {
    const root = repo();
    const r = await buildCodeIndex(root);
    expect(r.parsed).toBe(8);
    const f = r.index.files['apps/api/src/server.ts'];
    expect(f.symbols.find((s) => s.name === 'checkout')).toMatchObject({ kind: 'function', exported: true, sig: 'async function checkout(order: Order): Promise<void>', doc: 'Accepts an order and charges it.' });
    const resolved = Object.fromEntries(f.imports.map((i) => [i.spec, i.file ?? `pkg:${i.pkg}`]));
    expect(resolved).toEqual({
      '@shop/shared': 'packages/shared/src/index.ts',
      '@/store.js': 'apps/api/src/store.ts',
      '../../billing/src/charge': 'apps/billing/src/charge.ts',
      express: 'pkg:express',
      './late': 'apps/api/src/late.ts',
    });
    const store = r.index.files['apps/api/src/store.ts'].symbols;
    expect(store.map((s) => `${s.name}:${s.kind}:${s.exported}`)).toEqual(['save:function:true', 'hidden:function:false', 'Store:class:true']);
    expect(r.index.files['apps/api/src/late.ts'].symbols.map((s) => s.kind)).toEqual(['enum', 'type']);
    const py = r.index.files['services/scraper/app/main.py'];
    expect(py.imports.find((i) => i.spec === '.fetch')!.file).toBe('services/scraper/app/fetch.py');
    expect(py.symbols.map((s) => `${s.name}:${s.exported}`)).toEqual(['run:true', '_Private:false']);
    expect(py.symbols[0].doc).toBe('Fetch one page.');
  });

  it('reuses unchanged files on the next run', async () => {
    const root = repo();
    await buildCodeIndex(root);
    fs.writeFileSync(path.join(root, 'apps/api/src/late.ts'), 'export const changed = true;\n');
    const again = await buildCodeIndex(root);
    expect(again.parsed).toBe(1);
    expect(again.reused).toBe(7);
  });
});

describe('code graph linked to the model', () => {
  it('classifies node-to-node imports against declared links and warns about undeclared ones', async () => {
    const root = repo();
    expect(compile(root).code).toBeNull();
    await buildCodeIndex(root);
    const g = compile(root);
    const kinds = Object.fromEntries(g.codeDeps.map((d) => [`${d.from}>${d.to}`, d.kind]));
    expect(kinds).toEqual({ 'api>shared': 'library', 'api>billing': 'declared' });
    expect(g.nodes.find((n) => n.id === 'api')!.codeMap).toMatchObject({ files: 3, packages: ['express'] });
    fs.writeFileSync(path.join(root, 'apps/billing/src/charge.ts'), "import { save } from '../../api/src/store';\nexport function charge(id: string) { save(id); }\n");
    fs.writeFileSync(path.join(root, 'armature/nodes/api.yaml'), 'kind: service\nrole: order API\ncode: [apps/api/**]\n');
    await buildCodeIndex(root);
    const g2 = compile(root);
    expect(g2.codeDeps.filter((d) => d.kind === 'undeclared').map((d) => `${d.from}>${d.to}`).sort()).toEqual(['api>billing', 'billing>api']);
    expect(g2.problems.filter((p) => p.code === 'undeclared-import').length).toBe(2);
  });

  it('answers map, symbol and deps questions', async () => {
    const root = repo();
    await buildCodeIndex(root);
    const g = compile(root);
    const idx = readCodeIndex(root);
    const map = codeMap(g, idx, 'api');
    expect(map).toContain('Code map of api');
    expect(map).toContain('export async function checkout(order: Order): Promise<void>  :7  // Accepts an order and charges it.');
    expect(map).not.toContain('hidden');
    expect(codeMap(g, idx, 'api', 120)).toContain('more files');
    const card = codeMap(g, idx, 'apps/api/src/store.ts');
    expect(card).toContain('belongs to node api');
    expect(card).toContain('imported by 1 file');
    const sym = findSymbol(g, idx, 'charge');
    expect(sym).toContain('apps/billing/src/charge.ts:1 [billing]');
    expect(sym).toContain('imported by 1 file: api (1)');
    expect(findSymbol(g, idx, 'checkou')).toContain('No exact match');
    expect(codeDeps(g, 'api')).toContain('api -> billing: 1 import [declared]');
  });
});
