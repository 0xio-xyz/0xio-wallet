// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { Wallet } from '../../../types/wallet';

const vault: { wallets: Wallet[] } = { wallets: [] };

vi.mock('src/services/crypto/PasswordManager', () => ({
  passwordManager: { getSessionKey: vi.fn(async () => 'session') },
}));
vi.mock('src/services/wallet/WalletStorage', () => ({
  walletStorage: {
    loadVault: vi.fn(async () => vault.wallets),
    loadWallet: vi.fn(async (id: string) => vault.wallets.find((w) => w.id === id)),
  },
}));

const { withEvmKey } = await import('../signer');
const { evmAddressFromPublicKey } = await import('../accounts');

const ABANDON = [...Array(11).fill('abandon'), 'about'];
const EVM_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const EVM_1 = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';

const base = (id: string, over: Partial<Wallet>): Wallet => ({
  id,
  name: id,
  address: `oct${id}`,
  type: 'standard',
  privateKey: 'k',
  mnemonic: null,
  publicKey: null,
  isActive: false,
  metadata: { source: 'generated', createdAt: 0, isPadded: false },
  ...over,
});

const parent = base('parent', {
  mnemonic: ABANDON,
  metadata: {
    source: 'imported',
    createdAt: 0,
    isPadded: false,
    evm: { enabled: true, address: EVM_0, index: 0 },
  },
});
const added = base('acct1', {
  metadata: {
    source: 'derived' as never,
    createdAt: 0,
    isPadded: false,
    evm: { enabled: true, address: EVM_1, index: 1, sourceWalletId: 'parent' } as never,
  },
});

const addressOf = (key: Uint8Array) => evmAddressFromPublicKey(secp256k1.getPublicKey(key, true));

describe('withEvmKey', () => {
  beforeEach(() => {
    vault.wallets = [parent, added];
  });

  it('signs for a phrase wallet with its own phrase', async () => {
    expect(await withEvmKey('parent', 0, EVM_0, addressOf)).toBe(EVM_0);
  });

  it('signs for an added account with the parent phrase at its index and wipes the key', async () => {
    let seen: Uint8Array | null = null;
    const address = await withEvmKey('acct1', 1, EVM_1, (key) => {
      seen = key;
      return addressOf(key);
    });
    expect(address).toBe(EVM_1);
    expect(Array.from(seen!).every((b) => b === 0)).toBe(true);
  });

  it('refuses when the key does not make the shown address', async () => {
    const fn = vi.fn();
    await expect(withEvmKey('acct1', 0, EVM_1, fn)).rejects.toThrow(/does not match/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses an added account whose parent is gone, and a key wallet', async () => {
    vault.wallets = [added, base('key', {})];
    await expect(withEvmKey('acct1', 1, EVM_1, vi.fn())).rejects.toThrow(/no recovery phrase/);
    await expect(withEvmKey('key', 0, EVM_0, vi.fn())).rejects.toThrow(/no recovery phrase/);
  });
});
