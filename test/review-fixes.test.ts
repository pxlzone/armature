// Cases from a review where check said green, or a guard let something through, when it should not have.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCodeIndex } from '../src/code.js';
import { compile } from '../src/compile.js';
import { readDoc } from '../src/docs.js';
import { readCodeIndex } from '../src/code.js';
import { contextText } from '../src/context.js';
import { bashGate, writeGate } from '../src/gate.js';
import { status } from '../src/render.js';
import { rename } from '../src/rename.js';

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

  it('forgets a failure once the requirement names no test', () => {
    write('armature/nodes/core.yaml', lines('kind: service', 'role: core', 'code: [src/core/**]', 'requirements:', '  - id: works', '    text: works', '    tests: tests/core.test.ts'));
    write('src/core/a.ts', 'export const a = 1;\n');
    write('tests/core.test.ts', '');
    write('tests/other.test.ts', '');
    report(failing('tests/core.test.ts', 'works'));
    expect(statusOf('core')).toBe('failing');
    write('armature/nodes/core.yaml', lines('kind: service', 'role: core', 'code: [src/core/**]', 'requirements:', '  - id: works', '    text: works'));
    report(pass('tests/other.test.ts', 'other'));
    expect(statusOf('core')).not.toBe('failing');
  });
});

describe('routes', () => {
  const served = async (declared: string, code: string): Promise<boolean> => {
    write('armature/system.yaml', lines('name: T', 'headline: t', 'entry: [src/api/**]'));
    write('armature/nodes/api.yaml', lines('kind: service', 'role: api', 'code: [src/api/**]', 'accepts:', '  - id: one', '    via: http', `    route: ${declared}`));
    write('src/api/server.ts', `export const app = { get: (..._a: unknown[]) => undefined };\napp.get('${code}', () => undefined);\n`);
    await buildCodeIndex(root);
    return !compile(root).problems.some((p) => p.code === 'not-in-code' || p.code === 'runtime-drift');
  };

  it('lets a declared wildcard cover the routes under it', async () => {
    expect(await served('GET /api/admin/*', '/users/:id/roles')).toBe(true);
  });

  it('matches parameters a prefixed router declares', async () => {
    expect(await served('GET /api/control-log/:subjectType/:subjectId', '/:subjectType/:subjectId')).toBe(true);
  });

  it('matches a router root route to the declared route of its node', async () => {
    expect(await served('GET /api/approvals', '/')).toBe(true);
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

describe('the gate reads the file a path names, however it is spelled', () => {
  beforeEach(() => {
    write('armature/nodes/mail.yaml', lines('kind: service', 'role: sends mail', 'code: [src/mail/**]', 'change: mail'));
    write('armature/nodes/api.yaml', lines('kind: service', 'role: api', 'code: [src/api/**]', 'protect: true'));
    write('armature/changes/mail.yaml', lines('title: Mail', 'state: proposed'));
    write('src/api/server.ts', 'export const s = 1;\n');
  });
  const approve = { old_string: 'state: proposed', new_string: 'state: approved' };

  it('asks when a change is approved through other letter case', () => {
    if (!fs.existsSync(path.join(root, 'ARMATURE'))) return; // only on a disk that ignores case
    expect(writeGate(root, { file_path: 'ARMATURE/changes/mail.yaml', ...approve })).toMatchObject({ decision: 'ask' });
    expect(writeGate(root, { file_path: 'SRC/api/server.ts', content: 'x' })).toMatchObject({ decision: 'deny' });
  });

  it('asks when a change is approved through a symlinked folder', () => {
    fs.symlinkSync(path.join(root, 'armature'), path.join(root, 'm'));
    expect(writeGate(root, { file_path: 'm/changes/mail.yaml', ...approve })).toMatchObject({ decision: 'ask' });
  });

  it('still gates a model or protected file that links outside the repo', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-out-'));
    fs.renameSync(path.join(root, 'armature/changes/mail.yaml'), path.join(outside, 'mail.yaml'));
    fs.symlinkSync(path.join(outside, 'mail.yaml'), path.join(root, 'armature/changes/mail.yaml'));
    fs.renameSync(path.join(root, 'src/api/server.ts'), path.join(outside, 'server.ts'));
    fs.symlinkSync(path.join(outside, 'server.ts'), path.join(root, 'src/api/server.ts'));
    expect(writeGate(root, { file_path: 'armature/changes/mail.yaml', ...approve })).toMatchObject({ decision: 'ask' });
    expect(writeGate(root, { file_path: 'src/api/server.ts', content: 'x' })).toMatchObject({ decision: 'deny' });
    expect(bashGate(root, 'echo y >> src/api/server.ts')).toMatchObject({ decision: 'deny' });
  });

  it('still gates the model when its whole folder links outside the repo', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-out-'));
    fs.renameSync(path.join(root, 'armature'), path.join(outside, 'armature'));
    fs.symlinkSync(path.join(outside, 'armature'), path.join(root, 'armature'));
    expect(writeGate(root, { file_path: 'armature/changes/mail.yaml', ...approve })).toMatchObject({ decision: 'ask' });
  });

  it('reads ln -sf, &> and >| as writes', () => {
    expect(bashGate(root, 'ln -sf /tmp/x.yaml armature/changes/mail.yaml')).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, 'echo y &> src/api/server.ts')).toMatchObject({ decision: 'deny' });
    expect(bashGate(root, 'echo y >| src/api/server.ts')).toMatchObject({ decision: 'deny' });
  });
});

