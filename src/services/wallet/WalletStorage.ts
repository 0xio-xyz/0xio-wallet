import { passwordManager } from '../crypto/PasswordManager';
import { ZeroXIOConfig } from 'src/utils/config';
import type { Wallet } from 'src/types/wallet';
import { logger } from 'src/utils/logger';
import { BACKUP_PENDING_KEY, clearBackupPending } from './backupPending';
import { BAL_HIST_PREFIX, clearSnapshots } from './BalanceHistory';
import { clearSessionCaches } from 'src/utils/sessionCaches';
import { evmMetaFor, holdsPhrase, linkDerivedAccounts, type EvmMeta } from '../evm/walletEvm';
import {
  kidOf,
  newVaultKey,
  openVault,
  sealVault,
  StaleVaultKeyError,
  unwrapVaultKey,
  wrapVaultKey,
  type SealedVault,
  type WrappedVaultKey,
} from '../crypto/vaultKey';

interface LegacyVault {
  data: string;
  iv: string;
  salt: string;
  version: 3;
}

export const WALLET_NAME_MAX = 32;

let vaultQueue: Promise<unknown> = Promise.resolve();

const withVaultLock = async <T>(task: () => Promise<T>): Promise<T> => {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('0xio-vault', task);
  }
  const run = vaultQueue.then(task, task);
  vaultQueue = run.catch(() => {});
  return run;
};

export class VaultInUseError extends Error {
  constructor() {
    super('A wallet is already set up');
    this.name = 'VaultInUseError';
  }
}

interface VaultEdit {
  wallets: Wallet[];
  write: (alongside?: Record<string, unknown>) => Promise<void>;
}

export interface WalletInput {
  name?: string;
  address: string;
  type?: 'standard' | 'watch';
  privateKey?: string | null;
  mnemonic?: string[] | null;
  publicKey?: string | null;
  isActive?: boolean;
  source?: string;
  isPadded?: boolean;
  needsBackup?: boolean;
  evm?: EvmMeta;
}

const walletAddresses = (w: Wallet): string[] =>
  [w.address, w.metadata?.evm?.address]
    .filter((a): a is string => typeof a === 'string' && a.length > 0)
    .map((a) => a.toLowerCase());

const keyTokens = (key: string) => key.toLowerCase().split(/[^a-z0-9]+/);

export function keysForRemovedAddresses(
  keys: string[],
  removed: string[],
  kept: string[]
): string[] {
  const keep = new Set(kept.map((a) => a.toLowerCase()));
  const gone = new Set(removed.map((a) => a.toLowerCase()).filter((a) => a && !keep.has(a)));
  if (gone.size === 0) return [];
  return keys.filter((key) => {
    const tokens = keyTokens(key);
    return tokens.some((t) => gone.has(t)) && !tokens.some((t) => keep.has(t));
  });
}

export async function sweepWalletData(removed: Wallet, remaining: Wallet[]): Promise<void> {
  const kept = remaining.flatMap(walletAddresses);
  const keep = new Set(kept);
  const gone = walletAddresses(removed).filter((a) => !keep.has(a));
  if (gone.length === 0) return;
  const octra = removed.address.toLowerCase();
  const octraGone = gone.includes(octra);

  const local = ((await chrome.storage.local.get(null)) as unknown as Record<string, any>) ?? {};
  const localKeys = keysForRemovedAddresses(Object.keys(local), gone, kept);

  if (octraGone) {
    for (const [key, value] of Object.entries(local)) {
      if (key.startsWith('pending_tx_') && value?.from?.toLowerCase() === octra) {
        localKeys.push(key);
      }
    }
  }
  if (localKeys.length) await chrome.storage.local.remove(localKeys);

  if (octraGone) {
    const networks = new Set<string>();
    const legacy = removed.address.slice(0, 12);
    for (const key of Object.keys(local)) {
      if (!key.startsWith(BAL_HIST_PREFIX)) continue;
      const rest = key.slice(BAL_HIST_PREFIX.length);
      for (const tail of [`_${removed.address}`, `_${legacy}`]) {
        if (rest.endsWith(tail)) networks.add(rest.slice(0, -tail.length));
      }
    }
    const legacyShared = remaining.some((w) => w.address?.slice(0, 12) === legacy);
    if (!legacyShared) {
      for (const net of networks) await clearSnapshots(removed.address, net);
    }

    const queueState = local['tx_queue_state'];
    if (queueState?.queue?.length) {
      const filtered = queueState.queue.filter((tx: any) => tx.from?.toLowerCase() !== octra);
      if (filtered.length !== queueState.queue.length) {
        await chrome.storage.local.set({ tx_queue_state: { ...queueState, queue: filtered } });
      }
    }
  }

  try {
    const session =
      ((await chrome.storage.session.get(null)) as unknown as Record<string, unknown>) ?? {};
    const sessionKeys = keysForRemovedAddresses(Object.keys(session), gone, kept);
    if (sessionKeys.length) await chrome.storage.session.remove(sessionKeys);
  } catch {}
}

