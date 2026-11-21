import { describe, expect, it } from 'vitest';
import { walletKind } from 'src/features/wallet/walletKind';

const meta = (source: string) => ({ source, createdAt: 0, isPadded: false }) as never;
const words = 'abandon '.repeat(11).trim().split(' ').concat('about');

describe('wallet kind', () => {
  it('tells a phrase wallet, an added account, a key wallet and a watch wallet apart', () => {
    expect(
      walletKind({ type: 'standard', mnemonic: words, privateKey: 'k', metadata: meta('imported') })
    ).toBe('phrase');
    expect(
      walletKind({ type: 'standard', mnemonic: null, privateKey: 'k', metadata: meta('derived') })
    ).toBe('phrase');
    expect(
      walletKind({ type: 'standard', mnemonic: null, privateKey: 'k', metadata: meta('imported') })
    ).toBe('key');
    expect(
      walletKind({ type: 'watch', mnemonic: null, privateKey: null, metadata: meta('watch') })
    ).toBe('watch');
  });
});
