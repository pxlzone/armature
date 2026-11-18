// Cases a review of the security checks and the gate around them found: work finished before the
// checks existed, shapes and nodes the analysis did not follow, and guards that could be taken out
// of the model, the settings or the repo without a question.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCodeIndex } from '../src/code.js';
import { compile } from '../src/compile.js';
import { diffModel, diffText } from '../src/diff.js';
import { bashGate, shellRemovals, weakened, writeGate } from '../src/gate.js';
import { changeSecurity, isSecretName, surfaceText } from '../src/security.js';

let root: string;

function write(rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const yaml = (lines: string[]): string => `${lines.join('\n')}\n`;
const messages = (g: ReturnType<typeof compile>, code: string): string[] => g.problems.filter((p) => p.code === code).map((p) => p.message);
const edit = (rel: string, from: string, to: string): ReturnType<typeof writeGate> => writeGate(root, { file_path: rel, old_string: from, new_string: to });

const SYSTEM = [
  'name: Shop', 'headline: Takes orders and charges cards.',
  'actors:', '  - id: buyer', '    role: places orders', '    calls: [api#checkout]',
  'externals:', '  - id: crm', '    kind: external', '    role: partner CRM', '    accepts:', '      - { id: sync, via: http }',
  'data:', '  pii: { leaves: [] }',
];

/** A shop with an order API, a worker only the API may send to, a database, and a protected sign-in group. */
function shop(): void {
  write('armature/system.yaml', yaml(SYSTEM));
  write('armature/nodes/api.yaml', yaml(['kind: service', 'role: order API', 'code: [src/api/**]', 'accepts:', '  - id: checkout', '    via: http', '    auth: user', '    takes: Order']));
  write('armature/nodes/billing.yaml', yaml(['kind: worker', 'role: charges cards', 'code: [src/billing/**]', 'accepts:', '  - id: refund', '    via: pgmq', '    auth: service', '    only: [api]', '    takes: Order']));
  write('armature/nodes/db.yaml', yaml(['kind: store', 'role: orders database', 'holds:', '  - { id: orders, shape: Order }', '  - { id: users, shape: User }']));
  write('armature/nodes/auth/_group.yaml', yaml(['role: sign-in', 'protect: true']));
  write('armature/nodes/auth/tokens.yaml', yaml(['kind: library', 'role: signs tokens', 'code: [src/auth/tokens/**]']));
  write('armature/shapes/order.yaml', 'Order:\n  fields:\n    id: uuid\n    total: number\nUser:\n  fields:\n    id: uuid\n    email: email @pii\n');
  write('src/api/server.ts', 'export const x = 1;\n');
  write('src/billing/charge.ts', 'export const y = 1;\n');
  write('src/auth/tokens/sign.ts', 'export const sign = 1;\n');
}
const set = (rel: string, fn: (s: string) => string): void => write(rel, fn(read(rel)));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-security-holes-'));
  shop();
});

describe('work finished before the checks existed', () => {
  it('does not turn a finished change into an error for an entry point that states no auth yet', () => {
    write('armature/changes/orders.yaml', 'title: Orders\nstate: done\n');
    set('armature/nodes/api.yaml', (s) => s.replace('    auth: user\n', '').replace('    takes: Order', '    takes: User\n    change: orders'));
    const g = compile(root);
    // The entry point reaches @pii and nothing proves who gets it, but it was closed before "auth:" could be written.
    expect(messages(g, 'not-done')).toEqual([]);
    expect(messages(g, 'no-auth')).toHaveLength(1);
    // Once it states its auth, the change is held to it.
    set('armature/nodes/api.yaml', (s) => s.replace('    via: http', '    via: http\n    auth: user'));
    expect(messages(compile(root), 'not-done').join(' ')).toContain('no requirement of kind security');
  });

  it('refuses a finished change when one security requirement fails beside one that passes', () => {
    write('armature/changes/orders.yaml', 'title: Orders\nstate: done\n');
    set('armature/nodes/api.yaml', (s) => s.replace('    takes: Order', '    takes: User\n    change: orders') + yaml([
      'requirements:',
      '  - { id: own-orders, kind: security, text: A buyer sees only their own orders., match: own orders }',
      '  - { id: signed-in, kind: security, text: Checkout needs a session., match: needs a session }',
    ]));
    write('armature/.cache/reports/junit.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="needs a session"/><testcase classname="t" name="own orders"><failure message="another buyer could read it"/></testcase></testsuite></testsuites>');
    const m = messages(compile(root), 'not-done');
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('a security requirement of "api#checkout" fails: api:own-orders');
  });
});

