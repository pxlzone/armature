// The ways around the planning gate that a review found, each closed or made visible.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveChange, notePendingApproval, settleApproval } from '../src/approve.js';
import { compile } from '../src/compile.js';
import { bashGate, planGate, shellTargets, writeGate } from '../src/gate.js';
import { readApprovals } from '../src/paths.js';

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-holes-'));
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('armature/system.yaml', 'name: Shop\nheadline: Sells things.\nrules: []\n');
  write('armature/nodes/api.yaml', 'kind: service\nrole: order API\ncode: [src/api/**]\n');
  write('armature/nodes/mail.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/mail/**]\nchange: mail\n');
  write('armature/changes/mail.yaml', 'title: Receipts by email\nstate: proposed\n');
  write('src/api/server.ts', 'export const x = 1;\n');
  return root;
}
const put = (root: string, rel: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const change = 'armature/changes/mail.yaml';

describe('approval is asked for, however the edit is written', () => {
  it('asks when only the word changes', () => {
    const root = repo();
    expect(writeGate(root, { file_path: change, old_string: 'proposed', new_string: 'approved' })).toMatchObject({ decision: 'ask', approves: 'mail' });
    expect(writeGate(root, { file_path: change, edits: [{ old_string: 'state: proposed', new_string: 'state: approved' }] })).toMatchObject({ decision: 'ask' });
    // The same edit as an MCP file tool sends it.
    expect(writeGate(root, { path: change, edits: [{ oldText: 'proposed', newText: 'approved' }] })).toMatchObject({ decision: 'ask' });
    // An edit that leaves the state alone asks nothing, even when it mentions the word.
    expect(writeGate(root, { file_path: change, old_string: 'Receipts by email', new_string: 'Receipts, once approved' })).toBeNull();
  });

  it('asks before a change skips approval by going straight to done', () => {
    const root = repo();
    const skip = writeGate(root, { file_path: change, old_string: 'state: proposed', new_string: 'state: done' });
    expect(skip).toMatchObject({ decision: 'ask' });
    expect(skip!.reason).toContain('never approved');
    expect(writeGate(root, { file_path: 'armature/changes/new.yaml', content: 'title: X\nstate: done\n' })).toMatchObject({ decision: 'ask' });
    put(root, change, 'title: Receipts by email\nstate: approved\n');
    expect(writeGate(root, { file_path: change, old_string: 'approved', new_string: 'done' })).toBeNull();
  });

  it('asks before the gate is switched off or the approval record is edited', () => {
    const root = repo();
    expect(writeGate(root, { file_path: 'armature/system.yaml', old_string: 'rules: []', new_string: 'rules: []\ngate: off' })).toMatchObject({ decision: 'ask' });
    expect(writeGate(root, { file_path: 'armature/system.yaml', old_string: 'rules: []', new_string: 'rules:\n  - Be kind.' })).toBeNull();
    expect(writeGate(root, { file_path: 'armature/approvals.lock.json', content: '{}' })).toMatchObject({ decision: 'ask' });
  });
});

describe('what counts as a new source file', () => {
  it('does not let a "tests" folder or an unlisted language through', () => {
    const root = repo();
    // A test by name passes, and so does a helper in a test folder that is already there.
    expect(writeGate(root, { file_path: 'src/api/orders.test.ts', content: '' })).toBeNull();
    put(root, 'tests/api.test.ts', '');
    expect(writeGate(root, { file_path: 'tests/helpers/db.ts', content: '' })).toBeNull();
    // A folder called tests that does not exist is no way in.
    expect(writeGate(root, { file_path: 'src/tests/refund-engine.ts', content: '' })).toMatchObject({ decision: 'deny' });
    for (const f of ['web/App.vue', 'web/App.svelte', 'infra/main.tf', 'ops/deploy.sh', 'api/orders.proto', 'svc/main.go']) {
      expect(writeGate(root, { file_path: f, content: '' }), f).toMatchObject({ decision: 'deny' });
    }
    expect(writeGate(root, { file_path: 'config/app.json', content: '' })).toBeNull();
  });

  it('wants an approved change behind a node that has no code yet', () => {
    const root = repo();
    // Dropping the tag from a planned node does not make it buildable.
    put(root, 'armature/nodes/mail.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/mail/**]\n');
    const first = writeGate(root, { file_path: 'src/mail/send.ts', content: '' });
    expect(first).toMatchObject({ decision: 'deny' });
    expect(first!.reason).toContain('would be the first file of the node "mail"');
    // Neither does marking its change done.
    put(root, 'armature/nodes/mail.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/mail/**]\nchange: mail\n');
    put(root, change, 'title: Receipts by email\nstate: done\n');
    expect(writeGate(root, { file_path: 'src/mail/send.ts', content: '' })).toMatchObject({ decision: 'deny' });
    // A node that is already part of the system takes new files as before.
    expect(writeGate(root, { file_path: 'src/api/orders.ts', content: '' })).toBeNull();
  });

  it('holds new files back in a node that a proposed change alters', () => {
    const root = repo();
    put(root, 'armature/nodes/api.yaml', 'kind: service\nrole: order API\ncode: [src/api/**]\nmodify: mail\n');
    const v = writeGate(root, { file_path: 'src/api/receipts.ts', content: '' });
    expect(v).toMatchObject({ decision: 'deny' });
    expect(v!.reason).toContain('which change "mail" alters, which is still proposed');
  });
});

describe('an approval covers what was approved', () => {
  it('records the elements, and holds back what joins the change later', () => {
    const root = repo();
    expect(approveChange(root, 'mail', 'Sam')).toContain('add node mail [src/mail/**]');
    expect(fs.readFileSync(path.join(root, change), 'utf8')).toContain('state: approved');
    expect(readApprovals(root).mail).toMatchObject({ by: 'Sam', elements: ['add node mail [src/mail/**]'] });
    expect(writeGate(root, { file_path: 'src/mail/send.ts', content: '' })).toBeNull();
    expect(compile(root).problems.map((p) => p.code)).not.toContain('scope-changed');

    // Something unrelated is tagged onto the approved change.
    put(root, 'armature/nodes/ads.yaml', 'kind: service\nrole: sends marketing mail\ncode: [src/ads/**]\nchange: mail\n');
    const late = writeGate(root, { file_path: 'src/ads/send.ts', content: '' });
    expect(late).toMatchObject({ decision: 'deny' });
    expect(late!.reason).toContain('joined change "mail" after Sam approved it');
    const g = compile(root);
    expect(g.problems.find((p) => p.code === 'scope-changed')!.message).toContain('added: add node ads [src/ads/**]');
    expect(g.changes.find((c) => c.id === 'mail')!.approval).toMatchObject({ by: 'Sam', added: ['add node ads [src/ads/**]'] });

    // Approving again covers it.
    approveChange(root, 'mail', 'Sam');
    expect(writeGate(root, { file_path: 'src/ads/send.ts', content: '' })).toBeNull();
    expect(compile(root).problems.map((p) => p.code)).not.toContain('scope-changed');
  });

  it('says when an approval was typed with nothing recorded, and refuses to approve nothing', () => {
    const root = repo();
    put(root, change, 'title: Receipts by email\nstate: approved\n');
    expect(compile(root).problems.find((p) => p.code === 'unrecorded-approval')!.message).toContain('armature approve mail');
    put(root, 'armature/changes/empty.yaml', 'title: Nothing yet\nstate: proposed\n');
    expect(approveChange(root, 'empty')).toContain('has no elements yet');
    expect(approveChange(root, 'nope')).toContain('No change "nope"');
  });

  it('writes the record once the person has confirmed an edit that approves', () => {
    const root = repo();
    // The hook asked; the person said yes; the edit went through.
    notePendingApproval(root, 'mail');
    put(root, change, 'title: Receipts by email\nstate: approved\n');
    settleApproval(root, false);
    expect(readApprovals(root).mail?.elements).toEqual(['add node mail [src/mail/**]']);
    // What is written straight after, in the same turn, is part of what was approved.
    put(root, 'armature/nodes/mail.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/mail/**]\nchange: mail\naccepts:\n  - id: send\n    via: pgmq\n    change: mail\n');
    settleApproval(root, true);
    expect(readApprovals(root).mail?.elements).toEqual(['add interface mail#send', 'add node mail [src/mail/**]']);
    // After the turn ends, nothing more is added on the strength of that approval.
    put(root, 'armature/nodes/ads.yaml', 'kind: service\nrole: sends marketing mail\ncode: [src/ads/**]\nchange: mail\n');
    settleApproval(root, false);
    expect(readApprovals(root).mail?.elements).toHaveLength(2);
    // A question the person declined leaves no record.
    const other = repo();
    notePendingApproval(other, 'mail');
    settleApproval(other, true);
    expect(readApprovals(other)).toEqual({});
  });
});

describe('shell commands', () => {
  it('reads what a command would create', () => {
    const cwd = '/repo';
    expect(shellTargets('cat > src/a.ts <<EOF\nconst f = (x) => x > 1;\nEOF', cwd)).toEqual(['/repo/src/a.ts']);
    expect(shellTargets('mkdir -p src/x && touch src/x/a.ts src/x/b.ts', cwd)).toEqual(['/repo/src/x/a.ts', '/repo/src/x/b.ts']);
    expect(shellTargets('cd apps/api && echo hi >> notes.txt', cwd)).toEqual(['/repo/apps/api/notes.txt']);
    expect(shellTargets('git mv src/a.ts src/b.ts; cp tmpl.ts "src/new one.ts"', cwd)).toEqual(['/repo/src/b.ts', '/repo/src/new one.ts']);
    expect(shellTargets('npm test 2>&1 | tee out.log', cwd)).toEqual(['/repo/out.log']);
    expect(shellTargets('echo "a > b" && ls -la', cwd)).toEqual([]);
  });

  it('applies the gate to files a command creates and to approvals it writes', () => {
    const root = repo();
    const made = bashGate(root, 'mkdir -p src/reports && cat > src/reports/daily.ts <<EOF\nexport const x = 1;\nEOF');
    expect(made).toMatchObject({ decision: 'deny' });
    expect(made!.reason).toContain('This command would create src/reports/daily.ts');
    expect(bashGate(root, 'touch src/mail/send.ts')).toMatchObject({ decision: 'deny' });
    expect(bashGate(root, 'touch src/api/orders.ts')).toBeNull();
    expect(bashGate(root, `sed -i '' s/proposed/approved/ ${change}`)).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, 'armature approve mail')).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, 'node /x/bin/armature.mjs approve mail')).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, 'echo "gate: off" >> armature/system.yaml')).toMatchObject({ decision: 'ask' });
    // Reading, testing and committing are left alone.
    for (const cmd of ['git status', `cat ${change}`, 'armature check && armature show mail', 'npm test > /tmp/out.txt 2>&1', `git add ${change} && git commit -m "plan"`]) {
      expect(bashGate(root, cmd), cmd).toBeNull();
    }
  });
});

