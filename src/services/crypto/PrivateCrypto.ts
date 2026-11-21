import nacl from 'tweetnacl';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  concat,
  strToBytes,
  uint64LE,
  readUint64LE,
} from 'src/lib/encoding';
import { logger } from 'src/utils/logger';

// Domain separation constants (must match server exactly)
const STEALTH_TAG_DOMAIN = 'OCTRA_STEALTH_TAG_V1';
const CLAIM_SECRET_DOMAIN = 'OCTRA_CLAIM_SECRET_V1';
const CLAIM_BIND_DOMAIN = 'OCTRA_CLAIM_BIND_V1';

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const ab = new ArrayBuffer(data.length);
  new Uint8Array(ab).set(data);
  const buf = await crypto.subtle.digest('SHA-256', ab);
  return new Uint8Array(buf);
}

export function deriveViewKeypair(privKeyB64: string): {
  viewSk: Uint8Array;
  viewPub: Uint8Array;
} {
  const rawSeed = base64ToBytes(privKeyB64).slice(0, 32);
  const hash = nacl.hash(rawSeed);
  const curve25519Sk = new Uint8Array(32);
  curve25519Sk.set(hash.slice(0, 32));
  curve25519Sk[0] &= 248;
  curve25519Sk[31] &= 127;
  curve25519Sk[31] |= 64;
  const curve25519Pub = nacl.scalarMult.base(curve25519Sk);
  return { viewSk: curve25519Sk, viewPub: curve25519Pub };
}

export async function ecdhSharedSecret(
  ourSk: Uint8Array,
  theirPub: Uint8Array
): Promise<Uint8Array> {
  const raw = nacl.scalarMult(ourSk, theirPub);
  if (raw.every((b) => b === 0)) throw new Error('x25519 low-order public key rejected');
  return sha256(raw);
}

export function generateEphemeralKeypair(): {
  ephSk: Uint8Array;
  ephPub: Uint8Array;
} {
  const ephSk = nacl.randomBytes(32);
  ephSk[0] &= 248;
  ephSk[31] &= 127;
  ephSk[31] |= 64;
  const ephPub = nacl.scalarMult.base(ephSk);
  return { ephSk, ephPub };
}

export async function computePrivateTag(sharedSecret: Uint8Array): Promise<Uint8Array> {
  const data = concat(sharedSecret, strToBytes(STEALTH_TAG_DOMAIN));
  const hash = await sha256(data);
  return hash.slice(0, 16);
}

export async function computeClaimSecret(sharedSecret: Uint8Array): Promise<Uint8Array> {
  const data = concat(sharedSecret, strToBytes(CLAIM_SECRET_DOMAIN));
  return sha256(data);
}

export async function computeClaimPub(
  claimSecret: Uint8Array,
  recipientAddr: string
): Promise<Uint8Array> {
  const data = concat(claimSecret, strToBytes(recipientAddr), strToBytes(CLAIM_BIND_DOMAIN));
  return sha256(data);
}

export async function encryptPrivateAmount(
  sharedSecret: Uint8Array,
  amountRaw: number,
  blinding: Uint8Array
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    sharedSecret.slice(0, 32),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = concat(uint64LE(amountRaw), blinding);

  const ptAb = new ArrayBuffer(plaintext.length);
  new Uint8Array(ptAb).set(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, ptAb);

  const result = concat(nonce, new Uint8Array(ciphertext));
  return bytesToBase64(result);
}

export async function decryptPrivateAmount(
  sharedSecret: Uint8Array,
  encB64: string
): Promise<{ amount: number; blinding: Uint8Array }> {
  const raw = base64ToBytes(encB64);
  const nonce = raw.slice(0, 12);
  const ct = raw.slice(12);

  const key = await crypto.subtle.importKey(
    'raw',
    sharedSecret.slice(0, 32),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const ctAb = new ArrayBuffer(ct.length);
  new Uint8Array(ctAb).set(ct);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ctAb);

  const plain = new Uint8Array(plaintext);
  const amount = readUint64LE(plain.slice(0, 8));
  const blinding = plain.slice(8);

  return { amount, blinding: new Uint8Array(blinding) };
}

export async function scanPrivateOutputs(
  outputs: Array<{
    id: number;
    eph_pub: string;
    stealth_tag: string;
    enc_amount: string;
    claimed: number;
    epoch_id?: number;
  }>,
  privKeyB64: string,
  onProgress?: (scanned: number, total: number, matched: number) => void
): Promise<
  Array<{
    id: number;
    amount: number;
    tag: string;
    epoch: number;
    claimSecret: string;
    blinding: Uint8Array;
  }>
> {
  const { viewSk } = deriveViewKeypair(privKeyB64);
  const mine: Array<{
    id: number;
    amount: number;
    tag: string;
    epoch: number;
    claimSecret: string;
    blinding: Uint8Array;
  }> = [];

  const t0 = Date.now();
  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    if (out.claimed !== 0) continue;

    try {
      const ephPub = base64ToBytes(out.eph_pub);
      const shared = await ecdhSharedSecret(viewSk, ephPub);
      const myTag = bytesToHex(await computePrivateTag(shared));

      if (myTag === out.stealth_tag) {
        const { amount, blinding } = await decryptPrivateAmount(shared, out.enc_amount);
        const cs = await computeClaimSecret(shared);

        mine.push({
          id: out.id,
          amount,
          tag: myTag,
          epoch: out.epoch_id || 0,
          claimSecret: bytesToHex(cs),
          blinding,
        });
      }
    } catch (e) {
      logger.debug(`[scanPrivateOutputs] output #${out.id} scan failed:`, e);
      continue;
    }

    if ((i + 1) % 10 === 0) {
      logger.debug(
        `[scanPrivateOutputs] scanned ${i + 1}/${outputs.length} outputs (${mine.length} matched) - ${Date.now() - t0}ms`
      );
      if (onProgress) onProgress(i + 1, outputs.length, mine.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  logger.debug(
    `[scanPrivateOutputs] done: ${mine.length}/${outputs.length} matched in ${Date.now() - t0}ms`
  );
  return mine;
}

export { base64ToBytes, bytesToBase64, bytesToHex };
