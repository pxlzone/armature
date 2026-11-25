import { describe, expect, it } from 'vitest';
import { changeGate, changeUrl, openingAllowed, REOPEN_AFTER, type ProgressDeps, type Watching } from '../src/viewer-open.js';

describe('showing a change beside its approval prompt', () => {
  it('links to the change in the Work lens', () => {
    expect(changeUrl('http://localhost:4747', 'orders-export')).toBe('http://localhost:4747/?lens=work&change=orders-export');
    expect(changeUrl('http://localhost:4747/', 'a b')).toBe('http://localhost:4747/?lens=work&change=a%20b');
  });

  it('opens nothing in CI, in tests, or when turned off', () => {
    expect(openingAllowed({})).toBe(true);
    expect(openingAllowed({ CI: 'true' })).toBe(false);
    expect(openingAllowed({ VITEST: 'true' })).toBe(false);
    expect(openingAllowed({ ARMATURE_NO_OPEN: '1' })).toBe(false);
    expect(openingAllowed({ ARMATURE_NO_OPEN: '0' })).toBe(true);
  });

  const url = 'http://localhost:4747/?lens=work&change=orders-export';
  const deps = (shown: () => Record<string, number>, over: Partial<ProgressDeps> = {}): ProgressDeps & { opened: string[] } => {
    const opened: string[] = [];
    return { opened, allowed: () => true, viewer: () => 'http://localhost:4747', watchers: async (): Promise<Watching> => ({ session: 0, pages: 0, shown: shown() }), open: (u) => void opened.push(u), pause: async () => undefined, ...over };
  };

  it('sends the approving edit back once, for the agent to open the change in the browser pane', async () => {
    const d = deps(() => ({}));
    const out = await changeGate('/repo', 'orders-export', () => true, d);
    expect(out.url).toBe(url);
    expect(out.send).toContain(url);
    expect(out.send).toContain('not a refusal');
    expect(d.opened).toEqual([]);
  });

  it('asks the person straight away when the change was opened lately', async () => {
    let asked = 0;
    const d = deps(() => ({ 'orders-export': Date.now() - 1000 }));
    expect(await changeGate('/repo', 'orders-export', () => asked++ === 0, d)).toEqual({ url });
    expect(asked).toBe(0);
    expect(d.opened).toEqual([]);
  });

  it('does not open the default browser when the agent opened the change', async () => {
    // The edit comes back while the page is still loading.
    let polls = 0;
    const d = deps(() => (polls++ < 2 ? {} : { 'orders-export': Date.now() }));
    expect(await changeGate('/repo', 'orders-export', () => false, d)).toEqual({ url });
    expect(d.opened).toEqual([]);
  });

  it('opens the default browser when the edit comes back and the change is still not shown', async () => {
    const d = deps(() => ({ 'orders-export': Date.now() - REOPEN_AFTER - 1000, other: Date.now() }));
    expect(await changeGate('/repo', 'orders-export', () => false, d)).toEqual({ url });
    expect(d.opened).toEqual([url]);
  });

  it('opens nothing and never sends the edit back when turned off or with no viewer', async () => {
    for (const d of [deps(() => ({}), { allowed: () => false }), deps(() => ({}), { viewer: () => null })]) {
      expect(await changeGate('/repo', 'orders-export', () => true, d)).toEqual({ url: null });
      expect(d.opened).toEqual([]);
    }
    const silent = deps(() => ({}), { watchers: async () => null });
    expect(await changeGate('/repo', 'orders-export', () => true, silent)).toEqual({ url });
    expect(silent.opened).toEqual([]);
  });
});
