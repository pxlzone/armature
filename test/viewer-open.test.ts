import { describe, expect, it } from 'vitest';
import { changeUrl, openingAllowed } from '../src/viewer-open.js';

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
});
