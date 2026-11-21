import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const EVEN_HEX = /^0x([0-9a-fA-F]{2})*$/;
const PRINTABLE = /^[^\p{Cc}]*$/u;

/** A 65 byte r || s || v signature over a 32 byte digest, v as 27 or 28 like every EVM wallet. */
export function signDigestHex(digest: Uint8Array, privateKey: Uint8Array): string {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('Invalid digest');
  if (!(privateKey instanceof Uint8Array) || !secp256k1.utils.isValidSecretKey(privateKey)) {
    throw new Error('Invalid private key');
  }
  const sig = secp256k1.sign(digest, privateKey, {
    prehash: false,
    lowS: true,
    format: 'recovered',
  });
  return '0x' + bytesToHex(sig.subarray(1, 65)) + (27 + sig[0]).toString(16).padStart(2, '0');
}

/**
 * The bytes a personal_sign request signs. Even length 0x hex is raw bytes (what sites send for
 * binary data and what MetaMask does); anything else is UTF-8 text.
 */
export function personalMessageBytes(message: string): Uint8Array {
  if (typeof message !== 'string') throw new Error('Message must be a string');
  return EVEN_HEX.test(message) ? hexToBytes(message.slice(2)) : new TextEncoder().encode(message);
}

/** EIP-191 version 0x45: keccak256("\x19Ethereum Signed Message:\n" + length + message). */
export function personalMessageHash(bytes: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const all = new Uint8Array(prefix.length + bytes.length);
  all.set(prefix);
  all.set(bytes, prefix.length);
  return keccak_256(all);
}

export function signPersonalMessage(message: string, privateKey: Uint8Array): string {
  return signDigestHex(personalMessageHash(personalMessageBytes(message)), privateKey);
}

export function readableMessage(message: string): { text: string | null; hex: string } {
  const bytes = personalMessageBytes(message);
  const hex = '0x' + bytesToHex(bytes);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const clean = text.replace(/[\n\r\t]/g, '');
    return { text: text.length > 0 && PRINTABLE.test(clean) ? text : null, hex };
  } catch {
    return { text: null, hex };
  }
}
