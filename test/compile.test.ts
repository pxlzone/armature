import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { compile, confirmShapes } from '../src/compile.js';
import { impact, orient, show, where } from '../src/render.js';

let root: string;

function write(rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function base(): void {
  write('armature/system.yaml', 'name: Shop\nheadline: Takes orders and charges cards.\nactors:\n  - id: buyer\n    role: places orders\n    calls: [api]\nrules:\n  - Never log card numbers.\n');
  write('armature/nodes/api.yaml', [
    'kind: service', 'role: order API', 'hub: true', 'code: [src/api/**]', 'tests: [tests/api.test.ts]',
    'accepts:', '  - id: checkout', '    via: http', '    route: POST /checkout', '    takes: Order',
    'sends:', '  - to: billing#charge', 'writes: [db#orders]',
    'requirements:', '  - id: rejects-empty', '    text: An empty order is rejected.',
    'rules:', '  - Validate input at the edge.', '',
  ].join('\n'));
  write('armature/nodes/billing.yaml', [
    'kind: worker', 'role: charges the card', 'code: [src/billing/**]',
    'accepts:', '  - id: charge', '    via: pgmq', '    takes: Order',
    'requirements:', '  - id: retries', '    text: A failed charge is retried.', '    tests: tests/billing.test.ts', '',
  ].join('\n'));
  write('armature/nodes/db.yaml', 'kind: store\nrole: orders database\nholds:\n  - { id: orders, shape: Order }\n');
  write('armature/nodes/email.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/email/**]\nchange: receipts\naccepts:\n  - id: paid\n    via: pgmq\n    takes: Order\n');
  write('armature/shapes/order.yaml', 'Order:\n  source: src/api/order.ts#Order\n  fields:\n    id: uuid\n    total: money\n    email: email @pii\n');
  write('armature/flows/checkout.yaml', 'headline: An order is stored, then charged.\nsteps:\n  - buyer -> api\n  - api -> db#orders\n  - step: api -> billing#charge\n    note: Asynchronous.\n');
  write('armature/changes/receipts.yaml', 'title: Email receipts\nstate: approved\norder: 1\n');
  write('src/api/order.ts', 'export interface Order {\n  id: string;\n  total: number;\n  email: string;\n}\n');
  write('src/api/server.ts', 'export const x = 1;\n');
  write('src/billing/charge.ts', 'export const y = 1;\n');
  write('tests/api.test.ts', '');
  write('tests/billing.test.ts', '');
}

function junit(cases: Array<[string, string, boolean]>): string {
  const body = cases.map(([file, name, ok]) => `<testcase classname="${file}" name="${name}">${ok ? '' : '<failure message="boom"/>'}</testcase>`).join('');
  return `<?xml version="1.0"?><testsuites><testsuite name="all">${body}</testsuite></testsuites>`;
}

const byId = (g: ReturnType<typeof compile>, id: string) => g.nodes.find((n) => n.id === id)!;
const errors = (g: ReturnType<typeof compile>) => g.problems.filter((p) => p.level === 'error');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-'));
  base();
});

describe('status', () => {
  it('computes planned and built from files alone', () => {
    const g = compile(root);
    expect(errors(g)).toEqual([]);
    expect(byId(g, 'api').status).toBe('built');
    expect(byId(g, 'email').status).toBe('planned');
    expect(byId(g, 'db').status).toBe('built');
    expect(g.edges.find((e) => e.to === 'billing')!.async).toBe(true);
  });

  it('marks a node building once files exist while its change is open', () => {
    write('src/email/send.ts', 'export const z = 1;\n');
    expect(byId(compile(root), 'email').status).toBe('building');
  });

  it('verifies requirements from tagged test titles and from listed test files', () => {
    write('armature/.cache/reports/unit.xml', junit([
      ['tests/api.test.ts', 'rejects an empty order [req api:rejects-empty]', true],
      ['tests/billing.test.ts', 'retries a failed charge', true],
    ]));
    const g = compile(root);
    expect(byId(g, 'api').status).toBe('verified');
    expect(byId(g, 'billing').status).toBe('verified');
    expect(byId(g, 'api').testSummary).toMatchObject({ passed: 1, failed: 0 });
  });

  it('marks a node failing when a linked test fails', () => {
    write('armature/.cache/reports/unit.xml', junit([['tests/billing.test.ts', 'retries a failed charge', false]]));
    const g = compile(root);
    expect(byId(g, 'billing').status).toBe('failing');
    expect(byId(g, 'billing').requirements[0].state).toBe('failing');
  });

  it('rolls coverage up through code globs', () => {
    write('armature/.cache/reports/cov.info', `SF:${path.join(root, 'src/api/server.ts')}\nLF:10\nLH:7\nend_of_record\nSF:src/api/order.ts\nDA:1,1\nDA:2,0\nend_of_record\n`);
    expect(byId(compile(root), 'api').coverage).toBe(67);
  });
});

