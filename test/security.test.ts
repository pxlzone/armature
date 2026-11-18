// Security in the model: who may call an entry point, what sensitive data is behind it, where data
// may leave the system, who may link to an interface, where secrets are held, and the gate around them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCodeIndex } from '../src/code.js';
import { compile } from '../src/compile.js';
import { contextText } from '../src/context.js';
import { readCodeIndex } from '../src/code.js';
import { diffModel, diffText } from '../src/diff.js';
import { bashGate, planModeNote, weakened, writeGate } from '../src/gate.js';
import { impact } from '../src/render.js';
import { changeSecurity, mustHold, surfaceText } from '../src/security.js';

let root: string;

function write(rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const node = (lines: string[]): string => `${lines.join('\n')}\n`;
const codes = (g: ReturnType<typeof compile>, level?: 'error' | 'warning'): string[] => g.problems.filter((p) => !level || p.level === level).map((p) => p.code);
const messages = (g: ReturnType<typeof compile>, code: string): string[] => g.problems.filter((p) => p.code === code).map((p) => p.message);

function base(): void {
  write('armature/system.yaml', [
    'name: Shop', 'headline: Takes orders and charges cards.',
    'actors:', '  - id: buyer', '    role: places orders', '    calls: [web#pages]',
    'externals:', '  - id: stripe', '    kind: external', '    role: card payments', '    accepts:', '      - { id: charges, via: http }',
    '  - id: tracker', '    kind: external', '    role: product analytics', '    accepts:', '      - { id: events, via: http }',
    '',
  ].join('\n'));
  write('armature/nodes/web.yaml', node([
    'kind: app', 'role: the storefront', 'client: true', 'code: [src/web/**]',
    'accepts:', '  - { id: pages, via: http, auth: none }',
    'calls:', '  - to: api#checkout',
  ]));
  write('armature/nodes/api.yaml', node([
    'kind: service', 'role: order API', 'code: [src/api/**]',
    'accepts:', '  - id: checkout', '    via: http', '    route: POST /checkout', '    takes: Order', '    gives: Receipt',
    'writes: [db#orders]',
  ]));
  write('armature/nodes/db.yaml', 'kind: store\nrole: orders database\nholds:\n  - { id: orders, shape: Order }\n');
  write('armature/shapes/order.yaml', 'Order:\n  fields:\n    id: uuid\n    email: email @pii\n    card: Card\nCard:\n  fields:\n    number: string @secret\nReceipt:\n  fields:\n    id: uuid\n');
  write('src/api/server.ts', "export const app = { post: (..._a: unknown[]) => undefined };\napp.post('/checkout', () => undefined);\n");
  write('src/web/main.ts', 'export const x = 1;\n');
}

const setApi = (fn: (s: string) => string): void => write('armature/nodes/api.yaml', fn(read('armature/nodes/api.yaml')));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-security-'));
  base();
});

describe('entry points and auth', () => {
  it('finds entry points from actors, outside systems and clients, and asks who may call them', () => {
    const g = compile(root);
    // web#pages is on a client node: the user's own device is not an entry point into the system.
    expect(messages(g, 'no-auth')).toHaveLength(1);
    expect(messages(g, 'no-auth')[0]).toContain('"api#checkout" is reached from web');
  });

  it('refuses an open entry point that reaches sensitive data, through the embedded shapes', () => {
    setApi((s) => s.replace('route: POST /checkout', 'route: POST /checkout\n    auth: none'));
    const g = compile(root);
    const m = messages(g, 'open-entry');
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('@pii (Order.email)');
    expect(m[0]).toContain('@secret (Card.number)');
  });

  it('asks for a security requirement behind an authenticated entry point, and takes one that covers it', () => {
    setApi((s) => s.replace('route: POST /checkout', 'route: POST /checkout\n    auth: user'));
    expect(codes(compile(root))).toContain('no-security-requirement');
    setApi((s) => `${s}requirements:\n  - id: own-orders\n    kind: security\n    text: A buyer sees only their own orders.\n    covers: [api#checkout]\n`);
    const g = compile(root);
    expect(codes(g)).not.toContain('no-security-requirement');
    expect(codes(g)).not.toContain('no-auth');
  });

  it('keeps a change from being done while its entry point has nothing proving who gets the data', () => {
    write('armature/changes/checkout.yaml', 'title: Checkout\nstate: done\n');
    setApi((s) => s.replace('route: POST /checkout', 'route: POST /checkout\n    auth: user\n    change: checkout'));
    const g = compile(root);
    expect(messages(g, 'not-done').some((m) => m.includes('no requirement of kind security'))).toBe(true);
  });
});

