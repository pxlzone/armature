import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { parseConventional } from '../src/repo.js';
import { activity } from '../src/render.js';
import { indexGraph, visibleFor, visibleGraph } from '../viewer/src/view.js';

describe('Conventional Commits', () => {
  it('reads type, scope, breaking mark and description', () => {
    expect(parseConventional('feat(billing): retry failed charges (#122)')).toEqual({ type: 'feat', scope: 'billing', breaking: false, description: 'retry failed charges', conventional: true });
    expect(parseConventional('fix!: drop the old route')).toMatchObject({ type: 'fix', scope: undefined, breaking: true });
    expect(parseConventional('Fix(API): Case')).toMatchObject({ type: 'fix', scope: 'api' });
  });

  it('treats anything else as other', () => {
    expect(parseConventional('Merge pull request #1 from x/y')).toMatchObject({ type: 'other', conventional: false });
    expect(parseConventional('feat:no space')).toMatchObject({ conventional: false });
  });
});

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-act-'));
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Tester', ...args], { cwd: root, stdio: 'ignore' });
  };
  git('init', '-q');
  write('armature/system.yaml', 'name: Shop\nheadline: Sells things.\n');
  write('armature/nodes/core/_group.yaml', 'role: the core\n');
  write('armature/nodes/core/api.yaml', 'kind: service\nrole: order API\ncode: [src/api/**]\ncalls: [billing]\n');
  write('armature/nodes/core/email.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/email/**]\nchange: receipts\n');
  write('armature/nodes/billing.yaml', 'kind: worker\nrole: charges cards\ncode: [src/billing/**]\nscopes: [payments]\n');
  write('armature/changes/receipts.yaml', 'title: Receipts\nstate: approved\n');
  write('src/api/a.ts', '1');
  git('add', '-A');
  git('commit', '-qm', 'chore: start');
  write('src/api/a.ts', '2');
  git('commit', '-qam', 'feat(api): add checkout');
  write('src/billing/b.ts', '1');
  git('add', '-A');
  git('commit', '-qm', 'fix: retry a failed charge');
  git('commit', '-q', '--allow-empty', '-m', 'docs(payments): explain refunds');
  git('commit', '-q', '--allow-empty', '-m', 'ci(deploy): faster pipeline');
  return root;
}

describe('activity', () => {
  it('places commits on nodes by changed files and by scope', () => {
    const g = compile(repo(), { activity: true });
    const by = (id: string) => g.nodes.find((n) => n.id === id)!.activity;
    expect(g.activity).toMatchObject({ commits: 5, conventional: 5, prsLoaded: false });
    expect(by('core.api')).toMatchObject({ commits: 2, byType: { chore: 1, feat: 1 } });
    // The fix reaches billing through its file; the docs commit through the "payments" scope alias.
    expect(by('billing')).toMatchObject({ commits: 2, byType: { fix: 1, docs: 1 } });
    // A parent counts what its children count.
    expect(by('core')!.commits).toBe(2);
    expect(g.activity!.unmatchedScopes).toEqual([{ scope: 'deploy', count: 1 }]);
    expect(activity(g)).toContain('billing: 2 commits');
  });

  it('is skipped unless asked for', () => {
    expect(compile(repo()).activity).toBeNull();
  });
});

describe('what a screen shows', () => {
  it('lifts links to the deepest visible node and re-splits them on expansion', () => {
    const g = compile(repo());
    const ix = indexGraph(g);
    const base = { focus: null, showLibraries: false, hidePlanned: false };
    const collapsed = visibleGraph(g, ix, { ...base, expanded: new Set() });
    expect([...collapsed.nodes.keys()].sort()).toEqual(['billing', 'core']);
    expect([...collapsed.edges.keys()]).toEqual(['core=>billing']);
    const open = visibleGraph(g, ix, { ...base, expanded: new Set(['core']) });
    expect(open.nodes.get('core')!.container).toBe(true);
    expect([...open.edges.keys()]).toEqual(['core.api=>billing']);
    expect(visibleFor(ix, 'core.api', null, new Set())).toBe('core');
    expect(visibleFor(ix, 'core.api', null, new Set(['core']))).toBe('core.api');
  });

  it('hides planned nodes in the built-today view, and shows neighbours as ghosts when focused', () => {
    const g = compile(repo());
    const ix = indexGraph(g);
    const today = visibleGraph(g, ix, { focus: null, expanded: new Set(['core']), showLibraries: false, hidePlanned: true });
    expect(today.nodes.has('core.email')).toBe(false);
    expect(today.hiddenPlanned).toBe(1);
    const inside = visibleGraph(g, ix, { focus: 'core', expanded: new Set(), showLibraries: false, hidePlanned: false });
    expect(inside.nodes.get('billing')!.ghost).toBe(true);
    expect(inside.nodes.get('core.api')!.ghost).toBe(false);
  });
});
