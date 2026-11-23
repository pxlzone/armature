import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { bashGate } from '../src/gate.js';
import { approveFromPage } from '../src/server.js';
import { awaitingApproval } from '../src/types.js';

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-review-'));
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('armature/system.yaml', 'name: Shop\nheadline: Sells things.\n');
  write('armature/nodes/api.yaml', 'kind: service\nrole: order API\ncode: [src/api/**]\n');
  write('armature/nodes/mail.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/mail/**]\nchange: mail\n');
  write('armature/changes/mail.yaml', 'title: Receipts by email\nstate: proposed\n');
  write('src/api/server.ts', 'export const x = 1;\n');
  return root;
}

const TOKEN = 'a'.repeat(48);
const from = (headers: Record<string, string>) => ({ headers: { host: 'localhost:4747', ...headers } });
const waiting = (root: string): Array<string | null> => compile(root).changes.map((c) => awaitingApproval(c));

describe('approving from the viewer', () => {
  it('lists a proposed change as waiting, and a recorded approval as settled', () => {
    const root = repo();
    expect(waiting(root)).toEqual(['proposed']);
    const out = approveFromPage(root, TOKEN, from({ 'x-armature-token': TOKEN, origin: 'http://localhost:4747' }), '{"id":"mail"}');
    expect(out).toMatchObject({ status: 200, ok: true });
    expect(fs.readFileSync(path.join(root, 'armature/changes/mail.yaml'), 'utf8')).toContain('state: approved');
    expect(waiting(root)).toEqual([null]);
    // What joins the change afterwards puts it back in the queue.
    fs.writeFileSync(path.join(root, 'armature/nodes/sms.yaml'), 'kind: worker\nrole: sends texts\ncode: [src/sms/**]\nchange: mail\n');
    expect(waiting(root)).toEqual(['scope-changed']);
  });

  it('refuses a request that does not come from the page the server gave out', () => {
    const root = repo();
    const body = '{"id":"mail"}';
    expect(approveFromPage(root, TOKEN, from({}), body).status).toBe(403);
    expect(approveFromPage(root, TOKEN, from({ 'x-armature-token': 'b'.repeat(48) }), body).status).toBe(403);
    expect(approveFromPage(root, TOKEN, from({ 'x-armature-token': TOKEN, origin: 'https://evil.example' }), body).status).toBe(403);
    expect(approveFromPage(root, TOKEN, from({ 'x-armature-token': TOKEN, host: 'evil.example:4747' }), body).status).toBe(403);
    expect(approveFromPage(root, TOKEN, from({ 'x-armature-token': TOKEN }), '{"id":"../x"}').status).toBe(400);
    expect(approveFromPage(root, TOKEN, from({ 'x-armature-token': TOKEN }), '{"id":"nope"}')).toMatchObject({ status: 409, ok: false });
    expect(waiting(root)).toEqual(['proposed']);
  });

  it('puts a command that calls the viewer to approve to the person', () => {
    const root = repo();
    expect(bashGate(root, `curl -X POST http://localhost:4747/approve -H 'x-armature-token: abc' -d '{"id":"mail"}'`)).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, 'curl -s http://127.0.0.1:4747/ | grep __ARMATURE_APPROVE__')).toMatchObject({ decision: 'ask' });
    expect(bashGate(root, 'curl -s http://localhost:4747/graph.json')).toBeNull();
  });
});

describe('when a plan was proposed', () => {
  it('is the first commit of the change file, or the file date before it is committed', async () => {
    const { execFileSync } = await import('node:child_process');
    const { proposedAt } = await import('../src/server.js');
    const root = repo();
    // Not in git yet: the file's own date.
    const fresh = proposedAt(root, 'mail');
    expect(Math.abs(Date.parse(fresh ?? '') - Date.now())).toBeLessThan(60_000);
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2026-03-04T10:00:00Z', GIT_COMMITTER_DATE: '2026-03-04T10:00:00Z' } });
    };
    run('init', '-q');
    run('add', '.');
    run('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'plan');
    // A later edit does not move the date.
    fs.appendFileSync(path.join(root, 'armature/changes/mail.yaml'), 'why: People ask for receipts.\n');
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', 'why'], { cwd: root, stdio: 'ignore' });
    expect(Date.parse(proposedAt(root, 'mail') ?? '')).toBe(Date.parse('2026-03-04T10:00:00Z'));
    expect(proposedAt(root, 'nothing')).toBeUndefined();
  });
});
