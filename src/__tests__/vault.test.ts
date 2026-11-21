import { beforeEach, describe, expect, it } from 'vitest';
import {
  isVaultKeyToken,
  newVaultKey,
  openVault,
  sealVault,
  StaleVaultKeyError,
  unwrapVaultKey,
  wrapVaultKey,
} from '../services/crypto/vaultKey';
import { walletStorage } from '../services/wallet/WalletStorage';
import { passwordManager } from '../services/crypto/PasswordManager';

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();

const area = (m: Map<string, unknown>) => ({
  get: async (keys?: string | string[] | null) => {
    if (keys == null) return Object.fromEntries(m);
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => m.has(k)).map((k) => [k, m.get(k)]));
  },
  set: async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) m.set(k, structuredClone(v));
  },
  remove: async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k);
  },
});

beforeEach(() => {
  local.clear();
  session.clear();
  (chrome.storage as any).local = area(local);
  (chrome.storage as any).session = area(session);
});

const wallet = (name: string) => ({
  name,
  address: `oct${name}`,
  type: 'watch' as const,
});

describe('vault key', () => {
  it('wraps and unwraps under the right secret only', async () => {
    const token = newVaultKey();
    expect(isVaultKeyToken(token)).toBe(true);
    const wrapped = await wrapVaultKey(token, 'correct horse');
    expect(await unwrapVaultKey(wrapped, 'correct horse')).toBe(token);
    await expect(unwrapVaultKey(wrapped, 'wrong horse')).rejects.toThrow();
  });

  it('refuses a vault sealed under another key', async () => {
    const sealed = await sealVault(newVaultKey(), '[]');
    await expect(openVault(newVaultKey(), sealed)).rejects.toBeInstanceOf(StaleVaultKeyError);
  });

  it('does not take a password as a vault key', () => {
    expect(isVaultKeyToken('hunter22')).toBe(false);
    expect(isVaultKeyToken('')).toBe(false);
  });
});

describe('vault storage', () => {
  it('creates an empty vault on first unlock and keeps what is saved', async () => {
    const token = await walletStorage.unlockVault('pw-12345678');
    await walletStorage.saveWallet(wallet('a'), token);
    expect((await walletStorage.loadVault(token)).map((w) => w.name)).toEqual(['a']);
    expect(await walletStorage.unlockVault('pw-12345678')).toBe(token);
    await expect(walletStorage.unlockVault('not-the-password')).rejects.toThrow();
  }, 60_000);

  it('seals a pre-envelope vault under a vault key without losing wallets', async () => {
    const salt = await passwordManager.generateSalt();
    const legacyKey = await passwordManager.deriveEncryptionKey('old-password', salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wallets = [{ id: '1', name: 'Main', address: 'oct1', isActive: true }];
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      legacyKey,
      new TextEncoder().encode(JSON.stringify(wallets))
    );
    local.set('vault', {
      version: 3,
      salt,
      iv: btoa(String.fromCharCode(...iv)),
      data: btoa(String.fromCharCode(...new Uint8Array(data))),
    });

    await expect(walletStorage.unlockVault('wrong')).rejects.toThrow();
    expect((local.get('vault') as any).version).toBe(3);

    const token = await walletStorage.unlockVault('old-password');
    expect((local.get('vault') as any).version).toBe(4);
    expect(local.has('vaultKey')).toBe(true);
    expect(await walletStorage.loadVault(token)).toEqual(wallets);
  }, 60_000);

  it('changes the secret by re-wrapping: the old key keeps working, the old secret does not', async () => {
    const token = await walletStorage.unlockVault('first-password');
    await walletStorage.saveWallet(wallet('b'), token);
    const sealedBefore = local.get('vault');

    await walletStorage.rewrapVaultKey(token, 'second-password', { marker: true });

    expect(local.get('vault')).toEqual(sealedBefore);
    expect(local.get('marker')).toBe(true);
    expect(await walletStorage.unlockVault('second-password')).toBe(token);
    await expect(walletStorage.unlockVault('first-password')).rejects.toThrow();
    expect((await walletStorage.loadVault(token)).map((w) => w.name)).toEqual(['b']);
  }, 60_000);

  it('lets an abandoned setup start over, but never replaces a vault holding a wallet', async () => {
    await walletStorage.unlockVault('first-attempt');
    const retry = await walletStorage.unlockVault('second-attempt');
    await walletStorage.saveWallet(wallet('c'), retry);

    await expect(walletStorage.unlockVault('third-attempt')).rejects.toThrow();
    expect((await walletStorage.loadVault(retry)).map((w) => w.name)).toEqual(['c']);
  }, 60_000);

  it('never writes with a key that is no longer the stored one', async () => {
    const stale = await walletStorage.unlockVault('pw-one-111');
    const current = await walletStorage.createVault([], 'pw-two-222');
    const sealed = local.get('vault');

    await expect(walletStorage.saveVault([], stale)).rejects.toBeInstanceOf(StaleVaultKeyError);
    await expect(walletStorage.rewrapVaultKey(stale, 'x', {})).rejects.toBeInstanceOf(
      StaleVaultKeyError
    );
    expect(local.get('vault')).toEqual(sealed);
    expect(await walletStorage.loadVault(current)).toEqual([]);
  }, 60_000);
});

describe('session', () => {
  it('holds a vault key and refuses a password', async () => {
    await expect(passwordManager.setSessionKey('my password')).rejects.toThrow();
    const token = newVaultKey();
    await passwordManager.setSessionKey(token);
    expect(session.get('sessionKey')).toBe(token);
    await passwordManager.lockWallet();
  });

  it('drops a password left in the session by an older version', async () => {
    await passwordManager.lockWallet();
    session.set('wallet_unlocked', true);
    session.set('sessionVerification', {});
    session.set('sessionKey', 'plain password');
    expect(await passwordManager.getSessionKey()).toBeNull();
    expect(session.has('sessionKey')).toBe(false);
  });
});
