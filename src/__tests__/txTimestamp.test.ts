import { describe, expect, it } from 'vitest';
import { txTimestamp } from 'src/utils/txTimestamp';

describe('txTimestamp', () => {
  it('never lands on a whole second', () => {
    expect(Number.isInteger(txTimestamp(1790131980000))).toBe(false);
    expect(txTimestamp(1790131980000)).toBe(1790131980.001);
  });

  it('keeps other times as seconds with milliseconds', () => {
    expect(txTimestamp(1790131980123)).toBe(1790131980.123);
    expect(JSON.stringify({ t: txTimestamp(1790131980123) })).toBe('{"t":1790131980.123}');
  });
});
