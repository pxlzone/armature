import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodeIndex, readCodeIndex } from '../src/code.js';
import { compile } from '../src/compile.js';
import { callersText, contextPack, driftText, searchText, testsText } from '../src/context.js';
import { agentText, evalAgent, evalRetrieval } from '../src/eval.js';
import { syncShapeFiles } from '../src/schemas.js';
import { planSummaries, summarize } from '../src/summarize.js';

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-deep-'));
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd: root, stdio: 'ignore' });
  };
  write('armature/system.yaml', 'name: Shop\nheadline: Sells things.\n');
  write('armature/nodes/api.yaml', [
    'kind: service', 'role: order API', 'code: [apps/api/**]',
    'accepts:', '  - id: orders', '    via: http', '    route: POST /api/orders', '    takes: OrderBody',
    'writes: [db#orders]', 'sends: [{ to: worker#charge }]', '',
  ].join('\n'));
  write('armature/nodes/worker.yaml', ['kind: worker', 'role: charges cards', 'code: [apps/worker/**]', 'accepts:', '  - id: charge', '    via: temporal', '    queue: billing', ''].join('\n'));
  write('armature/nodes/web.yaml', 'kind: app\nrole: shop front\ncode: [apps/web/**]\n');
  write('armature/nodes/db.yaml', 'kind: store\nrole: database\ncode: [db/**]\nholds:\n  - { id: orders, shape: OrderRow }\n  - { id: refunds }\n');
  write('armature/shapes/main.yaml', [
    'OrderRow:', '  source: db/schema.ts#orders', '  fields:', '    id: uuid', '    email: string @pii', '    legacy: string', '',
    'OrderBody:', '  source: apps/api/src/body.ts#orderBody', '  fields: {}', '',
    'RefundRow:', '  source: db/migrations/001_init.sql#refunds', '',
  ].join('\n'));
  write('db/schema.ts', "import { pgTable, uuid, text, integer } from 'drizzle-orm/pg-core';\nexport const orders = pgTable('orders', {\n  id: uuid('id').primaryKey(),\n  email: text('email').notNull(),\n  total: integer('total'),\n});\nexport const refunds = pgTable('refunds', { id: uuid('id').primaryKey() });\n");
  write('db/migrations/001_init.sql', 'create table refunds (\n  id uuid primary key,\n  amount integer not null,\n  reason text\n);\n');
  write('db/migrations/002_more.sql', 'alter table refunds add column created_at timestamptz not null default now();\nalter table refunds drop column reason;\n');
  write('apps/api/src/body.ts', "import { z } from 'zod';\nexport const orderBody = z.object({\n  email: z.string().email(),\n  items: z.array(z.string()),\n  tags: z.array(z.enum(['a', 'b'])).optional(),\n  note: z.string().optional(),\n  kind: z.enum(['card', 'invoice']),\n});\n");
  write('apps/api/src/orders.ts', [
    "import { orders, refunds } from '../../../db/schema';",
    "import { orderBody } from './body';",
    "import * as money from './money';",
    '/** Takes an order and stores it. */',
    'export async function placeOrder(db: any, client: any, input: unknown) {',
    '  const body = orderBody.parse(input);',
    '  await db.insert(orders).values({ ...body, total: money.cents(1) });',
    "  await client.workflow.start('chargeWorkflow', { taskQueue: 'billing' });",
    '  await db.select().from(refunds);',
    '}',
    "export function register(app: any) { app.post('/orders', placeOrder); app.get('/health', () => 'ok'); }",
    '',
  ].join('\n'));
  write('apps/api/src/types.ts', "export interface Receipt {\n  id: string;\n  total: number;\n  status: 'paid' | 'void';\n  lines?: Line[];\n  paidAt: Date | null;\n}\nexport type Line = { sku: string; qty: number };\n");
  write('apps/api/src/money.ts', 'export function cents(n: number): number {\n  return n * 100;\n}\n');
  write('apps/api/test/orders.test.ts', "import { placeOrder } from '../src/orders';\nplaceOrder;\n");
  write('apps/worker/src/worker.ts', "import { Worker } from '@temporalio/worker';\nexport async function run() { await Worker.create({ taskQueue: 'billing' }); }\n");
  write('apps/web/src/cart.ts', "export async function checkout() {\n  return fetch(`${base}/api/orders`, { method: 'POST' });\n}\n");
  write('services/py/app.py', 'from pydantic import BaseModel\nfrom typing import Optional\n\nclass Item(BaseModel):\n    name: str\n    price: float\n    tags: list[str] = []\n    note: Optional[str] = None\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'feat(api): first version');
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(path.join(root, 'apps/api/src/orders.ts'), `// change ${i}\n`);
    fs.appendFileSync(path.join(root, 'apps/api/src/money.ts'), `// change ${i}\n`);
    git('commit', '-qam', `fix(api): order totals in cents round ${i}`);
  }
  return root;
}