describe('data policy', () => {
  it('lets tagged data leave only to the places system.yaml lists, and never secrets by default', () => {
    setApi((s) => s.replace('writes: [db#orders]', 'writes: [db#orders]\ncalls:\n  - { to: stripe#charges, takes: Card }\n  - { to: tracker#events, takes: Order }'));
    write('armature/system.yaml', `${read('armature/system.yaml')}data:\n  pii: { leaves: [stripe] }\n`);
    const g = compile(root);
    const leaks = messages(g, 'data-leak');
    // Card.number is @secret: nowhere is allowed. Order goes to the tracker with both tags.
    expect(leaks.some((m) => m.includes('to "stripe"') && m.includes('@secret'))).toBe(true);
    expect(leaks.some((m) => m.includes('to "tracker"') && m.includes('@pii'))).toBe(true);
    expect(leaks.some((m) => m.includes('to "stripe"') && m.includes('@pii'))).toBe(false);
    expect(surfaceText(g)).toContain('NOT ALLOWED');
  });

  it('names a destination that does not exist', () => {
    write('armature/system.yaml', `${read('armature/system.yaml')}data:\n  pii: { leaves: [nobody] }\n`);
    expect(messages(compile(root), 'reference').some((m) => m.includes('@pii may leave to "nobody"'))).toBe(true);
  });
});

describe('only', () => {
  it('refuses a link from a node the interface does not allow, and a write to a table from a non-writer', () => {
    write('armature/nodes/db.yaml', 'kind: store\nrole: orders database\nholds:\n  - { id: orders, shape: Order, only: [api] }\n');
    write('armature/nodes/report.yaml', node(['kind: job', 'role: nightly report', 'reads: [db#orders]', 'writes: [db#orders]']));
    const g = compile(root);
    const m = messages(g, 'not-allowed');
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('report writes "db#orders"');
  });
});

describe('secrets', () => {
  it('reads credentials from the environment, and asks for the ones the model does not list', async () => {
    write('src/api/keys.ts', 'export const k = process.env.STRIPE_SECRET_KEY;\nexport const p = process.env.PORT;\n');
    write('src/web/env.ts', "export const t = import.meta.env.VITE_API_URL;\nexport const s = process.env['ADMIN_TOKEN'];\n");
    await buildCodeIndex(root);
    let g = compile(root);
    expect(messages(g, 'undeclared-secret')[0]).toContain('STRIPE_SECRET_KEY');
    expect(messages(g, 'undeclared-secret')[0]).not.toContain('PORT');
    // The client reads a credential: that is an error wherever it is declared.
    expect(messages(g, 'client-secret')[0]).toContain('ADMIN_TOKEN');
    setApi((s) => `${s}secrets: [STRIPE_SECRET_KEY]\n`);
    g = compile(root);
    expect(codes(g)).not.toContain('undeclared-secret');
    expect(surfaceText(g)).toContain('api: STRIPE_SECRET_KEY');
  });

  it('refuses a secret on a client node and a secret whose name ships it to the browser', () => {
    write('armature/nodes/web.yaml', `${read('armature/nodes/web.yaml')}secrets: [SESSION_KEY]\n`);
    setApi((s) => `${s}secrets: [NEXT_PUBLIC_STRIPE_KEY]\n`);
    const m = messages(compile(root), 'client-secret');
    expect(m.some((x) => x.includes('"web" runs on the user\'s device and holds secrets'))).toBe(true);
    expect(m.some((x) => x.includes('NEXT_PUBLIC_STRIPE_KEY'))).toBe(true);
  });
});

describe('planning with the constraints in view', () => {
  it('puts every constraint on the nodes a task touches in the context pack and in impact', async () => {
    setApi((s) => s.replace('route: POST /checkout', 'route: POST /checkout\n    auth: user\n    only: [web]') + 'protect: true\nsecrets: [STRIPE_SECRET_KEY]\nnever:\n  - { to: web, why: The API never imports UI code. }\nrules:\n  - Validate every body with zod.\n  - Log no request body.\n  - Keep handlers thin.\n');
    write('armature/system.yaml', `${read('armature/system.yaml')}data:\n  pii: { leaves: [] }\n`);
    await buildCodeIndex(root);
    const g = compile(root);
    const lines = mustHold(g, ['api']).join('\n');
    for (const want of ['protected', 'never touches web', 'api#checkout: auth user; only web may use it', 'holds secrets STRIPE_SECRET_KEY', 'Keep handlers thin', '@pii data may leave the system only to: nowhere']) expect(lines).toContain(want);
    const pack = contextText(g, readCodeIndex(root)!, root, 'change the checkout order API handler', { budget: 5000 });
    expect(pack).toContain('## Must hold');
    expect(pack).toContain('Keep handlers thin');
    expect(impact(g, 'api')).toContain('Must hold');
  });

  it('shows the person what a change does to security, and refuses approval while it has security errors', () => {
    write('armature/changes/export.yaml', 'title: Export orders\nstate: proposed\n');
    setApi((s) => s.replace('writes: [db#orders]', 'writes: [db#orders]\ncalls:\n  - { to: tracker#events, takes: Order, change: export }'));
    const g = compile(root);
    const { lines, errors } = changeSecurity(g, 'export');
    expect(lines.join('\n')).toContain('-> tracker (NOT allowed for @secret)');
    expect(errors.map((e) => e.code)).toContain('data-leak');
    expect(surfaceText(g, 'export')).toContain('Errors:');
  });

  it('tells a planner to look at the security surface', () => {
    expect(planModeNote()).toContain('armature surface');
  });
});