async function dropWalletFromMemory(removed: Wallet): Promise<void> {
  clearSessionCaches();
  if (!removed.privateKey) return;
  try {
    const { pvacManager } = await import('../pvac/PvacManager');
    if (pvacManager.currentKey === removed.privateKey) pvacManager.destroy();
  } catch {}
}

export class WalletStorage {
  private _evmLinkDone = false;

  async decryptData(
    encryptedDataBase64: string,
    keyOrPassword: CryptoKey | string,
    saltBase64: string,
    ivBase64: string
  ): Promise<string> {
    try {
      let encryptionKey: CryptoKey;
      if (keyOrPassword instanceof CryptoKey) {
        encryptionKey = keyOrPassword;
      } else {
        encryptionKey = await passwordManager.deriveEncryptionKey(keyOrPassword, saltBase64);
      }

      const encryptedData = this.base64ToBytes(encryptedDataBase64);
      const iv = this.base64ToBytes(ivBase64);

      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        encryptionKey,
        encryptedData
      );

      const decoder = new TextDecoder();
      return decoder.decode(decryptedBuffer);
    } catch (error: unknown) {
      logger.error('Decryption error:', error);
      throw new Error('Failed to decrypt. Password may be incorrect.');
    }
  }

  async saveVault(wallets: Wallet[], vaultKey: string): Promise<void> {
    await withVaultLock(() => this._sealVault(wallets, vaultKey));
  }

  async loadVault(vaultKey: string): Promise<Wallet[]> {
    const { wallets, backfilled } = await this._openVault(vaultKey);
    if (backfilled) {
      try {
        await this._editVault(vaultKey, async () => {});
      } catch {}
    }
    return wallets;
  }

  private async _openVault(vaultKey: string): Promise<{ wallets: Wallet[]; backfilled: boolean }> {
    const storage = await chrome.storage.local.get(['vault']);
    if (!storage.vault) return { wallets: [], backfilled: false };
    if (storage.vault.version !== 4) throw new StaleVaultKeyError();

    const wallets: Wallet[] = JSON.parse(await openVault(vaultKey, storage.vault));

    let backfilled = false;
    for (const w of wallets) {
      if (w.privateKey && !w.publicKey) {
        try {
          const { CryptoManager } = await import('../crypto/CryptoManager');
          const cm = new CryptoManager();
          cm.setPrivateKey(w.privateKey);
          w.publicKey = cm.getPublicKey();
          backfilled = true;
          logger.debug(`[loadVault] backfilled publicKey for ${w.address?.slice(0, 8)}...`);
        } catch {}
      }
    }
    return { wallets, backfilled };
  }

  private async _sealVault(
    wallets: Wallet[],
    vaultKey: string,
    alongside: Record<string, unknown> = {}
  ): Promise<void> {
    const { vaultKey: wrap } = await chrome.storage.local.get(['vaultKey']);
    if (!wrap || wrap.kid !== kidOf(vaultKey)) throw new StaleVaultKeyError();
    const vault = {
      ...(await sealVault(vaultKey, JSON.stringify(wallets))),
      empty: !wallets.length,
    };
    await chrome.storage.local.set({ ...alongside, vault, encryptedWallets: null });
  }

  private async _editVault<T>(
    vaultKey: string,
    edit: (vault: VaultEdit) => Promise<T>
  ): Promise<T> {
    return withVaultLock(async () => {
      const { wallets, backfilled } = await this._openVault(vaultKey);
      let written = false;
      const result = await edit({
        wallets,
        write: async (alongside) => {
          await this._sealVault(wallets, vaultKey, alongside);
          written = true;
        },
      });
      if (backfilled && !written) await this._sealVault(wallets, vaultKey);
      return result;
    });
  }

  private async _backupPendingWith(address: string): Promise<Record<string, unknown>> {
    const stored = (await chrome.storage.local.get(BACKUP_PENDING_KEY))[BACKUP_PENDING_KEY];
    const list = Array.isArray(stored) ? stored.filter((a) => typeof a === 'string') : [];
    return { [BACKUP_PENDING_KEY]: list.includes(address) ? list : [...list, address] };
  }

  private async _newWallet(info: WalletInput, wallets: Wallet[]): Promise<Wallet> {
    const evm = await this._evmForNew(info, wallets);
    return {
      id: crypto.randomUUID(),
      name: info.name || 'Wallet',
      address: info.address,
      type: info.type || 'standard',
      privateKey: info.type === 'watch' ? null : (info.privateKey ?? null),
      mnemonic: info.type === 'watch' ? null : info.mnemonic || null,
      publicKey: info.type === 'watch' ? null : info.publicKey || null,
      isActive: info.isActive !== undefined ? info.isActive : wallets.length === 0,
      metadata: {
        source:
          info.type === 'watch'
            ? 'watch'
            : (info.source as 'generated' | 'imported') || 'generated',
        createdAt: Date.now(),
        isPadded: info.isPadded || false,
        ...(evm ? { evm } : {}),
      },
    };
  }

  private async _walletExtras(wallet: Wallet, info: WalletInput): Promise<Record<string, unknown>> {
    return {
      ...(wallet.isActive ? this._activeIds(wallet.id, wallet.address) : {}),
      ...(info.needsBackup && info.type !== 'watch'
        ? await this._backupPendingWith(wallet.address)
        : {}),
    };
  }

  async saveWallet(walletInfo: WalletInput, vaultKey: string): Promise<Wallet> {
    try {
      return await this._editVault(vaultKey, async ({ wallets, write }) => {
        const wallet = await this._newWallet(walletInfo, wallets);
        wallets.push(wallet);
        await write(await this._walletExtras(wallet, walletInfo));
        return wallet;
      });
    } catch (error: unknown) {
      logger.error('Save wallet error:', error);
      throw error;
    }
  }

  async createFirstVault(
    vaultKey: string,
    walletInfo: WalletInput,
    secret: string,
    alongside: Record<string, unknown>
  ): Promise<Wallet> {
    return withVaultLock(async () => {
      const s = await chrome.storage.local.get(['vault', 'encryptedWallets']);
      if (Array.isArray(s.encryptedWallets) && s.encryptedWallets.length) {
        throw new VaultInUseError();
      }
      if (s.vault && !(s.vault.version === 4 && s.vault.empty === true)) {
        throw new VaultInUseError();
      }
      const wallet = await this._newWallet({ ...walletInfo, isActive: true }, []);
      const [sealed, wrapped] = await Promise.all([
        sealVault(vaultKey, JSON.stringify([wallet])),
        wrapVaultKey(vaultKey, secret),
      ]);
      await chrome.storage.local.set({
        ...alongside,
        ...(await this._walletExtras(wallet, walletInfo)),
        vault: { ...sealed, empty: false },
        vaultKey: wrapped,
        encryptedWallets: null,
      });
      return wallet;
    });
  }

  /**
   * The EVM record a new wallet is saved with. A phrase wallet keeps what the flow made. An added
   * account gets its address from the named phrase wallet at its index, never from the draft.
   */
  private async _evmForNew(info: WalletInput, wallets: Wallet[]): Promise<EvmMeta | null> {
    if (info.type === 'watch' || !info.evm) return null;
    if (info.mnemonic?.length) {
      const { enabled, address, index } = info.evm;
      return { enabled, address, index };
    }
    const sourceId = info.evm.sourceWalletId;
    const source = sourceId ? wallets.find((w) => w.id === sourceId) : undefined;
    if (!source || !holdsPhrase(source) || !info.privateKey) return null;
    const draft = {
      id: '',
      type: 'standard',
      mnemonic: null,
      privateKey: info.privateKey,
      metadata: { evm: { ...info.evm, address: '' } },
    } as unknown as Wallet;
    try {
      return await evmMetaFor(draft, wallets, info.evm.enabled);
    } catch (e) {
      logger.warn('[saveWallet] could not make the EVM address', e);
      return null;
    }
  }

  async linkEvmAccounts(): Promise<boolean> {
    if (this._evmLinkDone) return false;
    this._evmLinkDone = true;
    const sessionKey = await passwordManager.getSessionKey();
    if (!sessionKey) {
      this._evmLinkDone = false;
      return false;
    }
    return this._editVault(sessionKey, async ({ wallets, write }) => {
      if (!(await linkDerivedAccounts(wallets))) return false;
      await write();
      return true;
    });
  }

  async loadAllWallets(): Promise<Wallet[]> {
    const sessionKey = await passwordManager.getSessionKey();
    if (!sessionKey) return [];

    try {
      return await this.loadVault(sessionKey);
    } catch (e: unknown) {
      logger.error('Could not unlock vault for listing', e);
      return [];
    }
  }

  async loadWallet(walletId: string, vaultKey: string): Promise<Wallet> {
    const wallets = await this.loadVault(vaultKey);
    const wallet = wallets.find((w) => w.id === walletId);
    if (!wallet) throw new Error('Wallet not found in vault');
    return wallet;
  }

  async setActiveWallet(walletId: string): Promise<Wallet> {
    const sessionKey = await passwordManager.getSessionKey();
    if (!sessionKey) throw new Error('Wallet locked');

    return this._editVault(sessionKey, async ({ wallets, write }) => {
      const wallet = wallets.find((w) => w.id === walletId);
      if (!wallet) throw new Error('Wallet not found');
      wallets.forEach((w) => (w.isActive = w.id === walletId));
      await write(this._activeIds(walletId, wallet.address));
      return wallet;
    });
  }

  private _activeIds(id: string, address: string): Record<string, string> {
    return { activeWalletId: id, [ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET]: address };
  }

  async setActiveWalletId(id: string, address: string): Promise<void> {
    await chrome.storage.local.set(this._activeIds(id, address));
  }

  async getActiveWalletId(): Promise<string | null> {
    const storage = await chrome.storage.local.get(['activeWalletId']);
    return storage.activeWalletId || null;
  }

  async deleteWallet(walletId: string): Promise<boolean> {
    const sessionKey = await passwordManager.getSessionKey();
    if (!sessionKey) throw new Error('Wallet locked');

    const { deletedWallet, remaining } = await this._editVault(
      sessionKey,
      async ({ wallets, write }) => {
        if (wallets.length <= 1) throw new Error('Cannot delete last wallet');
        const index = wallets.findIndex((w) => w.id === walletId);
        const [deleted] = index >= 0 ? wallets.splice(index, 1) : [];
        let alongside = {};
        if (!wallets.find((w) => w.isActive)) {
          wallets[0].isActive = true;
          alongside = this._activeIds(wallets[0].id, wallets[0].address);
        }
        await write(alongside);
        return { deletedWallet: deleted, remaining: [...wallets] };
      }
    );

    if (deletedWallet?.address) await clearBackupPending(deletedWallet.address).catch(() => {});
    if (deletedWallet) {
      await sweepWalletData(deletedWallet, remaining).catch(() => {});
      await dropWalletFromMemory(deletedWallet);
    }
    return true;
  }

  async setEvmEnabled(walletId: string, enabled: boolean): Promise<Wallet> {
    const sessionKey = await passwordManager.getSessionKey();
    if (!sessionKey) throw new Error('Wallet locked');

    return this._editVault(sessionKey, async ({ wallets, write }) => {
      const wallet = wallets.find((w) => w.id === walletId);
      if (!wallet) throw new Error('Wallet not found');
      if (wallet.type === 'watch') throw new Error('EVM needs a recovery phrase');

      const evm = await evmMetaFor(wallet, wallets, enabled);
      if (!evm) throw new Error('EVM needs a recovery phrase');
      wallet.metadata = { ...wallet.metadata, evm };

      await write();
      return wallet;
    });
  }

  async updateWalletName(walletId: string, newName: string): Promise<Wallet> {
    const sessionKey = await passwordManager.getSessionKey();
    if (!sessionKey) throw new Error('Wallet locked');

    return this._editVault(sessionKey, async ({ wallets, write }) => {
      const wallet = wallets.find((w) => w.id === walletId);
      if (!wallet) throw new Error('Wallet not found');

      const name = (newName ?? '').trim().slice(0, WALLET_NAME_MAX);
      if (!name) throw new Error('Wallet name is required');
      wallet.name = name;

      await write();
      return wallet;
    });
  }

  /** A fresh vault key sealing `wallets`, wrapped under `secret`. Replaces whatever vault exists. */
  async createVault(wallets: Wallet[], secret: string): Promise<string> {
    return withVaultLock(() => this._writeNewVault(wallets, secret));
  }

  /**
   * The vault key for `secret`, the one way into the vault. Throws when the secret is wrong. With
   * no vault yet (first setup) it creates an empty one. A pre-envelope vault is re-sealed under a
   * new vault key here, once, and read back before the old copy is gone for good.
   */
  async unlockVault(secret: string): Promise<string> {
    return withVaultLock(async () => {
      const s = await chrome.storage.local.get(['vault', 'vaultKey', 'salt']);
      if (!s.vault) return this._writeNewVault([], secret);
      if (s.vault.version === 4) {
        if (!s.vaultKey) throw new Error('Vault key missing');
        try {
          return await unwrapVaultKey(s.vaultKey as WrappedVaultKey, secret);
        } catch (e) {
          // A setup abandoned before its first wallet left an empty vault under that attempt's
          // secret. It holds nothing, so the next attempt starts over instead of being shut out.
          if (s.vault.empty === true) return this._writeNewVault([], secret);
          throw e;
        }
      }

      const legacy = s.vault as LegacyVault;
      const saltToUse = legacy.salt || s.salt;
      if (!saltToUse) throw new Error('Missing encryption salt');
      const wallets: Wallet[] = JSON.parse(
        await this.decryptData(legacy.data, secret, saltToUse, legacy.iv)
      );

      const token = await this._writeNewVault(wallets, secret);
      const check = await chrome.storage.local.get(['vault']);
      if ((await openVault(token, check.vault as SealedVault)) !== JSON.stringify(wallets)) {
        await chrome.storage.local.set({ vault: legacy });
        await chrome.storage.local.remove(['vaultKey']);
        throw new Error('Vault upgrade did not verify; the previous vault was kept');
      }
      logger.debug('[Vault] sealed under a vault key');
      return token;
    });
  }

  /**
   * Wraps the unchanged vault key under a new secret (password created, changed or removed), in
   * the same write as `alongside` (the verifier and mode flags), so the two never disagree. The
   * wallets are not re-encrypted and every open session keeps working.
   */
  async rewrapVaultKey(
    vaultKey: string,
    secret: string,
    alongside: Record<string, unknown>
  ): Promise<void> {
    await withVaultLock(async () => {
      const s = await chrome.storage.local.get(['vault', 'vaultKey']);
      if (!s.vaultKey || s.vaultKey.kid !== kidOf(vaultKey)) throw new StaleVaultKeyError();
      if (s.vault) await openVault(vaultKey, s.vault as SealedVault);
      const wrapped = await wrapVaultKey(vaultKey, secret);
      await chrome.storage.local.set({ ...alongside, vaultKey: wrapped });
    });
  }

  private async _writeNewVault(wallets: Wallet[], secret: string): Promise<string> {
    const token = newVaultKey();
    const [sealed, vaultKey] = await Promise.all([
      sealVault(token, JSON.stringify(wallets)),
      wrapVaultKey(token, secret),
    ]);
    const vault = { ...sealed, empty: !wallets.length };
    await chrome.storage.local.set({ vault, vaultKey, encryptedWallets: null });
    return token;
  }

  async isInitialized(): Promise<boolean> {
    const s = await chrome.storage.local.get(['vault', 'encryptedWallets']);
    if (Array.isArray(s.encryptedWallets) && s.encryptedWallets.length) return true;
    return !!s.vault && !(s.vault.version === 4 && s.vault.empty === true);
  }

  async getWalletCount(): Promise<number> {
    const wallets = await this.loadAllWallets();
    return wallets.length;
  }

  bytesToBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
  }

  base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
  }
}

export const walletStorage = new WalletStorage();
