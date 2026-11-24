import { describe, expect, it } from 'vitest';
import type { Edge } from '../src/types.js';
import { dataDirection, type VEdge } from '../viewer/src/view.js';
import { wheelKind, type WheelGesture } from '../viewer/src/App.js';

const edge = (from: string, to: string, verb: Edge['verb'], extra: Partial<Edge> = {}): Edge => ({ id: `${from}>${to}`, from, to, owner: from, verb, async: false, shapes: [], returns: [], status: 'built', ...extra });
const line = (from: string, to: string, edges: Edge[], extra: Partial<VEdge> = {}): VEdge => ({ id: 'l', from, to, edges, label: '', fullLabel: '', planned: false, retiring: false, async: false, ghost: false, both: false, codeKind: null, points: [], labelAt: null, ...extra });

describe('data direction on a line', () => {
  it('follows the verb', () => {
    expect(dataDirection(line('api', 'db', [edge('api', 'db', 'writes')]))).toEqual({ fwd: true, back: false });
    expect(dataDirection(line('api', 'db', [edge('api', 'db', 'reads')]))).toEqual({ fwd: false, back: true });
    expect(dataDirection(line('web', 'api', [edge('web', 'api', 'calls', { returns: ['User'] })]))).toEqual({ fwd: true, back: true });
  });
  it('lifts edges from inside a group and skips planned ones and imports', () => {
    expect(dataDirection(line('worker', 'db', [edge('worker.ingest', 'db', 'sends')]))).toEqual({ fwd: true, back: false });
    expect(dataDirection(line('api', 'db', [edge('api', 'db', 'writes', { status: 'planned' })]))).toEqual({ fwd: false, back: false });
    expect(dataDirection(line('a', 'b', [edge('a', 'b', 'calls')], { codeKind: 'declared' }))).toEqual({ fwd: false, back: false });
  });
});

describe('wheel gestures', () => {
  const ev = (deltaY: number, deltaX = 0, deltaMode = 0) => ({ deltaY, deltaX, deltaMode });

  it('keeps a trackpad scroll a scroll, however fast it gets', () => {
    const g: WheelGesture = { kind: 'wheel', at: -1e9 };
    // Starts small, then sends the large whole steps a mouse wheel would.
    const kinds = [2, 9, 40, 96, 120, 64].map((d, i) => wheelKind(g, ev(d), 1000 + i * 16));
    expect(new Set(kinds)).toEqual(new Set(['trackpad']));
  });

  it('takes a gesture that starts with a large step on one axis as a mouse wheel', () => {
    const g: WheelGesture = { kind: 'trackpad', at: -1e9 };
    expect(wheelKind(g, ev(100), 1000)).toBe('wheel');
    expect(wheelKind(g, ev(100), 1080)).toBe('wheel');
    // Line-based steps are always a wheel.
    expect(wheelKind({ kind: 'trackpad', at: 0 }, ev(3, 0, 1), 10)).toBe('wheel');
  });

  it('settles on a trackpad as soon as the movement goes sideways, and decides again after a pause', () => {
    const g: WheelGesture = { kind: 'trackpad', at: -1e9 };
    expect(wheelKind(g, ev(120), 1000)).toBe('wheel');
    expect(wheelKind(g, ev(80, 3), 1016)).toBe('trackpad');
    expect(wheelKind(g, ev(120), 1032)).toBe('trackpad');
    expect(wheelKind(g, ev(120), 2000)).toBe('wheel');
  });
});