describe('what the analysis follows', () => {
  it('finds a tag through shapes that embed each other, whichever link is declared first', () => {
    write('armature/shapes/order.yaml', 'Order:\n  fields:\n    id: uuid\n    email: email @pii\n    customer: Customer\nCustomer:\n  fields:\n    name: string\n    orders: Order[]\n');
    write('armature/nodes/db.yaml', yaml(['kind: store', 'role: orders database', 'holds:', '  - { id: orders, shape: Order }']));
    const toCrm = '  - { to: crm#sync, takes: Customer }';
    const toBilling = '  - { to: billing#refund, takes: Order }';
    for (const links of [[toBilling, toCrm], [toCrm, toBilling]]) {
      write('armature/nodes/api.yaml', yaml(['kind: service', 'role: order API', 'code: [src/api/**]', 'sends:', ...links]));
      const leaks = messages(compile(root), 'data-leak');
      expect(leaks, links.join(' | ')).toHaveLength(1);
      expect(leaks[0]).toContain('@pii (Order.email)');
      expect(leaks[0]).toContain('to "crm"');
    }
  });

  it('counts what a node inside the entry point reads, and what the node around it reads', () => {
    set('armature/nodes/api.yaml', (s) => s.replace('auth: user', 'auth: none'));
    expect(messages(compile(root), 'open-entry')).toEqual([]);
    // The read is declared on a node inside the service.
    write('armature/nodes/api/users.yaml', yaml(['kind: library', 'role: user lookups', 'reads: [db#users]']));
    const inside = messages(compile(root), 'open-entry');
    expect(inside).toHaveLength(1);
    expect(inside[0]).toContain('"api#checkout"');
    expect(inside[0]).toContain('@pii (User.email)');
    // The entry point is on a node inside, and the read is declared on the service around it.
    fs.rmSync(path.join(root, 'armature/nodes/api/users.yaml'));
    write('armature/nodes/api.yaml', yaml(['kind: service', 'role: order API', 'code: [src/api/**]', 'reads: [db#users]']));
    write('armature/nodes/api/http.yaml', yaml(['kind: library', 'role: route handlers', 'accepts:', '  - { id: checkout, via: http, auth: none, takes: Order }']));
    write('armature/system.yaml', yaml(SYSTEM).replace('api#checkout', 'api.http#checkout'));
    const around = messages(compile(root), 'open-entry');
    expect(around).toHaveLength(1);
    expect(around[0]).toContain('"api.http#checkout"');
  });

  it('takes an actor that links to a node as reaching every interface of it', () => {
    write('armature/system.yaml', yaml(SYSTEM).replace('calls: [api#checkout]', 'calls: [api]'));
    set('armature/nodes/api.yaml', (s) => s.replace('auth: user', 'auth: none').replace('takes: Order', 'takes: User'));
    const g = compile(root);
    expect(messages(g, 'open-entry')).toHaveLength(1);
    expect(surfaceText(g)).toContain('Entry points (1)');
    expect(surfaceText(g)).toContain('from buyer');
  });

  it('holds a link to a node to the allow-lists of its interfaces', () => {
    write('armature/nodes/reports.yaml', yaml(['kind: job', 'role: nightly reports', 'code: [src/reports/**]', 'sends:', '  - { to: billing, takes: Order }']));
    write('src/reports/run.ts', '');
    const m = messages(compile(root), 'not-allowed');
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('reports sends "billing" without naming an interface');
    expect(m[0]).toContain('"billing#refund" (only api)');
    // The node on the list may link either way.
    set('armature/nodes/reports.yaml', (s) => s.replace('to: billing,', 'to: billing#refund,'));
    expect(messages(compile(root), 'not-allowed')[0]).toContain('reports sends "billing#refund", which only api may use');
    write('armature/nodes/api.yaml', `${read('armature/nodes/api.yaml')}sends:\n  - { to: billing, takes: Order }\n`);
    fs.rmSync(path.join(root, 'armature/nodes/reports.yaml'));
    expect(messages(compile(root), 'not-allowed')).toEqual([]);
  });

  it('shows the person a change that only adds a tagged field to a shape already sent out', () => {
    write('armature/changes/ssn.yaml', 'title: Keep the tax id\nstate: proposed\n');
    write('armature/shapes/customer.yaml', 'Customer:\n  modify: ssn\n  fields:\n    name: string\n    tax_id: string @pii\n');
    set('armature/nodes/api.yaml', (s) => `${s}calls:\n  - { to: crm#sync, takes: Customer }\n`);
    const g = compile(root);
    const { lines, errors } = changeSecurity(g, 'ssn');
    expect(lines.join('\n')).toContain('@pii (Customer.tax_id) -> crm (NOT allowed for @pii)');
    expect(errors.map((e) => e.code)).toEqual(['data-leak']);
    expect(surfaceText(g, 'ssn')).not.toContain('sends no sensitive data');
  });
});

