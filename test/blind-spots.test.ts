// A check that passes must say what it did not look at: requirements with no test, nodes it
// cannot read, routes the model leaves out, and what a branch added to warnings already there.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { newSinceRun, problemsAt, pruneAccepts } from '../src/baseline.js';
import { buildCodeIndex } from '../src/code.js';
import { compile, confirmRequirements } from '../src/compile.js';
import { bashGate, writeGate } from '../src/gate.js';
import { show } from '../src/render.js';
import { surfaceText } from '../src/security.js';
import type { Problem } from '../src/types.js';

let root: string;

function write(rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
const node = (lines: string[]): string => `${lines.join('\n')}\n`;
const messages = (g: ReturnType<typeof compile>, code: string): string[] => g.problems.filter((p) => p.code === code).map((p) => p.message);
const req = (g: ReturnType<typeof compile>, ref: string) => g.nodes.flatMap((n) => n.requirements).find((q) => q.ref === ref)!;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'armature-blind-')));
  write('armature/system.yaml', 'name: Shop\nheadline: Takes orders.\nactors:\n  - id: admin\n    role: runs the shop\n    calls: [api#orders]\n');
  write('armature/nodes/api.yaml', node([
    'kind: service', 'role: order API', 'code: [src/api/**]',
    'accepts:', '  - id: orders', '    via: http', '    route: GET /orders', '    auth: session',
    'requirements:',
    '  - id: ids-only', '    text: A log line names ids, never content.',
    '  - id: admin-only', '    text: Only an admin reads the logs.',
  ]));
  write('src/api/server.ts', "export const app = { get: (..._a: unknown[]) => undefined };\napp.get('/orders', () => undefined);\n");
  write('src/api/server.test.ts', "import { app } from './server';\nit('lists orders', () => app);\n");
});

describe('requirements that name no test', () => {
  it('says so, with the tests that already exercise the node', async () => {
    await buildCodeIndex(root);
    const g = compile(root);
    const [m] = messages(g, 'untested-requirement');
    expect(m).toContain('"api": 2 requirements name no test');
    expect(m).toContain('ids-only, admin-only');
    expect(m).toContain('src/api/server.test.ts');
    expect(g.problems.find((p) => p.code === 'untested-requirement')!.items).toEqual(['ids-only', 'admin-only']);
  });

  it('counts a tag in a test title with no report to read, and tests: or match:', () => {
    write('src/api/server.test.ts', "it('keeps content out [req api:ids-only]', () => undefined);\n");
    write('armature/nodes/api.yaml', fs.readFileSync(path.join(root, 'armature/nodes/api.yaml'), 'utf8').replace('Only an admin reads the logs.', 'Only an admin reads the logs.\n    match: admin only'));
    expect(messages(compile(root), 'untested-requirement')).toEqual([]);
  });

  it('does not take a tag quoted in a document for a test', () => {
    write('docs/plan.md', 'We will tag it [req api:ids-only] and [req api:admin-only].\n');
    expect(messages(compile(root), 'untested-requirement')[0]).toContain('2 requirements');
  });

  it('tells a finished change that a requirement can never be verified, apart from one whose tests have not run', () => {
    write('armature/changes/logs.yaml', 'title: Logs\nstate: done\n');
    write('armature/nodes/api.yaml', fs.readFileSync(path.join(root, 'armature/nodes/api.yaml'), 'utf8')
      .replace('A log line names ids, never content.', 'A log line names ids, never content.\n    change: logs')
      .replace('Only an admin reads the logs.', 'Only an admin reads the logs.\n    change: logs\n    tests: src/api/server.test.ts'));
    const g = compile(root);
    expect(messages(g, 'done-untested')).toHaveLength(1);
    expect(messages(g, 'done-untested')[0]).toContain('api:ids-only');
    expect(messages(g, 'done-unchecked')[0]).toContain('1 of its requirements cannot be checked here');
    expect(g.problems.find((p) => p.code === 'done-untested')!.group).toBe('wrong');
  });
});

describe('a node the index cannot read', () => {
  beforeEach(() => {
    write('armature/nodes/logs.yaml', node([
      'kind: service', 'role: collects logs', 'code: [infra/logs/**]',
      'requirements:', '  - id: keeps-30-days', '    text: Logs are kept for 30 days.',
    ]));
    write('infra/logs/config.alloy', 'loki.write "default" { retention = "30d" }\n');
  });

  it('is reported as not checked', async () => {
    await buildCodeIndex(root);
    const [m] = messages(compile(root), 'unread-node');
    expect(m).toContain('"logs" owns 1 file and none is in a language armature reads');
    expect(m).toContain('1 requirement is not checked');
    expect(m).toContain('armature confirm logs:keeps-30-days');
    expect(messages(compile(root), 'unread-node').join()).not.toContain('"api"');
  });

  it('lets a person confirm a requirement by reading, until a file or the text changes', async () => {
    await buildCodeIndex(root);
    expect(confirmRequirements(root, ['logs:keeps-30-days', 'logs:nope'], 'Ada')).toMatchObject({ confirmed: ['logs:keeps-30-days'], missing: ['logs:nope'] });
    let g = compile(root);
    expect(req(g, 'logs:keeps-30-days').state).toBe('verified');
    expect(show(g, 'logs')).toContain('verified: read by Ada');
    expect(messages(g, 'unread-node')).toEqual([]);
    expect(messages(g, 'untested-requirement').join()).not.toContain('"logs"');

    write('infra/logs/config.alloy', 'loki.write "default" { retention = "7d" }\n');
    g = compile(root);
    expect(req(g, 'logs:keeps-30-days').state).toBe('unverified');
    expect(messages(g, 'stale-confirmation')[0]).toContain('confirmed by Ada');
    expect(g.problems.find((p) => p.code === 'stale-confirmation')!.group).toBe('wrong');
  });

  it('asks the person before an agent confirms or edits the record', () => {
    expect(bashGate(root, 'armature confirm logs:keeps-30-days --by Ada')?.decision).toBe('ask');
    expect(bashGate(root, 'armature confirm Order')).toBeNull();
    expect(writeGate(root, { file_path: path.join(root, 'armature/confirmed.lock.json'), content: '{}' })?.decision).toBe('ask');
  });
});

