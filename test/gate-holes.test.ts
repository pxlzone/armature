// The ways around the planning gate that a review found, each closed or made visible.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveChange, callKey, dropPendingApproval, notePendingApproval, settleApproval } from '../src/approve.js';
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

  it('writes the record when the edit the person confirmed goes through, and only then', () => {
    const root = repo();
    const edit = { file_path: change, old_string: 'proposed', new_string: 'approved' };
    // The hook asked about this edit; the person said yes; the edit went through.
    notePendingApproval(root, 'mail', callKey(edit));
    put(root, change, 'title: Receipts by email\nstate: approved\n');
    // Some other edit finishing settles nothing.
    expect(settleApproval(root, callKey({ file_path: 'armature/nodes/mail.yaml', content: 'x' }))).toBe(false);
    expect(readApprovals(root)).toEqual({});
    // The same edit does, whatever order its fields come in.
    expect(settleApproval(root, callKey({ new_string: 'approved', old_string: 'proposed', file_path: change }))).toBe(true);
    expect(readApprovals(root).mail?.elements).toEqual(['add node mail [src/mail/**]']);

    // What is written afterwards is not part of what was approved, in the same turn or a later one.
    put(root, 'armature/nodes/ads.yaml', 'kind: service\nrole: sends marketing mail\ncode: [src/ads/**]\nchange: mail\n');
    expect(settleApproval(root, callKey(edit))).toBe(false);
    expect(readApprovals(root).mail?.elements).toEqual(['add node mail [src/mail/**]']);
    expect(writeGate(root, { file_path: 'src/ads/send.ts', content: '' })).toMatchObject({ decision: 'deny' });
    expect(compile(root).problems.map((p) => p.code)).toContain('scope-changed');
  });

  it('leaves no record of a question the person declined, whatever happens to the change later', () => {
    const root = repo();
    const edit = { file_path: change, content: 'title: Receipts by email\nstate: approved\n' };
    notePendingApproval(root, 'mail', callKey(edit));
    // The person said no. The next write begins (or the agent stops), and the question is closed.
    dropPendingApproval(root);
    // The state changes some way the gate cannot see, and the same edit is sent again.
    put(root, change, 'title: Receipts by email\nstate: approved\n');
    expect(settleApproval(root, callKey(edit))).toBe(false);
    expect(readApprovals(root)).toEqual({});
    expect(compile(root).problems.map((p) => p.code)).toContain('unrecorded-approval');
  });

  it('covers a node inside one the change alters, and no new node through it', () => {
    const root = repo();
    put(root, 'armature/nodes/shop/_group.yaml', 'role: storefront\nmodify: mail\n');
    put(root, 'armature/nodes/shop/cart.yaml', 'kind: service\nrole: cart\ncode: [src/cart/**]\n');
    put(root, 'src/cart/index.ts', 'export const c = 1;\n');
    // While the change is proposed, what it alters takes no new files.
    expect(writeGate(root, { file_path: 'src/cart/totals.ts', content: '' })).toMatchObject({ decision: 'deny' });
    approveChange(root, 'mail', 'Sam');
    // The record names the group that carries the tag, and that covers the node inside it.
    expect(readApprovals(root).mail.elements).toEqual(['add node mail [src/mail/**]', 'modify node shop']);
    expect(writeGate(root, { file_path: 'src/cart/totals.ts', content: '' })).toBeNull();
    // A node that appears inside the group afterwards has no code and no change of its own.
    put(root, 'armature/nodes/shop/ads.yaml', 'kind: service\nrole: ads\ncode: [src/ads/**]\n');
    const late = writeGate(root, { file_path: 'src/ads/send.ts', content: '' });
    expect(late).toMatchObject({ decision: 'deny' });
    expect(late!.reason).toContain('would be the first file of the node "shop.ads"');
  });
});

