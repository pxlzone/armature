// What the model claims has to be checkable, and "not checked" must never read as "fine".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCodeIndex } from '../src/code.js';
import { compile } from '../src/compile.js';
import { driftText } from '../src/context.js';
import { impact, pathText, show, traceText } from '../src/render.js';

let root: string;

function write(rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

const node = (lines: string[]): string => `${lines.join('\n')}\n`;

function base(): void {
  write('armature/system.yaml', 'name: Shop\nheadline: Takes orders and charges cards.\nactors:\n  - id: buyer\n    role: places orders\n    calls: [api#checkout]\n');
  write('armature/nodes/api.yaml', node([
    'kind: service', 'role: order API', 'code: [src/api/**]',
    'accepts:', '  - id: checkout', '    via: http', '    route: POST /checkout', '    takes: Order', '    gives: Receipt',
    'sends:', '  - to: billing#charge', 'writes: [db#orders]',
    'requirements:', '  - id: rejects-empty', '    text: An empty order is rejected.', '    tests: tests/api.test.ts',
  ]));
  write('armature/nodes/billing.yaml', node(['kind: worker', 'role: charges the card', 'code: [src/billing/**]', 'accepts:', '  - id: charge', '    via: pgmq', '    takes: Order']));
  write('armature/nodes/db.yaml', 'kind: store\nrole: orders database\nholds:\n  - { id: orders, shape: Order }\n');
  write('armature/shapes/order.yaml', 'Order:\n  fields:\n    id: uuid\n    email: email @pii\nReceipt:\n  fields:\n    id: uuid\n');
  write('src/api/server.ts', "export const app = { post: (..._a: unknown[]) => undefined };\napp.post('/checkout', () => undefined);\n");
  write('src/billing/charge.ts', 'export const y = 1;\n');
  write('tests/api.test.ts', '');
}

function junit(cases: Array<[string, string, boolean]>): void {
  const body = cases.map(([file, name, ok]) => `<testcase classname="${file}" name="${name}">${ok ? '' : '<failure message="boom"/>'}</testcase>`).join('');
  write('armature/.cache/reports/junit.xml', `<?xml version="1.0"?><testsuites><testsuite name="all">${body}</testsuite></testsuites>`);
}

const codes = (g: ReturnType<typeof compile>, level?: 'error' | 'warning'): string[] => g.problems.filter((p) => !level || p.level === level).map((p) => p.code);
const byId = (g: ReturnType<typeof compile>, id: string) => g.nodes.find((n) => n.id === id)!;
const messages = (g: ReturnType<typeof compile>, code: string): string[] => g.problems.filter((p) => p.code === code).map((p) => p.message);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-sound-'));
  base();
});

describe('what the model claims against the code', () => {
  it('says when a declared interface is not in the code, and only where it could look', async () => {
    fs.appendFileSync(path.join(root, 'armature/nodes/api.yaml'), '');
    write('armature/nodes/api.yaml', fs.readFileSync(path.join(root, 'armature/nodes/api.yaml'), 'utf8').replace('sends:', '  - id: ghost\n    via: http\n    route: GET /does-not-exist\nsends:'));
    // A service in a language the index does not read: nothing can be said about its routes.
    write('armature/nodes/ledger.yaml', node(['kind: service', 'role: keeps the ledger', 'code: [svc/ledger/**]', 'accepts:', '  - id: entries', '    via: http', '    route: GET /entries']));
    write('svc/ledger/main.go', 'package main\n');
    await buildCodeIndex(root);
    const g = compile(root);
    const iface = (ref: string) => g.nodes.flatMap((n) => n.interfaces).find((i) => i.ref === ref)!;
    expect(iface('api#checkout').evidence).toBe('seen');
    expect(iface('api#ghost').evidence).toBe('unseen');
    expect(iface('ledger#entries').evidence).toBe('unchecked');
    expect(messages(g, 'not-in-code')).toHaveLength(1);
    expect(messages(g, 'not-in-code')[0]).toContain('api#ghost (GET /does-not-exist)');
    expect(show(g, 'api#ghost')).toContain('[not seen in code]');
    // The drift answer names what it could not read, so silence is not taken for a pass.
    const drift = driftText(g);
    expect(drift).toContain('Checked: api (routes)');
    expect(drift).toMatch(/Not checked: .*ledger.*no file in a language the code index reads/);
    expect(g.detectors.find((d) => d.node === 'ledger')).toMatchObject({ indexed: 0, kinds: [] });
  });

  it('does not expect a planned interface in the code', async () => {
    write('armature/changes/export.yaml', 'title: Export\nstate: approved\n');
    write('armature/nodes/api.yaml', fs.readFileSync(path.join(root, 'armature/nodes/api.yaml'), 'utf8').replace('sends:', '  - id: export\n    via: http\n    route: GET /export\n    change: export\nsends:'));
    await buildCodeIndex(root);
    const g = compile(root);
    expect(codes(g)).not.toContain('not-in-code');
    // Marked done with the route still missing: that is a contradiction, not a warning.
    write('armature/changes/export.yaml', 'title: Export\nstate: done\n');
    expect(messages(compile(root), 'not-done')[0]).toContain('interface "api#export" is not in the code');
  });
});

