import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultInUseError, WalletStorage, walletStorage } from '../services/wallet/WalletStorage';
import { passwordManager } from '../services/crypto/PasswordManager';
import { BACKUP_PENDING_KEY } from '../services/wallet/backupPending';
import { newVaultKey, sealVault } from '../services/crypto/vaultKey';

let local = new Map<string, unknown>();
const session = new Map<string, unknown>();
let snapshots: Map<string, unknown>[] = [];

const area = (read: () => Map<string, unknown>, record = false) => ({
  get: async (keys?: string | string[] | null) => {
    await new Promise((r) => setTimeout(r, 0));
    const m = read();
    if (keys == null) return structuredClone(Object.fromEntries(m));
    const list = Array.isArray(keys) ? keys : [keys];
    return structuredClone(
      Object.fromEntries(list.filter((k) => m.has(k)).map((k) => [k, m.get(k)]))
    );
  },
  set: async (items: Record<string, unknown>) => {
    await new Promise((r) => setTimeout(r, 0));
    const m = read();
    for (const [k, v] of Object.entries(items)) m.set(k, structuredClone(v));
    if (record) snapshots.push(structuredClone(m));
  },
  remove: async (keys: string | string[]) => {
    const m = read();
    for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k);
    if (record) snapshots.push(structuredClone(m));
  },
});

const lockQueues = new Map<string, Promise<unknown>>();
const locks = {
  request: <T>(name: string, task: () => Promise<T>): Promise<T> => {
    const run = (lockQueues.get(name) ?? Promise.resolve()).then(() => task());
    lockQueues.set(
      name,
      run.catch(() => {})
    );
    return run;
  },
};

beforeEach(() => {
  local = new Map();
  session.clear();
  snapshots = [];
  (chrome.storage as any).local = area(() => local, true);
  (chrome.storage as any).session = area(() => session);
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
});

afterEach(async () => {
  await passwordManager.lockWallet();
  Reflect.deleteProperty(navigator, 'locks');
});

const created = (name: string) => ({
  name,
  address: `oct${name}`,
  type: 'standard' as const,
  privateKey: `pk-${name}`,
  publicKey: `pub-${name}`,
  source: 'generate',
  needsBackup: true,
});

const at = async <T>(state: Map<string, unknown>, read: () => Promise<T>): Promise<T> => {
  const live = local;
  local = structuredClone(state);
  try {
    return await read();
  } finally {
    local = live;
  }
};

const pending = (state: Map<string, unknown>) =>
  (state.get(BACKUP_PENDING_KEY) as string[] | undefined) ?? [];

describe('first run', () => {
  it('is either not set up or fully set up with the backup asked, whenever it stops', async () => {
    const wallet = await passwordManager.initializeVault('first-run-pw', created('a'));
    const token = (await passwordManager.getSessionKey())!;

    for (const state of snapshots) {
      const initialized = await at(state, () => walletStorage.isInitialized());
      if (!initialized) {
        expect(pending(state)).not.toContain(wallet.address);
        continue;
      }
      expect(state.get('hashedPassword')).toBeTruthy();
      expect(pending(state)).toContain(wallet.address);
      expect(state.get('activeWalletId')).toBe(wallet.id);
      const stored = await at(state, () => walletStorage.loadVault(token));
      expect(stored.map((w) => w.address)).toEqual([wallet.address]);
    }
    expect(await walletStorage.isInitialized()).toBe(true);
    expect(await walletStorage.unlockVault('first-run-pw')).toBe(token);
  }, 60_000);

  it('works the same without a password', async () => {
    const wallet = await passwordManager.initializeVault('', created('b'));
    expect(local.get('passwordSkipped')).toBe(true);
    expect(pending(local)).toEqual([wallet.address]);
    expect(await walletStorage.isInitialized()).toBe(true);
  }, 60_000);

  it('sends a setup cut off before its first wallet back to onboarding', async () => {
    await passwordManager.setupPassword('cut-off-pw');
    expect(await walletStorage.isInitialized()).toBe(false);

    await walletStorage.unlockVault('cut-off-pw');
    expect(local.get('vault')).toMatchObject({ version: 4, empty: true });
    expect(await walletStorage.isInitialized()).toBe(false);

    const wallet = await passwordManager.initializeVault('fresh-pw', created('c'));
    const token = (await passwordManager.getSessionKey())!;
    expect(await walletStorage.isInitialized()).toBe(true);
    expect((await walletStorage.loadVault(token)).map((w) => w.id)).toEqual([wallet.id]);
    expect(await walletStorage.unlockVault('fresh-pw')).toBe(token);
  }, 60_000);

  it('never replaces a vault that holds wallets', async () => {
    await passwordManager.initializeVault('owner-pw', created('d'));
    const before = structuredClone(local);

    await expect(passwordManager.initializeVault('other-pw', created('e'))).rejects.toBeInstanceOf(
      VaultInUseError
    );
    expect(local.get('vault')).toEqual(before.get('vault'));
    expect(local.get('vaultKey')).toEqual(before.get('vaultKey'));
    expect(local.get('hashedPassword')).toEqual(before.get('hashedPassword'));
    expect(await passwordManager.getSessionKey()).toBeNull();
  }, 60_000);

  it('still treats older vault formats as set up', async () => {
    local.set('vault', { version: 3, data: 'x', iv: 'y', salt: 'z' });
    expect(await walletStorage.isInitialized()).toBe(true);
    local.delete('vault');
    local.set('encryptedWallets', [{ id: '1', encryptedData: 'x', isActive: true }]);
    expect(await walletStorage.isInitialized()).toBe(true);
    local.set('vault', { ...(await sealVault(newVaultKey(), '[]')), empty: false });
    expect(await walletStorage.isInitialized()).toBe(true);
  });
});

describe('adding a wallet', () => {
  it('asks for the backup in the same write that stores a created wallet', async () => {
    await passwordManager.initializeVault('add-pw', created('f'));
    const token = (await passwordManager.getSessionKey())!;
    snapshots = [];

    const added = await walletStorage.saveWallet(created('g'), token);

    for (const state of snapshots) {
      const stored = await at(state, () => walletStorage.loadVault(token));
      if (stored.some((w) => w.id === added.id)) expect(pending(state)).toContain(added.address);
    }
    expect(pending(local)).toContain(added.address);
  }, 60_000);

  it('keeps a wallet the popup adds while the worker switches the active one', async () => {
    const first = await passwordManager.initializeVault('race-pw', created('h'));
    const token = (await passwordManager.getSessionKey())!;
    const second = await walletStorage.saveWallet(created('i'), token);

    const popup = new WalletStorage();
    const worker = new WalletStorage();
    const [added] = await Promise.all([
      popup.saveWallet(created('j'), token),
      worker.setActiveWallet(second.id),
      popup.updateWalletName(first.id, 'Renamed'),
      worker.saveWallet(created('k'), token),
    ]);

    const stored = await walletStorage.loadVault(token);
    expect(stored.map((w) => w.address).sort()).toEqual(['octh', 'octi', 'octj', 'octk']);
    expect(stored.find((w) => w.id === added.id)).toBeTruthy();
    expect(stored.filter((w) => w.isActive).map((w) => w.id)).toEqual([second.id]);
    expect(stored.find((w) => w.id === first.id)?.name).toBe('Renamed');
    expect(local.get('activeWalletId')).toBe(second.id);
  }, 60_000);
});
