// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { clampMemo, memoBytes } from '../memo';

describe('memo', () => {
  it('counts bytes and never splits a character', () => {
    expect(memoBytes('ab')).toBe(2);
    expect(memoBytes('é')).toBe(2);
    expect(clampMemo('a😀b', 4)).toBe('a');
    expect(clampMemo('a😀b', 5)).toBe('a😀');
    expect(clampMemo('x'.repeat(300))).toHaveLength(200);
  });
});