describe('secrets', () => {
  it('tells a credential from a name that only looks like one', () => {
    for (const name of ['STRIPE_SECRET_KEY', 'GITHUB_TOKEN', 'SENTRY_AUTH_TOKEN', 'OPENAI_API_KEY', 'STRIPE_KEY', 'AWS_ACCESS_KEY_ID', 'DATABASE_URL', 'DB_PASSWORD']) expect(isSecretName(name), name).toBe(true);
    for (const name of ['MAX_TOKENS', 'SORT_KEY', 'CACHE_KEY', 'JWT_PUBLIC_KEY', 'TOKEN_LIMIT', 'ACCESS_TOKEN_TTL', 'API_KEY_HEADER', 'TOKENIZER', 'PORT']) expect(isSecretName(name), name).toBe(false);
  });

  it('lets the build configuration of a client read a credential, and still refuses one in code it ships', async () => {
    write('armature/nodes/web.yaml', yaml(['kind: app', 'role: the storefront', 'client: true', 'code: [apps/web/**]']));
    write('apps/web/vite.config.ts', 'export default { plugins: [upload({ authToken: process.env.SENTRY_AUTH_TOKEN })] };\n');
    write('apps/web/src/main.ts', 'export const api = import.meta.env.VITE_API_URL;\n');
    write('src/api/llm.ts', 'export const max = Number(process.env.MAX_TOKENS ?? 1024);\nexport const sort = process.env.SORT_KEY;\nexport const key = process.env.OPENAI_API_KEY;\n');
    await buildCodeIndex(root);
    let g = compile(root);
    expect(messages(g, 'client-secret')).toEqual([]);
    const undeclared = messages(g, 'undeclared-secret');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]).toContain('"api" reads OPENAI_API_KEY from the environment');
    write('apps/web/src/admin.ts', 'export const t = process.env.ADMIN_TOKEN;\n');
    await buildCodeIndex(root);
    g = compile(root);
    expect(messages(g, 'client-secret')).toHaveLength(1);
    expect(messages(g, 'client-secret')[0]).toContain('ADMIN_TOKEN');
  });
});