describe('deeper code index', () => {
  it('reads schemas from Drizzle, Zod, Pydantic and SQL with later migrations replayed', async () => {
    const root = repo();
    await buildCodeIndex(root);
    const g = compile(root);
    const shape = (id: string) => g.shapes.find((s) => s.id === id)!;
    expect(shape('OrderRow')).toMatchObject({ fromCode: 'drizzle', drift: { onlyModel: ['legacy'], onlyCode: ['total'] } });
    expect(shape('OrderRow').fields).toEqual([
      { name: 'id', type: 'uuid', tags: [] },
      { name: 'email', type: 'string', tags: ['pii'] },
      { name: 'total', type: 'int?', tags: [] },
    ]);
    expect(shape('OrderBody').fields.map((f) => `${f.name}:${f.type}`)).toEqual(['email:email', 'items:string[]', 'tags:enum(a|b)[]?', 'note:string?', 'kind:enum(card|invoice)']);
    expect(shape('RefundRow').fields.map((f) => `${f.name}:${f.type}`)).toEqual(['id:uuid', 'amount:int', 'created_at:timestamp']);
    const ts = readCodeIndex(root)!.files['apps/api/src/types.ts'].schemas;
    expect(ts.Receipt.fields.map((f) => `${f.name}:${f.type}`)).toEqual(['id:string', 'total:float', 'status:enum(paid|void)', 'lines:Line[]?', 'paidAt:timestamp?']);
    expect(ts.Line.fields.map((f) => f.name)).toEqual(['sku', 'qty']);
    const py = readCodeIndex(root)!.files['services/py/app.py'].schemas.Item.fields;
    expect(py.map((f) => `${f.name}:${f.type}`)).toEqual(['name:string', 'price:float', 'tags:string[]?', 'note:string?']);
  });

  it('rewrites shape files from code, keeping tags', async () => {
    const root = repo();
    await buildCodeIndex(root);
    const changed = await syncShapeFiles(path.join(root, 'armature'), readCodeIndex(root)!);
    expect(changed.sort()).toEqual(['OrderBody', 'OrderRow', 'RefundRow']);
    const text = fs.readFileSync(path.join(root, 'armature/shapes/main.yaml'), 'utf8');
    expect(text).toContain('email: string @pii');
    expect(text).not.toContain('legacy');
    expect(compile(root).problems.some((p) => p.code === 'shape-fields')).toBe(false);
  });

  it('finds callers through named and namespace imports, with the enclosing function and tests', async () => {
    const root = repo();
    await buildCodeIndex(root);
    const g = compile(root);
    const idx = readCodeIndex(root);
    const text = callersText(g, idx, 'cents');
    expect(text).toContain('apps/api/src/orders.ts:7 in placeOrder (call)');
    expect(text).toContain('tests that exercise it or its callers: apps/api/test/orders.test.ts');
    expect(testsText(g, idx, 'api')).toContain('apps/api/test/orders.test.ts');
    expect(g.nodes.find((n) => n.id === 'api')!.testedBy).toEqual(['apps/api/test/orders.test.ts']);
  });

  it('compares run-time behaviour with declared links', async () => {
    const root = repo();
    await buildCodeIndex(root);
    const g = compile(root);
    const api = g.runtime.find((r) => r.node === 'api')!;
    // Declared: writes orders, sends to the billing queue, serves POST /orders. Not declared: reads refunds, serves /health.
    expect(api.undeclared.map((u) => `${u.kind} ${u.what} ${u.op}`).sort()).toEqual(['route GET /health serves', 'table db#refunds read']);
    expect(api.confirmed).toBeGreaterThanOrEqual(3);
    const web = g.runtime.find((r) => r.node === 'web')!;
    expect(web.undeclared.map((u) => u.kind)).toEqual(['http']);
    expect(g.runtime.find((r) => r.node === 'worker')?.undeclared ?? []).toEqual([]);
    expect(g.codeDeps.some((d) => d.from === 'web' && d.to === 'api' && d.via === 'http' && d.kind === 'undeclared')).toBe(true);
    expect(driftText(g, 'api')).toContain('in code, not in model: table db#refunds (read)');
  });

  it('ranks files for a task and packs context within a budget', async () => {
    const root = repo();
    await buildCodeIndex(root);
    const g = compile(root);
    const idx = readCodeIndex(root)!;
    const r = contextPack(g, idx, root, 'order totals should be stored in cents', { budget: 1500 });
    expect(r.files[0].path).toMatch(/apps\/api\/src\/(orders|money)\.ts/);
    expect(r.nodes[0].id).toBe('api');
    expect(r.text.length).toBeLessThanOrEqual(1500);
    expect(r.text).toContain('## Files, most relevant first');
    expect(searchText(g, idx, root, 'place order')).toContain('apps/api/src/orders.ts');
  });

  it('scores rankings against past commits', async () => {
    const root = repo();
    await buildCodeIndex(root);
    const report = evalRetrieval(compile(root), readCodeIndex(root)!, root, 10);
    expect(report.tasks).toBe(3); // "first version" is too short to be a task
    expect(report.variants.full.hit[5]).toBe(1);
  });
});

