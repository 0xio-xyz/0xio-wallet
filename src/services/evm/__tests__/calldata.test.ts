// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeKnownCall, selectorOf } from '../calldata';
import { erc20ApproveData, erc20TransferData } from '../tx';

const SPENDER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';

describe('decodeKnownCall', () => {
  it('reads transfers and approvals', () => {
    expect(decodeKnownCall(erc20TransferData(SPENDER, 25_000_000n))).toEqual({
      kind: 'transfer',
      to: SPENDER,
      amount: '25000000',
    });
    expect(decodeKnownCall(erc20ApproveData(SPENDER, (1n << 256n) - 1n))).toMatchObject({
      kind: 'approve',
      spender: SPENDER,
      unlimited: true,
    });
    expect(decodeKnownCall(erc20ApproveData(SPENDER, 5n))).toMatchObject({ unlimited: false });
  });

  it('returns null for anything it cannot read exactly', () => {
    expect(decodeKnownCall('0x')).toBeNull();
    expect(decodeKnownCall('0xe3e3aed0' + '00'.repeat(64))).toBeNull();
    expect(decodeKnownCall(erc20TransferData(SPENDER, 1n) + '00')).toBeNull();
    expect(decodeKnownCall('0xa9059cbb' + 'f'.repeat(64) + '0'.repeat(64))).toBeNull();
    expect(selectorOf('0xA9059CBB00')).toBe('0xa9059cbb');
    expect(selectorOf('0x12')).toBeNull();
  });
});
