// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Wallet } from '../../../types/wallet';
import { cryptoManager } from 'src/services/crypto/CryptoManager';
import { canUseEvm, evmMetaFor, evmSourceOf, isEvmOn, linkDerivedAccounts } from '../walletEvm';

const ABANDON = [...Array(11).fill('abandon'), 'about'];
const EVM_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const EVM_1 = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const NOT_ITS_ADDRESS = '0x48Dd3e7E1D7C36e2E9E11C1B2a3c5b2F4bD9b1E2';

const wallet = (over: Partial<Wallet> & { id: string }): Wallet => ({
  name: over.id,
  address: `oct${over.id}`,
  type: 'standard',
  privateKey: null,
  mnemonic: null,
  publicKey: null,
  isActive: false,
  metadata: { source: 'generated', createdAt: 0, isPadded: false },
  ...over,
});

const phraseWallet = (evmEnabled = true) =>
  wallet({
    id: 'parent',
    mnemonic: ABANDON,
    privateKey: 'x',
    metadata: {
      source: 'imported',
      createdAt: 0,
      isPadded: false,
      evm: { enabled: evmEnabled, address: EVM_0, index: 0 },
    },
  });

const derivedAt = async (index: number, evm?: Record<string, unknown>) => {
  const a = await cryptoManager.deriveAccountAtIndex(ABANDON.join(' '), index);
  return wallet({
    id: `acct${index}`,
    address: a.address,
    privateKey: a.privateKey,
    publicKey: a.publicKey,
    metadata: {
      source: 'derived' as never,
      createdAt: 0,
      isPadded: false,
      ...(evm ? { evm: evm as never } : {}),
    },
  });
};

describe('evmSourceOf', () => {
  it('points a phrase wallet at itself and its stored index', () => {
    expect(evmSourceOf(phraseWallet())).toEqual({ walletId: 'parent', index: 0 });
    expect(canUseEvm(phraseWallet())).toBe(true);
    expect(isEvmOn(phraseWallet())).toBe(true);
    expect(isEvmOn(phraseWallet(false))).toBe(false);
  });

  it('points an added account at its parent phrase wallet and its own index', async () => {
    const parent = phraseWallet();
    const acct = await derivedAt(1, {
      enabled: true,
      address: EVM_1,
      index: 1,
      sourceWalletId: 'parent',
    });
    expect(evmSourceOf(acct, [parent, acct])).toEqual({ walletId: 'parent', index: 1 });
    expect(isEvmOn(acct, [parent, acct])).toBe(true);
    expect(evmSourceOf(acct, [acct])).toBeNull();
    expect(isEvmOn(acct, [acct])).toBe(false);
  });

  it('gives a key wallet and a watch wallet no source', () => {
    const key = wallet({
      id: 'key',
      privateKey: 'AAAA',
      metadata: { source: 'imported', createdAt: 0, isPadded: false },
    });
    const watch = wallet({ id: 'watch', type: 'watch' });
    expect(evmSourceOf(key)).toBeNull();
    expect(evmSourceOf(watch)).toBeNull();
    expect(canUseEvm(key, [phraseWallet(), key])).toBe(false);
    expect(canUseEvm(watch, [phraseWallet(), watch])).toBe(false);
  });

  it('lets an unlinked added account turn EVM on while a phrase wallet is present', async () => {
    const acct = await derivedAt(1);
    expect(evmSourceOf(acct)).toBeNull();
    expect(canUseEvm(acct, [phraseWallet(), acct])).toBe(true);
    expect(canUseEvm(acct, [acct])).toBe(false);
  });
});

describe('linking added accounts', () => {
  it('finds the parent and index from the stored Octra key', async () => {
    const parent = phraseWallet(true);
    const one = await derivedAt(1);
    const five = await derivedAt(5);
    const wallets = [parent, one, five];
    expect(await linkDerivedAccounts(wallets)).toBe(true);
    expect(one.metadata.evm).toEqual({
      enabled: true,
      address: EVM_1,
      index: 1,
      sourceWalletId: 'parent',
    });
    expect((five.metadata.evm as { index: number }).index).toBe(5);
    expect(await linkDerivedAccounts(wallets)).toBe(false);
  });

  it('follows the parent switch and leaves strangers alone', async () => {
    const parent = phraseWallet(false);
    const one = await derivedAt(1);
    const stranger = wallet({
      id: 'stranger',
      privateKey: cryptoManager.bytesToBase64(new Uint8Array(32).fill(7)),
      metadata: { source: 'derived' as never, createdAt: 0, isPadded: false },
    });
    await linkDerivedAccounts([parent, one, stranger]);
    expect(one.metadata.evm?.enabled).toBe(false);
    expect(stranger.metadata.evm).toBeUndefined();
  });

  it('makes the record for a switch, refusing a link whose key is not from that index', async () => {
    const parent = phraseWallet();
    const one = await derivedAt(1);
    expect(await evmMetaFor(one, [parent, one], true)).toEqual({
      enabled: true,
      address: EVM_1,
      index: 1,
      sourceWalletId: 'parent',
    });
    expect(await evmMetaFor(parent, [parent, one], false)).toEqual({
      enabled: false,
      address: EVM_0,
      index: 0,
    });
    const wrong = await derivedAt(2, {
      enabled: true,
      address: NOT_ITS_ADDRESS,
      index: 3,
      sourceWalletId: 'parent',
    });
    expect(await evmMetaFor(wrong, [parent, wrong], true)).toBeNull();
  });
});