describe('shapes', () => {
  it('flags a shape stale after its source changes, until it is confirmed again', () => {
    expect(compile(root).problems.some((p) => p.code === 'unconfirmed')).toBe(true);
    confirmShapes(root, []);
    let g = compile(root);
    expect(g.shapes[0].bound).toBe(true);
    write('src/api/order.ts', 'export interface Order {\n  id: string;\n  total: number;\n  email: string;\n  currency: string;\n}\n');
    g = compile(root);
    expect(g.shapes[0].stale).toBe(true);
    expect(byId(g, 'api').status).toBe('stale');
    confirmShapes(root, ['Order']);
    expect(compile(root).shapes[0].stale).toBe(false);
  });
});

describe('checks', () => {
  it('refuses a change marked done while a node has no code', () => {
    write('armature/changes/receipts.yaml', 'title: Email receipts\nstate: done\n');
    expect(errors(compile(root)).map((p) => p.code)).toContain('not-done');
  });

  it('reports broken references, unknown flow steps and long role lines', () => {
    write('armature/nodes/extra.yaml', 'kind: service\nrole: one two three four five six\ncalls:\n  - to: nowhere#x\n  - to: api#missing\n');
    write('armature/flows/bad.yaml', 'headline: Broken.\nsteps:\n  - billing -> api\n');
    const codes = errors(compile(root)).map((p) => p.code);
    expect(codes.filter((c) => c === 'reference').length).toBe(2);
    expect(codes).toContain('flow-step');
    expect(codes).toContain('role');
  });

  it('enforces the node budget and reports unowned source files', () => {
    for (let i = 0; i < 9; i++) write(`armature/nodes/n${i}.yaml`, 'kind: external\nrole: filler\n');
    write('src/orphan/thing.ts', 'export {};\n');
    const g = compile(root);
    expect(errors(g).map((p) => p.code)).toContain('budget');
    // Coverage counts every file: the stray file, and a test file no node's tests glob claims.
    expect(g.unowned).toEqual(['src/orphan/thing.ts', 'tests/billing.test.ts']);
  });

  it('rejects unknown keys with the file name', () => {
    write('armature/nodes/api.yaml', 'kind: service\nrole: order API\ncolour: red\n');
    const e = errors(compile(root)).find((p) => p.code === 'schema')!;
    expect(e.message).toContain('colour');
    expect(e.file).toBe('armature/nodes/api.yaml');
  });
});

describe('answers for agents', () => {
  it('orients, locates a file and inherits rules', () => {
    const g = compile(root);
    expect(orient(g)).toContain('api (service): order API');
    const w = where(g, 'src/api/server.ts');
    expect(w).toContain('node api');
    expect(w).toContain('Never log card numbers. (from system)');
    expect(w).toContain('Validate input at the edge.');
    expect(where(g, 'README.md')).toContain('No node owns');
  });

  it('shows interfaces and the impact of changing a shape', () => {
    const g = compile(root);
    expect(show(g, 'billing#charge')).toContain('api -> billing#charge: Order (sends via pgmq)');
    const i = impact(g, 'Order');
    expect(i).toContain('interface api#checkout');
    expect(i).toContain('link api -> db#orders');
  });
});

describe('node tags', () => {
  it('reads free labels from a node, lists them, and refuses one that is not a slug', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { compile } = await import('../src/compile.js');
    const { show, tagsText } = await import('../src/render.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-tags-'));
    const write = (rel: string, body: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    };
    write('armature/system.yaml', 'name: Shop\nheadline: Sells things.\n');
    write('armature/nodes/api.yaml', 'kind: service\nrole: order API\ntags: [critical, legacy, critical]\n');
    write('armature/nodes/mail.yaml', 'kind: worker\nrole: sends receipts\ntags: legacy\n');
    const g = compile(root);
    expect(g.problems.filter((p) => p.level === 'error')).toEqual([]);
    expect(g.nodes.find((n) => n.id === 'api')?.tags).toEqual(['critical', 'legacy']);
    expect(tagsText(g)).toBe('critical (1): api\nlegacy (2): api, mail');
    expect(tagsText(g, '#legacy')).toContain('mail (worker): sends receipts');
    expect(tagsText(g, 'nope')).toContain('Tags in use: critical, legacy');
    expect(show(g, 'api')).toContain('tags: critical, legacy');

    write('armature/nodes/mail.yaml', 'kind: worker\nrole: sends receipts\ntags: [Not A Slug]\n');
    expect(compile(root).problems.some((p) => p.level === 'error' && p.file?.endsWith('mail.yaml'))).toBe(true);
  });
});
