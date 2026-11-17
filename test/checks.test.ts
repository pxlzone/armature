import { describe, expect, it } from 'vitest';
import { formatProblems } from '../src/render.js';
import { WARNING_INFO, warningGroup, type Problem } from '../src/types.js';

describe('warning groups', () => {
  it('puts each code in one group', () => {
    expect(warningGroup('runtime-drift')).toBe('wrong');
    expect(warningGroup('undeclared-import')).toBe('wrong');
    expect(warningGroup('no-shape')).toBe('incomplete');
    expect(warningGroup('no-requirement')).toBe('incomplete');
    expect(warningGroup('something-new')).toBe('incomplete');
    for (const info of Object.values(WARNING_INFO)) expect(info.what.length).toBeGreaterThan(10);
  });

  it('prints errors, then wrong, then incomplete, with a split summary', () => {
    const problems: Problem[] = [
      { level: 'warning', code: 'no-shape', message: 'a', group: 'incomplete' },
      { level: 'warning', code: 'runtime-drift', message: 'b', group: 'wrong' },
      { level: 'error', code: 'schema', message: 'c' },
    ];
    const text = formatProblems(problems);
    const at = (s: string): number => text.indexOf(s);
    expect(at('Errors')).toBeLessThan(at('Model disagrees with the code (1)'));
    expect(at('Model disagrees with the code (1)')).toBeLessThan(at('Model is incomplete (1)'));
    expect(text).toContain('1 error, 2 warnings: 1 wrong, 1 incomplete.');
  });
});