describe('detectors', () => {
  it('do not read comments and prose as queries, routes or calls', async () => {
    write('armature/nodes/db.yaml', 'kind: store\nrole: orders database\nholds:\n  - { id: orders, shape: Order }\n  - { id: system }\n  - { id: approvals }\n');
    write('src/api/notes.ts', [
      '// Reads the gate setting from system.yaml, and who approved what from approvals.lock.json.',
      '/** Example: app.get("/health", ...) calls "/api/orders/list" and then selects from orders. */',
      'export const hint = "Update orders whenever you like; take the totals from orders too.";',
      'export const note = "Copy the list from system and from approvals.";',
      '',
    ].join('\n'));
    await buildCodeIndex(root);
    const { readCodeIndex } = await import('../src/code.js');
    expect(readCodeIndex(root)!.files['src/api/notes.ts'].hints).toEqual([]);
    // Real SQL in the same repo is still read.
    write('src/api/query.ts', 'export const q = `SELECT id FROM orders o JOIN approvals a ON a.id = o.id`;\nexport const u = "update orders set paid = true";\n');
    await buildCodeIndex(root);
    expect(readCodeIndex(root)!.files['src/api/query.ts'].hints.map((h) => `${h.v}:${h.op}`).sort()).toEqual(['approvals:read', 'orders:read', 'orders:write']);
  });
});

describe('test reports as evidence', () => {
  it('counts a pass only while the report is newer than the code', () => {
    junit([['tests/api.test.ts', 'rejects an empty order', true]]);
    let g = compile(root);
    expect(byId(g, 'api').requirements[0].state).toBe('verified');
    expect(byId(g, 'api').status).toBe('verified');
    expect(g.system.reports.at).toBeTruthy();

    // The code changes after the test run.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'src/api/server.ts'), later, later);
    g = compile(root);
    const q = byId(g, 'api').requirements[0];
    expect(q.state).toBe('unverified');
    expect(q.outdated).toBe(true);
    expect(byId(g, 'api').status).toBe('built');
    expect(messages(g, 'outdated-report')[0]).toContain('older than the code');
    expect(show(g, 'api:rejects-empty')).toContain('report older than the code');
  });

  it('keeps a failure until a newer run says otherwise', () => {
    junit([['tests/api.test.ts', 'rejects an empty order', false]]);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'src/api/server.ts'), later, later);
    expect(byId(compile(root), 'api').requirements[0].state).toBe('failing');
  });

  it('does not fail a finished change for want of a report, and does when a report disagrees', () => {
    write('armature/changes/orders.yaml', 'title: Orders\nstate: done\n');
    write('armature/nodes/api.yaml', fs.readFileSync(path.join(root, 'armature/nodes/api.yaml'), 'utf8').replace('    tests: tests/api.test.ts', '    tests: tests/api.test.ts\n    change: orders'));
    // A fresh checkout, or CI with no test step: nothing can be said, so nothing is claimed.
    let g = compile(root);
    expect(codes(g, 'error')).toEqual([]);
    expect(messages(g, 'done-unchecked')[0]).toContain('there is no test report');
    // A report that ran other tests and not this one is a real gap.
    junit([['tests/other.test.ts', 'something else', true]]);
    g = compile(root);
    expect(messages(g, 'not-done')[0]).toContain('requirement "api:rejects-empty" is not verified');
    junit([['tests/api.test.ts', 'rejects an empty order', true]]);
    expect(codes(compile(root), 'error')).toEqual([]);
  });

  it('says so when "done" proves nothing', () => {
    write('armature/changes/export.yaml', 'title: Export\nstate: done\n');
    write('armature/nodes/api.yaml', fs.readFileSync(path.join(root, 'armature/nodes/api.yaml'), 'utf8').replace('sends:', '  - id: export\n    via: http\n    route: GET /export\n    change: export\nsends:'));
    // No code index here, so the interface cannot be looked for.
    expect(messages(compile(root), 'done-unchecked')[0]).toContain('nothing in it can be checked');
  });
});

