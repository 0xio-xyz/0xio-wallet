// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { uniqueWalletName } from '../walletName';

describe('uniqueWalletName', () => {
  it('keeps a name no wallet has', () => {
    expect(uniqueWalletName('Imported Wallet', [])).toBe('Imported Wallet');
    expect(uniqueWalletName('Imported Wallet', ['Main Vault', 'Watch Wallet'])).toBe(
      'Imported Wallet'
    );
    expect(uniqueWalletName('Wallet 3', ['Wallet', 'Wallet 2'])).toBe('Wallet 3');
  });

  it('numbers a taken name from 2', () => {
    expect(uniqueWalletName('Imported Wallet', ['Imported Wallet'])).toBe('Imported Wallet 2');
    expect(uniqueWalletName('Imported Wallet', ['Imported Wallet', 'Imported Wallet 2'])).toBe(
      'Imported Wallet 3'
    );
  });

  it('compares trimmed and case-insensitive', () => {
    expect(uniqueWalletName('  imported ', ['IMPORTED'])).toBe('imported 2');
    expect(uniqueWalletName('Imported', [' imported  ', 'imported 2 '])).toBe('Imported 3');
  });

  it('continues the number of a numbered base', () => {
    expect(uniqueWalletName('Wallet 2', ['Wallet', 'Wallet 2'])).toBe('Wallet 3');
    expect(uniqueWalletName('Wallet 2', ['Wallet 2'])).toBe('Wallet 3');
    expect(uniqueWalletName('Wallet 2', ['Wallet 2', 'Wallet 7'])).toBe('Wallet 8');
    expect(uniqueWalletName('Main Vault 2', ['Main Vault', 'Main Vault 2'])).toBe('Main Vault 3');
  });

  it('goes past the highest number, not into gaps', () => {
    expect(uniqueWalletName('A', ['A', 'A 3'])).toBe('A 4');
  });

  it('ignores other bases that share a prefix', () => {
    expect(uniqueWalletName('Imported', ['Imported', 'Imported Wallet 9', 'Importer 5'])).toBe(
      'Imported 2'
    );
  });

  it('cuts the base so the result fits the limit', () => {
    const long = 'A'.repeat(32);
    expect(uniqueWalletName(`${long}BB`, [], 32)).toBe(long);
    expect(uniqueWalletName(long, [long], 32)).toBe(`${'A'.repeat(30)} 2`);
    expect(uniqueWalletName(long, [long, `${'A'.repeat(30)} 2`], 32)).toBe(`${'A'.repeat(30)} 3`);
    expect(uniqueWalletName('Wallet', ['Wallet'], 32)).toBe('Wallet 2');
    expect(uniqueWalletName(`${'A'.repeat(29)} B`, [`${'A'.repeat(29)} B`], 32)).toBe(
      `${'A'.repeat(29)} 2`
    );
  });

  it('leaves an empty name alone', () => {
    expect(uniqueWalletName('  ', ['', 'A'])).toBe('');
  });
});
