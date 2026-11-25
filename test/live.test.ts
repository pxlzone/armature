import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hook } from '../src/agent.js';
import { compile } from '../src/compile.js';
import { commandName, fileDiff, liveFile, noteLive, readLive, type LiveEvent } from '../src/live.js';
import { fileId, indexGraph, visibleGraph, withFiles } from '../viewer/src/view.js';
import { progressGate, sessionUrl, type ProgressDeps, type Watching } from '../src/viewer-open.js';
import { liveFiles, liveMarks, liveNode, sizeOf, stepLines } from '../viewer/src/Live.js';

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-live-'));
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('armature/system.yaml', 'name: Shop\nheadline: Sells things.\n');
  write('armature/nodes/core/_group.yaml', 'role: the core\n');
  write('armature/nodes/core/api.yaml', 'kind: service\nrole: order API\ncode: [src/api/**]\n');
  write('armature/nodes/core/email.yaml', 'kind: worker\nrole: sends receipts\ncode: [src/email/**]\nchange: receipts\n');
  write('armature/nodes/billing.yaml', 'kind: worker\nrole: charges cards\ncode: [src/billing/**]\n');
  write('armature/changes/receipts.yaml', 'title: Receipts\nstate: approved\n');
  write('src/api/a.ts', '1');
  write('src/billing/b.ts', '1');
  return root;
}