describe('the gate around security', () => {
  const gated = (): void => {
    setApi((s) => `${s}protect: true\n`);
  };

  it('refuses an edit to an existing file of a protected node without an approved change', () => {
    gated();
    const v = writeGate(root, { file_path: 'src/api/server.ts', old_string: 'undefined);', new_string: 'null);' });
    expect(v?.decision).toBe('deny');
    expect(v?.reason).toContain('protected');
    // Tests and documents of the node stay editable.
    expect(writeGate(root, { file_path: 'src/web/main.ts', content: 'export const x = 2;\n' })).toBeNull();
  });

  it('lets the edit through once a change that modifies the node is approved and records it', () => {
    gated();
    write('armature/changes/fix.yaml', 'title: Fix checkout\nstate: approved\n');
    setApi((s) => `${s}modify: fix\n`);
    write('armature/approvals.lock.json', JSON.stringify({ fix: { by: 'sam', at: '2026-01-01', elements: ['modify node api'] } }));
    expect(writeGate(root, { file_path: 'src/api/server.ts', content: 'x' })).toBeNull();
  });

  it('refuses a shell command that rewrites a protected file', () => {
    gated();
    expect(bashGate(root, 'echo hi > src/api/server.ts')?.decision).toBe('deny');
    expect(bashGate(root, "sed -i '' s/a/b/ src/api/server.ts")?.decision).toBe('deny');
  });

  it('asks the person before the model is weakened', () => {
    const before = node(['kind: service', 'role: order API', 'protect: true', 'accepts:', '  - { id: checkout, auth: user, only: [web] }', 'never:', '  - { to: web }', 'requirements:', '  - { id: own, kind: security, text: Own orders only. }']);
    const after = node(['kind: service', 'role: order API', 'accepts:', '  - { id: checkout, auth: none }', 'requirements: []']);
    const w = weakened('armature/nodes/api.yaml', before, after);
    for (const want of ['protect api', 'auth api#checkout', 'only api#checkout: web', 'never api -> web', 'requirement api:own']) expect(w.join('\n')).toContain(want);
    const sys = weakened('armature/system.yaml', 'name: x\ndata:\n  pii: { leaves: [] }\n', 'name: x\ndata:\n  pii: { leaves: [tracker] }\nignore:\n  - { path: src/**, why: x }\naccept:\n  - { code: no-auth, why: later }\n');
    expect(sys.join('\n')).toContain('@pii may leave to tracker');
    expect(sys.join('\n')).toContain('ignore src/**');
    expect(sys.join('\n')).toContain('accept no-auth');
    const v = writeGate(root, { file_path: 'armature/nodes/api.yaml', content: read('armature/nodes/api.yaml').replace('kind: service', 'kind: service\nprotect: false') });
    expect(v).toBeNull();
    setApi((s) => `${s}protect: true\n`);
    const ask = writeGate(root, { file_path: 'armature/nodes/api.yaml', content: read('armature/nodes/api.yaml').replace('protect: true\n', '') });
    expect(ask?.decision).toBe('ask');
    expect(ask?.reason).toContain('protect api');
  });

  it('asks before a node file is deleted and before the hooks are taken out of the settings', () => {
    expect(bashGate(root, 'rm armature/nodes/api.yaml')?.decision).toBe('ask');
    write('.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "x/armature.mjs" hook pre-bash' }] }] } }));
    const v = writeGate(root, { file_path: '.claude/settings.json', content: JSON.stringify({ hooks: {} }) });
    expect(v?.decision).toBe('ask');
    expect(v?.reason).toContain('pre-bash');
  });

  it('lists the guards a model change removes, in diff', () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    setApi((s) => s.replace('route: POST /checkout', 'route: POST /checkout\n    auth: user'));
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: root });
    setApi((s) => s.replace('    auth: user\n', '    auth: none\n'));
    write('armature/system.yaml', `${read('armature/system.yaml')}ignore:\n  - { path: src/api/**, why: no }\n`);
    const text = diffText(diffModel(root, 'HEAD'));
    expect(text).toContain('Guards removed');
    expect(text).toContain('auth api#checkout');
    expect(text).toContain('ignore src/api/**');
  });
});