describe('a plan that says the model does not change', () => {
  it('needs a reason, and must not create what the model has no place for', () => {
    const root = repo();
    expect(planGate('# Plan\n\n## Model change\nNone.\n\n## Steps\n1. add a new service\n', 'armature', undefined, root)).toContain('gives no reason');
    const made = planGate('# Plan\n\n## Model change\nNone. Nothing in the model moves.\n\n## Steps\n1. Create src/reports/daily.ts\n', 'armature', undefined, root);
    expect(made).toContain('the plan creates src/reports/daily.ts');
    // A new file inside a node that exists is no model change.
    expect(planGate('# Plan\n\n## Model change\nNone. The fix stays inside the API.\n\n## Steps\n1. Create src/api/validate.ts\n', 'armature', undefined, root)).toBeNull();
    expect(planGate('# Plan\n\n## Model change\n\nChange `reports`: a new worker with code in src/reports/**.\n\n1. Create src/reports/daily.ts\n', 'armature', undefined, root)).toBeNull();
  });
});

describe('the hook itself', () => {
  it('answers through the launcher, and stays silent and quick where there is no model', () => {
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'armature.mjs');
    if (!fs.existsSync(path.resolve(import.meta.dirname, '..', 'dist', 'cli.js'))) return; // not built: nothing to launch
    const run = (cwd: string, name: string, input: object): string => execFileSync('node', [bin, 'hook', name], { input: JSON.stringify({ cwd, ...input }), encoding: 'utf8' });
    const root = repo();
    const verdict = JSON.parse(run(root, 'pre-write', { tool_input: { file_path: 'src/reports/daily.ts', content: '' } }));
    expect(verdict.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(JSON.parse(run(root, 'pre-bash', { tool_input: { command: 'touch src/mail/send.ts' } })).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(run(root, 'pre-bash', { tool_input: { command: 'git status' } })).toBe('');
    // No model above this folder: nothing is said, and the CLI is not even loaded.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-bare-'));
    const started = Date.now();
    expect(run(bare, 'pre-write', { tool_input: { file_path: 'src/x.ts', content: '' } })).toBe('');
    expect(Date.now() - started).toBeLessThan(1400);
  });
});