describe('model tools and status', () => {
  it('renames a node in the data policy too', () => {
    write('armature/system.yaml', lines('name: T', 'headline: t', 'externals:', '  - id: mailer', '    role: sends mail', 'data:', '  pii: { leaves: [mailer] }'));
    expect(rename(root, 'mailer', 'postmark')).toMatch(/^Renamed /);
    expect(fs.readFileSync(path.join(root, 'armature/system.yaml'), 'utf8')).toContain('leaves: [postmark]');
  });

  it('treats auth: public as open', () => {
    write('armature/system.yaml', lines('name: T', 'headline: t', 'actors:', '  - id: visitor', '    role: anyone', '    calls: [api#profile]'));
    write('armature/nodes/api.yaml', lines('kind: service', 'role: api', 'code: [src/api/**]', 'accepts:', '  - id: profile', '    via: http', '    gives: User', '    auth: public'));
    write('armature/shapes/user.yaml', lines('User:', '  fields:', '    email: email @pii'));
    write('src/api/a.ts', 'export const a = 1;\n');
    expect(compile(root).problems.some((p) => p.code === 'open-entry')).toBe(true);
  });

  it('says why nothing is verified when there is no test report', () => {
    write('armature/nodes/api.yaml', lines('kind: service', 'role: api', 'code: [src/api/**]', 'requirements:', '  - id: works', '    text: works', '    tests: tests/api.test.ts'));
    write('src/api/a.ts', 'export const a = 1;\n');
    write('tests/api.test.ts', '');
    expect(status(compile(root))).toContain('no JUnit test report found');
  });

  it('counts a deleted file as a change to the code a report tested', async () => {
    write('armature/nodes/api.yaml', lines('kind: service', 'role: api', 'code: [src/api/**]', 'requirements:', '  - id: works', '    text: works', '    tests: tests/api.test.ts'));
    write('src/api/a.ts', 'export const a = 1;\n');
    write('src/api/b.ts', 'export const b = 1;\n');
    write('tests/api.test.ts', '');
    const past = new Date(Date.now() - 120_000);
    for (const f of ['src/api/a.ts', 'src/api/b.ts', 'src/api']) fs.utimesSync(path.join(root, f), past, past);
    write('armature/.cache/reports/junit.xml', `<?xml version="1.0"?><testsuites><testsuite name="all">${pass('tests/api.test.ts', 'works')}</testsuite></testsuites>\n`);
    const then = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(root, 'armature/.cache/reports/junit.xml'), then, then);
    expect(statusOf('api')).toBe('verified');
    fs.rmSync(path.join(root, 'src/api/b.ts'));
    expect(statusOf('api')).not.toBe('verified');
  });
});

describe('imports the dead-code check follows', () => {
  const importsOf = (f: string): Array<string | null> => readCodeIndex(root)!.files[f].imports.map((i) => i.file);

  it('follows Python submodule imports', async () => {
    write('app/__init__.py', '');
    write('app/helpers.py', 'def h():\n    return 1\n');
    write('app/utils/__init__.py', '');
    write('app/utils/fmt.py', 'def f():\n    return 1\n');
    write('app/main.py', 'from . import helpers\nfrom app.utils import fmt\n');
    await buildCodeIndex(root);
    expect(importsOf('app/main.py')).toEqual(expect.arrayContaining(['app/helpers.py', 'app/utils/fmt.py']));
    const count = importsOf('app/main.py').length;
    await buildCodeIndex(root);
    await buildCodeIndex(root);
    expect(importsOf('app/main.py')).toHaveLength(count);
  });

  it('follows jsconfig aliases, baseUrl paths and folder imports with a trailing slash', async () => {
    write('jsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
    write('src/components/button.js', 'export const b = 1;\n');
    write('src/pkg/a.js', 'export const a = 1;\n');
    write('src/dir/index.js', 'export const d = 1;\n');
    write('src/main.js', "import { b } from '@/components/button';\nimport { a } from 'src/pkg/a';\nimport { d } from './dir/';\n");
    await buildCodeIndex(root);
    expect(importsOf('src/main.js')).toEqual(['src/components/button.js', 'src/pkg/a.js', 'src/dir/index.js']);
  });
});

describe('the context pack', () => {
  it('lists the test named after the task first, and does not repeat rules', async () => {
    write('armature/nodes/core.yaml', lines('kind: library', 'role: core', 'code: [src/**]', 'rules:', '  - Keep it small.'));
    write('src/islands.ts', 'export function islands(): number {\n  return 1;\n}\n');
    write('src/other.ts', "import { islands } from './islands';\nexport const o = islands();\n");
    for (const t of ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'islands']) write(`test/${t}.test.ts`, "import { islands } from '../src/islands';\nislands();\n");
    await buildCodeIndex(root);
    const text = contextText(compile(root), readCodeIndex(root), root, 'add a json flag to islands', { budget: 5000 });
    expect(text.split('## Tests to run\n')[1]?.split('\n')[0]).toBe('- test/islands.test.ts');
    expect(text.split('Keep it small.').length - 1).toBe(1);
  });
});
