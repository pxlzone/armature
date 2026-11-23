// Cases from a review where check said green, or a guard let something through, when it should not have.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCodeIndex } from '../src/code.js';
import { compile } from '../src/compile.js';
import { readDoc } from '../src/docs.js';

let root: string;

function write(rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
const lines = (...l: string[]): string => `${l.join('\n')}\n`;
const statusOf = (id: string): string | undefined => compile(root).nodes.find((n) => n.id === id)?.status;

/** A report written after the code, so its passes count. */
function report(...cases: string[]): void {
  write('armature/.cache/reports/junit.xml', `<?xml version="1.0"?><testsuites><testsuite name="all">\n${cases.join('\n')}\n</testsuite></testsuites>\n`);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(root, 'armature/.cache/reports/junit.xml'), later, later);
}
const pass = (file: string, name: string): string => `<testcase classname="${file}" name="${name}"/>`;
const failing = (file: string, name: string): string => `<testcase classname="${file}" name="${name}"><failure message="boom"/></testcase>`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-fixes-'));
  write('armature/system.yaml', lines('name: T', 'headline: t'));
});

describe('status of a parent node', () => {
  beforeEach(() => {
    write('armature/nodes/app/core.yaml', lines('kind: service', 'role: core', 'code: [src/app/core/**]', 'requirements:', '  - id: works', '    text: works', '    tests: tests/core.test.ts'));
    write('src/app/core/a.ts', 'export const a = 1;\n');
    write('tests/core.test.ts', '');
    write('tests/group.test.ts', '');
  });

  it('is failing when its own requirement fails, though everything inside is verified', () => {
    write('armature/nodes/app/_group.yaml', lines('kind: group', 'role: the app', 'requirements:', '  - id: whole', '    text: about the whole app', '    tests: tests/group.test.ts'));
    report(pass('tests/core.test.ts', 'works'), failing('tests/group.test.ts', 'whole'));
    expect(statusOf('app.core')).toBe('verified');
    expect(statusOf('app')).toBe('failing');
  });

  it('is not verified while its own requirement has no passing test', () => {
    write('armature/nodes/app/_group.yaml', lines('kind: group', 'role: the app', 'requirements:', '  - id: whole', '    text: about the whole app', '    tests: tests/group.test.ts'));
    report(pass('tests/core.test.ts', 'works'));
    expect(statusOf('app')).toBe('built');
  });
});

describe('failures across test runs', () => {
  it('keeps a failure when a later run did not include its tests', () => {
    write('armature/nodes/core.yaml', lines('kind: service', 'role: core', 'code: [src/core/**]', 'requirements:', '  - id: works', '    text: works', '    tests: tests/core.test.ts'));
    write('armature/nodes/web.yaml', lines('kind: app', 'role: web', 'code: [src/web/**]', 'requirements:', '  - id: renders', '    text: renders', '    tests: tests/web.test.ts'));
    write('src/core/a.ts', 'export const a = 1;\n');
    write('src/web/w.ts', 'export const w = 1;\n');
    write('tests/core.test.ts', '');
    write('tests/web.test.ts', '');
    report(failing('tests/core.test.ts', 'works'), pass('tests/web.test.ts', 'renders'));
    expect(statusOf('core')).toBe('failing');
    report(pass('tests/web.test.ts', 'renders'));
    expect(statusOf('core')).toBe('failing');
    expect(statusOf('web')).toBe('verified');
    report(pass('tests/core.test.ts', 'works'));
    expect(statusOf('core')).toBe('verified');
  });
});

describe('security and drift', () => {
  it('treats auth: None like auth: none', () => {
    write('armature/system.yaml', lines('name: T', 'headline: t', 'actors:', '  - id: visitor', '    role: anyone', '    calls: [api#profile]'));
    write('armature/nodes/api.yaml', lines('kind: service', 'role: api', 'code: [src/api/**]', 'accepts:', '  - id: profile', '    via: http', '    route: GET /profile', '    gives: User', '    auth: None'));
    write('armature/shapes/user.yaml', lines('User:', '  fields:', '    id: uuid', '    email: email @pii'));
    write('src/api/a.ts', 'export const a = 1;\n');
    expect(compile(root).problems.some((p) => p.code === 'open-entry')).toBe(true);
  });

  it('does not count a declared route as seen because the code has a parameter-only route', async () => {
    write('armature/system.yaml', lines('name: T', 'headline: t', 'entry: [src/api/**]'));
    write('armature/nodes/api.yaml', lines('kind: service', 'role: api', 'code: [src/api/**]', 'accepts:', '  - id: ghost', '    via: http', '    route: GET /admin/export-everything'));
    write('src/api/server.ts', "export const app = { get: (..._a: unknown[]) => undefined };\napp.get('/:id', () => undefined);\n");
    await buildCodeIndex(root);
    expect(compile(root).problems.some((p) => p.code === 'not-in-code' && p.ref === 'api')).toBe(true);
  });

  it('names each undeclared secret, so a branch that adds one shows it as new', async () => {
    write('armature/nodes/api.yaml', lines('kind: service', 'role: api', 'code: [src/api/**]'));
    write('src/api/a.ts', 'export const k = process.env.STRIPE_SECRET_KEY;\n');
    await buildCodeIndex(root);
    const p = compile(root).problems.find((x) => x.code === 'undeclared-secret');
    expect(p?.items).toEqual(['STRIPE_SECRET_KEY']);
  });
});

describe('files outside the repo', () => {
  it('does not read a Markdown symlink that points outside the repo', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), 'private\n');
    fs.mkdirSync(path.join(root, 'armature/docs'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'armature/docs/link.md'));
    write('armature/docs/real.md', 'inside\n');
    expect(readDoc(root, 'armature/docs/link.md')).toBeNull();
    expect(readDoc(root, 'armature/docs/real.md')).toBe('inside\n');
  });
});

describe('non-ASCII file names', () => {
  it('owns a file whose name git would quote', async () => {
    const { execFileSync } = await import('node:child_process');
    write('armature/nodes/api.yaml', lines('kind: service', 'role: api', 'code: [src/api/**]'));
    write('src/api/café.ts', 'export const c = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const g = compile(root);
    expect(g.nodes.find((n) => n.id === 'api')?.files).toBe(1);
  });
});