describe('ownership', () => {
  it('reports two nodes that claim the same files', () => {
    write('src/shared/util.ts', 'export const s = 1;\n');
    for (const n of ['api', 'billing']) write(`armature/nodes/${n}.yaml`, fs.readFileSync(path.join(root, `armature/nodes/${n}.yaml`), 'utf8').replace(/code: \[(.*)\]/, 'code: [$1, src/shared/**]'));
    const g = compile(root);
    expect(messages(g, 'overlap')[0]).toContain('"api" and "billing" both claim 1 file (src/shared/util.ts)');
    // A parent and its child sharing a glob is how nesting works, not an overlap.
    write('armature/nodes/api/_group.yaml', 'kind: group\nrole: order API\ncode: [src/api/**]\n');
    write('armature/nodes/api/http.yaml', 'kind: service\nrole: serves HTTP\ncode: [src/api/**]\n');
    fs.rmSync(path.join(root, 'armature/nodes/api.yaml'));
    expect(messages(compile(root), 'overlap').some((m) => m.includes('api.http'))).toBe(false);
  });

  it('lets a node that is being built have globs with no files yet', () => {
    write('armature/changes/refunds.yaml', 'title: Refunds\nstate: approved\n');
    write('armature/nodes/refunds.yaml', 'kind: worker\nrole: refunds orders\ncode: [src/refunds/**, src/refund-jobs/**]\nchange: refunds\n');
    write('src/refunds/worker.ts', 'export const r = 1;\n');
    let g = compile(root);
    expect(codes(g, 'error')).toEqual([]);
    expect(byId(g, 'refunds').status).toBe('building');
    // Once the change is finished, a glob that matches nothing is a mistake again.
    write('armature/changes/refunds.yaml', 'title: Refunds\nstate: done\n');
    g = compile(root);
    expect(codes(g, 'error')).toContain('dead-glob');
  });

  it('flags code that was written before its change was approved', () => {
    write('armature/changes/refunds.yaml', 'title: Refunds\nstate: proposed\n');
    write('armature/nodes/refunds.yaml', 'kind: worker\nrole: refunds orders\ncode: [src/refunds/**]\nchange: refunds\n');
    expect(codes(compile(root))).not.toContain('built-unapproved');
    write('src/refunds/worker.ts', 'export const r = 1;\n');
    expect(messages(compile(root), 'built-unapproved')[0]).toContain('"refunds" already has code');
  });
});