describe('model-backed commands, with a stand-in for the claude CLI', () => {
  function fakeClaude(script: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  it('summarises only what changed, and caches by content', async () => {
    const root = repo();
    await buildCodeIndex(root);
    const idx = readCodeIndex(root)!;
    process.env.ARMATURE_CLAUDE_BIN = fakeClaude(`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const files=[...s.matchAll(/=== (\\S+)/g)].map(m=>m[1]);console.log(JSON.stringify({result:JSON.stringify(Object.fromEntries(files.map(f=>[f,'Does things with '+f])))}));});`);
    const plan = planSummaries(root, idx);
    expect(plan.files.length).toBeGreaterThan(0);
    expect(summarize(root, idx, plan, () => undefined)).toBe(plan.files.length);
    expect(planSummaries(root, idx).files).toEqual([]);
    delete process.env.ARMATURE_CLAUDE_BIN;
  });

  it('runs both variants of a task in throwaway copies and reports usage', async () => {
    const root = repo();
    const tasks = path.join(root, 'tasks.yaml');
    fs.writeFileSync(tasks, '- id: cents\n  prompt: Store order totals in cents\n  check: test -f package.json || true\n');
    process.env.ARMATURE_CLAUDE_BIN = fakeClaude(`const armature=require('fs').existsSync('armature');console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{file_path:'a.ts'}},{type:'tool_use',name:armature?'mcp__armature__context':'Grep',input:{}}]}}));console.log(JSON.stringify({type:'result',num_turns:armature?3:5,usage:{input_tokens:armature?100:200,output_tokens:10,cache_read_input_tokens:5,cache_creation_input_tokens:1},total_cost_usd:armature?0.01:0.02}));`);
    const bin = path.resolve('bin/armature.mjs');
    const runs = await evalAgent(root, tasks, bin, () => undefined);
    delete process.env.ARMATURE_CLAUDE_BIN;
    expect(runs.map((r) => `${r.variant}:${r.turns}:${r.inputTokens}:${r.ok}`)).toEqual(['bare:5:200:true', 'armature:3:100:true']);
    expect(runs[1].tools).toEqual({ Read: 1, mcp__armature__context: 1 });
    expect(agentText(runs)).toContain('totals: bare $0.02');
    expect(fs.readdirSync(path.join(root, 'armature/.cache/eval')).length).toBe(1);
  });
});
