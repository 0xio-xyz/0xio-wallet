/**
 * Authenticators without PRF support are refused: a passkey that does not protect the password
 * is worse than none.
 */

import { logger } from 'src/utils/logger';

const STORAGE_KEYS = {
  CREDENTIAL_ID: 'passkey_credential_id',
  ENCRYPTED_PASSWORD: 'passkey_encrypted_password',
  PRF_SALT: 'passkey_prf_salt',
  ENABLED: 'passkey_enabled',
  SIGN_COUNT: 'passkey_sign_count',
  ATTEMPT_COUNT: 'passkey_attempt_count',
  LOCKED_UNTIL: 'passkey_locked_until',
};

/** Formats that must never be trusted again. */
const LEGACY_KEYS = ['passkey_encrypted_key', 'passkey_encryption_key'];

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
const HKDF_INFO = '0xio-passkey-v3';

const RP = {
  name: '0xio Wallet',
  id: typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.id : 'localhost',
};

let lastError: 'unsupported' | 'no_prf' | 'cancelled' | 'mismatch' | 'rate_limited' | null = null;
export function getLastPasskeyError() {
  return lastError;
}

export function isWebAuthnAvailable(): boolean {
  // The API surface (PublicKeyCredential / navigator.credentials) EXISTS in Firefox extension
  // pages too, so presence alone is a false positive. This feature uses the extension's OWN origin
  // as the WebAuthn relying party (self-RP), which only Chromium supports for chrome-extension://
  // origins. Firefox (moz-extension://) has no self-RP path - the ceremony throws - so gate the
  // whole feature to Chromium extension origins.
  const selfRpSupported =
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime?.getURL === 'function' &&
    chrome.runtime.getURL('').startsWith('chrome-extension://');
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials !== 'undefined' &&
    selfRpSupported
  );
}

export async function isPasskeyEnabled(): Promise<boolean> {
  try {
    const r = await chrome.storage.local.get([
      STORAGE_KEYS.ENABLED,
      STORAGE_KEYS.PRF_SALT,
      ...LEGACY_KEYS,
    ]);
    if (r[STORAGE_KEYS.ENABLED] !== true) return false;
    if (!r[STORAGE_KEYS.PRF_SALT] || LEGACY_KEYS.some((k) => r[k])) {
      logger.warn('[Passkey] Pre-PRF record found - disabled; re-enable in Settings');
      await removePasskey();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function checkRateLimit(): Promise<{ allowed: boolean; remainingMs: number }> {
  try {
    const data = await chrome.storage.local.get([
      STORAGE_KEYS.ATTEMPT_COUNT,
      STORAGE_KEYS.LOCKED_UNTIL,
    ]);
    const lockedUntil = data[STORAGE_KEYS.LOCKED_UNTIL] || 0;
    if (lockedUntil > Date.now()) {
      return { allowed: false, remainingMs: lockedUntil - Date.now() };
    }
    return { allowed: true, remainingMs: 0 };
  } catch {
    return { allowed: true, remainingMs: 0 };
  }
}

async function recordAttempt(success: boolean): Promise<void> {
  try {
    if (success) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.ATTEMPT_COUNT]: 0,
        [STORAGE_KEYS.LOCKED_UNTIL]: 0,
      });
      return;
    }
    const data = await chrome.storage.local.get(STORAGE_KEYS.ATTEMPT_COUNT);
    const count = (data[STORAGE_KEYS.ATTEMPT_COUNT] || 0) + 1;
    const update: Record<string, number> = { [STORAGE_KEYS.ATTEMPT_COUNT]: count };
    if (count >= MAX_ATTEMPTS) {
      update[STORAGE_KEYS.LOCKED_UNTIL] = Date.now() + LOCKOUT_MS;
      update[STORAGE_KEYS.ATTEMPT_COUNT] = 0;
      logger.warn(`[Passkey] Rate limited after ${MAX_ATTEMPTS} failed attempts`);
    }
    await chrome.storage.local.set(update);
  } catch {}
}