const events = (root: string): LiveEvent[] => fs.readFileSync(liveFile(root), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Writes the log as it would be `minutesAgo` minutes later. */
function age(root: string, minutes: number): void {
  fs.writeFileSync(liveFile(root), `${events(root).map((e) => JSON.stringify({ ...e, t: e.t - minutes * 60000 })).join('\n')}\n`);
}

describe('command names', () => {
  it('keeps the program and its first word, and nothing that could be a secret', () => {
    expect(commandName('npm test -- --run')).toBe('npm test');
    expect(commandName('/usr/local/bin/pytest -q tests')).toBe('pytest');
    expect(commandName('TOKEN=abc123 curl -H "Authorization: Bearer abc123" https://x.test')).toBe('curl');
    expect(commandName('psql "postgres://u:secret@host/db"')).toBe('psql');
    expect(commandName('')).toBe('');
  });
});

describe('live sessions', () => {
  it('says what a session is doing and which parts it touched', () => {
    const root = repo();
    noteLive(root, 's1', 'start');
    noteLive(root, 's1', 'prompt', { text: `Send a receipt\nafter every charge. ${'x'.repeat(300)}` });
    noteLive(root, 's1', 'read', { file: path.join(root, 'src/api/a.ts') });
    noteLive(root, 's1', 'editing', { file: 'src/billing/b.ts' });
    noteLive(root, 's1', 'edited', { file: 'src/billing/b.ts' });
    noteLive(root, 's1', 'editing', { file: 'src/email/send.ts' });
    noteLive(root, 's1', 'edited', { file: 'src/email/send.ts' });
    noteLive(root, 's1', 'edited', { file: 'src/email/send.ts' });
    const [s] = readLive(root, compile(root)).sessions;
    expect(s.working).toBe(true);
    expect(s.prompt).toHaveLength(140);
    expect(s.prompt).toMatch(/^Send a receipt after every charge\. x+…$/);
    expect(s.now).toMatchObject({ kind: 'edited', node: 'core.email', file: 'src/email/send.ts' });
    expect(s.nodes.map((n) => [n.id, n.edits, n.reads])).toEqual([['core.email', 2, 0], ['billing', 1, 0], ['core.api', 0, 1]]);
    // The change that plans the part being edited is the work in progress.
    expect(s.changes).toEqual(['receipts']);
    expect(s.steps[0].kind).toBe('edited');
  });

  it('shows a command while it runs, and a stop as a stop', () => {
    const root = repo();
    noteLive(root, 's1', 'edited', { file: 'src/api/a.ts' });
    noteLive(root, 's1', 'run', { text: 'npm test' });
    let [s] = readLive(root, compile(root)).sessions;
    expect(s.now).toMatchObject({ kind: 'run', text: 'npm test' });
    // The part it was in keeps its mark while the command runs.
    expect(s.part).toBe('core.api');
    noteLive(root, 's1', 'stop');
    [s] = readLive(root, compile(root)).sessions;
    expect(s.working).toBe(false);
    expect(s.nodes.map((n) => n.id)).toEqual(['core.api']);
  });

  it('takes a silent session to have stopped, then forgets it', () => {
    const root = repo();
    noteLive(root, 's1', 'edited', { file: 'src/api/a.ts' });
    age(root, 20);
    expect(readLive(root, compile(root)).sessions[0].working).toBe(false);
    age(root, 20);
    expect(readLive(root, compile(root)).sessions).toEqual([]);
  });

  it('lists the working session first and leaves out files outside the repo', () => {
    const root = repo();
    noteLive(root, 'idle', 'edited', { file: 'src/api/a.ts' });
    noteLive(root, 'idle', 'stop');
    noteLive(root, 'busy', 'read', { file: '/etc/passwd' });
    noteLive(root, 'busy', 'read', { file: 'armature/.cache/code-index.json' });
    noteLive(root, '', 'edited', { file: 'src/api/a.ts' });
    const live = readLive(root, compile(root));
    expect(live.sessions.map((s) => s.id)).toEqual(['busy', 'idle']);
    expect(live.sessions[0].steps).toEqual([]);
    expect(JSON.stringify(live)).not.toContain('passwd');
  });

  it('survives a broken line and keeps the log small', () => {
    const root = repo();
    noteLive(root, 's1', 'edited', { file: 'src/api/a.ts' });
    fs.appendFileSync(liveFile(root), '{"t":1,"s":"s1","k":"edi\n');
    expect(readLive(root, compile(root)).sessions).toHaveLength(1);
    fs.appendFileSync(liveFile(root), `${JSON.stringify({ t: Date.now(), s: 's1', k: 'read', file: 'x'.repeat(200) })}\n`.repeat(1500));
    noteLive(root, 's1', 'stop');
    expect(fs.statSync(liveFile(root)).size).toBeLessThan(256 * 1024);
    expect(events(root).pop()).toMatchObject({ k: 'stop' });
  });
});

describe('hooks write the log', () => {
  const run = async (root: string, name: string, input: object): Promise<void> => {
    (globalThis as { __ARMATURE_STDIN__?: string }).__ARMATURE_STDIN__ = JSON.stringify({ session_id: 's1', cwd: root, ...input });
    try {
      await hook(name, root);
    } finally {
      delete (globalThis as { __ARMATURE_STDIN__?: string }).__ARMATURE_STDIN__;
    }
  };

  it('one line per step, with the name of a command and never the command', async () => {
    const root = repo();
    await run(root, 'prompt', { prompt: 'fix it' });
    await run(root, 'pre-write', { tool_input: { file_path: path.join(root, 'src/api/a.ts'), old_string: '1', new_string: '2' } });
    await run(root, 'post-edit', { tool_input: { file_path: path.join(root, 'src/api/a.ts') } });
    await run(root, 'pre-bash', { tool_input: { command: 'SECRET=hunter2 npm test' } });
    await run(root, 'note', { tool_input: { file_path: path.join(root, 'src/billing/b.ts') } });
    await run(root, 'stop', {});
    expect(events(root).map((e) => e.k)).toEqual(['prompt', 'editing', 'edited', 'run', 'read', 'stop']);
    expect(fs.readFileSync(liveFile(root), 'utf8')).not.toContain('hunter2');
    expect(events(root)[3].text).toBe('npm test');
  });

  it('the launcher records a read without loading the CLI', () => {
    const root = repo();
    const launcher = path.resolve(import.meta.dirname, '..', 'bin', 'armature.mjs');
    const input = JSON.stringify({ session_id: 's1', cwd: root, tool_input: { file_path: path.join(root, 'src/billing/b.ts') } });
    execFileSync(process.execPath, [launcher, 'hook', 'note'], { input });
    expect(events(root)).toMatchObject([{ s: 's1', k: 'read' }]);
    expect(readLive(root, compile(root)).sessions[0].now).toMatchObject({ kind: 'read', node: 'billing' });
  });
});

describe('marks on the map', () => {
  it('fall on the block that shows the part: the part itself, or the closed group around it', () => {
    const root = repo();
    noteLive(root, 's1', 'edited', { file: 'src/billing/b.ts' });
    noteLive(root, 's1', 'editing', { file: 'src/email/send.ts' });
    const g = compile(root);
    const live = readLive(root, g);
    const ix = indexGraph(g);
    expect(liveNode(live)).toBe('core.email');
    expect([...liveMarks(live, ix, null, new Set())]).toEqual([['billing', 'touched'], ['core', 'now']]);
    expect(liveMarks(live, ix, null, new Set(['core'])).get('core.email')).toBe('now');
    expect(liveMarks(null, ix, null, new Set()).size).toBe(0);
  });
});

describe('the session view', () => {
  it('lists the steps newest first, one line per write, and counts a step repeated in a row', () => {
    const root = repo();
    noteLive(root, 's1', 'start');
    noteLive(root, 's1', 'prompt', { text: 'Send receipts' });
    noteLive(root, 's1', 'read', { file: 'src/api/a.ts' });
    for (let i = 0; i < 2; i++) {
      noteLive(root, 's1', 'editing', { file: 'src/billing/b.ts' });
      noteLive(root, 's1', 'edited', { file: 'src/billing/b.ts' });
    }
    noteLive(root, 's1', 'run', { text: 'npm test' });
    const g = compile(root);
    const lines = stepLines(readLive(root, g).sessions[0].steps, indexGraph(g));
    expect(lines.map((l) => [l.verb, l.what, l.node, l.times])).toEqual([
      ['Ran', 'npm test', undefined, 1],
      ['Edited', 'src/billing/b.ts', 'billing', 2],
      ['Read', 'src/api/a.ts', 'core.api', 1],
      ['Task', 'Send receipts', undefined, 1],
    ]);
  });
});

describe('what a session changed', () => {
  const committed = (): string => {
    const root = repo();
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Tester', ...args], { cwd: root, stdio: 'ignore' });
    };
    fs.writeFileSync(path.join(root, 'secret.txt'), 'not for the page\n');
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'first');
    return root;
  };

  it('gives each edited file its size against the last commit, and a new file as all new', () => {
    const root = committed();
    fs.writeFileSync(path.join(root, 'src/billing/b.ts'), 'one\ntwo\n');
    fs.mkdirSync(path.join(root, 'src/email'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/email/send.ts'), 'a\nb\nc\n');
    noteLive(root, 's1', 'read', { file: 'src/api/a.ts' });
    noteLive(root, 's1', 'edited', { file: 'src/billing/b.ts' });
    noteLive(root, 's1', 'edited', { file: 'src/billing/b.ts' });
    noteLive(root, 's1', 'edited', { file: 'src/email/send.ts' });
    const g = compile(root);
    const plain = readLive(root, g);
    expect(plain.sessions[0].nodes.find((n) => n.id === 'billing')?.files).toEqual([{ path: 'src/billing/b.ts', edits: 2 }]);
    const live = readLive(root, g, Date.now(), { changes: true });
    const files = live.sessions[0].nodes.flatMap((n) => n.files);
    expect(files).toEqual([
      { path: 'src/email/send.ts', edits: 1, added: 3, removed: 0, fresh: true },
      { path: 'src/billing/b.ts', edits: 2, added: 2, removed: 1 },
      { path: 'src/api/a.ts', edits: 0 },
    ]);
    expect(files.map(sizeOf)).toEqual(['new, 3 lines', '+2 −1', '']);
    // On the map the files sit on the block that shows their part.
    expect([...liveFiles(live, indexGraph(g), null, new Set())].map(([id, fs]) => [id, fs.map((f) => f.path)])).toEqual([['core', ['src/email/send.ts']], ['billing', ['src/billing/b.ts']]]);
  });

  it('shows the diff of a file a session edited, and of no other file', () => {
    const root = committed();
    fs.writeFileSync(path.join(root, 'src/billing/b.ts'), 'one\n');
    fs.writeFileSync(path.join(root, 'src/billing/new.ts'), 'x\ny\n');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'changed\n');
    noteLive(root, 's1', 'edited', { file: 'src/billing/b.ts' });
    noteLive(root, 's1', 'edited', { file: 'src/billing/new.ts' });
    noteLive(root, 's1', 'read', { file: 'src/api/a.ts' });
    const live = readLive(root, compile(root));
    expect(fileDiff(root, live, 'src/billing/b.ts')).toMatch(/^-1$[\s\S]*^\+one$/m);
    expect(fileDiff(root, live, 'src/billing/new.ts')).toBe('@@ -0,0 +1,2 @@ new file\n+x\n+y\n');
    // Not edited by a session: refused, whether it changed, was only read, or lies outside the repo.
    expect(fileDiff(root, live, 'secret.txt')).toBeNull();
    expect(fileDiff(root, live, 'src/api/a.ts')).toBeNull();
    expect(fileDiff(root, live, '../../etc/passwd')).toBeNull();
  });
});

