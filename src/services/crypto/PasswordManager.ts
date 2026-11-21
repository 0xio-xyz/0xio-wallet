import { logger } from 'src/utils/logger';
import { isVaultKeyToken, newVaultKey } from './vaultKey';
import type { WalletInput } from '../wallet/WalletStorage';
import type { Wallet } from 'src/types/wallet';

interface StorageKeys {
  HASHED_PASSWORD: string;
  SALT: string;
  PASSWORD_SKIPPED: string;
  BOOTED: string;
  BOOT_SECRET: string;
  DEVICE_KEY: string;
  SETTINGS: string;
  FAILED_ATTEMPTS: string;
  LOCKOUT_UNTIL: string;
}

export type PasskeyCarry = 'carried' | 'removed' | 'none';

export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'WrongPasswordError';
  }
}

export class LockedOutError extends Error {
  constructor(readonly seconds: number) {
    super(`Too many attempts. Try again in ${seconds}s`);
    this.name = 'LockedOutError';
  }
}

interface BootedData {
  data: string;
  iv: string;
  salt: string;
}

export class PasswordManager {
  private sessionKey: string | null = null;
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  private autoLockDuration: number = 300;
  private activityTrackingActive: boolean = false;
  private lastActivityWrite: number = 0;

  private readonly ITERATIONS: number = 900000;
  private readonly LEGACY_ITERATIONS: number = 100000;

  private failedAttempts: number = 0;
  private lockoutUntil: number = 0;
  private readonly MAX_ATTEMPTS: number = 5;
  private readonly BASE_LOCKOUT_SECONDS: number = 30;

  private readonly KEYS: StorageKeys = {
    HASHED_PASSWORD: 'hashedPassword',
    SALT: 'salt',
    PASSWORD_SKIPPED: 'passwordSkipped',
    BOOTED: 'booted',
    BOOT_SECRET: 'bootSecret',
    DEVICE_KEY: 'deviceEncryptionKey',
    SETTINGS: 'settings',
    FAILED_ATTEMPTS: 'failedPasswordAttempts',
    LOCKOUT_UNTIL: 'passwordLockoutUntil',
  };

  constructor() {
    this.loadAutoLockSetting();
    this.loadRateLimitState();
  }

  async loadRateLimitState(): Promise<void> {
    try {
      const storage = await chrome.storage.local.get([
        this.KEYS.FAILED_ATTEMPTS,
        this.KEYS.LOCKOUT_UNTIL,
      ]);
      this.failedAttempts = storage[this.KEYS.FAILED_ATTEMPTS] || 0;
      this.lockoutUntil = storage[this.KEYS.LOCKOUT_UNTIL] || 0;
    } catch (_e: unknown) {}
  }

  async saveRateLimitState(): Promise<void> {
    try {
      await chrome.storage.local.set({
        [this.KEYS.FAILED_ATTEMPTS]: this.failedAttempts,
        [this.KEYS.LOCKOUT_UNTIL]: this.lockoutUntil,
      });
    } catch (e: unknown) {
      logger.error('Failed to save rate limit state:', e);
    }
  }

  isLockedOut(): boolean {
    if (this.lockoutUntil === 0) return false;
    return Date.now() < this.lockoutUntil;
  }

  getLockoutRemainingSeconds(): number {
    if (!this.isLockedOut()) return 0;
    return Math.ceil((this.lockoutUntil - Date.now()) / 1000);
  }

  attemptsLeft(): number {
    return Math.max(0, this.MAX_ATTEMPTS - this.failedAttempts);
  }

  async recordFailedAttempt(): Promise<void> {
    this.failedAttempts++;

    if (this.failedAttempts >= this.MAX_ATTEMPTS) {
      const lockoutMultiplier = Math.pow(
        2,
        Math.floor(this.failedAttempts / this.MAX_ATTEMPTS) - 1
      );
      const lockoutSeconds = this.BASE_LOCKOUT_SECONDS * lockoutMultiplier;
      this.lockoutUntil = Date.now() + lockoutSeconds * 1000;
    }

    await this.saveRateLimitState();
  }

  async resetRateLimit(): Promise<void> {
    this.failedAttempts = 0;
    this.lockoutUntil = 0;
    await this.saveRateLimitState();
  }