async function keyFromPrf(prfOutput: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', prfOutput, { name: 'HKDF' }, false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt.buffer as ArrayBuffer,
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function prfOutputOf(credential: PublicKeyCredential): ArrayBuffer | null {
  const ext = credential.getClientExtensionResults() as unknown as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
  };
  const first = ext.prf?.results?.first;
  return first && first.byteLength >= 32 ? first : null;
}

async function assertWithPrf(
  credentialId: string,
  prfSalt: Uint8Array
): Promise<PublicKeyCredential | null> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: base64ToBuffer(credentialId) }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  return assertion;
}

export async function registerPasskey(password: string): Promise<boolean> {
  lastError = null;
  if (!isWebAuthnAvailable()) {
    lastError = 'unsupported';
    logger.warn('[Passkey] WebAuthn not available');
    return false;
  }

  try {
    const t0 = Date.now();
    const userId = crypto.getRandomValues(new Uint8Array(32));
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));

    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: RP,
        user: { id: userId, name: '0xio Wallet User', displayName: '0xio Wallet' },
        challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'required',
        },
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;

    if (!credential) {
      lastError = 'cancelled';
      logger.warn('[Passkey] Credential creation cancelled');
      return false;
    }

    const ext = credential.getClientExtensionResults() as unknown as {
      prf?: { enabled?: boolean };
    };
    if (ext.prf?.enabled !== true) {
      lastError = 'no_prf';
      logger.warn('[Passkey] Authenticator has no PRF support - passkey unlock refused');
      return false;
    }
    const credentialId = bufferToBase64(credential.rawId);

    let prfOutput = prfOutputOf(credential);
    if (!prfOutput) {
      const assertion = await assertWithPrf(credentialId, prfSalt);
      prfOutput = assertion ? prfOutputOf(assertion) : null;
    }
    if (!prfOutput) {
      lastError = 'no_prf';
      logger.warn('[Passkey] PRF evaluation returned nothing - passkey unlock refused');
      return false;
    }

    const key = await keyFromPrf(prfOutput, prfSalt);
    const encryptedPassword = await encryptData(password, key);

    await chrome.storage.local.remove(LEGACY_KEYS);
    await chrome.storage.local.set({
      [STORAGE_KEYS.CREDENTIAL_ID]: credentialId,
      [STORAGE_KEYS.ENCRYPTED_PASSWORD]: encryptedPassword,
      [STORAGE_KEYS.PRF_SALT]: bufferToBase64(prfSalt.buffer as ArrayBuffer),
      [STORAGE_KEYS.ENABLED]: true,
      [STORAGE_KEYS.SIGN_COUNT]: 0,
    });

    logger.info(`[Passkey] Registration complete (${Date.now() - t0}ms)`);
    return true;
  } catch (e: any) {
    lastError = 'cancelled';
    logger.error('[Passkey] Registration failed:', e.message);
    return false;
  }
}