describe('the language', () => {
  it('lets a consumer read from a queue it does not own', () => {
    write('armature/nodes/events.yaml', node(['kind: queue', 'role: carries order events', 'accepts:', '  - id: order-placed', '    via: kafka', '    takes: Order']));
    write('armature/nodes/billing.yaml', `${fs.readFileSync(path.join(root, 'armature/nodes/billing.yaml'), 'utf8')}reads: [events#order-placed]\n`);
    let g = compile(root);
    expect(codes(g)).not.toContain('verb');
    const e = g.edges.find((x) => x.owner === 'billing' && x.verb === 'reads')!;
    expect([e.from, e.to, e.async]).toEqual(['events', 'billing', true]);
    // Publishing is "sends"; writing to a queue is still questioned, with the fix named.
    write('armature/nodes/api.yaml', `${fs.readFileSync(path.join(root, 'armature/nodes/api.yaml'), 'utf8')}`.replace('writes: [db#orders]', 'writes: [db#orders, events#order-placed]'));
    g = compile(root);
    expect(messages(g, 'verb')[0]).toContain('Publishing to a queue is "sends"');
  });

  it('reads the answer to a call as a flow step', () => {
    write('armature/flows/checkout.yaml', 'headline: The buyer pays and gets a receipt.\nsteps:\n  - buyer -> api#checkout\n  - api#checkout -> buyer\n');
    const g = compile(root);
    expect(codes(g, 'error')).toEqual([]);
    expect(g.flows[0].steps.map((s) => !!s.reply)).toEqual([false, true]);
    expect(show(g, 'checkout')).toContain('2. api -> buyer: Receipt (the answer to buyer calling api#checkout)');
    // Data that never comes back is still not a step.
    write('armature/flows/checkout.yaml', 'headline: The buyer pays.\nsteps:\n  - billing -> api\n');
    expect(codes(compile(root), 'error')).toContain('flow-step');
  });

  it('names a link, so a flow, a document and a query can point at it', () => {
    write('armature/nodes/pay.yaml', node(['kind: external', 'role: card processor', 'accepts:', '  - id: charges', '    via: http']));
    write('armature/shapes/pay.yaml', 'ChargeRequest:\n  fields:\n    amount: money\nRefundRequest:\n  fields:\n    amount: money\n');
    write('armature/nodes/billing.yaml', `${fs.readFileSync(path.join(root, 'armature/nodes/billing.yaml'), 'utf8')}calls:\n  - to: pay#charges\n    id: charge-card\n    takes: ChargeRequest\n  - to: pay#charges\n    id: refund-card\n    takes: RefundRequest\n`);
    write('armature/flows/refund.yaml', 'headline: A refund goes back to the card.\nsteps:\n  - billing~refund-card\n');
    write('armature/docs/guides/refunds.md', '---\nkind: guide\nabout: [billing~refund-card]\n---\n# Refunds\n\nSee [[billing~refund-card]].\n');
    let g = compile(root);
    expect(codes(g, 'error')).toEqual([]);
    const e = g.edges.find((x) => x.ref === 'billing~refund-card')!;
    expect(g.flows[0].steps[0].edge).toBe(e.id);
    expect(show(g, 'billing~refund-card')).toContain('RefundRequest');
    expect(impact(g, 'billing~refund-card')).toContain('flows: refund');
    expect(g.docs.find((d) => d.path.endsWith('refunds.md'))!.refs[0]).toMatchObject({ type: 'link', id: 'billing~refund-card' });
    // A step that names the interface cannot tell the two links apart, and says so.
    write('armature/flows/refund.yaml', 'headline: A refund goes back to the card.\nsteps:\n  - billing -> pay#charges\n');
    g = compile(root);
    expect(messages(g, 'ambiguous-step')[0]).toContain('matches 2 links that carry different data');
  });

  it('resolves a name one way everywhere, and says when it has several meanings', () => {
    write('armature/changes/refunds.yaml', 'title: Refunds\nstate: proposed\n');
    write('armature/nodes/refunds.yaml', 'kind: worker\nrole: refunds orders\ncode: [src/refunds/**]\nchange: refunds\naccepts:\n  - id: run\n    via: pgmq\n');
    write('armature/flows/refunds.yaml', 'headline: A refund.\nchange: refunds\nsteps:\n  - buyer -> api#checkout\n');
    write('armature/docs/plans/refunds.md', '---\nkind: plan\nchange: refunds\n---\n# Refunds\n\nThe [[refunds]] worker.\n');
    let g = compile(root);
    expect(show(g, 'refunds')).toContain('node refunds (worker)');
    expect(show(g, 'refunds')).toContain('"refunds" also names: flow:refunds, change:refunds');
    expect(show(g, 'flow:refunds')).toContain('flow refunds: A refund.');
    expect(show(g, 'change:refunds')).toContain('change refunds [proposed]');
    expect(messages(g, 'ambiguous-reference')[0]).toContain('refunds (read as the node; also flow:refunds, change:refunds)');
    write('armature/docs/plans/refunds.md', '---\nkind: plan\nchange: refunds\n---\n# Refunds\n\nThe [[node:refunds]] worker runs the [[flow:refunds]] flow.\n');
    g = compile(root);
    expect(codes(g)).not.toContain('ambiguous-reference');
    expect(g.docs.find((d) => d.path.endsWith('refunds.md'))!.refs.map((r) => r.type).sort()).toEqual(['flow', 'node']);
  });

  it('says which nodes a short name could mean', () => {
    write('armature/nodes/a/_group.yaml', 'kind: group\nrole: first half\n');
    write('armature/nodes/a/store.yaml', 'kind: store\nrole: first store\n');
    write('armature/nodes/b/_group.yaml', 'kind: group\nrole: second half\n');
    write('armature/nodes/b/store.yaml', 'kind: store\nrole: second store\n');
    write('armature/nodes/billing.yaml', `${fs.readFileSync(path.join(root, 'armature/nodes/billing.yaml'), 'utf8')}reads: [store]\n`);
    expect(messages(compile(root), 'reference').join(' ')).toContain('"store" could be a.store or b.store. Write the full id.');
  });

  it('enforces a boundary a node declares, against links and against imports', async () => {
    write('armature/nodes/web.yaml', node(['kind: app', 'role: shop front', 'code: [src/web/**]', 'never:', '  - to: db', '    why: The shop front reaches data through the API only.', 'calls: [api#checkout]']));
    write('src/web/cart.ts', 'export const cart = 1;\n');
    await buildCodeIndex(root);
    expect(codes(compile(root), 'error')).toEqual([]);
    // A link across the boundary.
    write('armature/nodes/web.yaml', `${fs.readFileSync(path.join(root, 'armature/nodes/web.yaml'), 'utf8')}reads: [db#orders]\n`);
    let g = compile(root);
    expect(messages(g, 'boundary')[0]).toContain('"web" must never touch "db" (The shop front reaches data through the API only.), but: web reads db#orders');
    // An import across another boundary.
    write('armature/nodes/web.yaml', node(['kind: app', 'role: shop front', 'code: [src/web/**]', 'never: [billing]', 'calls: [api#checkout]']));
    write('src/web/cart.ts', "import { y } from '../billing/charge';\nexport const cart = y;\n");
    await buildCodeIndex(root);
    g = compile(root);
    expect(messages(g, 'boundary')[0]).toContain('web imports code of billing');
    expect(byId(g, 'web').never).toEqual([{ node: 'billing', why: undefined, from: 'web' }]);
  });

  it('lets a requirement cover a flow, an interface or a shape', () => {
    write('armature/flows/checkout.yaml', 'headline: The buyer pays.\nsteps:\n  - buyer -> api#checkout\n');
    write('armature/nodes/api.yaml', fs.readFileSync(path.join(root, 'armature/nodes/api.yaml'), 'utf8').replace('    tests: tests/api.test.ts', '    tests: tests/api.test.ts\n    covers: [checkout, api#checkout, Order, nothing-here]'));
    const g = compile(root);
    expect(byId(g, 'api').requirements[0].covers).toEqual(['checkout', 'api#checkout', 'Order']);
    expect(g.flows[0].requirements).toEqual(['api:rejects-empty']);
    expect(show(g, 'checkout')).toContain('requirements that cover it:');
    expect(impact(g, 'Order')).toContain('requirements that cover it:');
    expect(messages(g, 'reference').join(' ')).toContain('covers "nothing-here"');
  });

  it('tags what a change alters without calling it planned', async () => {
    write('armature/changes/coupons.yaml', 'title: Coupons\nstate: proposed\n');
    write('src/api/body.ts', "import { z } from 'zod';\nexport const orderBody = z.object({\n  id: z.string().uuid(),\n  email: z.string().email(),\n});\n");
    write('armature/shapes/order.yaml', 'Order:\n  source: src/api/body.ts#orderBody\n  modify: coupons\n  fields:\n    id: uuid\n    email: email @pii\n    coupon: string?\nReceipt:\n  fields:\n    id: uuid\n');
    write('armature/nodes/api.yaml', fs.readFileSync(path.join(root, 'armature/nodes/api.yaml'), 'utf8').replace('    gives: Receipt', '    gives: Receipt\n    modify: coupons'));
    await buildCodeIndex(root);
    let g = compile(root);
    const iface = g.nodes.flatMap((n) => n.interfaces).find((i) => i.ref === 'api#checkout')!;
    expect(iface.status).toBe('built');
    const change = g.changes.find((c) => c.id === 'coupons')!;
    expect(change.interfaces).toContain('api#checkout');
    expect(change.elements).toEqual(['modify interface api#checkout', 'modify shape Order']);
    // The field only the model lists is planned, not a disagreement with the code.
    const order = g.shapes.find((s) => s.id === 'Order')!;
    expect(order.fields.find((f) => f.name === 'coupon')?.tags).toContain('planned');
    expect(order.fields.find((f) => f.name === 'email')?.tags).toContain('pii');
    expect(codes(g)).not.toContain('shape-fields');
    // Without the tag, the same file is drift.
    write('armature/shapes/order.yaml', fs.readFileSync(path.join(root, 'armature/shapes/order.yaml'), 'utf8').replace('  modify: coupons\n', ''));
    g = compile(root);
    expect(codes(g)).toContain('shape-fields');
  });

  it('orders changes, and refuses a cycle', () => {
    write('armature/changes/one.yaml', 'title: First\nstate: approved\n');
    write('armature/changes/two.yaml', 'title: Second\nstate: done\nafter: one\n');
    write('armature/nodes/billing.yaml', `${fs.readFileSync(path.join(root, 'armature/nodes/billing.yaml'), 'utf8')}change: one\n`);
    write('armature/nodes/db.yaml', 'kind: store\nrole: orders database\nholds:\n  - { id: orders, shape: Order }\n  - { id: refunds, change: two }\n');
    let g = compile(root);
    expect(messages(g, 'not-done')[0]).toContain('it comes after "one", which is not done');
    expect(g.changes.find((c) => c.id === 'two')!.waits).toEqual(['one']);
    write('armature/changes/one.yaml', 'title: First\nstate: approved\nafter: two\n');
    g = compile(root);
    expect(messages(g, 'cycle')[0]).toMatch(/one -> two -> one|two -> one -> two/);
  });

  it('follows data across several links, and to where it leaves the system', () => {
    write('armature/nodes/mail.yaml', node(['kind: external', 'role: sends email', 'accepts:', '  - id: send', '    via: http']));
    write('armature/shapes/batch.yaml', 'OrderBatch:\n  fields:\n    orders: Order[]\n');
    write('armature/nodes/billing.yaml', `${fs.readFileSync(path.join(root, 'armature/nodes/billing.yaml'), 'utf8')}calls:\n  - to: mail#send\n    takes: OrderBatch\n`);
    const g = compile(root);
    expect(pathText(g, 'buyer', 'mail')).toContain('Data gets from buyer to mail in 3 steps:');
    expect(pathText(g, 'mail', 'buyer')).toContain('The other way, buyer reaches mail in 3 steps');
    expect(pathText(g, 'db', 'mail')).toContain('No declared links connect db and mail');
    // The answer to a call is data too.
    expect(pathText(g, 'api', 'buyer')).toContain('(the answer to buyer calling api#checkout)');
    const out = impact(g, 'buyer');
    expect(out).toContain('its data goes on to: billing (2 links away), db (2 links away), mail (3 links away)');
    expect(impact(g, 'Order')).toContain('shape OrderBatch embeds it');
    const trace = traceText(g, '@pii');
    expect(trace).toContain('@pii marks 1 field: Order.email');
    expect(trace).toContain('also carried inside: OrderBatch (embeds Order)');
    expect(trace).toContain('held in:\n  db#orders');
    expect(trace).toContain('leaves the system to:\n  mail:');
    expect(traceText(g, 'Receipt')).toContain('comes back to buyer');
  });
});

