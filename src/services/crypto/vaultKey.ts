/**
 * A vault key travels as an opaque token `vk1.<kid>.<base64 key>`. The kid is stored beside the
 * wrap and inside the sealed vault, so a token that no longer matches what is stored can neither
 * read the vault nor seal data under a key nobody can unwrap.
 */

const ITERATIONS = 900_000;
const TOKEN = /^vk1\.([0-9a-f]{16})\.([A-Za-z0-9+/]{43}=)$/;

export interface WrappedVaultKey {
  kid: string;
  salt: string;
  iv: string;
  wrapped: string;
}

export interface SealedVault {
  version: 4;
  kid: string;
  iv: string;
  data: string;
}

export class StaleVaultKeyError extends Error {
  constructor() {
    super('The wallet was unlocked with a key that is no longer current. Unlock again.');
    this.name = 'StaleVaultKeyError';
  }
}

const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromB64 = (b64: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const utf8 = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

export const isVaultKeyToken = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN.test(value);

function parse(token: string): { kid: string; raw: Uint8Array<ArrayBuffer> } {
  const m = TOKEN.exec(token);
  if (!m) throw new Error('Not a vault key');
  return { kid: m[1], raw: fromB64(m[2]) };
}

export const kidOf = (token: string): string => parse(token).kid;

export function newVaultKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const kid = toHex(crypto.getRandomValues(new Uint8Array(8)));
  const token = `vk1.${kid}.${toB64(raw)}`;
  raw.fill(0);
  return token;
}

async function keyFromSecret(secret: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8(secret), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function keyFromToken(token: string): Promise<{ kid: string; key: CryptoKey }> {
  const { kid, raw } = parse(token);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return { kid, key };
}

export async function wrapVaultKey(token: string, secret: string): Promise<WrappedVaultKey> {
  const { kid, raw } = parse(token);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(kid) },
    await keyFromSecret(secret, salt),
    raw
  );
  raw.fill(0);
  return { kid, salt: toB64(salt), iv: toB64(iv), wrapped: toB64(new Uint8Array(wrapped)) };
}

export async function unwrapVaultKey(w: WrappedVaultKey, secret: string): Promise<string> {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(w.iv), additionalData: utf8(w.kid) },
        await keyFromSecret(secret, fromB64(w.salt)),
        fromB64(w.wrapped)
      )
    );
  } catch {
    throw new Error('Could not unlock the vault key');
  }
  const token = `vk1.${w.kid}.${toB64(raw)}`;
  raw.fill(0);
  return token;
}

export async function sealVault(token: string, plaintext: string): Promise<SealedVault> {
  const { kid, key } = await keyFromToken(token);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(kid) },
    key,
    utf8(plaintext)
  );
  return { version: 4, kid, iv: toB64(iv), data: toB64(new Uint8Array(data)) };
}

export async function openVault(token: string, vault: SealedVault): Promise<string> {
  const { kid, key } = await keyFromToken(token);
  if (vault.kid !== kid) throw new StaleVaultKeyError();
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(vault.iv), additionalData: utf8(kid) },
    key,
    fromB64(vault.data)
  );
  return new TextDecoder().decode(plain);
}
