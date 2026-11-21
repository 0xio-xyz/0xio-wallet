// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Wallet } from 'src/types/wallet';
import { cryptoManager } from 'src/services/crypto/CryptoManager';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import { WalletStorage } from '../WalletStorage';

const ABANDON = [...Array(11).fill('abandon'), 'about'];
const EVM_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const EVM_1 = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';

const parent: Wallet = {
  id: 'parent',
  name: 'Main',
  address: 'octparent',
  type: 'standard',
  privateKey: 'k',
  mnemonic: ABANDON,
  publicKey: null,
  isActive: true,
  metadata: {
    source: 'imported',
    createdAt: 0,
    isPadded: false,
    evm: { enabled: true, address: EVM_0, index: 0 },
  },
};

const setup = (initial: Wallet[]) => {
  const storage = new WalletStorage();
  let stored = structuredClone(initial);
  const inner = storage as unknown as {
    _openVault: () => Promise<{ wallets: Wallet[]; backfilled: boolean }>;
    _sealVault: (w: Wallet[]) => Promise<void>;
  };
  vi.spyOn(inner, '_openVault').mockImplementation(async () => ({
    wallets: structuredClone(stored),
    backfilled: false,
  }));
  vi.spyOn(inner, '_sealVault').mockImplementation(async (w) => {
    stored = structuredClone(w);
  });
  return { storage, stored: () => stored };
};

const accountAt = (i: number) => cryptoManager.deriveAccountAtIndex(ABANDON.join(' '), i);

describe('WalletStorage EVM for added accounts', () => {
  beforeEach(() => {
    vi.spyOn(passwordManager, 'getSessionKey').mockResolvedValue('session');
  });

  it('saves account i with EVM on at index i, address made from the parent phrase', async () => {
    const { storage, stored } = setup([parent]);
    const a = await accountAt(1);
    await storage.saveWallet(
      {
        name: 'Main 2',
        address: a.address,
        privateKey: a.privateKey,
        publicKey: a.publicKey,
        mnemonic: null,
        source: 'derived',
        evm: { enabled: true, address: '0xwrong', index: 1, sourceWalletId: 'parent' },
      },
      'session'
    );
    const saved = stored()[1];
    expect(saved.mnemonic).toBeNull();
    expect(saved.metadata.evm).toEqual({
      enabled: true,
      address: EVM_1,
      index: 1,
      sourceWalletId: 'parent',
    });
    expect(JSON.stringify(saved)).not.toContain('abandon');
  });

  it('drops EVM when the named parent is not a phrase wallet in the vault', async () => {
    const { storage, stored } = setup([parent]);
    const a = await accountAt(1);
    await storage.saveWallet(
      {
        address: a.address,
        privateKey: a.privateKey,
        source: 'derived',
        evm: { enabled: true, address: EVM_1, index: 1, sourceWalletId: 'missing' },
      },
      'session'
    );
    expect(stored()[1].metadata.evm).toBeUndefined();
  });

  it('turns EVM on for an older added account and links it once', async () => {
    const a = await accountAt(1);
    const old: Wallet = {
      ...parent,
      id: 'old',
      address: a.address,
      privateKey: a.privateKey,
      mnemonic: null,
      isActive: false,
      metadata: { source: 'derived' as never, createdAt: 0, isPadded: false },
    };
    const { storage, stored } = setup([parent, old]);
    await storage.setEvmEnabled('old', true);
    expect(stored()[1].metadata.evm).toEqual({
      enabled: true,
      address: EVM_1,
      index: 1,
      sourceWalletId: 'parent',
    });

    const lazy = setup([parent, old]);
    expect(await lazy.storage.linkEvmAccounts()).toBe(true);
    expect(lazy.stored()[1].metadata.evm?.address).toBe(EVM_1);
    expect(await lazy.storage.linkEvmAccounts()).toBe(false);
  });
});
