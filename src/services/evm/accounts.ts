import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { cryptoManager } from '../crypto/CryptoManager';

export const evmPath = (index: number) => `m/44'/60'/0'/0/${index}`;

export interface EvmAccount {
  enabled: boolean;
  address: string;
  index: number;
}

export function toChecksumAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error('Invalid EVM address');
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(hex)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  return out;
}

export function evmAddressFromPublicKey(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return toChecksumAddress(bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20)));
}

/** The 0x address of a phrase at m/44'/60'/0'/0/index, the path MetaMask and most wallets use. */
export async function deriveEvmAddress(mnemonic: string[] | string, index = 0): Promise<string> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error('Invalid account number');
  }
  const phrase = Array.isArray(mnemonic) ? mnemonic.join(' ') : mnemonic.trim();
  const seed = await cryptoManager.mnemonicToSeed(phrase);
  const key = HDKey.fromMasterSeed(seed).derive(evmPath(index));
  if (!key.publicKey) throw new Error('Could not derive the EVM key');
  return evmAddressFromPublicKey(key.publicKey);
}

/**
 * True when other BIP39 wallets accept the phrase: every word is on the standard list and the
 * checksum holds. Phrases from the extension's older word list restore here but fail elsewhere.
 */
export function isStandardPhrase(words: string[]): boolean {
  if (![12, 15, 18, 21, 24].includes(words.length)) return false;
  const list = cryptoManager.mnemonicWordlist();
  const index = new Map(list.map((w, i) => [w, i]));
  let bits = '';
  for (const w of words) {
    const i = index.get(w.toLowerCase());
    if (i === undefined) return false;
    bits += i.toString(2).padStart(11, '0');
  }
  const checksumBits = words.length / 3;
  const entropyBits = bits.slice(0, bits.length - checksumBits);
  const entropy = new Uint8Array(entropyBits.length / 8);
  for (let i = 0; i < entropy.length; i++) {
    entropy[i] = parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2);
  }
  const expected = Array.from(sha256(entropy))
    .map((b) => b.toString(2).padStart(8, '0'))
    .join('')
    .slice(0, checksumBits);
  return expected === bits.slice(-checksumBits);
}
