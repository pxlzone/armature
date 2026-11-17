// The tools that act on the model: diff between commits, rename, and the warning baseline.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { newSince, readBaseline, writeBaseline } from '../src/baseline.js';
import { compile } from '../src/compile.js';
import { diffModel, diffText } from '../src/diff.js';
import { readApprovals } from '../src/paths.js';
import { rename } from '../src/rename.js';
import { approveChange } from '../src/approve.js';

let root: string;
const write = (rel: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const git = (...args: string[]): void => void execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd: root, stdio: 'ignore' });
const errors = (): string[] => compile(root).problems.filter((p) => p.level === 'error').map((p) => `${p.code}: ${p.message}`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-tools-'));
  write('armature/system.yaml', 'name: Shop\nheadline: Takes orders and charges cards.\nactors:\n  - id: buyer\n    role: places orders\n    calls: [api#checkout]\n');
  write('armature/nodes/api.yaml', [
    'kind: service', 'role: order API', 'code: [src/api/**]', 'never: [db]',
    'accepts:', '  - id: checkout', '    via: http', '    route: POST /checkout', '    takes: Order',
    'sends:', '  - to: billing#charge', '    id: queue-charge',
    'requirements:', '  - id: rejects-empty', '    text: An empty order is rejected.', '    covers: [checkout, billing#charge, Order]', '',
  ].join('\n'));
  write('armature/nodes/billing.yaml', 'kind: worker\nrole: charges the card\ncode: [src/billing/**]\naccepts:\n  - id: charge\n    via: pgmq\n    takes: Order\nwrites: [db#orders]\n');
  write('armature/nodes/db.yaml', 'kind: store\nrole: orders database\nholds:\n  - { id: orders, shape: Order }\n');
  write('armature/shapes/order.yaml', '# What a buyer sends.\nOrder:\n  fields:\n    id: uuid\n    lines: OrderLine[]\nOrderLine:\n  fields:\n    sku: string\n');
  write('armature/flows/checkout.yaml', 'headline: An order is stored, then charged.\nsteps:\n  - buyer -> api#checkout\n  - step: api -> billing#charge\n    note: Asynchronous.\n  - billing -> db#orders\n');
  write('armature/docs/guides/orders.md', '---\nkind: guide\nabout: [billing, api#checkout, Order]\n---\n# Orders\n\nThe [[billing]] worker takes an [[Order]] from [[api#checkout]] through [[api~queue-charge]], as the [[checkout]] flow shows.\nIn code: `[[billing]]` stays as written.\n');
  write('src/api/server.ts', 'export const x = 1;\n');
  write('src/billing/charge.ts', 'export const y = 1;\n');
});

describe('armature diff', () => {
  it('lists what a branch adds, changes and removes in the model', () => {
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'feat: model');
    expect(diffText(diffModel(root, 'HEAD'))).toBe('The model declares the same things as at HEAD.');

    write('armature/nodes/mail.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/mail/**]\nchange: mail\naccepts:\n  - id: paid\n    via: pgmq\n    takes: Order\n');
    write('armature/changes/mail.yaml', 'title: Receipts by email\nstate: proposed\n');
    write('armature/nodes/billing.yaml', `${read('armature/nodes/billing.yaml')}sends: [mail#paid]\n`);
    write('armature/shapes/order.yaml', read('armature/shapes/order.yaml').replace('    id: uuid\n', '    id: uuid\n    email: email @pii\n'));
    write('armature/nodes/api.yaml', read('armature/nodes/api.yaml').replace('role: order API', 'role: order and refund API').replace('never: [db]\n', ''));
    write('armature/flows/checkout.yaml', read('armature/flows/checkout.yaml').replace('  - billing -> db#orders\n', ''));
    const d = diffModel(root, 'HEAD');
    if (typeof d === 'string') throw new Error(d);
    const text = diffText(d);
    expect(text).toContain('+ node mail (worker): sends receipts  [src/mail/**]  (change mail)');
    expect(text).toContain('+ interface mail#paid via pgmq takes Order');
    expect(text).toContain('+ link billing sends mail#paid via pgmq: Order');
    expect(text).toContain('+ change mail [proposed] Receipts by email');
    expect(text).toContain('~ shape Order\n    + field email: email @pii');
    expect(text).toContain('~ node api\n    role: was order API; now order and refund API\n    - never: db');
    expect(text).toContain('~ flow checkout');
    expect(d.removed).toEqual([]);

    fs.rmSync(path.join(root, 'armature/nodes/db.yaml'));
    const gone = diffModel(root, 'HEAD');
    expect(typeof gone === 'string' ? [] : gone.removed).toEqual(['node db', 'interface db#orders', 'link billing writes db#orders']);
    expect(diffModel(root, 'no-such-branch')).toContain('is not a commit, branch or tag');
  });
});