describe('guards that an edit to the model takes away', () => {
  const protectedEdit = (): ReturnType<typeof writeGate> => writeGate(root, { file_path: 'src/auth/tokens/sign.ts', old_string: '1', new_string: '2' });

  it('asks before a node steps out of the protection of the node around it', () => {
    expect(protectedEdit()?.decision).toBe('deny');
    const v = edit('armature/nodes/auth/tokens.yaml', 'kind: library', 'kind: library\nprotect: false');
    expect(v?.decision).toBe('ask');
    expect(v?.reason).toContain('protect: false on auth.tokens, inside a protected node');
    expect(v?.reason).toContain('no longer protected: src/auth/tokens/sign.ts');
    // A new node that takes the files, inside the group or outside it, is the same loss.
    for (const rel of ['armature/nodes/auth/extra.yaml', 'armature/nodes/auth/tokens/raw.yaml']) {
      const taken = writeGate(root, { file_path: rel, content: yaml(['kind: library', 'role: helpers', 'protect: false', 'code: [src/auth/tokens/sign.ts]']) });
      expect(taken?.decision, rel).toBe('ask');
      expect(taken?.reason, rel).toContain('no longer protected: src/auth/tokens/sign.ts');
    }
    // "protect: false" where nothing around it is protected takes nothing away.
    expect(edit('armature/nodes/api.yaml', 'kind: service', 'kind: service\nprotect: false')).toBeNull();
  });

  it('lists a node that stepped out of protection in diff', () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: root });
    set('armature/nodes/auth/tokens.yaml', (s) => `${s}protect: false\n`);
    set('armature/nodes/billing.yaml', (s) => s.replace('only: [api]', 'only: [api, crm]').replace('auth: service', 'auth: user'));
    set('armature/shapes/order.yaml', (s) => s.replace(' @pii', ''));
    const text = diffText(diffModel(root, 'HEAD'));
    expect(text).toContain('Guards removed');
    expect(text).toContain('protect: false on auth.tokens, inside a protected node');
    expect(text).toContain('now allowed: crm may use billing#refund');
    expect(text).toContain('auth billing#refund: was service, now user');
    expect(text).toContain('no longer: @pii on User.email');
  });

  it('asks before the files of a protected node are taken out of its globs or placed by a technology', () => {
    const narrowed = edit('armature/nodes/auth/tokens.yaml', 'code: [src/auth/tokens/**]', 'code: [src/auth/other/**]');
    expect(narrowed?.decision).toBe('ask');
    expect(narrowed?.reason).toContain('no longer protected: src/auth/tokens/sign.ts');
    // Wider globs take nothing away.
    expect(edit('armature/nodes/auth/tokens.yaml', 'code: [src/auth/tokens/**]', 'code: [src/auth/**]')).toBeNull();
    // A technology's "files:" lets new files through like an "ignore:" entry, so a glob that can hold code is asked about.
    const tech = writeGate(root, { file_path: 'armature/tech.yaml', content: 'tech:\n  - { id: ts, name: TypeScript, files: ["src/**"] }\n' });
    expect(tech?.decision).toBe('ask');
    expect(tech?.reason).toContain('files of ts: src/**');
    expect(writeGate(root, { file_path: 'armature/tech.yaml', content: 'tech:\n  - { id: pnpm, name: pnpm, files: ["**/package.json", "pnpm-lock.yaml"] }\n' })).toBeNull();
    // And once it is there, it places files nobody owns: a file of a protected node stays protected.
    write('armature/tech.yaml', 'tech:\n  - { id: ts, name: TypeScript, files: ["src/**"] }\n');
    expect(protectedEdit()?.decision).toBe('deny');
    expect(bashGate(root, 'echo x > src/auth/tokens/sign.ts')?.decision).toBe('deny');
  });

  it('reads an allow-list the right way round: a new name asks, a name taken off does not', () => {
    const file = 'armature/nodes/billing.yaml';
    const node = (only: string): string => yaml(['kind: worker', 'role: charges cards', 'accepts:', `  - { id: refund, via: pgmq, only: ${only} }`]);
    expect(weakened(file, node('[api]'), node('[api, crm]'))).toEqual(['now allowed: crm may use billing#refund']);
    expect(weakened(file, node('[api, web]'), node('[api]'))).toEqual([]);
    // A node inside one already on the list is not a new name; the node around one is.
    expect(weakened(file, node('[api]'), node('[api.server]'))).toEqual([]);
    expect(weakened(file, node('[api.server]'), node('[api]'))).toEqual(['now allowed: api may use billing#refund']);
    // Without the list anyone may use it; a list where there was none tightens it.
    expect(weakened(file, node('[api]'), yaml(['kind: worker', 'role: charges cards', 'accepts:', '  - { id: refund, via: pgmq }']))).toEqual(['no longer: only billing#refund: api']);
    expect(weakened(file, yaml(['kind: worker', 'role: charges cards', 'accepts:', '  - { id: refund, via: pgmq }']), node('[api]'))).toEqual([]);
    expect(edit(file, 'only: [api]', 'only: [api, crm]')?.decision).toBe('ask');
  });

  it('asks when the auth of an interface changes to another scheme', () => {
    const file = 'armature/nodes/billing.yaml';
    const v = edit(file, 'auth: service', 'auth: user');
    expect(v?.decision).toBe('ask');
    expect(v?.reason).toContain('auth billing#refund: was service, now user');
    const node = (auth: string): string => yaml(['kind: worker', 'role: charges cards', 'accepts:', `  - { id: refund, via: pgmq${auth} }`]);
    expect(weakened(file, node(', auth: user'), node(', auth: none'))).toEqual(['auth billing#refund: was user, now none']);
    expect(weakened(file, node(', auth: user'), node(''))).toEqual(['no longer: auth billing#refund (was user)']);
    expect(weakened(file, node(''), node(', auth: none'))).toEqual(['now allowed: auth none billing#refund']);
    // Stating an auth, or closing an open interface, takes nothing away.
    expect(weakened(file, node(''), node(', auth: user'))).toEqual([]);
    expect(weakened(file, node(', auth: none'), node(', auth: user'))).toEqual([]);
  });

  it('asks before a tag is dropped from a field, and refuses a shell rewrite of a shapes file', () => {
    const v = edit('armature/shapes/order.yaml', 'email: email @pii', 'email: email');
    expect(v?.decision).toBe('ask');
    expect(v?.reason).toContain('no longer: @pii on User.email');
    // Adding a tag or a field takes nothing away.
    expect(edit('armature/shapes/order.yaml', 'total: number', 'total: number\n    card: string @secret')).toBeNull();
    expect(bashGate(root, "sed -i '' 's/ @pii//' armature/shapes/order.yaml")?.decision).toBe('deny');
  });
});