describe('writes the gate is not shown in full', () => {
  it('reads what a moved file brings, and asks when it is told nothing', () => {
    const root = repo();
    // An MCP move_file names two paths and no content.
    put(root, 'scratch/mail.yaml', 'title: Receipts by email\nstate: approved\n');
    expect(writeGate(root, { source: 'scratch/mail.yaml', destination: change })).toMatchObject({ decision: 'ask', approves: 'mail' });
    put(root, 'scratch/system.yaml', 'name: Shop\nheadline: Sells things.\ngate: off\n');
    expect(writeGate(root, { source: 'scratch/system.yaml', destination: 'armature/system.yaml' })).toMatchObject({ decision: 'ask' });
    // A move that brings nothing of the kind passes.
    put(root, 'scratch/plain.yaml', 'title: Receipts, later\nstate: proposed\n');
    expect(writeGate(root, { source: 'scratch/plain.yaml', destination: change })).toBeNull();
    // Moving the approval record away removes it.
    expect(writeGate(root, { source: 'armature/approvals.lock.json', destination: 'scratch/old.json' })).toMatchObject({ decision: 'ask' });
    // A tool whose input the gate does not know: it cannot tell what the file will hold, so it asks.
    const unknown = writeGate(root, { path: 'armature/changes/other.yaml', text: 'state: approved' } as never);
    expect(unknown).toMatchObject({ decision: 'ask' });
    expect(unknown!.reason).toContain('in a way the gate cannot read');
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
    // system.yaml is written with the file tools, where the person is asked about "gate: off" with the edit in view.
    expect(bashGate(root, 'echo "gate: off" >> armature/system.yaml')).toMatchObject({ decision: 'deny' });
    // Reading, testing and committing are left alone.
    for (const cmd of ['git status', `cat ${change}`, 'armature check && armature show mail', 'npm test > /tmp/out.txt 2>&1', `git add ${change} && git commit -m "plan"`]) {
      expect(bashGate(root, cmd), cmd).toBeNull();
    }
  });

  it('sees a write to a change however the path and the command are spelled', () => {
    const root = repo();
    const inModel = path.join(root, 'armature');
    // The same file, named from inside the model folder.
    expect(bashGate(root, "sed -i '' s/proposed/approved/ changes/mail.yaml", inModel)).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, "cd armature && sed -i '' s/proposed/approved/ changes/mail.yaml")).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, `cd armature/changes && python3 -c "open('mail.yaml','w').write('state: approved')"`)).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, "sed -i '' s/proposed/approved/ armature/changes/*.yaml")).toMatchObject({ decision: 'ask' });
    // The long form of a flag, and the CLI file the launcher loads, run directly.
    expect(bashGate(root, 'sed --in-place s/proposed/approved/ armature/changes/mail.yaml')).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, 'node /plugins/armature/dist/cli.mjs approve mail')).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, 'npx tsx src/cli.ts approve mail')).toMatchObject({ decision: 'ask' });
    // "gate: off" as an assignment: an in-place edit of system.yaml is refused, and a command the gate
    // cannot place a target for still asks.
    expect(bashGate(root, `yq -i '.gate = "off"' armature/system.yaml`)).toMatchObject({ decision: 'deny' });
    expect(bashGate(root, "cd armature && yq --inplace '.gate=\"off\"' system.yaml")).toMatchObject({ decision: 'deny' });
    expect(bashGate(root, `python3 -c "open('armature/system.yaml','a').write('gate: off')"`)).toMatchObject({ decision: 'ask' });
    // Reading from inside the model folder, and other commands of the CLI, are left alone.
    for (const cmd of ['cat changes/mail.yaml && ls nodes', 'grep -rn state changes/']) expect(bashGate(root, cmd, inModel), cmd).toBeNull();
    for (const cmd of ['node dist/cli.js check', "yq '.gate' armature/system.yaml"]) expect(bashGate(root, cmd), cmd).toBeNull();
  });

  it('does not take a path in the home folder for a file in the repo', () => {
    const root = repo();
    expect(shellTargets('touch ~/notes/todo.ts', root)).toEqual([path.join(os.homedir(), 'notes/todo.ts')]);
    expect(shellTargets('cd ~ && touch notes.ts', root)).toEqual([path.join(os.homedir(), 'notes.ts')]);
    expect(bashGate(root, "cat > ~/bin/deploy.sh <<'EOF'\necho hi\nEOF")).toBeNull();
    expect(bashGate(root, 'cp ops.sh ~/bin/')).toBeNull();
    // The same file inside the repo is still a new source file.
    expect(bashGate(root, 'touch bin/deploy.sh')).toMatchObject({ decision: 'deny' });
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

  it('does not take a short name for a file, or a package path, for a new source file', () => {
    const root = repo();
    const plan = (step: string): string => `# Plan\n\n## Model change\nNone. The fix stays inside the API.\n\n## Steps\n1. ${step}\n`;
    // A file that exists, and a new one beside it, named by the end of the path.
    expect(planGate(plan('Edit `api/server.ts` to validate input'), 'armature', undefined, root)).toBeNull();
    expect(planGate(plan('Add api/validate.ts beside the server'), 'armature', undefined, root)).toBeNull();
    // Packages and module paths are not files of this repo.
    expect(planGate(plan('Import McpServer from @modelcontextprotocol/sdk/server/mcp.js'), 'armature', undefined, root)).toBeNull();
    expect(planGate(plan('Follow github.com/acme/kit/retry.go for the backoff'), 'armature', undefined, root)).toBeNull();
    // A new file that no folder of the repo has a place for is still a model change.
    expect(planGate(plan('Create reports/daily.ts'), 'armature', undefined, root)).toContain('the plan creates reports/daily.ts');
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
    // An edit that approves is asked about; a question that is not answered with that edit leaves no record.
    const edit = { file_path: path.join(root, change), old_string: 'proposed', new_string: 'approved' };
    expect(JSON.parse(run(root, 'pre-write', { tool_input: edit })).hookSpecificOutput.permissionDecision).toBe('ask');
    run(root, 'pre-write', { tool_input: { file_path: path.join(root, 'src/api/orders.ts'), content: '' } });
    put(root, change, 'title: Receipts by email\nstate: approved\n');
    run(root, 'post-edit', { tool_input: edit });
    expect(readApprovals(root)).toEqual({});
    // Asked again and confirmed: the edit goes through, and the record is written with what the change holds then.
    put(root, change, 'title: Receipts by email\nstate: proposed\n');
    expect(JSON.parse(run(root, 'pre-write', { tool_input: edit })).hookSpecificOutput.permissionDecision).toBe('ask');
    put(root, change, 'title: Receipts by email\nstate: approved\n');
    run(root, 'post-edit', { tool_input: edit });
    expect(readApprovals(root).mail?.elements).toEqual(['add node mail [src/mail/**]']);
    // No model above this folder: nothing is said, and the CLI is not even loaded.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-bare-'));
    const started = Date.now();
    expect(run(bare, 'pre-write', { tool_input: { file_path: 'src/x.ts', content: '' } })).toBe('');
    expect(Date.now() - started).toBeLessThan(1400);
  });
});
