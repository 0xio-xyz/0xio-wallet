import { secp256k1 } from '@noble/curves/secp256k1.js';
import { passwordManager } from '../crypto/PasswordManager';
import { walletStorage } from '../wallet/WalletStorage';
import { logger } from '../../utils/logger';
import { evmAddressFromPublicKey } from './accounts';
import type { EvmNetwork } from './networks';
import type { RpcOptions } from './rpc';
import { broadcastOutcome } from './rpcErrors';
import { broadcast, estimateFees, estimateGas, getNonce, type PreparedTransfer } from './send';
import { deriveEvmPrivateKey, isEvmAddress, signEvmTx, type Eip1559Tx } from './tx';

export interface SubmittedTx {
  /** Computed from the signed bytes, never taken from the node. */
  hash: string;
  nonce: number;
  raw: string;
  acknowledged: boolean;
}
import { evmSourceOf, phraseWords } from './walletEvm';

/**
 * Runs `fn` with the wallet's EVM private key, derived from the phrase only for this call and
 * wiped after. An account added from a phrase wallet uses that wallet's phrase. The key must
 * produce the address the wallet shows, or nothing is signed.
 */
export async function withEvmKey<T>(
  walletId: string,
  index: number,
  expectedAddress: string,
  fn: (privateKey: Uint8Array) => Promise<T> | T
): Promise<T> {
  const sessionKey = await passwordManager.getSessionKey();
  if (!sessionKey) throw new Error('Wallet locked');
  const wallets = await walletStorage.loadVault(sessionKey);
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet) throw new Error('Wallet not found in vault');
  const source = evmSourceOf(wallet, wallets);
  const holder = source && wallets.find((w) => w.id === source.walletId);
  const words = phraseWords(holder?.mnemonic);
  if (words.length === 0) throw new Error('This wallet has no recovery phrase for EVM');
  const key = await deriveEvmPrivateKey(words, index);
  try {
    const address = evmAddressFromPublicKey(secp256k1.getPublicKey(key, true));
    if (address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error('The signing key does not match this wallet');
    }
    return await fn(key);
  } finally {
    key.fill(0);
  }
}

export async function prepareCall(
  network: EvmNetwork,
  call: { from: string; to: string; value?: bigint; data: string; gasLimit?: bigint },
  opts?: RpcOptions
): Promise<PreparedTransfer> {
  if (!isEvmAddress(call.from) || !isEvmAddress(call.to)) throw new Error('Invalid address');
  const value = call.value ?? 0n;
  const [nonce, fees, gasLimit] = await Promise.all([
    getNonce(network, call.from, opts),
    estimateFees(network, opts),
    call.gasLimit ??
      estimateGas(network, { from: call.from, to: call.to, value, data: call.data }, opts),
  ]);
  const tx: Eip1559Tx = {
    chainId: network.chainId,
    nonce,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
    gasLimit,
    to: call.to,
    value,
    data: call.data,
    ...(fees.legacy ? { legacy: true as const } : {}),
  };
  const feeWei = gasLimit * fees.maxFeePerGas;
  return { tx, feeWei, totalNative: value + feeWei, fees };
}

/**
 * Signs a reviewed transaction and hands it to the RPC. Throws only when nothing left the wallet
 * or the node refused this transaction; any other failure after the hand-off returns the local
 * hash, so the caller follows it instead of signing again.
 */
export async function signAndSubmit(
  network: EvmNetwork,
  tx: Eip1559Tx,
  wallet: { id: string; evmIndex: number; evmAddress: string }
): Promise<SubmittedTx> {
  if (tx.chainId !== network.chainId) throw new Error('Transaction is for another network');
  const signed = await withEvmKey(wallet.id, wallet.evmIndex, wallet.evmAddress, (key) =>
    signEvmTx(tx, key)
  );
  const local = { hash: signed.hash, nonce: tx.nonce, raw: signed.raw };
  try {
    const remote = await broadcast(network, signed.raw);
    if (remote.toLowerCase() !== signed.hash.toLowerCase()) {
      logger.warn('[EvmSigner] node returned another hash, following the local one', {
        local: signed.hash,
        remote,
      });
    }
    return { ...local, acknowledged: true };
  } catch (e) {
    if (broadcastOutcome(e) === 'rejected') throw e;
    logger.warn('[EvmSigner] no clear answer to the broadcast, following the local hash', e);
    return { ...local, acknowledged: false };
  }
}

export async function signAndBroadcast(
  network: EvmNetwork,
  tx: Eip1559Tx,
  wallet: { id: string; evmIndex: number; evmAddress: string }
): Promise<string> {
  return (await signAndSubmit(network, tx, wallet)).hash;
}