describe('guards that are taken away outside the model', () => {
  it('sees the plugin switched off in the local settings, and refuses a settings file written from the shell', () => {
    write('.claude/settings.json', '{"enabledPlugins": {"armature@armature": true}}\n');
    const v = writeGate(root, { file_path: '.claude/settings.local.json', content: '{"enabledPlugins": {"armature@armature": false}}\n' });
    expect(v?.decision).toBe('ask');
    expect(v?.reason).toContain('plugin armature@armature switched off');
    expect(writeGate(root, { file_path: '.claude/settings.local.json', content: '{"permissions": {"allow": ["Bash(npm test)"]}}\n' })).toBeNull();
    // The local file does not exist yet: a new one can switch the hooks off as well as an old one.
    const made = bashGate(root, `echo '{"disableAllHooks": true}' > .claude/settings.local.json`);
    expect(made?.decision).toBe('deny');
    expect(made?.reason).toContain('file tools');
    expect(bashGate(root, 'cat > armature/nodes/extra.yaml <<EOF\nkind: library\nrole: helpers\nEOF')?.decision).toBe('deny');
  });

  it('reads what a command takes away', () => {
    const cwd = '/repo';
    expect(shellRemovals('rm -rf armature/nodes/auth', cwd)).toEqual({ deleted: ['/repo/armature/nodes/auth'], moved: [] });
    expect(shellRemovals('cd src && git rm a.ts b.ts', cwd).deleted).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
    expect(shellRemovals('git mv src/a.ts src/b.ts && mv x y z/', cwd).moved).toEqual(['/repo/src/a.ts', '/repo/x', '/repo/y']);
    expect(shellRemovals('ls | xargs -n 1 rm -f old.ts', cwd).deleted).toEqual(['/repo/old.ts']);
    expect(shellRemovals('sudo rm -rf build; FORCE=1 rm cache', cwd).deleted).toEqual(['/repo/build', '/repo/cache']);
    expect(shellRemovals('(cd src && rm -rf auth)', cwd).deleted).toEqual(['/repo/src/auth']);
    // What find removes is taken as everything under where it looks.
    expect(shellRemovals('find src/auth -name "*.ts" -delete', cwd).deleted).toEqual(['/repo/src/auth']);
    expect(shellRemovals('find src/auth tmp -type f -exec rm -f {} +', cwd).deleted).toEqual(['/repo/src/auth', '/repo/tmp']);
    // "rm" as a word of some other command takes nothing away.
    for (const cmd of ['npm run build && echo rm', 'grep -rn rm src/auth', 'git commit -m "rm src/auth/old.ts"', 'find src -name rm', 'find src -name "*.ts" -exec grep rm {} +']) expect(shellRemovals(cmd, cwd), cmd).toEqual({ deleted: [], moved: [] });
  });

  it('asks before part of the model is deleted or moved away from the shell', () => {
    for (const cmd of ['rm -rf armature/nodes/auth', 'rm -r armature', 'mv armature/nodes/billing.yaml /tmp/billing.yaml', 'cd armature && rm shapes/order.yaml', 'rm armature/tech.yaml']) {
      expect(bashGate(root, cmd)?.decision, cmd).toBe('ask');
    }
    write('.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "x/armature.mjs" hook pre-bash' }] }] } }));
    const settings = bashGate(root, 'rm -rf .claude');
    expect(settings?.decision).toBe('ask');
    expect(settings?.reason).toContain('hook pre-bash');
    // A folder around the model takes the protected files with it: that is refused, not asked about.
    expect(bashGate(root, 'rm -rf .')?.decision).toBe('deny');
    // The cache, documents and build output are not guards, and neither is reading.
    for (const cmd of ['rm -rf armature/.cache', 'rm -rf dist node_modules', 'rm src/api/server.ts', 'mv notes.md docs/notes.md', 'grep -rn rm src/auth armature/nodes']) expect(bashGate(root, cmd), cmd).toBeNull();
  });

  it('refuses to delete or move away a file of a protected node', () => {
    for (const cmd of ['rm src/auth/tokens/sign.ts', 'rm -rf src/auth', 'git rm src/auth/tokens/*.ts', 'git mv src/auth/tokens/sign.ts src/api/sign.ts', 'cd src && rm -rf auth/tokens', 'find src/auth -name "*.ts" -delete']) {
      const v = bashGate(root, cmd);
      expect(v?.decision, cmd).toBe('deny');
      expect(v?.reason, cmd).toContain('src/auth/tokens/sign.ts');
    }
    // A file tool that moves a file takes it away as well.
    expect(writeGate(root, { source: 'src/auth/tokens/sign.ts', destination: 'src/api/sign.ts' })?.decision).toBe('deny');
    expect(writeGate(root, { source: 'armature/nodes/billing.yaml', destination: 'notes/billing.yaml' })?.decision).toBe('ask');
    // A question earlier in the command does not carry a refused step through.
    expect(bashGate(root, 'rm armature/nodes/db.yaml && echo x > src/auth/tokens/sign.ts')?.decision).toBe('deny');
    expect(bashGate(root, 'armature approve x && rm src/auth/tokens/sign.ts')?.decision).toBe('deny');
  });
});