export async function authenticateWithPasskey(): Promise<string | null> {
  lastError = null;
  if (!isWebAuthnAvailable()) {
    lastError = 'unsupported';
    return null;
  }

  const { allowed, remainingMs } = await checkRateLimit();
  if (!allowed) {
    lastError = 'rate_limited';
    logger.warn(`[Passkey] Rate limited - ${Math.ceil(remainingMs / 1000)}s remaining`);
    return null;
  }

  try {
    const t0 = Date.now();
    if (!(await isPasskeyEnabled())) {
      logger.warn('[Passkey] No usable record');
      return null;
    }
    const storage = await chrome.storage.local.get([
      STORAGE_KEYS.CREDENTIAL_ID,
      STORAGE_KEYS.ENCRYPTED_PASSWORD,
      STORAGE_KEYS.PRF_SALT,
      STORAGE_KEYS.SIGN_COUNT,
    ]);
    const credentialId = storage[STORAGE_KEYS.CREDENTIAL_ID];
    const encryptedPassword = storage[STORAGE_KEYS.ENCRYPTED_PASSWORD];
    const prfSaltB64 = storage[STORAGE_KEYS.PRF_SALT];
    const storedCount = storage[STORAGE_KEYS.SIGN_COUNT] || 0;
    if (!credentialId || !encryptedPassword || !prfSaltB64) {
      logger.warn('[Passkey] Missing stored data');
      return null;
    }

    const prfSalt = new Uint8Array(base64ToBuffer(prfSaltB64));
    const assertion = await assertWithPrf(credentialId, prfSalt);
    if (!assertion) {
      lastError = 'cancelled';
      logger.info(`[Passkey] Prompt closed (${Date.now() - t0}ms)`);
      return null;
    }

    // Sign counter (anti-clone). Many platform authenticators always report 0, which is skipped.
    const response = assertion.response as AuthenticatorAssertionResponse;
    const signCount = new DataView(response.authenticatorData.slice(33, 37)).getUint32(0);
    if (signCount > 0 && signCount <= storedCount) {
      lastError = 'mismatch';
      logger.error(`[Passkey] Sign counter replay: got ${signCount}, expected > ${storedCount}`);
      await recordAttempt(false);
      return null;
    }

    const prfOutput = prfOutputOf(assertion);
    if (!prfOutput) {
      lastError = 'no_prf';
      logger.error('[Passkey] Assertion carried no PRF output');
      await recordAttempt(false);
      return null;
    }

    try {
      const key = await keyFromPrf(prfOutput, prfSalt);
      const password = await decryptData(encryptedPassword, key);
      await chrome.storage.local.set({ [STORAGE_KEYS.SIGN_COUNT]: signCount });
      await recordAttempt(true);
      logger.info(`[Passkey] Authenticated (${Date.now() - t0}ms)`);
      return password;
    } catch {
      lastError = 'mismatch';
      logger.error(`[Passkey] Password decryption failed (${Date.now() - t0}ms)`);
      await recordAttempt(false);
      return null;
    }
  } catch (e: any) {
    // A dismissed or timed-out prompt rejects with NotAllowedError (AbortError when aborted). That
    // is the user saying no, not a failed authentication, so it must not count toward the lockout:
    // counting it let anyone who prefers their password lock the passkey out just by closing the
    // prompt the lock screen opens for them.
    lastError = 'cancelled';
    if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') {
      logger.info('[Passkey] Prompt dismissed');
    } else {
      logger.error('[Passkey] Authentication failed:', e?.message);
      await recordAttempt(false);
    }
    return null;
  }
}

export async function removePasskey(): Promise<void> {
  await chrome.storage.local.remove([...Object.values(STORAGE_KEYS), ...LEGACY_KEYS]);
  logger.info('[Passkey] Passkey removed');
}

export async function updateStoredPassword(newPassword: string): Promise<boolean> {
  try {
    if (!(await isPasskeyEnabled())) return false;
    const storage = await chrome.storage.local.get([
      STORAGE_KEYS.CREDENTIAL_ID,
      STORAGE_KEYS.PRF_SALT,
    ]);
    const credentialId = storage[STORAGE_KEYS.CREDENTIAL_ID];
    const prfSaltB64 = storage[STORAGE_KEYS.PRF_SALT];
    if (!credentialId || !prfSaltB64) return false;

    const prfSalt = new Uint8Array(base64ToBuffer(prfSaltB64));
    const assertion = await assertWithPrf(credentialId, prfSalt);
    const prfOutput = assertion ? prfOutputOf(assertion) : null;
    if (!prfOutput) return false;

    const key = await keyFromPrf(prfOutput, prfSalt);
    const encrypted = await encryptData(newPassword, key);
    await chrome.storage.local.set({ [STORAGE_KEYS.ENCRYPTED_PASSWORD]: encrypted });
    return true;
  } catch {
    return false;
  }
}

async function encryptData(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return bufferToBase64(packed.buffer as ArrayBuffer);
}

async function decryptData(encrypted: string, key: CryptoKey): Promise<string> {
  const packed = new Uint8Array(base64ToBuffer(encrypted));
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext.buffer as ArrayBuffer
  );
  return new TextDecoder().decode(decrypted);
}

function bufferToBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