describe('warnings a team has looked at', () => {
  it('drops an accepted warning, counts it, and notices when the entry goes stale', () => {
    expect(codes(compile(root))).toContain('no-requirement');
    fs.appendFileSync(path.join(root, 'armature/system.yaml'), 'accept:\n  - code: no-requirement\n    ref: billing\n    why: The worker is a thin wrapper; the API tests cover it.\n  - code: runtime-drift\n    ref: api\n');
    const g = compile(root);
    expect(messages(g, 'no-requirement')).toEqual([]);
    expect(g.accepted).toBe(1);
    expect(messages(g, 'stale-accept')[0]).toContain('runtime-drift api');
    expect(messages(g, 'accept-reason')[0]).toContain('runtime-drift api');
  });
});

describe('documents', () => {
  it('knows which decision replaced which', () => {
    write('armature/docs/decisions/queue.md', '---\nkind: decision\nabout: [billing]\n---\n# Use pgmq\n\nWe queue charges in Postgres because it is already there.\n');
    write('armature/docs/decisions/queue-2.md', '---\nkind: decision\nabout: [billing]\nsupersedes: queue.md\n---\n# Use Temporal\n\nRetries got too complex for a plain queue, so workflows replace it.\n');
    write('armature/docs/decisions/gone.md', '---\nkind: decision\nsupersedes: armature/docs/decisions/never-was.md\n---\n# Another\n\nThis one names a decision that does not exist any more.\n');
    const g = compile(root);
    const doc = (name: string) => g.docs.find((d) => d.path.endsWith(name))!;
    expect(doc('queue.md').supersededBy).toBe('armature/docs/decisions/queue-2.md');
    expect(doc('queue-2.md').supersedes).toEqual(['armature/docs/decisions/queue.md']);
    expect(messages(g, 'doc-reference').join(' ')).toContain('supersedes "armature/docs/decisions/never-was.md"');
  });
});
