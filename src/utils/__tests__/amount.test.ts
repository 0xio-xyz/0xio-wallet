// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { cleanAmountInput, toUnits, fromUnits, isValidAmount } from '../amount';

describe('cleanAmountInput', () => {
  it('reads a lone comma as the decimal separator', () => {
    expect(cleanAmountInput('1,5')).toBe('1.5');
    expect(cleanAmountInput('0,500')).toBe('0.500');
    expect(cleanAmountInput('1.000,50')).toBe('1000.50');
  });
  it('keeps thousands grouping', () => {
    expect(cleanAmountInput('1,000')).toBe('1000');
    expect(cleanAmountInput('12,345.678')).toBe('12345.678');
  });
  it('rejects text that is not an amount', () => {
    expect(cleanAmountInput('1e5')).toBeNull();
    expect(cleanAmountInput('-5')).toBeNull();
    expect(cleanAmountInput('1.2.3')).toBeNull();
    expect(cleanAmountInput('1,2,3')).toBeNull();
  });
  it('cuts decimals, integer digits and leading zeros', () => {
    expect(cleanAmountInput('0.12345678')).toBe('0.123456');
    expect(cleanAmountInput('1.5', 0)).toBe('1');
    expect(cleanAmountInput('0005')).toBe('5');
    expect(cleanAmountInput('.5')).toBe('0.5');
    expect(cleanAmountInput('1234567890123456789')).toBe('123456789012345');
    expect(cleanAmountInput(' 1 000 ')).toBe('1000');
  });
});

describe('toUnits', () => {
  it('is exact where floating point is not', () => {
    expect(toUnits('1.005')).toBe(1005000n);
    expect(toUnits(1.005)).toBe(1005000n);
    expect(toUnits(0.1 + 0.2)).toBe(300000n);
    expect(toUnits('1000000', 18)).toBe(10n ** 24n);
  });
  it('refuses extra decimals and junk', () => {
    expect(() => toUnits('0.0000001')).toThrow();
    expect(() => toUnits('1e5')).toThrow();
    expect(() => toUnits('NaN')).toThrow();
    expect(() => toUnits('-1')).toThrow();
  });
  it('round-trips with fromUnits', () => {
    expect(fromUnits(1005000n)).toBe('1.005');
    expect(fromUnits(toUnits('42', 18), 18)).toBe('42');
    expect(fromUnits(7n, 0)).toBe('7');
  });
  it('treats zero and dust as invalid', () => {
    expect(isValidAmount('0')).toBe(false);
    expect(isValidAmount('0.0000009')).toBe(false);
    expect(isValidAmount('0.000001')).toBe(true);
  });
});
