import { describe, expect, it } from 'vitest';
import { burnToOctraData } from '../abi';
import { decodeBurn } from '../recover';

describe('decodeBurn', () => {
  it('reads back the amount and Octra address of a burn', () => {
    const data = burnToOctraData('oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq', 1_500_000n);
    expect(decodeBurn(data)).toEqual({
      amountRaw: 1_500_000n,
      octra: 'oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq',
    });
  });

  it('ignores other calls and truncated data', () => {
    expect(decodeBurn('0x095ea7b3' + '0'.repeat(128))).toBeNull();
    expect(decodeBurn('0xe3e3aed0' + '0'.repeat(64))).toBeNull();
  });
});
