import { walletStorage } from './WalletStorage';
import { passwordManager } from '../crypto/PasswordManager';
import type { Wallet } from 'src/types/wallet';
import { logger } from 'src/utils/logger';

const CURRENT_VAULT_VERSION = 3;

interface MigrationResult {
  success: boolean;
  migrated?: boolean;
  count?: number;
  error?: string;
}

interface LegacyEncryptedWallet {
  id: string;
  encryptedData: string;
  isActive: boolean;
}

interface VaultStorageData {
  encryptedWallets?: LegacyEncryptedWallet[];
  vault?: {
    data: string;
    iv: string;
    salt: string;
    version: number;
  };
  salt?: string;
  passwordSkipped?: boolean;
  booted?: boolean;
  hashedPassword?: string;
}

export const MigrationService = {
  async checkAndMigrate(userPassword: string | null = null): Promise<MigrationResult> {
    const storage: VaultStorageData = await chrome.storage.local.get([
      'encryptedWallets',
      'vault',
      'salt',
      'passwordSkipped',
      'booted',
      'hashedPassword',
    ]);

    if (storage.vault) {
      const vaultVersion = storage.vault.version || 1;
      if (vaultVersion >= CURRENT_VAULT_VERSION) {
        return { success: true, migrated: false };
      }

      logger.debug(`Vault version migration needed: v${vaultVersion} -> v${CURRENT_VAULT_VERSION}`);
      const vaultResult = await this._migrateVaultVersion(storage, userPassword);

      if (!vaultResult.success && storage.encryptedWallets && storage.encryptedWallets.length > 0) {
        logger.debug('Vault migration failed, falling back to legacy encryptedWallets...');
        await chrome.storage.local.remove(['vault']);
      } else {
        return vaultResult;
      }
    }

    if (!storage.encryptedWallets || storage.encryptedWallets.length === 0) {
      return { success: true, migrated: false };
    }

    logger.debug('Legacy data found. Starting migration sequence...');

    try {
      const candidates: string[] = [];

      if (userPassword !== null) {
        candidates.push(userPassword);
      }

      candidates.push('');
      candidates.push('null');
      candidates.push('undefined');

      const uniqueCandidates = [...new Set(candidates)];

      let recoveredWallets: Wallet[] = [];
      let successfulPassword: string | null = null;

      for (const candidatePassword of uniqueCandidates) {
        try {
          const logSafe =
            candidatePassword === '' ||
            candidatePassword === 'null' ||
            candidatePassword === 'undefined'
              ? `[${candidatePassword}]`
              : '***';

          logger.debug(`Migration: Trying candidate password: ${logSafe}`);

          recoveredWallets = await this._tryDecryptAll(
            storage.encryptedWallets!,
            candidatePassword,
            storage.salt!
          );

          if (recoveredWallets.length > 0) {
            successfulPassword = candidatePassword;
            logger.debug('Migration: Decryption successful!');
            break;
          }
        } catch {}
      }

      if (recoveredWallets.length === 0) {
        if (userPassword !== null) {
          return { success: false, error: 'INVALID_PASSWORD' };
        }
        return { success: false, error: 'PASSWORD_REQUIRED' };
      }

      const isNoPasswordMode =
        successfulPassword === '' ||
        successfulPassword === 'null' ||
        successfulPassword === 'undefined';

      if (isNoPasswordMode) {
        logger.debug("Migration: normalizing to 'No Password' mode.");
        const deviceKey = await passwordManager.skipPasswordSetup();
        const vaultKey = await walletStorage.createVault(recoveredWallets, deviceKey);
        await passwordManager.setSessionKey(vaultKey);
      } else {
        logger.debug('Migration: carrying over user password.');
        await passwordManager.setupPassword(successfulPassword!);
        await walletStorage.createVault(recoveredWallets, successfulPassword!);
      }

      await chrome.storage.local.remove(['encryptedWallets']);

      return { success: true, migrated: true, count: recoveredWallets.length };
    } catch (error: unknown) {
      logger.error('Migration Critical Failure:', error);
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  },

  async _tryDecryptAll(
    encryptedWallets: LegacyEncryptedWallet[],
    password: string,
    saltBase64: string
  ): Promise<Wallet[]> {
    const recovered: Wallet[] = [];
    const key = await this.deriveLegacyKey(password, saltBase64);

    for (const w of encryptedWallets) {
      const decryptedJson = await this.decryptLegacyData(w.encryptedData, key);
      const walletObj = JSON.parse(decryptedJson);

      walletObj.isActive = w.isActive;
      if (!walletObj.id) walletObj.id = w.id;

      recovered.push(walletObj);
    }
    return recovered;
  },

  async deriveLegacyKey(password: string, saltBase64: string): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const saltStr = atob(saltBase64);
    const salt = new Uint8Array(saltStr.length);
    for (let i = 0; i < saltStr.length; i++) salt[i] = saltStr.charCodeAt(i);

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
  },

  async decryptLegacyData(encryptedB64: string, key: CryptoKey): Promise<string> {
    const binaryStr = atob(encryptedB64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const iv = bytes.slice(0, 12);
    const data = bytes.slice(12);

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
    return new TextDecoder().decode(decrypted);
  },

  async _migrateVaultVersion(
    storage: VaultStorageData,
    userPassword: string | null = null
  ): Promise<MigrationResult> {
    const vault = storage.vault!;
    const vaultVersion = vault.version || 1;

    logger.debug(`Starting vault version migration from v${vaultVersion}...`);

    try {
      const hasRealPassword = !!storage.hashedPassword;
      const isSkippedMode = (storage.passwordSkipped || storage.booted) && !hasRealPassword;

      const candidates: string[] = [];

      if (isSkippedMode) {
        logger.debug(
          'Vault migration: Skipped-password mode detected, attempting auto-migration...'
        );

        try {
          const deviceKey = await passwordManager.getDeviceKey();
          if (deviceKey) {
            candidates.push(deviceKey);
          }
        } catch {
          logger.debug('Could not retrieve device key for migration');
        }

        candidates.push('');
        candidates.push('null');
        candidates.push('undefined');
      } else {
        if (userPassword !== null) {
          candidates.push(userPassword);
        }
        candidates.push('');
        candidates.push('null');
        candidates.push('undefined');
      }

      const uniqueCandidates = [...new Set(candidates)];

      let recoveredWallets: Wallet[] | null = null;
      let successfulPassword: string | null = null;

      for (const candidate of uniqueCandidates) {
        try {
          const logSafe =
            candidate === '' || candidate === 'null' || candidate === 'undefined'
              ? `[${candidate}]`
              : isSkippedMode && candidate === uniqueCandidates[0]
                ? '[device-key]'
                : '***';

          logger.debug(`Vault migration: Trying candidate: ${logSafe}`);

          recoveredWallets = await this._tryDecryptVault(vault, candidate, storage.salt);

          if (recoveredWallets && recoveredWallets.length > 0) {
            successfulPassword = candidate;
            logger.debug('Vault migration: Decryption successful!');
            break;
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.debug(`Vault migration: Candidate failed - ${msg}`);
        }
      }

      if (!recoveredWallets || recoveredWallets.length === 0) {
        if (userPassword !== null) {
          return { success: false, error: 'INVALID_PASSWORD' };
        }

        if (isSkippedMode) {
          logger.debug(
            'Vault migration: Skipped-password user, auto-migration failed. Cannot recover.'
          );
          return { success: false, error: 'MIGRATION_FAILED_NO_PASSWORD' };
        }

        return { success: false, error: 'PASSWORD_REQUIRED' };
      }

      const deviceKey = isSkippedMode ? await passwordManager.getDeviceKey() : null;
      const isNoPasswordMode =
        isSkippedMode ||
        successfulPassword === '' ||
        successfulPassword === 'null' ||
        successfulPassword === 'undefined' ||
        successfulPassword === deviceKey;

      if (isNoPasswordMode) {
        logger.debug("Vault migration: Re-encrypting in 'No Password' mode.");
        const newDeviceKey = await passwordManager.skipPasswordSetup();
        const vaultKey = await walletStorage.createVault(recoveredWallets, newDeviceKey);
        await passwordManager.setSessionKey(vaultKey);
      } else {
        logger.debug('Vault migration: Re-encrypting with user password.');
        await passwordManager.setupPassword(successfulPassword!);
        await walletStorage.createVault(recoveredWallets, successfulPassword!);
      }

      logger.debug(`Vault migration complete: v${vaultVersion} -> v${CURRENT_VAULT_VERSION}`);
      return { success: true, migrated: true, count: recoveredWallets.length };
    } catch (error: unknown) {
      logger.error('Vault migration failed:', error);
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  },

  async _tryDecryptVault(
    vault: NonNullable<VaultStorageData['vault']>,
    password: string,
    fallbackSalt?: string
  ): Promise<Wallet[]> {
    const { data, iv, salt: vaultSalt, version } = vault;

    const saltsToTry: string[] = [];
    if (vaultSalt) saltsToTry.push(vaultSalt);
    if (fallbackSalt && fallbackSalt !== vaultSalt) saltsToTry.push(fallbackSalt);

    if (saltsToTry.length === 0) {
      throw new Error('Missing encryption salt');
    }

    const iterationsToTry = version && version >= 3 ? [900000, 100000] : [100000, 900000];

    if (iv) {
      for (const iterations of iterationsToTry) {
        for (const saltToUse of saltsToTry) {
          try {
            logger.debug(
              `Vault migration: Trying ${iterations / 1000}k iterations with salt: ${saltToUse.substring(0, 10)}...`
            );
            const key = await this._deriveKeyWithIterations(password, saltToUse, iterations);
            const encryptedData = this._base64ToBytes(data);
            const ivBytes = this._base64ToBytes(iv);

            const decryptedBuffer = await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: ivBytes },
              key,
              encryptedData
            );

            const jsonString = new TextDecoder().decode(decryptedBuffer);
            logger.debug(
              `Vault migration: Decryption succeeded with ${iterations / 1000}k iterations`
            );
            return JSON.parse(jsonString);
          } catch {}
        }
      }
    }

    for (const saltToUse of saltsToTry) {
      try {
        logger.debug(
          `Vault migration: Trying legacy format (100k, combined IV) with salt: ${saltToUse.substring(0, 10)}...`
        );
        const key = await this.deriveLegacyKey(password, saltToUse);
        const jsonString = await this.decryptLegacyData(data, key);
        logger.debug('Vault migration: Legacy format decryption succeeded');
        return JSON.parse(jsonString);
      } catch {}
    }

    throw new Error('Decryption failed with all iteration counts, formats, and salts');
  },

  async _deriveKeyWithIterations(
    password: string,
    saltBase64: string,
    iterations: number
  ): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: this._base64ToBytes(saltBase64),
        iterations: iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  _base64ToBytes(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  },
};
