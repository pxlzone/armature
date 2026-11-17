import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, findRoot } from '../src/compile.js';
import { planGate, readOwnership, writeGate } from '../src/gate.js';
import { docsDir, modelDir, newPlanPath } from '../src/paths.js';

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-gate-'));
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('armature/system.yaml', 'name: Shop\nheadline: Sells things.\nignore:\n  - { path: "scripts/once/**", why: one-off data fixes }\n');
  write('armature/tech.yaml', 'tech:\n  - { id: vitest, name: Vitest, category: tool, files: ["**/vitest.config.ts"] }\n');
  write('armature/nodes/api.yaml', 'kind: service\nrole: order API\ncode: [src/api/**]\ntests: [tests/api/**]\n');
  write('armature/nodes/mail/_group.yaml', 'kind: group\nrole: sends email\nchange: mail\n');
  write('armature/nodes/mail/sender.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/mail/**]\n');
  write('armature/changes/mail.yaml', 'title: Receipts by email\nstate: proposed\n');
  write('src/api/server.ts', 'export const x = 1;\n');
  return root;
}

describe('planning gate', () => {
  it('reads who owns what straight from the YAML', () => {
    const own = readOwnership(repo());
    expect(own.on).toBe(true);
    expect(own.nodes.map((n) => `${n.id}:${n.change ?? ''}`)).toEqual(['mail.sender:mail', 'api:', 'mail:mail']);
    expect(own.changes.get('mail')).toBe('proposed');
  });

  it('lets new files into nodes that exist and blocks the ones nothing owns', () => {
    const root = repo();
    expect(writeGate(root, { file_path: path.join(root, 'src/api/orders.ts'), content: '' })).toBeNull();
    const loose = writeGate(root, { file_path: path.join(root, 'src/reports/daily.ts'), content: '' });
    expect(loose?.decision).toBe('deny');
    expect(loose?.reason).toContain('no node in the architecture model owns');
    // Editing a file that exists, tests, documents, tool files and ignored paths all pass.
    expect(writeGate(root, { file_path: path.join(root, 'src/api/server.ts'), new_string: 'x' })).toBeNull();
    expect(writeGate(root, { file_path: 'tests/new/area.test.ts', content: '' })).toBeNull();
    expect(writeGate(root, { file_path: 'docs/notes.md', content: '' })).toBeNull();
    expect(writeGate(root, { file_path: 'vitest.config.ts', content: '' })).toBeNull();
    expect(writeGate(root, { file_path: 'scripts/once/fix.ts', content: '' })).toBeNull();
    expect(writeGate(root, { file_path: '../elsewhere/x.ts', content: '' })).toBeNull();
  });

  it('holds code back until a person approves the change', () => {
    const root = repo();
    const early = writeGate(root, { file_path: 'src/mail/send.ts', content: '' });
    expect(early).toMatchObject({ decision: 'deny' });
    expect(early!.reason).toContain('change "mail", which is still proposed');

    // The agent setting "approved" puts the question to the person, whether it writes or edits the file.
    expect(writeGate(root, { file_path: 'armature/changes/mail.yaml', new_string: 'state: approved' })).toMatchObject({ decision: 'ask' });
    expect(writeGate(root, { file_path: 'armature/changes/new-one.yaml', content: 'title: X\nstate: approved\n' })).toMatchObject({ decision: 'ask' });
    expect(writeGate(root, { file_path: 'armature/changes/mail.yaml', new_string: 'why: because' })).toBeNull();
    expect(writeGate(root, { file_path: 'armature/changes/new-one.yaml', content: 'title: X\nstate: proposed\n' })).toBeNull();

    fs.writeFileSync(path.join(root, 'armature/changes/mail.yaml'), 'title: Receipts by email\nstate: approved\n');
    expect(writeGate(root, { file_path: 'src/mail/send.ts', content: '' })).toBeNull();
    expect(writeGate(root, { file_path: 'armature/changes/mail.yaml', new_string: 'state: approved' })).toBeNull();

    fs.writeFileSync(path.join(root, 'armature/changes/mail.yaml'), 'title: Receipts by email\nstate: dropped\n');
    expect(writeGate(root, { file_path: 'src/mail/send.ts', content: '' })?.reason).toContain('was dropped');
  });

  it('can be switched off, and stays out of the way while a model has no code yet', () => {
    const root = repo();
    fs.appendFileSync(path.join(root, 'armature/system.yaml'), 'gate: off\n');
    expect(writeGate(root, { file_path: 'src/reports/daily.ts', content: '' })).toBeNull();
    // Approval still asks: that is not a matter of how strict the gate is.
    expect(writeGate(root, { file_path: 'armature/changes/mail.yaml', new_string: 'state: approved' })).toMatchObject({ decision: 'ask' });

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-gate-'));
    fs.mkdirSync(path.join(fresh, 'armature/nodes'), { recursive: true });
    fs.writeFileSync(path.join(fresh, 'armature/system.yaml'), 'name: New\nheadline: Nothing yet.\n');
    fs.writeFileSync(path.join(fresh, 'armature/nodes/web.yaml'), 'kind: app\nrole: the site\n');
    expect(writeGate(fresh, { file_path: 'src/index.ts', content: '' })).toBeNull();
  });

  it('still reads a model in arch/, the earlier name of the folder, and says so', () => {
    const root = repo();
    fs.renameSync(path.join(root, 'armature'), path.join(root, 'arch'));
    expect(modelDir(root)).toBe('arch');
    expect(findRoot(path.join(root, 'src/api'))).toBe(root);
    const g = compile(root);
    expect(g.system.dir).toBe('arch');
    expect(g.nodes.map((n) => n.id)).toContain('mail.sender');
    expect(g.problems.filter((p) => p.code === 'legacy-folder').map((p) => p.message)[0]).toContain('git mv arch armature');
    expect(g.problems.filter((p) => p.level === 'error')).toEqual([]);
    // The gate works on the folder the repo has, and names it in what it says.
    expect(writeGate(root, { file_path: 'src/mail/send.ts', content: '' })).toMatchObject({ decision: 'deny' });
    expect(writeGate(root, { file_path: 'arch/changes/mail.yaml', new_string: 'state: approved' })).toMatchObject({ decision: 'ask' });
    expect(writeGate(root, { file_path: 'src/reports/daily.ts', content: '' })!.reason).toContain('arch/changes/<id>.yaml');
    expect(planGate('# A plan', modelDir(root))).toContain('arch/docs/plans/<id>.md');
    // A repo with both folders uses the new one.
    fs.mkdirSync(path.join(root, 'armature'));
    fs.writeFileSync(path.join(root, 'armature/system.yaml'), 'name: Shop\nheadline: Sells things.\n');
    expect(modelDir(root)).toBe('armature');
  });

  it('names the plan path of a repo that keeps its documents elsewhere', () => {
    const root = repo();
    expect(writeGate(root, { file_path: 'src/reports/daily.ts', content: '' })!.reason).toContain('the plan in armature/docs/plans/<id>.md');
    fs.mkdirSync(path.join(root, 'docs'));
    fs.appendFileSync(path.join(root, 'armature/system.yaml'), 'docs: docs\n');
    expect(docsDir(root)).toBe('docs');
    expect(newPlanPath(docsDir(root), 'armature')).toBe('docs/<id>-plan.md');
    expect(writeGate(root, { file_path: 'src/reports/daily.ts', content: '' })!.reason).toContain('the plan in docs/<id>-plan.md');
    expect(planGate('# A plan', 'armature', 'docs/<id>-plan.md')).toContain('the plan document (docs/<id>-plan.md)');
  });

  it('sends back a plan that does not say how it changes the model', () => {
    expect(planGate('# Add receipts\n\n1. Write the mailer.\n')).toContain('Add a section headed "Model change"');
    expect(planGate('# Add receipts\n\n## Model change\n\nChange `mail`: a new worker `mail.sender`.\n')).toBeNull();
    expect(planGate('# Fix a typo\n\n**Model change:** None. The fix stays inside one function.\n')).toBeNull();
    expect(planGate('')).toBeNull();
  });
});
