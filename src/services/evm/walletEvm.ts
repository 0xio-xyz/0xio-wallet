import { HDKey } from '@scure/bip32';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import type { Wallet } from '../../types/wallet';
import { cryptoManager } from '../crypto/CryptoManager';
import { evmAddressFromPublicKey, evmPath } from './accounts';

/**
 * What a wallet keeps about its EVM side. Only the address is stored; the key is derived from the
 * phrase when it is used. An account added from another wallet's phrase holds no phrase of its
 * own, so it names that wallet in `sourceWalletId` and keeps its account number in `index`.
 */
export interface EvmMeta {
  enabled: boolean;
  address: string;
  index: number;
  sourceWalletId?: string;
}

export interface EvmSource {
  walletId: string;
  index: number;
}

type EvmWallet = Pick<Wallet, 'id' | 'type' | 'mnemonic' | 'privateKey'> & {
  metadata?: { source?: string; evm?: EvmMeta };
};

export const MAX_DERIVED_INDEX = 999;

const OCTRA_SEED_KEY = new TextEncoder().encode('Octra seed');

export const phraseWords = (mnemonic: unknown): string[] =>
  Array.isArray(mnemonic)
    ? mnemonic.map(String).filter(Boolean)
    : typeof mnemonic === 'string' && mnemonic.trim()
      ? mnemonic.trim().split(/\s+/)
      : [];

export const holdsPhrase = (w: EvmWallet | null | undefined): boolean =>
  !!w && w.type !== 'watch' && phraseWords(w.mnemonic).length > 0;

export const evmMetaOf = (w: EvmWallet | null | undefined): EvmMeta | null =>
  (w?.metadata?.evm as EvmMeta | undefined) ?? null;

export const isDerivedAccount = (w: EvmWallet | null | undefined): boolean =>
  !!w &&
  w.type !== 'watch' &&
  !holdsPhrase(w) &&
  !!w.privateKey &&
  (w.metadata?.source as string | undefined) === 'derived';

export function evmSourceOf(
  wallet: EvmWallet | null | undefined,
  wallets?: EvmWallet[]
): EvmSource | null {
  if (!wallet || wallet.type === 'watch') return null;
  const evm = evmMetaOf(wallet);
  if (holdsPhrase(wallet)) return { walletId: wallet.id, index: evm?.index ?? 0 };
  const sourceId = evm?.sourceWalletId;
  if (!sourceId || sourceId === wallet.id || !Number.isSafeInteger(evm?.index)) return null;
  if (wallets && !holdsPhrase(wallets.find((w) => w.id === sourceId))) return null;
  return { walletId: sourceId, index: evm!.index };
}

export function canUseEvm(wallet: EvmWallet | null | undefined, wallets?: EvmWallet[]): boolean {
  if (evmSourceOf(wallet, wallets)) return true;
  if (!isDerivedAccount(wallet) || evmMetaOf(wallet)?.sourceWalletId) return false;
  return wallets ? wallets.some(holdsPhrase) : true;
}

export function isEvmOn(wallet: EvmWallet | null | undefined, wallets?: EvmWallet[]): boolean {
  const evm = evmMetaOf(wallet);
  return !!evm?.enabled && !!evm.address && !!evmSourceOf(wallet, wallets);
}

const evmAddressFromSeed = (seed: Uint8Array, index: number): string => {
  const key = HDKey.fromMasterSeed(seed).derive(evmPath(index));
  if (!key.publicKey) throw new Error('Could not derive the EVM key');
  return evmAddressFromPublicKey(key.publicKey);
};

const seedOf = (w: EvmWallet) => cryptoManager.mnemonicToSeed(phraseWords(w.mnemonic).join(' '));

/** The Octra key at `index`, the same bytes CryptoManager.deriveAccountAtIndex makes. */
const octraKeyAt = (seed: Uint8Array, index: number): string => {
  const input = new Uint8Array(seed.length + (index === 0 ? 0 : 4));
  input.set(seed);
  if (index !== 0) new DataView(input.buffer).setUint32(seed.length, index, true);
  const mac = hmac(sha512, OCTRA_SEED_KEY, input);
  const key = cryptoManager.bytesToBase64(mac.slice(0, 32));
  mac.fill(0);
  input.fill(0);
  return key;
};

const normalizedKey = (privateKey: string | null): string | null => {
  if (!privateKey) return null;
  try {
    const bytes = cryptoManager.base64ToBytes(privateKey.trim());
    if (bytes.length !== 32 && bytes.length !== 64) return null;
    return cryptoManager.bytesToBase64(bytes.slice(0, 32));
  } catch {
    return null;
  }
};

export async function linkDerivedAccounts(wallets: Wallet[]): Promise<boolean> {
  const pending = new Map<string, Wallet>();
  for (const w of wallets) {
    if (!isDerivedAccount(w) || evmMetaOf(w)?.sourceWalletId) continue;
    const key = normalizedKey(w.privateKey);
    if (key) pending.set(key, w);
  }
  if (!pending.size) return false;

  let linked = false;
  for (const parent of wallets.filter(holdsPhrase)) {
    if (!pending.size) break;
    const seed = await seedOf(parent);
    try {
      for (let i = 1; i <= MAX_DERIVED_INDEX && pending.size; i++) {
        const key = octraKeyAt(seed, i);
        const account = pending.get(key);
        if (!account) continue;
        pending.delete(key);
        const meta: EvmMeta = {
          enabled: !!evmMetaOf(parent)?.enabled,
          address: evmAddressFromSeed(seed, i),
          index: i,
          sourceWalletId: parent.id,
        };
        account.metadata = { ...account.metadata, evm: meta };
        linked = true;
      }
    } finally {
      seed.fill(0);
    }
  }
  return linked;
}

/**
 * The EVM record for `wallet` with EVM set to `enabled`, made from the phrase that owns its key.
 * An added account not linked yet is found among `wallets` first. Null when no phrase in the vault
 * makes this account. The address is derived again each time, so a stored one is never trusted.
 */
export async function evmMetaFor(
  wallet: Wallet,
  wallets: Wallet[],
  enabled: boolean
): Promise<EvmMeta | null> {
  if (!evmSourceOf(wallet, wallets) && isDerivedAccount(wallet)) {
    const copy: Wallet = { ...wallet, metadata: { ...wallet.metadata, evm: undefined } };
    const scope = wallets.map((w) => (w.id === wallet.id ? copy : w));
    if (!(await linkDerivedAccounts(scope))) return null;
    wallet = copy;
  }
  const source = evmSourceOf(wallet, wallets);
  if (!source) return null;
  const holder = wallets.find((w) => w.id === source.walletId);
  if (!holder || !holdsPhrase(holder)) return null;
  const seed = await seedOf(holder);
  try {
    const added = source.walletId !== wallet.id;
    if (added && octraKeyAt(seed, source.index) !== normalizedKey(wallet.privateKey)) return null;
    return {
      enabled,
      address: evmAddressFromSeed(seed, source.index),
      index: source.index,
      ...(added ? { sourceWalletId: source.walletId } : {}),
    };
  } finally {
    seed.fill(0);
  }
}