describe('the surface', () => {
  it('lists routes the code serves that the model does not declare, for the system and for a change', async () => {
    write('armature/changes/logs.yaml', 'title: Logs\nstate: approved\n');
    write('armature/nodes/office.yaml', node(['kind: service', 'role: admin pages', 'code: [src/admin/**]', 'change: logs', 'accepts:', '  - id: turns', '    via: http', '    route: GET /turns', '    auth: session']));
    write('src/admin/routes.ts', "export const app = { get: (..._a: unknown[]) => undefined };\napp.get('/turns', () => undefined);\napp.get('/logs', () => undefined);\n");
    await buildCodeIndex(root);
    const g = compile(root);
    for (const text of [surfaceText(g), surfaceText(g, 'logs')]) {
      expect(text).toContain('Routes the code serves that the model does not declare (1)');
      expect(text).toMatch(/office: GET \/logs\s+src\/admin\/routes\.ts:3/);
      // Declared, but no actor or client is linked to it, so it is not an entry point: said, not hidden.
      expect(text).toContain('Interfaces with a route and no caller from outside declared (1)');
      expect(text).toContain('office#turns GET /turns: auth session');
    }
    expect(surfaceText(g)).toContain('Entry points (1)');
    expect(surfaceText(g, 'logs')).not.toContain('api#orders GET');
  });

  it('says when no code was read', () => {
    write('armature/changes/logs.yaml', 'title: Logs\nstate: approved\n');
    expect(surfaceText(compile(root), 'logs')).toContain('No node has been compared with its code');
  });
});

describe('what a branch adds', () => {
  const w = (code: string, ref: string, items?: string[]): Problem => ({ level: 'warning', code, ref, message: `${code} on ${ref}.`, ...(items ? { items } : {}) });

  it('shows a warning that was there only when it lists something new', () => {
    const then = [w('runtime-drift', 'api', ['table orders (read)']), w('no-shape', 'api')];
    const now = [w('runtime-drift', 'api', ['table orders (read)', 'route GET / (GET)']), w('no-shape', 'api'), w('no-shape', 'billing'), { level: 'error', code: 'schema', message: 'x' } as Problem];
    const out = newSinceRun(now, then);
    expect(out.map((p) => `${p.code} ${p.ref ?? ''}`.trim())).toEqual(['runtime-drift api', 'no-shape billing', 'schema']);
    expect(out[0].message).toContain('New here: route GET / (GET).');
    expect(out[0].items).toEqual(['route GET / (GET)']);
  });

  it('runs the same check on another commit, code index and all', async () => {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    write('armature/.gitignore', '.cache/\n');
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
    write('src/api/server.ts', "export const app = { get: (..._a: unknown[]) => undefined };\napp.get('/orders', () => undefined);\napp.get('/logs', () => undefined);\n");
    await buildCodeIndex(root);
    const then = await problemsAt(root, 'main');
    expect(Array.isArray(then)).toBe(true);
    const fresh = newSinceRun(compile(root).problems, then as Problem[]);
    expect(fresh.map((p) => p.code)).toEqual(['runtime-drift']);
    expect(fresh[0].message).toContain('route GET /logs');
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(await problemsAt(root, 'no-such-branch')).toContain('is not a commit');
  });
});

describe('accept entries that match nothing', () => {
  it('are removed from system.yaml, comments and the live entries kept', () => {
    fs.appendFileSync(path.join(root, 'armature/system.yaml'), [
      'accept:',
      '  # the logger is tested through the API',
      '  - code: untested-requirement',
      '    ref: api',
      '    why: Covered by the end-to-end run.',
      '  - code: no-code',
      '    ref: gone',
      '    why: Was a stub.',
      '  - code: runtime-drift',
      '    ref: api',
      '    why: A string the detector misreads.',
      '',
    ].join('\n'));
    const g = compile(root);
    expect(g.system.idleAccepts).toEqual([1]);
    expect(pruneAccepts(root, g.system.idleAccepts)).toBe(1);
    const text = fs.readFileSync(path.join(root, 'armature/system.yaml'), 'utf8');
    expect(text).toContain('# the logger is tested through the API');
    expect(text).toContain('code: untested-requirement');
    expect(text).toContain('code: runtime-drift');
    expect(text).not.toContain('ref: gone');
    expect(compile(root).problems.map((p) => p.code)).not.toContain('stale-accept');
  });
});
