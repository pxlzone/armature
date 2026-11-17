import { describe, expect, it } from 'vitest';
import type { Edge } from '../src/types.js';
import { dataDirection, type VEdge } from '../viewer/src/view.js';

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