describe('files on the map', () => {
  it('draws the files of a part inside it, the edited ones always, with the imports between them', () => {
    const root = repo();
    fs.writeFileSync(path.join(root, 'src/api/a.ts'), "import { b } from './b';\nexport const a = b;\n");
    for (const name of ['b', 'c', 'd', 'e']) fs.writeFileSync(path.join(root, `src/api/${name}.ts`), `export const ${name} = 1;\n`);
    noteLive(root, 's1', 'editing', { file: 'src/api/e.ts' });
    noteLive(root, 's1', 'edited', { file: 'src/api/e.ts' });
    const g = compile(root, { files: true });
    expect(g.files?.['core.api'].map((f) => f.path)).toEqual(['src/api/a.ts', 'src/api/b.ts', 'src/api/c.ts', 'src/api/d.ts', 'src/api/e.ts']);
    g.files!['core.api'][0].imports = ['src/api/b.ts'];
    const live = readLive(root, g);
    const { graph, edges } = withFiles(g, new Set(['src/api/e.ts']), 2);
    const api = graph.nodes.find((n) => n.id === 'core.api')!;
    // The edited file comes first and is never cut; the rest is one block.
    expect(api.children.map((id) => graph.nodes.find((n) => n.id === id)!.name)).toEqual(['e.ts', 'a.ts', '3 more files']);
    expect(g.nodes.find((n) => n.id === 'core.api')!.children).toEqual([]);
    // b.ts is not drawn, so neither is the import that leads to it.
    expect(edges).toEqual([]);
    const all = withFiles(g, new Set(), 10);
    expect(all.edges.map((e) => [e.from, e.to])).toEqual([[fileId('core.api', 'src/api/a.ts'), fileId('core.api', 'src/api/b.ts')]]);
    // The mark is on the file once its part is open, and on the part or its group while they are closed.
    const ix = indexGraph(graph);
    const e = fileId('core.api', 'src/api/e.ts');
    expect(liveNode(live, ix)).toBe(e);
    expect([...liveMarks(live, ix, null, new Set(['core', 'core.api']))]).toEqual([[e, 'now']]);
    expect([...liveMarks(live, ix, null, new Set(['core']))]).toEqual([['core.api', 'now']]);
    expect([...liveMarks(live, ix, null, new Set())]).toEqual([['core', 'now']]);
    expect([...liveFiles(live, ix, null, new Set(['core', 'core.api'])).keys()]).toEqual([e]);
    // An import between files is not lifted to their parts.
    const closed = visibleGraph(all.graph, indexGraph(all.graph), { focus: null, expanded: new Set(['core']), showLibraries: true, hidePlanned: false, fileEdges: all.edges });
    expect([...closed.edges.keys()].filter((k) => k.includes('§'))).toEqual([]);
    const open = visibleGraph(all.graph, indexGraph(all.graph), { focus: null, expanded: new Set(['core', 'core.api']), showLibraries: true, hidePlanned: false, fileEdges: all.edges });
    expect([...open.edges.keys()].filter((k) => k.includes('§'))).toHaveLength(1);
  });
});

