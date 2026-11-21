// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isOctAddress, normalizeAddress } from '../address';

describe('addresses', () => {
  const a = 'octDpvujku1YTWeEWKbqADu9nuWVQznW5GJy3e9Keru97ic';
  it('accepts only oct plus 44 base58 characters', () => {
    expect(isOctAddress(a)).toBe(true);
    expect(isOctAddress(a + 'x')).toBe(false);
    expect(isOctAddress(a + ' ')).toBe(false);
    expect(isOctAddress(a.replace('D', '0'))).toBe(false);
  });
  it('strips whitespace from pasted addresses', () => {
    expect(normalizeAddress(` ${a.slice(0, 20)}\n${a.slice(20)} `)).toBe(a);
  });
});
