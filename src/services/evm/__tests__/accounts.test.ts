// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { deriveEvmAddress, isStandardPhrase, toChecksumAddress } from '../accounts';

const ABANDON = [...Array(11).fill('abandon'), 'about'];

describe('EVM accounts', () => {
  it('derives the standard BIP44 address from a phrase', async () => {
    expect(await deriveEvmAddress(ABANDON, 0)).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(await deriveEvmAddress(ABANDON.join(' '), 1)).toBe(
      '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
    );
  });

  it('refuses account numbers outside the non-hardened range', async () => {
    await expect(deriveEvmAddress(ABANDON, -1)).rejects.toThrow();
    await expect(deriveEvmAddress(ABANDON, 0x80000000)).rejects.toThrow();
  });

  it('writes EIP-55 checksums', () => {
    expect(toChecksumAddress('0x9858effd232b4033e47d90003d41ec34ecaeda94')).toBe(
      '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
    );
    expect(() => toChecksumAddress('0x123')).toThrow();
  });

  it('tells standard phrases from older non-standard ones', () => {
    expect(isStandardPhrase(ABANDON)).toBe(true);
    expect(isStandardPhrase([...ABANDON.slice(0, 11), 'abandon'])).toBe(false);
    expect(isStandardPhrase([...ABANDON.slice(0, 11), 'against'])).toBe(false);
    expect(isStandardPhrase(ABANDON.slice(0, 11))).toBe(false);
  });
});