describe('the progress view is open before a session edits', () => {
  const watching = (session: number, pages = session): Watching => ({ session, pages, shown: {} });
  const deps = (over: Partial<ProgressDeps> = {}): ProgressDeps & { opened: string[] } => {
    const opened: string[] = [];
    return { opened, allowed: () => true, viewer: () => 'http://localhost:4747', watchers: async () => watching(0), open: (url) => void opened.push(url), pause: async () => undefined, ...over };
  };

  it('sends the first edit back once, with the address of this session', async () => {
    const d = deps();
    const reason = await progressGate('/repo', 's 1', true, () => true, d);
    expect(reason).toContain('http://localhost:4747/?view=session&session=s%201');
    expect(reason).toContain('once per session');
    expect(d.opened).toEqual([]);
    expect(sessionUrl('http://localhost:4747/', '')).toBe('http://localhost:4747/?view=session');
  });

  it('lets the edit through when the view is already open', async () => {
    const d = deps({ watchers: async () => watching(1) });
    expect(await progressGate('/repo', 's1', true, () => true, d)).toBeNull();
    expect(await progressGate('/repo', 's1', false, () => true, d)).toBeNull();
    expect(d.opened).toEqual([]);
  });

  it('opens the view itself on a later edit, once, when the agent could not', async () => {
    const d = deps();
    let asked = 0;
    const fallback = (): boolean => asked++ === 0;
    expect(await progressGate('/repo', 's1', false, fallback, d)).toBeNull();
    expect(await progressGate('/repo', 's1', false, fallback, d)).toBeNull();
    expect(d.opened).toEqual(['http://localhost:4747/?view=session&session=s1']);
  });

  it('opens no second window when the viewer is open on another view', async () => {
    // The pane shows the viewer without "?view=session": the first edit still asks for the session view, the fallback stays quiet.
    const d = deps({ watchers: async () => watching(0, 1) });
    expect(await progressGate('/repo', 's1', true, () => true, d)).toContain('?view=session');
    expect(await progressGate('/repo', 's1', false, () => true, d)).toBeNull();
    expect(d.opened).toEqual([]);
  });

  it('waits for a page the agent just opened before it opens one itself', async () => {
    let asked = 0;
    const d = deps({ watchers: async () => watching(asked++ < 2 ? 0 : 1) });
    expect(await progressGate('/repo', 's1', false, () => true, d)).toBeNull();
    expect(asked).toBe(3);
    expect(d.opened).toEqual([]);
  });

  it('never holds an edit back when it is turned off, has no session, or the viewer does not answer', async () => {
    for (const d of [deps({ allowed: () => false }), deps({ viewer: () => null }), deps({ watchers: async () => null })]) {
      expect(await progressGate('/repo', 's1', true, () => true, d)).toBeNull();
      expect(await progressGate('/repo', 's1', false, () => true, d)).toBeNull();
      expect(d.opened).toEqual([]);
    }
    expect(await progressGate('/repo', '', true, () => true, deps())).toBeNull();
  });
});