  async generateSalt(): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    return this.bytesToBase64(salt);
  }

  async hashPassword(password: string, saltBase64: string): Promise<string> {
    // The stored verifier must NOT equal the vault's AES key. deriveEncryptionKey derives the AES
    // key as PBKDF2(password, salt, ITERATIONS); returning those same bits here would store the key
    // in plaintext next to the ciphertext. Hash the derived bits once more so the verifier is a
    // one-way value that reveals nothing usable, while still being deterministic for comparison.
    const bits = await this._hashWithIterations(password, saltBase64, this.ITERATIONS);
    return this._verifierFromBits(bits);
  }

  private async _verifierFromBits(bitsBase64: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', this.base64ToBytes(bitsBase64));
    return this.bytesToBase64(new Uint8Array(digest));
  }

  private async _hashWithIterations(
    password: string,
    saltBase64: string,
    iterations: number
  ): Promise<string> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: this.base64ToBytes(saltBase64),
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );

    return this.bytesToBase64(new Uint8Array(derivedBits));
  }

  async verifyPassword(password: string, storedHash: string, salt: string): Promise<boolean> {
    try {
      const rawBits = await this._hashWithIterations(password, salt, this.ITERATIONS);

      const verifier = await this._verifierFromBits(rawBits);
      if (verifier === storedHash) return true;

      // Legacy form where the stored verifier was the raw derived bits - i.e. byte-for-byte the
      // vault's AES key. Accept it once to migrate, then immediately rewrite it to the safe verifier
      // so the key stops living in storage.
      if (rawBits === storedHash) {
        await chrome.storage.local.set({ [this.KEYS.HASHED_PASSWORD]: verifier });
        logger.debug('Migrated legacy password verifier (raw key) to hashed form');
        return true;
      }
      const legacyBits = await this._hashWithIterations(password, salt, this.LEGACY_ITERATIONS);
      if (legacyBits === storedHash) {
        await chrome.storage.local.set({ [this.KEYS.HASHED_PASSWORD]: verifier });
        logger.debug('Migrated legacy password verifier (100k raw key) to hashed 900k form');
        return true;
      }

      return false;
    } catch (error: unknown) {
      logger.error('Verification error:', error);
      return false;
    }
  }

  async deriveEncryptionKey(
    password: string,
    saltBase64: string,
    allowExtract: boolean = false
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
        salt: this.base64ToBytes(saltBase64),
        iterations: this.ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      allowExtract,
      ['encrypt', 'decrypt']
    );
  }

  async setSessionKey(vaultKey: string): Promise<void> {
    if (!isVaultKeyToken(vaultKey)) throw new Error('The session only holds a vault key');
    this.sessionKey = vaultKey;

    try {
      const sessionEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
      const sessionIv = crypto.getRandomValues(new Uint8Array(12));
      const verificationToken = crypto.getRandomValues(new Uint8Array(32));

      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        sessionEncryptionKey,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );

      const encryptedToken = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: sessionIv },
        cryptoKey,
        verificationToken
      );

      const now = Date.now();

      await chrome.storage.session.set({
        wallet_unlocked: true,
        sessionKey: vaultKey,
        sessionVerification: {
          encryptedToken: this.bytesToBase64(new Uint8Array(encryptedToken)),
          iv: this.bytesToBase64(sessionIv),
          tokenHash: this.bytesToBase64(verificationToken),
        },
        lastActivityTime: now,
      });

      await chrome.storage.local.set({ lastActivityTime: now });
    } catch (error: unknown) {
      logger.error('Failed to set session key:', error);
    }

    this.startAutoLockTimer();
  }

  async getSessionKey(): Promise<string | null> {
    if (this.sessionKey) return this.sessionKey;

    const result = await chrome.storage.session.get([
      'wallet_unlocked',
      'sessionVerification',
      'sessionKey',
    ]);

    if (result.sessionKey && !isVaultKeyToken(result.sessionKey)) {
      // Written by a version that kept the password itself here. Never reuse it.
      await chrome.storage.session.remove(['sessionKey', 'wallet_unlocked']);
      return null;
    }

    if (result.wallet_unlocked && result.sessionVerification) {
      if (result.sessionKey) {
        this.sessionKey = result.sessionKey;
        return this.sessionKey;
      }

      if (await this.isPasswordSkipped()) {
        const vaultKey = await this.unlockWithDeviceKey();
        if (vaultKey) {
          await this.setSessionKey(vaultKey);
          return vaultKey;
        }
      }
    }

    return null;
  }

  private async unlockWithDeviceKey(): Promise<string | null> {
    const deviceKey = await this.getDeviceKey();
    if (!deviceKey) return null;
    const { walletStorage } = await import('../wallet/WalletStorage');
    return walletStorage.unlockVault(deviceKey);
  }

  async initializeVault(password: string, firstWallet: WalletInput): Promise<Wallet> {
    const { secret, record } =
      password.length > 0
        ? { secret: password, record: await this.passwordRecord(password) }
        : await this.deviceKeyRecord();
    const vaultKey = newVaultKey();
    const { walletStorage } = await import('../wallet/WalletStorage');
    await this.setSessionKey(vaultKey);
    try {
      return await walletStorage.createFirstVault(vaultKey, firstWallet, secret, record);
    } catch (e) {
      await this.lockWallet();
      throw e;
    }
  }

  async generateDeviceKey(): Promise<string> {
    const key = crypto.getRandomValues(new Uint8Array(32));
    return this.bytesToBase64(key);
  }

  async deriveBootKey(saltBase64: string): Promise<CryptoKey> {
    const bootSecret = await this.getOrGenerateBootSecret();

    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(bootSecret),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: this.base64ToBytes(saltBase64),
        iterations: 900000,
        hash: 'SHA-256',
      },
      secretKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async getOrGenerateBootSecret(): Promise<string> {
    const storage = await chrome.storage.local.get([this.KEYS.BOOT_SECRET]);

    if (storage[this.KEYS.BOOT_SECRET]) {
      return storage[this.KEYS.BOOT_SECRET];
    }

    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    const bootSecret = this.bytesToBase64(randomBytes);

    await chrome.storage.local.set({
      [this.KEYS.BOOT_SECRET]: bootSecret,
    });

    return bootSecret;
  }

  async storeDeviceKey(deviceKeyBase64: string): Promise<BootedData> {
    const bootSalt = await this.generateSalt();
    const wrapKey = await this.deriveBootKey(bootSalt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encodedKey = new TextEncoder().encode(deviceKeyBase64);

    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      wrapKey,
      encodedKey
    );

    return {
      data: this.bytesToBase64(new Uint8Array(encryptedBuffer)),
      iv: this.bytesToBase64(iv),
      salt: bootSalt,
    };
  }

  async getDeviceKey(): Promise<string | null> {
    const result = await chrome.storage.local.get([this.KEYS.BOOTED]);
    if (!result[this.KEYS.BOOTED]) return null;

    const { data, iv, salt } = result[this.KEYS.BOOTED];

    try {
      const wrapKey = await this.deriveBootKey(salt);
      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.base64ToBytes(iv) },
        wrapKey,
        this.base64ToBytes(data)
      );
      return new TextDecoder().decode(decryptedBuffer);
    } catch (e: unknown) {
      logger.error('Failed to unlock device key:', e);
      return null;
    }
  }

  async skipPasswordSetup(): Promise<string> {
    const { secret, record } = await this.deviceKeyRecord();
    await chrome.storage.local.set(record);
    return secret;
  }

  async setupPassword(password: string): Promise<void> {
    await chrome.storage.local.set(await this.passwordRecord(password));
  }

  private async deviceKeyRecord(): Promise<{ secret: string; record: Record<string, unknown> }> {
    const deviceKey = await this.generateDeviceKey();
    const salt = await this.generateSalt();
    return {
      secret: deviceKey,
      record: {
        [this.KEYS.BOOTED]: await this.storeDeviceKey(deviceKey),
        [this.KEYS.PASSWORD_SKIPPED]: true,
        [this.KEYS.HASHED_PASSWORD]: null,
        [this.KEYS.SALT]: salt,
        [this.KEYS.DEVICE_KEY]: null,
      },
    };
  }

  private async passwordRecord(password: string): Promise<Record<string, unknown>> {
    const salt = await this.generateSalt();
    return {
      [this.KEYS.HASHED_PASSWORD]: await this.hashPassword(password, salt),
      [this.KEYS.SALT]: salt,
      [this.KEYS.PASSWORD_SKIPPED]: false,
      [this.KEYS.BOOTED]: null,
      [this.KEYS.DEVICE_KEY]: null,
    };
  }

  async changePassword(
    oldPassword: string,
    newPassword: string | null
  ): Promise<{ passkey: PasskeyCarry }> {
    // Prevents WalletContext from reacting before vault re-encryption completes
    await chrome.storage.session.set({ processing_auth_change: true });

    try {
      const passwordSkipped = await this.isPasswordSkipped();

      if (passwordSkipped) {
        const deviceKey = await this.getDeviceKey();
        if (!deviceKey) throw new Error('Device key not found.');
      } else {
        const storage = await chrome.storage.local.get([this.KEYS.HASHED_PASSWORD, this.KEYS.SALT]);
        const isValid = await this.verifyPassword(
          oldPassword,
          storage[this.KEYS.HASHED_PASSWORD],
          storage[this.KEYS.SALT]
        );
        if (!isValid) throw new WrongPasswordError();
      }

      const vaultKey = await this.getSessionKey();
      if (!vaultKey) throw new Error('Session expired. Please unlock wallet.');

      const { walletStorage } = await import('../wallet/WalletStorage');
      const newSalt = await this.generateSalt();

      if (newPassword) {
        await walletStorage.rewrapVaultKey(vaultKey, newPassword, {
          [this.KEYS.HASHED_PASSWORD]: await this.hashPassword(newPassword, newSalt),
          [this.KEYS.SALT]: newSalt,
          [this.KEYS.PASSWORD_SKIPPED]: false,
          [this.KEYS.BOOTED]: null,
        });
      } else {
        const deviceKey = await this.generateDeviceKey();
        await walletStorage.rewrapVaultKey(vaultKey, deviceKey, {
          [this.KEYS.BOOTED]: await this.storeDeviceKey(deviceKey),
          [this.KEYS.HASHED_PASSWORD]: null,
          [this.KEYS.SALT]: newSalt,
          [this.KEYS.PASSWORD_SKIPPED]: true,
        });
      }
      await this.setSessionKey(vaultKey);

      // After the vault is committed, so a cancelled passkey prompt can never undo the change.
      return { passkey: await this.carryPasskey(newPassword) };
    } finally {
      await chrome.storage.session.remove('processing_auth_change');
    }
  }

  /**
   * Never throws: the password change has already landed.
   */
  private async carryPasskey(newPassword: string | null): Promise<PasskeyCarry> {
    try {
      const passkey = await import('./PasskeyService');
      if (!(await passkey.isPasskeyEnabled())) return 'none';
      if (newPassword && (await passkey.updateStoredPassword(newPassword))) return 'carried';
      await passkey.removePasskey();
      return 'removed';
    } catch (e) {
      logger.warn('[Auth] passkey could not follow the password change', e);
      try {
        const { removePasskey } = await import('./PasskeyService');
        await removePasskey();
        return 'removed';
      } catch {
        return 'none';
      }
    }
  }

  async isPasswordSkipped(): Promise<boolean> {
    const storage = await chrome.storage.local.get([this.KEYS.PASSWORD_SKIPPED]);
    return !!storage[this.KEYS.PASSWORD_SKIPPED];
  }

  async lockWallet(): Promise<boolean> {
    this.sessionKey = null;
    this.stopAutoLockTimer();
    await chrome.storage.session.remove([
      'wallet_unlocked',
      'sessionKey',
      'sessionKeyJWK',
      'sessionVerification',
      'lastActivityTime',
      'lastUnlockTime',
    ]);
    await chrome.storage.local.remove(['lastActivityTime', 'lastUnlockTime']);
    return true;
  }

  isUnlocked(): boolean {
    return this.sessionKey !== null;
  }

  startAutoLockTimer(): void {
    this.stopAutoLockTimer();
    if (!this.isUnlocked()) return;
    const durationSeconds = this.autoLockDuration;

    if (durationSeconds > 0) {
      this.autoLockTimer = setTimeout(() => this.lockWallet(), durationSeconds * 1000);
    }
  }

  stopAutoLockTimer(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
  }

  resetAutoLockTimer(): void {
    if (this.isUnlocked()) this.startAutoLockTimer();
  }

  async suppressAutoLock(): Promise<void> {
    this.stopAutoLockTimer();
    await chrome.storage.session.set({ activeOperation: Date.now() });
    await chrome.storage.local.set({ activeOperation: Date.now() });
    logger.debug('[PasswordManager] Auto-lock suppressed (active operation)');
  }

  async resumeAutoLock(): Promise<void> {
    await chrome.storage.session.remove(['activeOperation']);
    await chrome.storage.local.remove(['activeOperation']);
    this.updateLastActivity();
    this.startAutoLockTimer();
    logger.debug('[PasswordManager] Auto-lock resumed');
  }

  async loadAutoLockSetting(): Promise<void> {
    try {
      const storage = await chrome.storage.local.get(['autoLockDuration']);
      this.autoLockDuration =
        storage.autoLockDuration !== undefined ? storage.autoLockDuration : 300;
      await this.initializeUnlockStatus();
    } catch (_e: unknown) {
      this.initializeUnlockStatus();
    }
  }

  async initializeUnlockStatus(): Promise<void> {
    try {
      const skipped = await this.isPasswordSkipped();
      if (skipped) {
        const localStorage = await chrome.storage.local.get(['lastActivityTime', 'lastUnlockTime']);
        const lastActivityTime = localStorage.lastActivityTime ?? localStorage.lastUnlockTime;

        // First run or after update: auto-unlock to avoid breaking skip-mode users
        if (
          lastActivityTime === undefined ||
          this.autoLockDuration === 0 ||
          Date.now() - lastActivityTime < this.autoLockDuration * 1000
        ) {
          const vaultKey = (await this.getSessionKey()) ?? (await this.unlockWithDeviceKey());
          if (vaultKey) await this.setSessionKey(vaultKey);
          return;
        }

        this.lockWallet();
        return;
      }

      const session = await chrome.storage.session.get([
        'wallet_unlocked',
        'lastActivityTime',
        'lastUnlockTime',
        'sessionVerification',
      ]);

      if (session.wallet_unlocked && session.sessionVerification) {
        let lastActivityTime = session.lastActivityTime ?? session.lastUnlockTime;
        if (!lastActivityTime) {
          const localStorage = await chrome.storage.local.get([
            'lastActivityTime',
            'lastUnlockTime',
          ]);
          lastActivityTime = localStorage.lastActivityTime ?? localStorage.lastUnlockTime;
        }

        // Trust valid session on first run after update
        if (lastActivityTime === undefined) {
          const now = Date.now();
          await chrome.storage.session.set({ lastActivityTime: now });
          await chrome.storage.local.set({ lastActivityTime: now });
          await this.getSessionKey();
          this.startAutoLockTimer();
          return;
        }

        const now = Date.now();
        const timeSince = now - lastActivityTime;

        if (this.autoLockDuration === 0 || timeSince < this.autoLockDuration * 1000) {
          await this.getSessionKey();
          this.startAutoLockTimer();
          return;
        }
      }

      this.lockWallet();
    } catch (e: unknown) {
      // Only log warning on transient errors - don't lock wallet on read failures (prevents boot loops)
      logger.warn('Auto-lock check failed:', e);
    }
  }

  async updateAutoLockDuration(seconds: number): Promise<void> {
    this.stopAutoLockTimer();
    this.autoLockDuration = seconds;
    await chrome.storage.local.set({ autoLockDuration: seconds });
    this.startAutoLockTimer();
  }

  setupActivityTracking(): void {
    if (this.activityTrackingActive) return;
    this.activityTrackingActive = true;
    const handler = () => {
      this.resetAutoLockTimer();
      this.updateLastActivity();
    };
    ['mousedown', 'keydown', 'touchstart', 'scroll'].forEach((evt) =>
      document.addEventListener(evt, handler, { passive: true })
    );
  }

  async updateLastActivity(): Promise<void> {
    if (this.isUnlocked()) {
      const now = Date.now();
      if (now - this.lastActivityWrite < 10_000) return;
      this.lastActivityWrite = now;
      await chrome.storage.session.set({ lastActivityTime: now });
      await chrome.storage.local.set({ lastActivityTime: now });
    }
  }

  bytesToBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
  }

  base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
  }
}

export const passwordManager = new PasswordManager();