describe('armature rename', () => {
  it('moves a node into a group and rewrites every reference', () => {
    write('armature/nodes/money/_group.yaml', 'kind: group\nrole: everything about money\n');
    const out = rename(root, 'billing', 'money.charger');
    expect(out).toContain('Renamed node billing to money.charger.');
    expect(fs.existsSync(path.join(root, 'armature/nodes/money/charger.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'armature/nodes/billing.yaml'))).toBe(false);
    expect(errors()).toEqual([]);
    expect(read('armature/nodes/api.yaml')).toContain('to: money.charger#charge');
    expect(read('armature/nodes/api.yaml')).toContain('covers: [checkout, money.charger#charge, Order]');
    expect(read('armature/flows/checkout.yaml')).toContain('step: api -> money.charger#charge');
    expect(read('armature/flows/checkout.yaml')).toContain('- money.charger -> db#orders');
    const doc = read('armature/docs/guides/orders.md');
    expect(doc).toContain('about: [money.charger, api#checkout, Order]');
    expect(doc).toContain('The [[money.charger]] worker');
    // What is written as code in a document is not a reference.
    expect(doc).toContain('`[[billing]]` stays as written');
    const g = compile(root);
    expect(g.flows[0].steps.every((s) => s.edge)).toBe(true);
    expect(g.docs[0].broken).toEqual([]);
  });

  it('rewrites a name that would start to mean another node', () => {
    write('armature/nodes/money/_group.yaml', 'kind: group\nrole: everything about money\n');
    write('armature/nodes/money/db.yaml', 'kind: store\nrole: ledger database\n');
    // "db" now names two nodes only if written short; the existing references are to the top-level one.
    expect(errors()).toEqual([]);
    rename(root, 'db', 'money.orders-db');
    expect(read('armature/nodes/billing.yaml')).toContain('writes: [money.orders-db#orders]');
    expect(read('armature/nodes/api.yaml')).toContain('never: [money.orders-db]');
    expect(errors()).toEqual([]);
  });

  it('renames an interface, a link, a requirement, a shape, a flow and a change', () => {
    expect(rename(root, 'api#checkout', 'place-order')).toContain('Renamed interface api#checkout to api#place-order.');
    expect(read('armature/nodes/api.yaml')).toContain('- id: place-order');
    expect(read('armature/system.yaml')).toContain('calls: [api#place-order]');
    expect(read('armature/flows/checkout.yaml')).toContain('- buyer -> api#place-order');
    expect(read('armature/docs/guides/orders.md')).toContain('from [[api#place-order]]');

    rename(root, 'api~queue-charge', 'enqueue');
    expect(read('armature/nodes/api.yaml')).toContain('id: enqueue');
    expect(read('armature/docs/guides/orders.md')).toContain('[[api~enqueue]]');

    rename(root, 'api:rejects-empty', 'refuses-empty');
    expect(read('armature/nodes/api.yaml')).toContain('- id: refuses-empty');

    rename(root, 'Order', 'Purchase');
    const shapes = read('armature/shapes/order.yaml');
    expect(shapes).toContain('Purchase:\n');
    // A longer name that starts the same is another shape.
    expect(shapes).toContain('lines: OrderLine[]');
    expect(shapes).toContain('# What a buyer sends.');
    expect(read('armature/nodes/db.yaml')).toContain('shape: Purchase');
    expect(read('armature/nodes/api.yaml')).toContain('takes: Purchase');
    expect(read('armature/docs/guides/orders.md')).toContain('takes an [[Purchase]]');

    rename(root, 'flow:checkout', 'buy');
    expect(fs.existsSync(path.join(root, 'armature/flows/buy.yaml'))).toBe(true);
    expect(read('armature/nodes/api.yaml')).toContain('covers: [buy, billing#charge, Purchase]');
    expect(read('armature/docs/guides/orders.md')).toContain('the [[buy]] flow');

    write('armature/changes/mail.yaml', 'title: Receipts by email\nstate: proposed\n');
    write('armature/nodes/mail.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/mail/**]\nchange: mail\n');
    approveChange(root, 'mail', 'Sam');
    rename(root, 'change:mail', 'receipts');
    expect(read('armature/nodes/mail.yaml')).toContain('change: receipts');
    expect(Object.keys(readApprovals(root))).toEqual(['receipts']);
    expect(errors()).toEqual([]);
    expect(compile(root).problems.map((p) => p.code)).not.toContain('scope-changed');
  });

  it('refuses a name that is taken or malformed', () => {
    expect(rename(root, 'billing', 'api')).toBe('Node "api" already exists.');
    expect(rename(root, 'billing', 'nowhere.charger')).toContain('"nowhere" is not a node');
    expect(rename(root, 'Order', 'order')).toContain('is not a shape name');
    expect(rename(root, 'api#checkout', 'Check Out')).toContain('is not a valid name');
    expect(rename(root, 'ghost', 'x')).toBe('Nothing named "ghost".');
    expect(errors()).toEqual([]);
  });
});

describe('the warning baseline', () => {
  it('sets today\'s warnings aside and shows only what comes after', () => {
    const before = compile(root).problems;
    expect(readBaseline(root)).toBeNull();
    const n = writeBaseline(root, before);
    expect(n).toBe(before.filter((p) => p.level === 'warning').length);
    expect(newSince(compile(root).problems, readBaseline(root)!)).toEqual([]);
    // One more of a kind that was already there is still new.
    write('armature/nodes/mail.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/mail/**]\n');
    write('src/mail/send.ts', 'export const z = 1;\n');
    const fresh = newSince(compile(root).problems, readBaseline(root)!);
    expect(fresh.map((p) => `${p.code} ${p.ref}`)).toEqual(['no-requirement mail']);
  });
});
