// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_UINT256, applyApproveEdit, parseApproveAmount, readApproveEdit } from '../approveEdit';
import { decodeKnownCall } from '../calldata';
import { erc20ApproveData, erc20TransferData } from '../tx';

const SPENDER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const ASKED = 1_000_000_000n;
const increase = (amount: bigint) =>
  '0x39509351' +
  SPENDER.slice(2).toLowerCase().padStart(64, '0') +
  amount.toString(16).padStart(64, '0');

describe('applyApproveEdit', () => {
  it('encodes an edited amount into the same call', () => {
    const data = erc20ApproveData(SPENDER, ASKED);
    const out = applyApproveEdit(data, { unlimited: false, amount: '250000000' });
    expect(out).toBe(erc20ApproveData(SPENDER, 250_000_000n));
    expect(decodeKnownCall(out)).toEqual({
      kind: 'approve',
      spender: SPENDER,
      amount: '250000000',
      unlimited: false,
    });
    expect(applyApproveEdit(increase(ASKED), { unlimited: false, amount: '7' })).toBe(increase(7n));
  });

  it('encodes Unlimited as the max uint256, and keeps a site value that already was unlimited', () => {
    const out = applyApproveEdit(erc20ApproveData(SPENDER, ASKED), { unlimited: true });
    expect(out).toBe(erc20ApproveData(SPENDER, MAX_UINT256));
    expect(out.slice(-64)).toBe('f'.repeat(64));
    const siteMax = erc20ApproveData(SPENDER, 1n << 255n);
    expect(applyApproveEdit(siteMax, { unlimited: true })).toBe(siteMax);
    expect(applyApproveEdit(siteMax, null)).toBe(siteMax);
  });

  it('never signs more than the site asked for, zero, or a non-approval', () => {
    const data = erc20ApproveData(SPENDER, ASKED);
    expect(() => applyApproveEdit(data, { unlimited: false, amount: '1000000001' })).toThrow();
    expect(() => applyApproveEdit(data, { unlimited: false, amount: '0' })).toThrow();
    expect(() =>
      applyApproveEdit(erc20ApproveData(SPENDER, MAX_UINT256), {
        unlimited: false,
        amount: (MAX_UINT256 + 1n).toString(),
      })
    ).toThrow();
    expect(() =>
      applyApproveEdit(erc20TransferData(SPENDER, 5n), { unlimited: false, amount: '1' })
    ).toThrow();
    expect(() => applyApproveEdit('0x', { unlimited: true })).toThrow();
  });
});

describe('parseApproveAmount', () => {
  it('reads decimal text as base units by the token decimals', () => {
    expect(parseApproveAmount('250', 6, ASKED)).toEqual({ units: 250_000_000n });
    expect(parseApproveAmount('0.5', 6, ASKED)).toEqual({ units: 500_000n });
    expect(parseApproveAmount('1,5', 6, ASKED)).toEqual({ units: 1_500_000n });
    expect(parseApproveAmount('1,000', 6, ASKED)).toEqual({ units: 1_000_000_000n });
    expect(parseApproveAmount('.25', 6, ASKED)).toEqual({ units: 250_000n });
    expect(parseApproveAmount('1.500000000', 6, ASKED)).toEqual({ units: 1_500_000n });
    expect(parseApproveAmount('42', 0, 100n)).toEqual({ units: 42n });
  });

  it('says why an amount cannot be used', () => {
    expect(parseApproveAmount('', 6, ASKED)).toEqual({ problem: 'empty' });
    expect(parseApproveAmount('abc', 6, ASKED)).toEqual({ problem: 'invalid' });
    expect(parseApproveAmount('-1', 6, ASKED)).toEqual({ problem: 'invalid' });
    expect(parseApproveAmount('1e6', 6, ASKED)).toEqual({ problem: 'invalid' });
    expect(parseApproveAmount('1.2.3', 6, ASKED)).toEqual({ problem: 'invalid' });
    expect(parseApproveAmount('0', 6, ASKED)).toEqual({ problem: 'zero' });
    expect(parseApproveAmount('0.000', 6, ASKED)).toEqual({ problem: 'zero' });
    expect(parseApproveAmount('0.0000001', 6, ASKED)).toEqual({ problem: 'decimals' });
    expect(parseApproveAmount('1.5', 0, 100n)).toEqual({ problem: 'decimals' });
    expect(parseApproveAmount('1001', 6, ASKED)).toEqual({ problem: 'above' });
    expect(parseApproveAmount((MAX_UINT256 + 1n).toString(), 0, MAX_UINT256)).toEqual({
      problem: 'tooLarge',
    });
    expect(parseApproveAmount(MAX_UINT256.toString(), 0, MAX_UINT256)).toEqual({
      units: MAX_UINT256,
    });
  });
});

describe('readApproveEdit', () => {
  it('accepts only the two shapes the review sends', () => {
    expect(readApproveEdit({ unlimited: true })).toEqual({ unlimited: true });
    expect(readApproveEdit({ unlimited: false, amount: '12' })).toEqual({
      unlimited: false,
      amount: '12',
    });
    const bads: unknown[] = [
      null,
      'unlimited',
      [],
      { unlimited: 'yes' },
      { unlimited: false },
      { unlimited: false, amount: 12 },
      { unlimited: false, amount: '0' },
      { unlimited: false, amount: '012' },
      { unlimited: false, amount: '1.5' },
      { unlimited: false, amount: '9'.repeat(79) },
    ];
    for (const bad of bads) {
      expect(readApproveEdit(bad)).toBeNull();
    }
  });
});
