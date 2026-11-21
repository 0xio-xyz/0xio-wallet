/**
 * Pairing with 0xio Desktop (protocol 0xio-pair-v1, mirrored in the desktop's ws_auth.rs).
 *
 * The secret is kept in chrome.storage.local without the vault key: the desktop link is set up
 * before and apart from the wallet vault (and must survive a password change), and the secret
 * only proves this install to the desktop and the desktop to it. It opens no wallet.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';

export const PAIRING_KEY = '0xio_desktop_pairing';
export const CLIENT_ID_KEY = '0xio_desktop_client_id';

export interface DesktopPairing {
  v: 1;
  clientId: string;
  desktopId: string;
  secret: string;
  pairedAt: number;
}

const enc = new TextEncoder();
const ID = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
export const isHex32 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** sha256 over the label, both ids and both public keys, in a fixed order. */
export function transcript(
  desktopId: string,
  clientId: string,
  epkE: Uint8Array,
  epkD: Uint8Array
): Uint8Array {
  const zero = new Uint8Array([0]);
  return sha256(
    concatBytes(
      enc.encode('0xio-pair-v1'),
      zero,
      enc.encode(desktopId),
      zero,
      enc.encode(clientId),
      zero,
      epkE,
      epkD
    )
  );
}

export function pairCode(shared: Uint8Array, t: Uint8Array): string {
  const c = hmac(sha256, shared, concatBytes(enc.encode('0xio-pair-code'), t));
  const n = (((c[0] << 24) >>> 0) + (c[1] << 16) + (c[2] << 8) + c[3]) % 1_000_000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** A uniform integer in [0, n) from 32 random bits, redrawing the biased tail (no modulo bias). */
export function uniformBelow(n: number, rand32: () => number = randomU32): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const x = rand32();
    if (x < limit) return x % n;
  }
}

function randomU32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

const triple = (g: string) => g[0] === g[1] && g[1] === g[2];

/**
 * The real code among two decoys at a random place. Decoys come only from fresh randomness, never
 * from the secret or the transcript, and share no half with the real code: picking the right row
 * means reading the whole code on the desktop.
 */
export function pairCodeChoices(
  real: string,
  rand32: () => number = randomU32
): { codes: string[]; index: number } {
  const [r1, r2] = real.split(' ');
  const decoys: string[] = [];
  while (decoys.length < 2) {
    const d = String(uniformBelow(1_000_000, rand32)).padStart(6, '0');
    const [a, b] = [d.slice(0, 3), d.slice(3)];
    const code = `${a} ${b}`;
    if (a === r1 || b === r2 || triple(a) || triple(b)) continue;
    if (decoys.includes(code)) continue;
    decoys.push(code);
  }
  const index = uniformBelow(3, rand32);
  const codes = [...decoys];
  codes.splice(index, 0, real);
  return { codes, index };
}

export function pairSecret(shared: Uint8Array, t: Uint8Array): Uint8Array {
  return hmac(sha256, shared, concatBytes(enc.encode('0xio-pair-secret'), t));
}

export type Role = 'desktop' | 'extension';

export function authProof(
  secret: Uint8Array,
  role: Role,
  clientId: string,
  desktopId: string,
  nonceE: Uint8Array,
  nonceD: Uint8Array
): Uint8Array {
  const zero = new Uint8Array([0]);
  return hmac(
    sha256,
    secret,
    concatBytes(
      enc.encode('0xio-auth-v1'),
      zero,
      enc.encode(role),
      zero,
      enc.encode(clientId),
      zero,
      enc.encode(desktopId),
      zero,
      nonceE,
      nonceD
    )
  );
}

/** Compares in time that does not depend on where the bytes differ. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function verifyProof(
  secret: Uint8Array,
  role: Role,
  clientId: string,
  desktopId: string,
  nonceE: Uint8Array,
  nonceD: Uint8Array,
  proofHex: unknown
): boolean {
  if (!isHex32(proofHex)) return false;
  return sameBytes(
    authProof(secret, role, clientId, desktopId, nonceE, nonceD),
    hexToBytes(proofHex)
  );
}

/** X25519 shared secret; null for a low-order key, whose result is all zero. */
export function sharedSecret(sk: Uint8Array, peerHex: string): Uint8Array | null {
  if (!isHex32(peerHex)) return null;
  try {
    const s = x25519.getSharedSecret(sk, hexToBytes(peerHex));
    return s.some((b) => b !== 0) ? s : null;
  } catch {
    return null;
  }
}

export function newKeyPair(): { sk: Uint8Array; pk: Uint8Array } {
  const sk = x25519.utils.randomSecretKey();
  return { sk, pk: x25519.getPublicKey(sk) };
}

export const toHex = bytesToHex;
export const fromHex = hexToBytes;

export async function getClientId(): Promise<string> {
  const got = await chrome.storage.local.get(CLIENT_ID_KEY);
  const id = got?.[CLIENT_ID_KEY];
  if (isId(id)) return id;
  const fresh = bytesToHex(randomBytes(16));
  await chrome.storage.local.set({ [CLIENT_ID_KEY]: fresh });
  return fresh;
}

export function readPairing(raw: unknown): DesktopPairing | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || !isId(p.clientId) || !isId(p.desktopId) || !isHex32(p.secret)) return null;
  return {
    v: 1,
    clientId: p.clientId,
    desktopId: p.desktopId,
    secret: p.secret,
    pairedAt: typeof p.pairedAt === 'number' ? p.pairedAt : 0,
  };
}

export async function loadPairing(): Promise<DesktopPairing | null> {
  const got = await chrome.storage.local.get(PAIRING_KEY);
  return readPairing(got?.[PAIRING_KEY]);
}

export async function savePairing(p: DesktopPairing): Promise<void> {
  await chrome.storage.local.set({ [PAIRING_KEY]: p });
}

export async function forgetPairing(): Promise<void> {
  await chrome.storage.local.remove(PAIRING_KEY);
}
