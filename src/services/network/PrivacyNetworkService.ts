import { cryptoManager, CryptoManager } from '../crypto/CryptoManager';
import { logger } from 'src/utils/logger';
import {
  seedClaimBudget,
  seedClaimBudgetEmpty,
  consumeClaimSlot,
  refundClaimSlot,
  plausibleLayers,
} from '../privacy/claimBudget';
import { base64ToBytes, bytesToBase64, bytesToHex } from 'src/lib/encoding';
import { REQUIRED_COMPACT_LAYERS } from '../pvac/pvacPolicy';
import type { NetworkService } from './NetworkService';
import type { TransactionBroadcastResult, EncryptedBalanceResult } from 'src/types/network';
import type { ClaimErrorCode, ClaimRefusal } from '../privacy/claimLedger';
import type { SignedTransaction } from 'src/types/transaction';
import { txTimestamp } from 'src/utils/txTimestamp';
import {
  localTxHash,
  plainDigits,
  txSigningJson,
  withoutEmptyOptionals,
} from 'src/utils/octra/txHash';
import { FEE_CHANGED, FeeUnavailableError } from 'src/utils/octra/dappTx';
import { MAX_FEE_RAW, feeFloorFor } from './feeQuotes';
import { isSubmitVerdict } from './txOutcome';
import { rpcFetch, type RpcLane } from './rpcExchange';
import {
  bindsKey,
  proofPolicyFor,
  requireProofPolicy,
  cipherProofRoute,
} from '../pvac/proofPolicy';
import { ZeroXIOConfig } from 'src/utils/config';
import { registerSessionCache } from 'src/utils/sessionCaches';
import {
  SCOPE_CHANGED,
  TxScopeError,
  assertTxScope,
  captureTxScope,
  type NetworkPin,
  type TxScope,
} from './txScope';

// Learned per network: some nodes (mainnet today) lack the paged or by-id stealth reads.
const stealthPageMissing = new Set<string>();
const stealthByIdMissing = new Set<string>();
// webcli stealth_scan_from_epoch: a scan without a cursor reads this many recent epochs.
const ONE_SHOT_WINDOW = 50_000;
const isMethodMissing = (e: { code?: number; message?: string }) =>
  e.code === -32601 || /method not found/i.test(e.message ?? '');

export function resetStealthTransportForTests(): void {
  stealthPageMissing.clear();
  stealthByIdMissing.clear();
}

/** No verdict came back: the tx may have landed, so it is tracked by its local hash, never resent. */
function unknownOutcome(txHash: string, cause: unknown) {
  const error = cause instanceof Error ? cause.message : String(cause);
  logger.warn('[PrivacyNet] submit outcome unknown', txHash.slice(0, 16), error);
  return { success: false as const, outcomeUnknown: true as const, txHash, error };
}

export class PrivacyNetworkService {
  private _ns: NetworkService;
  private _lastCipher: string | null = null;
  // One decrypt per network + address + cipher; a cipher-only read must never mark one decrypted.
  private _decrypted: {
    scope: string;
    cipher: string;
    raw: number;
    legacy: boolean;
    at: number;
  } | null = null;
  private _inFlightEncryptedBalanceRequests: Map<string, Promise<EncryptedBalanceResult>> =
    new Map();
  private static readonly DECRYPT_CACHE_TTL = 60_000;

  constructor(networkService: NetworkService) {
    this._ns = networkService;
    // The on-chain PVAC key is per network and wallet: never carry a cached one across a switch.
    const { CURRENT_NETWORK, ACTIVE_WALLET } = ZeroXIOConfig.STORAGE.KEYS;
    try {
      chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area === 'local' && (CURRENT_NETWORK in changes || ACTIVE_WALLET in changes)) {
          this.clearPvacPubkeyCache();
        }
      });
    } catch {}
    registerSessionCache(() => this.clearPvacPubkeyCache());
  }

  clearDecryptCache(): void {
    this._lastCipher = null;
    this._decrypted = null;
  }

  /** Includes the hfhe_v1| prefix. */
  getLastCipher(): string | null {
    return this._lastCipher;
  }

  async fetchCipherOnly(
    address: string,
    privateKey: string,
    publicKey: string,
    at?: NetworkPin
  ): Promise<string | null> {
    let pubKey = publicKey;
    if (!pubKey) {
      const tempCm = new CryptoManager();
      tempCm.setPrivateKey(privateKey);
      pubKey = tempCm.getPublicKey();
      logger.debug(
        `[fetchCipherOnly] publicKey was empty - derived from privateKey: ${pubKey?.slice(0, 12)}...`
      );
    }
    const authMessage = `octra_encryptedBalance|${address}`;
    const signature = cryptoManager.signTransaction(authMessage, privateKey);
    const result = await this._ns.jsonRpcCall(
      'octra_encryptedBalance',
      [address, signature, pubKey],
      undefined,
      at
    );
    const cipher = result?.cipher;
    if (!cipher || cipher === '0') return null;
    this._lastCipher = cipher;
    return cipher;
  }

  async getEncryptedBalanceDevnet(
    address: string,
    privateKey: string,
    publicKey: string,
    at?: NetworkPin
  ): Promise<EncryptedBalanceResult> {
    const pin = at ?? (await this._ns.resolveNetwork());
    const network = pin.networkId;
    const dedupKey = `${address}_${network}`;
    const inFlight = this._inFlightEncryptedBalanceRequests.get(dedupKey);
    if (inFlight) {
      logger.debug(
        `[encBal] deduplicating getEncryptedBalanceDevnet for ${address.slice(0, 8)}… (${network})`
      );
      return inFlight;
    }
    for (const [key] of this._inFlightEncryptedBalanceRequests) {
      if (key.startsWith(`${address}_`) && key !== dedupKey) {
        logger.debug(
          `[encBal] discarding stale in-flight request from different network (${key} -> ${dedupKey})`
        );
        this._inFlightEncryptedBalanceRequests.delete(key);
      }
    }

    const promise = this._getEncryptedBalanceDevnetInternal(address, privateKey, publicKey, pin);
    this._inFlightEncryptedBalanceRequests.set(dedupKey, promise);
    try {
      return await promise;
    } finally {
      if (this._inFlightEncryptedBalanceRequests.get(dedupKey) === promise) {
        this._inFlightEncryptedBalanceRequests.delete(dedupKey);
      }
    }
  }

  private async _getEncryptedBalanceDevnetInternal(
    address: string,
    privateKey: string,
    publicKey: string,
    pin: NetworkPin
  ): Promise<EncryptedBalanceResult> {
    const t0 = Date.now();
    const scope = `${pin.networkId}:${address}`;
    let readAt = performance.now();
    logger.debug(`[encBal] getEncryptedBalanceDevnet starting for ${address.slice(0, 8)}…`);
    try {
      const authMessage = `octra_encryptedBalance|${address}`;
      const signT0 = Date.now();
      const signature = cryptoManager.signTransaction(authMessage, privateKey);
      logger.debug(`[encBal] auth signature done in ${Date.now() - signT0}ms`);

      const rpcT0 = Date.now();
      readAt = performance.now();
      const [result, balResult] = await Promise.all([
        this._ns.jsonRpcCall(
          'octra_encryptedBalance',
          [address, signature, publicKey],
          undefined,
          pin
        ),
        this._ns.jsonRpcCall('octra_balance', [address], undefined, pin),
      ]);
      logger.debug(
        `[encBal] RPC calls done in ${Date.now() - rpcT0}ms (cipher=${result?.cipher ? result.cipher.length + ' chars' : 'none'})`
      );

      const publicBalance = parseFloat(balResult?.balance || 0);
      const publicBalanceRaw = Math.round(publicBalance * 1000000);

      const cipher = result?.cipher || '0';
      let encryptedBalance = 0;
      let encryptedBalanceRaw = 0;
      let cipherCorrupted = false;
      let cipherLegacy = false;
      // A cipher we could not read is an unknown amount, not zero.
      let undecrypted = false;

      if (cipher && cipher !== '0') {
        try {
          const hit = this._decrypted;
          const cacheAge = hit ? Date.now() - hit.at : Infinity;
          if (
            hit &&
            hit.scope === scope &&
            hit.cipher === cipher &&
            cacheAge < PrivacyNetworkService.DECRYPT_CACHE_TTL
          ) {
            encryptedBalanceRaw = hit.raw;
            encryptedBalance = encryptedBalanceRaw / 1000000;
            cipherLegacy = hit.legacy;
            logger.debug(
              `[encBal] decrypt cache hit: ${encryptedBalance} OCT (age=${Math.round(cacheAge / 1000)}s)`
            );
          } else {
            const { pvacManager, MAX_BALANCE_RAW } = await import('../pvac/PvacManager');
            if (pvacManager.proofGenerationActive) {
              logger.debug('[encBal] skipping decrypt - proof generation in progress');
              return {
                success: true,
                public: publicBalance,
                publicRaw: publicBalanceRaw,
                encrypted: 0,
                encryptedRaw: 0,
                total: publicBalance,
                decryptSkipped: true,
                readAt,
              };
            } else {
              const initT0 = Date.now();
              await pvacManager.initialize(privateKey);
              logger.debug(
                `[encBal] PVAC init/check done in ${Date.now() - initT0}ms (ready=${pvacManager.isReady})`
              );
              if (pvacManager.isReady) {
                const decT0 = Date.now();
                encryptedBalanceRaw = await pvacManager.decryptAsync(cipher);
                encryptedBalance = encryptedBalanceRaw / 1000000;
                logger.info(
                  `[encBal] decrypt raw=${encryptedBalanceRaw} legacy=${pvacManager.lastDecryptLegacy} corrupted=${pvacManager.lastDecryptCorrupted} cipherLen=${cipher.length}`
                );
                if (
                  encryptedBalanceRaw < 0 ||
                  encryptedBalanceRaw > MAX_BALANCE_RAW ||
                  pvacManager.lastDecryptCorrupted
                ) {
                  logger.warn(
                    `[encBal] CORRUPTED CIPHERTEXT: raw=${encryptedBalanceRaw} exceeds sane range - likely wrong key (${Date.now() - decT0}ms)`
                  );
                  cipherCorrupted = true;
                  encryptedBalanceRaw = 0;
                  encryptedBalance = 0;
                } else {
                  // Legacy opens only with the pre-parity keys: not corruption, but private ops
                  // must pause on it.
                  cipherLegacy = pvacManager.lastDecryptLegacy;
                  this._lastCipher = cipher;
                  this._decrypted = {
                    scope,
                    cipher,
                    raw: encryptedBalanceRaw,
                    legacy: cipherLegacy,
                    at: Date.now(),
                  };
                  logger.debug(
                    `[encBal] decrypted: ${encryptedBalance} OCT${cipherLegacy ? ' (legacy cipher)' : ''} in ${Date.now() - decT0}ms`
                  );
                }
              } else {
                undecrypted = true;
                logger.warn('[encBal] PVAC still not ready after init attempt');
              }
            }
          }
        } catch (e) {
          undecrypted = true;
          logger.error('[encBal] PVAC decrypt failed:', e);
        }
      } else {
        logger.debug('[encBal] no cipher (balance=0 or not encrypted)');
      }

      logger.debug(
        `[encBal] complete: public=${publicBalance}, private=${encryptedBalance}, total=${publicBalance + encryptedBalance} OCT - ${Date.now() - t0}ms total`
      );
      return {
        success: true,
        public: publicBalance,
        publicRaw: publicBalanceRaw,
        encrypted: encryptedBalance,
        encryptedRaw: encryptedBalanceRaw,
        total: publicBalance + encryptedBalance,
        cipher: cipher !== '0' ? cipher : undefined,
        cipherCorrupted: cipherCorrupted || undefined,
        cipherLegacy: cipherLegacy || undefined,
        decryptSkipped: undecrypted || undefined,
        readAt,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[encBal] failed in ${Date.now() - t0}ms:`, message);
      return {
        success: false,
        public: 0,
        publicRaw: 0,
        encrypted: 0,
        encryptedRaw: 0,
        total: 0,
        error: message,
        readAt,
      };
    }
  }

  /** The node only accepts registration as a key_switch tx; the key applies once it confirms. */
  async registerPvacViaKeySwitch(
    address: string,
    pvacPubKeyB64: string,
    privateKey: string,
    publicKey: string | null,
    migration?: Record<string, unknown>,
    feeTier: 'recommended' | 'fast' = 'recommended',
    ou?: string,
    txScope?: TxScope,
    preparedPolicy?: number
  ): Promise<string> {
    const { signedTx, nonce, scope } = await this.signKeySwitch(
      address,
      pvacPubKeyB64,
      privateKey,
      publicKey,
      migration,
      feeTier,
      ou,
      txScope,
      preparedPolicy
    );
    const txId = crypto.randomUUID();
    const response = await chrome.runtime.sendMessage({
      type: 'QUEUE_TRANSACTION',
      transaction: {
        txId,
        opType: 'key_switch',
        type: 'broadcast_only',
        signedTransaction: signedTx,
        from: address,
        to: address,
        amount: 0,
        scope,
      },
    });
    if (!response?.success) {
      if (response?.errorType) this._ns.releaseNonce(address, nonce, scope.networkId);
      if (response?.errorType === SCOPE_CHANGED) throw new TxScopeError(response.error);
      throw new Error(response?.error || 'PVAC key registration failed');
    }
    logger.debug(
      `[registerPvacViaKeySwitch] submitted key_switch ${txId} (hash=${(response.txHash || '?').slice(0, 8)}…) for ${address.slice(0, 8)}…`
    );
    return response.txHash || txId;
  }

  async signKeySwitch(
    address: string,
    pvacPubKeyB64: string,
    privateKey: string,
    publicKey: string | null,
    migration?: Record<string, unknown>,
    feeTier: 'recommended' | 'fast' = 'recommended',
    ou?: string,
    txScope?: TxScope,
    preparedPolicy?: number
  ): Promise<{ signedTx: SignedTransaction; nonce: number; scope: TxScope }> {
    const scope = txScope ?? (await captureTxScope(address));
    if (scope.address !== address) throw new Error('Sender does not match this wallet');
    await assertTxScope(scope);
    const policy = preparedPolicy ?? (await proofPolicyFor(address, scope));
    await requireProofPolicy(policy, address, scope);
    const { pvacManager } = await import('../pvac/PvacManager');
    const aesKat = await pvacManager.computeAesKat();
    const pkHashBytes = await cryptoManager.sha256(base64ToBytes(pvacPubKeyB64));
    // webcli new_key: memo prefix, the first 8 bytes of sha256(pubkey).
    const pubkeyHashPrefix = bytesToHex(pkHashBytes).slice(0, 16);
    const nonce = await this._ns.getNextNonce(address, scope);
    const signedTx = await this.buildKeySwitchTransaction({
      from: address,
      nonce,
      privateKey,
      publicKey: publicKey ?? undefined,
      newPubkeyB64: pvacPubKeyB64,
      aesKat,
      pubkeyHashPrefix,
      migration,
      policy,
      feeTier,
      ou,
      at: scope,
    });
    return { signedTx, nonce: Number(nonce), scope };
  }

  async sourceCipherHash(cipher: string): Promise<string> {
    // webcli hashes the RPC cipher string verbatim, hfhe_v1| prefix included; any other digest
    // leaves the key_switch deferred in staging until the TTL drops it.
    const bytes = await cryptoManager.sha256(new TextEncoder().encode(cipher));
    return bytesToHex(bytes);
  }

  async buildKeyBoundMigrationPayload(
    address: string,
    privateKey: string,
    publicKey: string,
    onProgress?: (msg: string) => void,
    at?: NetworkPin
  ): Promise<{ migration: Record<string, unknown>; policy: number }> {
    const pin = at ?? (await this._ns.resolveNetwork());
    const policy = await proofPolicyFor(address, pin);
    const status = await this._ns.getPvacMigrationStatus(address, pin);
    if (cipherProofRoute(status)) {
      return {
        migration: await this._cipherProofMigration(
          address,
          privateKey,
          publicKey,
          pin,
          policy,
          onProgress
        ),
        policy,
      };
    }
    if (!status || status.can_v3_migrate !== true) {
      throw new Error(
        `The node has not opened the v3 migration for this account yet (can_v3_migrate=${status?.can_v3_migrate}).`
      );
    }
    onProgress?.('Fetching balance...');
    const cipher = await this.fetchCipherOnly(address, privateKey, publicKey, pin);
    if (!cipher) throw new Error('No encrypted balance on-chain');
    const oldPubkeyB64 = await this.getPvacPubkey(address, pin);
    if (!oldPubkeyB64) throw new Error('Registered PVAC pubkey unavailable');
    const { pvacManager } = await import('../pvac/PvacManager');
    const amount = await pvacManager.decryptAsync(cipher);
    onProgress?.('Building migration proofs (this takes a few minutes)...');
    const build = await pvacManager.buildKeyBoundMigration(
      pvacManager.getCipherBytes(cipher),
      amount,
      base64ToBytes(oldPubkeyB64),
      policy
    );
    if (!build.ok) {
      throw new Error(
        `Local migration proof verification failed (new=${build.newValid}, old=${build.oldValid}) - not submitting, no fee spent.`
      );
    }
    const migration = {
      new_cipher: build.new_cipher,
      new_zero_proof: build.new_zero_proof,
      old_zero_proof: build.old_zero_proof,
      amount_commitment: build.amount_commitment,
      source_cipher_hash: await this.sourceCipherHash(cipher),
    };
    logger.debug(
      `[migrateKeyBound] built + verified payload for ${address.slice(0, 8)}… (source ${String(migration.source_cipher_hash).slice(0, 8)}…)`
    );
    return { migration, policy };
  }

  // webcli cipher_proof mode: a balance on a historical registered key moves in the key_switch.
  private async _cipherProofMigration(
    address: string,
    privateKey: string,
    publicKey: string,
    pin: NetworkPin,
    policy: number,
    onProgress?: (msg: string) => void
  ): Promise<Record<string, unknown>> {
    onProgress?.('Fetching balance...');
    const cipher = await this.fetchCipherOnly(address, privateKey, publicKey, pin);
    if (!cipher) throw new Error('No encrypted balance on-chain');
    const oldPubkeyB64 = await this.getPvacPubkey(address, pin);
    if (!oldPubkeyB64) throw new Error('Registered PVAC pubkey unavailable');
    const { pvacManager } = await import('../pvac/PvacManager');
    const amount = await pvacManager.decryptAsync(cipher);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error('Historical balance is unreadable');
    }
    onProgress?.('Building migration proofs (this takes a few minutes)...');
    const migration = await pvacManager.buildCipherProofMigration(
      base64ToBytes(oldPubkeyB64),
      cipher,
      amount,
      policy
    );
    const latest = await this.fetchCipherOnly(address, privateKey, publicKey, pin);
    if (!latest || migration.source_cipher_hash !== (await this.sourceCipherHash(latest))) {
      throw new Error('Encrypted balance changed while building the migration. Try again.');
    }
    return { ...migration };
  }

  async submitKeyBoundMigration(
    address: string,
    privateKey: string,
    publicKey: string,
    migration: Record<string, unknown>,
    opts?: {
      feeTier?: 'recommended' | 'fast';
      ou?: string;
      onProgress?: (msg: string) => void;
      scope?: TxScope;
      policy?: number;
    }
  ): Promise<{ txHash: string }> {
    const { pvacManager } = await import('../pvac/PvacManager');
    opts?.onProgress?.('Submitting migration...');
    const localPub = await pvacManager.getPublicKeyAsync();
    const txHash = await this.registerPvacViaKeySwitch(
      address,
      localPub,
      privateKey,
      publicKey,
      migration,
      opts?.feeTier ?? 'recommended',
      opts?.ou,
      opts?.scope,
      opts?.policy
    );
    return { txHash };
  }

  private _pvacPubkeyCache: Map<string, { value: string | null; time: number }> = new Map();
  private _pvacPubkeyInFlight: Map<string, Promise<string | null>> = new Map();

  clearPvacPubkeyCache(address?: string): void {
    if (!address) {
      this._pvacPubkeyCache.clear();
      return;
    }
    for (const k of [...this._pvacPubkeyCache.keys()]) {
      if (k.endsWith(`:${address}`)) this._pvacPubkeyCache.delete(k);
    }
  }

  async getPvacPubkey(address: string, at?: NetworkPin): Promise<string | null> {
    const pin = at ?? (await this._ns.resolveNetwork());
    const key = `${pin.networkId}:${pin.rpcUrl}:${address}`;
    const cached = this._pvacPubkeyCache.get(key);
    if (cached && Date.now() - cached.time < 300000) {
      logger.debug(`[getPvacPubkey] cache hit for ${address.slice(0, 8)}… (${pin.networkId})`);
      return cached.value;
    }
    const inFlight = this._pvacPubkeyInFlight.get(key);
    if (inFlight) {
      logger.debug(`[getPvacPubkey] deduplicating for ${address.slice(0, 8)}…`);
      return inFlight;
    }
    const promise = (async () => {
      try {
        const result = await this._ns.jsonRpcCall('octra_pvacPubkey', [address], undefined, pin);
        const value = result?.pvac_pubkey || null;
        this._pvacPubkeyCache.set(key, { value, time: Date.now() });
        return value;
      } finally {
        // A transport failure propagates: an unreachable node must not read as an unregistered key.
        this._pvacPubkeyInFlight.delete(key);
      }
    })();
    this._pvacPubkeyInFlight.set(key, promise);
    return promise;
  }

  async getViewPubkey(address: string, at?: NetworkPin): Promise<string | null> {
    try {
      const result = await this._ns.jsonRpcCall('octra_viewPubkey', [address], undefined, at);
      return result?.view_pubkey || null;
    } catch (e: unknown) {
      logger.warn('[getViewPubkey] Failed:', e);
      return null;
    }
  }

  async getPrivateOutputs(startEpoch = 0, at?: NetworkPin): Promise<any[]> {
    return (await this.getStealthOutputsPaged(startEpoch, { at })).outputs;
  }

  private async _stealthRpc(
    url: string,
    method: string,
    params: unknown[],
    timeoutMs: number,
    lane: RpcLane = 'poll'
  ): Promise<{ result?: any; error?: { code?: number; message?: string } }> {
    const res = await rpcFetch(
      `${url}/rpc`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      },
      { timeoutMs, lane }
    );
    return await res.json();
  }

  async getHeadEpoch(at?: NetworkPin): Promise<number | null> {
    try {
      const url = at?.rpcUrl ?? (await this._ns.getCurrentNetworkUrl());
      const r = (await this._stealthRpc(url, 'node_status', [], 10_000)).result;
      const n = typeof r?.current_epoch === 'number' ? r.current_epoch : r?.epoch;
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  /** complete is false when anything went unread, so a cursor must not move past it. */
  async getStealthOutputsPaged(
    fromEpoch = 0,
    opts: { at?: NetworkPin; headEpoch?: number | null } = {}
  ): Promise<{ outputs: any[]; complete: boolean; fromEpoch: number }> {
    const url = opts.at?.rpcUrl ?? (await this._ns.getCurrentNetworkUrl());
    const net = opts.at?.networkId ?? (await this._ns.getCurrentNetworkId());
    if (!stealthPageMissing.has(net)) {
      const all: any[] = [];
      const MAX_PAGES = 4096;
      const t0 = Date.now();
      let before: number | null = null;
      let limit = 64;
      let missing = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        try {
          const json = await this._stealthRpc(
            url,
            'octra_stealthOutputsPage',
            [fromEpoch, before, limit],
            60_000
          );
          if (json.error) {
            if (page === 0 && isMethodMissing(json.error)) {
              missing = true;
              break;
            }
            if (json.error.code === -32013 && limit > 4) {
              limit = Math.max(4, Math.floor(limit / 2));
              page--;
              continue;
            }
            logger.warn(`[getStealthOutputs] RPC error: ${json.error.message || 'unknown'}`);
            return { outputs: all, complete: false, fromEpoch };
          }
          const r = json.result;
          const outputs: any[] = Array.isArray(r?.outputs) ? r.outputs : [];
          all.push(...outputs);
          if (!r?.has_more) {
            logger.debug(
              `[getStealthOutputs] ${all.length} outputs, ${page + 1} page(s) in ${Date.now() - t0}ms`
            );
            return { outputs: all, complete: true, fromEpoch };
          }
          const next: unknown = r.next_before_id;
          if (typeof next !== 'number' || (before != null && next >= before)) {
            logger.warn('[getStealthOutputs] page cursor missing or not moving');
            return { outputs: all, complete: false, fromEpoch };
          }
          before = next;
        } catch (e: unknown) {
          logger.warn(
            `[getStealthOutputs] page fetch failed: ${e instanceof Error ? e.message : e}`
          );
          return { outputs: all, complete: false, fromEpoch };
        }
      }
      if (!missing) {
        logger.warn(`[getStealthOutputs] hit page cap (${MAX_PAGES}), returning ${all.length}`);
        return { outputs: all, complete: false, fromEpoch };
      }
      stealthPageMissing.add(net);
    }

    let from = fromEpoch;
    if (from === 0) {
      const head = opts.headEpoch ?? (await this.getHeadEpoch(opts.at));
      if (head != null) from = Math.max(0, head - ONE_SHOT_WINDOW);
    }
    try {
      const json = await this._stealthRpc(url, 'octra_stealthOutputs', [from], 120_000);
      const outputs = json.result?.outputs;
      if (json.error || !Array.isArray(outputs))
        return { outputs: [], complete: false, fromEpoch: from };
      return { outputs, complete: true, fromEpoch: from };
    } catch (e: unknown) {
      logger.warn(
        `[getStealthOutputs] one-shot read failed: ${e instanceof Error ? e.message : e}`
      );
      return { outputs: [], complete: false, fromEpoch: from };
    }
  }

  /** Null unless every id came back: a claim must not run on a partial answer. */
  async getStealthOutputsById(
    ids: number[],
    opts: {
      at?: NetworkPin;
      minEpoch?: number;
      partial?: boolean;
      timeoutMs?: number;
      lane?: RpcLane;
    } = {}
  ): Promise<any[] | null> {
    if (ids.length === 0) return [];
    const url = opts.at?.rpcUrl ?? (await this._ns.getCurrentNetworkUrl());
    const net = opts.at?.networkId ?? (await this._ns.getCurrentNetworkId());
    const lane = opts.lane ?? 'user';
    try {
      if (!stealthByIdMissing.has(net)) {
        const json = await this._stealthRpc(
          url,
          'octra_stealthOutputsById',
          [ids],
          opts.timeoutMs ?? 30_000,
          lane
        );
        if (!json.error) {
          const r = json.result;
          if (!Array.isArray(r?.outputs)) return null;
          return r.complete === true || opts.partial ? r.outputs : null;
        }
        if (!isMethodMissing(json.error)) return null;
        stealthByIdMissing.add(net);
      }
      if (opts.minEpoch == null) return null;
      const json = await this._stealthRpc(
        url,
        'octra_stealthOutputs',
        [Math.max(0, opts.minEpoch)],
        120_000,
        lane
      );
      const outputs = json.result?.outputs;
      if (json.error || !Array.isArray(outputs)) return null;
      const want = new Set(ids);
      const found = outputs.filter((o: any) => want.has(Number(o.id)));
      return found.length === want.size || opts.partial ? found : null;
    } catch (e: unknown) {
      logger.warn(`[getStealthOutputsById] failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  async buildPrivateTransaction(params: {
    from: string;
    nonce: string | number;
    privateKey: string;
    publicKey?: string;
    privateTransferData: string;
    ou: string;
  }): Promise<SignedTransaction> {
    return this.buildHfheTransaction({
      from: params.from,
      to: 'stealth',
      amount: '0',
      nonce: params.nonce,
      privateKey: params.privateKey,
      publicKey: params.publicKey,
      opType: 'stealth',
      encryptedData: params.privateTransferData,
      ou: params.ou,
    });
  }

  async buildClaimTransaction(params: {
    from: string;
    nonce: string | number;
    privateKey: string;
    publicKey?: string;
    claimData: string;
    ou: string;
  }): Promise<SignedTransaction> {
    return this.buildHfheTransaction({
      from: params.from,
      to: params.from,
      amount: '0',
      nonce: params.nonce,
      privateKey: params.privateKey,
      publicKey: params.publicKey,
      opType: 'claim',
      encryptedData: params.claimData,
      ou: params.ou,
    });
  }

  async buildHfheTransaction(params: {
    from: string;
    to: string;
    amount: string;
    amountInOCT?: number;
    nonce: string | number;
    privateKey: string;
    publicKey?: string;
    opType: 'encrypt' | 'decrypt' | 'stealth' | 'claim' | 'key_switch';
    encryptedData: string;
    message?: string;
    ou: string;
  }): Promise<SignedTransaction> {
    logger.debug(
      `[PrivacyNet.buildHfheTransaction] opType=${params.opType}, from=${params.from.slice(0, 12)}..., to=${params.to.slice(0, 12)}..., amount=${params.amount}, nonce=${params.nonce}, encryptedData=${params.encryptedData?.length || 0} chars`
    );
    const operationalUnit = params.ou ?? '';
    if (!/^[1-9]\d*$/.test(operationalUnit)) throw new FeeUnavailableError();
    const fee = BigInt(operationalUnit);
    if (fee < BigInt(feeFloorFor(params.opType)) || fee > BigInt(MAX_FEE_RAW)) {
      throw new Error(FEE_CHANGED);
    }
    const timestamp = txTimestamp();

    const tx: any = {
      from: params.from,
      to_: params.to,
      amount: plainDigits(params.amount),
      nonce: parseInt(String(params.nonce)),
      ou: plainDigits(operationalUnit),
      timestamp: timestamp,
      op_type: params.opType,
      ...(params.encryptedData ? { encrypted_data: params.encryptedData } : {}),
    };

    if (params.message) {
      tx.message = params.message.slice(0, 1024);
    }

    const signatureData = txSigningJson(tx);
    logger.info(
      `[PrivacyNet.buildHfheTransaction] sigPayload (${signatureData.length} chars): ${signatureData.slice(0, 300)}...`
    );
    const signature = cryptoManager.signTransaction(signatureData, params.privateKey);
    logger.info(
      `[PrivacyNet.buildHfheTransaction] Signed: sig=${signature.slice(0, 24)}... ou=${operationalUnit}, timestamp=${timestamp}`
    );

    let publicKey = params.publicKey;
    if (!publicKey) {
      const tempManager = new CryptoManager();
      tempManager.setPrivateKey(params.privateKey);
      publicKey = tempManager.getPublicKey();
    }

    return withoutEmptyOptionals({
      ...tx,
      signature,
      public_key: publicKey,
    });
  }

  /** Raw micro-OCT; null when the node could not be read, so the op never runs on a guess. */
  async getKeySwitchFeeQuote(
    tier: 'recommended' | 'fast' = 'recommended',
    at?: NetworkPin
  ): Promise<string | null> {
    const quote = await this._ns.getRecommendedFeeStrict('key_switch', at);
    if (!quote) return null;
    return tier === 'fast' && quote.fast ? quote.fast : quote.recommended;
  }

  async buildKeySwitchTransaction(params: {
    from: string;
    nonce: string | number;
    privateKey: string;
    publicKey?: string;
    newPubkeyB64: string;
    aesKat: string;
    pubkeyHashPrefix: string;
    /** Merged into encrypted_data (webcli build_pvac_migration_payload). */
    migration?: Record<string, unknown>;
    policy: number;
    feeTier?: 'recommended' | 'fast';
    /** The fee already shown; a re-quote after the proof build would charge another amount. */
    ou?: string;
    at?: NetworkPin;
  }): Promise<SignedTransaction> {
    let owner = {};
    if (bindsKey(params.policy)) {
      const { pvacManager } = await import('../pvac/PvacManager');
      owner = await pvacManager.makeKeyOwnerProof(params.from, params.policy);
    }
    const encryptedData = JSON.stringify({
      new_pubkey: params.newPubkeyB64,
      aes_kat: params.aesKat,
      ...(params.migration ?? {}),
      ...owner,
    });

    const ou =
      params.ou ?? (await this.getKeySwitchFeeQuote(params.feeTier ?? 'recommended', params.at));
    if (!ou) throw new FeeUnavailableError();
    logger.debug(`[PrivacyNet.buildKeySwitchTransaction] ou=${ou}`);

    return this.buildHfheTransaction({
      from: params.from,
      to: params.from,
      amount: '0',
      nonce: params.nonce,
      privateKey: params.privateKey,
      publicKey: params.publicKey,
      opType: 'key_switch',
      encryptedData,
      message: `encryption key switch | new_key:${params.pubkeyHashPrefix}`,
      ou,
    });
  }

  async privateSpendBlocker(
    address: string,
    privateKey: string,
    at?: NetworkPin
  ): Promise<string | null> {
    try {
      const pin = at ?? (await this._ns.resolveNetwork());
      const cipher = await this.fetchCipherOnly(address, privateKey, '', pin);
      if (!cipher) return 'No private balance to send from.';
      const { pvacManager } = await import('../pvac/PvacManager');
      const bytes = pvacManager.getCipherBytes(cipher);
      const check = await pvacManager.checkBoundProvable(bytes);
      const layers = check ? check.baseLayers : await pvacManager.baseLayerCount(bytes);
      if (layers < REQUIRED_COMPACT_LAYERS) return null;
      const mig = await this._ns.getPvacMigrationStatus(address, pin);
      const isV3 = mig?.cipher_class === 'v3' || mig?.cipher_class === 'key_bound';
      const held = isV3 && mig?.can_key_switch === false && mig?.can_v3_migrate !== true;
      return held
        ? 'Private balance is awaiting the network migration. Sends resume once it completes.'
        : 'Private balance needs a migration before it can be spent. Open the 0xio extension and choose Migrate balance.';
    } catch {
      return null;
    }
  }

  async createPrivateTransfer(
    from: string,
    to: string,
    amountRaw: string | number,
    fromPrivateKey: string,
    ou: string,
    txScope?: TxScope
  ): Promise<TransactionBroadcastResult> {
    logger.debug(
      `[PrivacyNet.createPrivateTransfer] from=${from.slice(0, 12)}..., to=${to.slice(0, 12)}..., amountRaw=${amountRaw}, ou=${ou}`
    );
    try {
      const scope = txScope ?? (await captureTxScope(from));
      if (scope.address !== from) throw new Error('Sender does not match this wallet');
      await assertTxScope(scope);
      const [{ buildStealthSendPayload }, { pvacManager }] = await Promise.all([
        import('../privacy/stealthSend'),
        import('../pvac/PvacManager'),
      ]);
      const policy = await proofPolicyFor(from, scope);
      await pvacManager.ensureOffscreenReady(fromPrivateKey);
      const signer = new CryptoManager();
      signer.setPrivateKey(fromPrivateKey);
      const privateTransferData = await buildStealthSendPayload({
        from,
        to,
        privateKey: fromPrivateKey,
        publicKey: signer.getPublicKey() ?? '',
        amountRaw: Number(amountRaw),
        scope,
        policy,
      });
      // The proof takes minutes: recheck scope and policy before submit.
      await assertTxScope(scope);
      await requireProofPolicy(policy, from, scope);
      const pendingTx = await this._ns.storePendingTransaction({
        from,
        to,
        amount: 0,
        message: 'PRIVATE_TRANSFER',
        timestamp: Date.now(),
        type: 'outgoing',
        opType: 'stealth',
        confirmed: false,
        pending: true,
        network: scope.networkId,
      });

      const nonce = await this._ns.getNextNonce(from, scope);
      const signedTx = await this.buildPrivateTransaction({
        from,
        nonce,
        privateKey: fromPrivateKey,
        privateTransferData,
        ou,
      });

      const local = localTxHash(signedTx);
      let result: any;
      try {
        result = await this._ns.jsonRpcCall('octra_submit', [signedTx], undefined, scope);
      } catch (e: unknown) {
        if (!isSubmitVerdict(e) && local) return unknownOutcome(local, e);
        throw e;
      }

      if (result.tx_hash || result.hash) {
        const txHash = result.tx_hash || result.hash;
        if (pendingTx) {
          await this._ns.updatePendingTransaction(txHash, {
            hash: txHash,
            txId: pendingTx.txId,
          });
        }
        return { success: true, txHash };
      } else if (result.status === 'rejected') {
        this._ns.releaseNonce(from, nonce, scope.networkId);
        throw new Error(result.error?.reason || 'Transfer rejected');
      }
      if (local) return unknownOutcome(local, 'The node returned no transaction hash');

      throw new Error('Transfer failed');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async getPendingPrivateTransfers(
    address: string,
    privateKey: string,
    opts: { pin?: NetworkPin; prepare?: () => Promise<void> } = {}
  ): Promise<{ success: boolean; transfers: any[]; error?: string }> {
    if (!privateKey) return { success: false, transfers: [], error: 'Private key not available' };
    try {
      const pin = opts.pin ?? (await captureTxScope(address));
      const [{ scanWaiting }, { pvacManager }] = await Promise.all([
        import('../privacy/stealthWaiting'),
        import('../pvac/PvacManager'),
      ]);
      const outputs = await scanWaiting({
        address,
        privateKey,
        pin,
        stillHere: () => true,
        prepare: opts.prepare ?? (() => pvacManager.ensureOffscreenReady(privateKey)),
      });
      return {
        success: true,
        transfers: (outputs ?? []).map((o) => ({
          id: String(o.id),
          amount: o.amount,
          epoch: o.epoch,
          canClaim: true,
        })),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[PrivacyNet.getPendingPrivateTransfers] Error:`, error);
      return { success: false, transfers: [], error: message };
    }
  }

  async claimableAmount(
    address: string,
    privateKey: string | null,
    transferId: string,
    pin: NetworkPin
  ): Promise<
    | { ok: true; amount: number }
    | { ok: false; locked?: boolean; error: string; code?: ClaimErrorCode }
  > {
    const outputId = Number(transferId);
    if (!/^\d{1,15}$/.test(transferId) || !Number.isSafeInteger(outputId)) {
      return { ok: false, error: 'Unknown transfer' };
    }
    const [{ freshStealthOutput }, { scanState, scopeKey }, { pvacManager }] = await Promise.all([
      import('../privacy/stealthWaiting'),
      import('../privacy/stealthScan'),
      import('../pvac/PvacManager'),
    ]);
    const known = scanState(scopeKey(pin.networkId, address))?.outputs.find(
      (o) => o.id === outputId
    );
    if (known) return { ok: true, amount: known.amount };
    if (!privateKey) {
      return { ok: false, locked: true, error: 'Unlock the 0xio extension to review this claim.' };
    }
    try {
      const fresh = await freshStealthOutput({
        id: outputId,
        privateKey,
        pin,
        prepare: () => pvacManager.ensureOffscreenReady(privateKey),
      });
      if (!fresh || fresh.kind === 'claimed') {
        const { claimOutputRefusal } = await import('../privacy/claimLedger');
        const { error, code } = claimOutputRefusal(fresh ? 'spent' : 'unknown');
        return { ok: false, error, code };
      }
      if (fresh.kind !== 'ready') {
        return { ok: false, error: `This transfer cannot be claimed (${fresh.reason})` };
      }
      return { ok: true, amount: fresh.output.amount };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async _claimEpoch(networkId: string, address: string, outputId: number) {
    const { scanState, scopeKey } = await import('../privacy/stealthScan');
    const known = scanState(scopeKey(networkId, address));
    return (
      known?.outputs.find((o) => o.id === outputId)?.epoch ??
      known?.restore.find((r) => r.id === outputId)?.epoch
    );
  }

  async earlierClaim(
    address: string,
    transferId: string,
    scope: TxScope
  ): Promise<{ txHash: string } | ClaimRefusal | null> {
    const outputId = Number(transferId);
    if (!/^\d{1,15}$/.test(transferId) || !Number.isSafeInteger(outputId)) return null;
    const ledger = await import('../privacy/claimLedger');
    const epoch = await this._claimEpoch(scope.networkId, address, outputId);
    try {
      const slot = await ledger.claimSlotFor(scope, address, outputId, epoch);
      if (slot.kind === 'blocked') return ledger.CLAIM_CONFLICT_REFUSAL;
      if (slot.kind === 'previous') return { txHash: slot.row.hash };
    } catch (e: unknown) {
      const code = ledger.claimFaultCode(e);
      if (code) return { success: false, error: e instanceof Error ? e.message : String(e), code };
    }
    return null;
  }

  /** webcli /api/stealth/claim: the output is read fresh by id before the v5 claim proof. */
  async claimPrivateTransfer(
    address: string,
    privateKey: string,
    transferId: string,
    ou: string,
    txScope?: TxScope,
    prepare?: () => Promise<void>
  ): Promise<TransactionBroadcastResult & { amount?: number; code?: ClaimErrorCode }> {
    logger.debug(
      `[PrivacyNet.claimPrivateTransfer] address=${address.slice(0, 12)}..., transferId=${transferId}`
    );
    const outputId = Number(transferId);
    if (!/^\d{1,15}$/.test(transferId) || !Number.isSafeInteger(outputId)) {
      return { success: false, error: 'Unknown transfer' };
    }
    let scope: TxScope;
    try {
      scope = txScope ?? (await captureTxScope(address));
      if (scope.address !== address) throw new Error('Sender does not match this wallet');
      await assertTxScope(scope);
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const net = scope.networkId;
    const [{ freshStealthOutput }, { scopeKey }, { pvacManager }, ledger] = await Promise.all([
      import('../privacy/stealthWaiting'),
      import('../privacy/stealthScan'),
      import('../pvac/PvacManager'),
      import('../privacy/claimLedger'),
    ]);
    const failed = (e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      const code = ledger.claimFaultCode(e);
      return { success: false as const, error: error || 'Claim failed', ...(code ? { code } : {}) };
    };
    const ready = prepare ?? (() => pvacManager.ensureOffscreenReady(privateKey));
    const scanScopeKey = scopeKey(net, address);
    const epoch = await this._claimEpoch(net, address, outputId);
    let slot: import('../privacy/claimLedger').ClaimSlot;
    try {
      slot = await ledger.claimSlotFor(scope, address, outputId, epoch);
    } catch (e: unknown) {
      return failed(e);
    }
    if (slot.kind === 'blocked') return ledger.CLAIM_CONFLICT_REFUSAL;
    if (slot.kind === 'previous') return { success: true, txHash: slot.row.hash };
    if (slot.kind === 'recovery' && slot.row.tx) {
      const resend = await ledger.claimResendFor(scope, address, slot.row, ou, epoch);
      if (resend === 'spent' || resend === 'unreadable') {
        return ledger.claimOutputRefusal(resend === 'spent' ? 'spent' : 'unknown');
      }
      if (resend === 'resend') return this._sendClaim(scope, outputId, slot.row.tx, null);
    }
    let output: import('../privacy/stealthScan').MatchedStealthOutput;
    try {
      const fresh = await freshStealthOutput({
        id: outputId,
        epoch,
        privateKey,
        pin: scope,
        prepare: ready,
      });
      if (!fresh) return ledger.claimOutputRefusal('unknown');
      if (fresh.kind === 'claimed') {
        (await import('../privacy/stealthScan')).dropFromScope(scanScopeKey, [outputId]);
        return ledger.claimOutputRefusal('spent');
      }
      if (fresh.kind !== 'ready') {
        return { success: false, error: `This transfer cannot be claimed (${fresh.reason})` };
      }
      output = fresh.output;
    } catch (e: unknown) {
      return failed(e);
    }
    // Each claim adds two base layers; past six even the compact is unprovable and the balance
    // is lost. Shares the popup's in-flight counter.
    try {
      const cipher = await this.fetchCipherOnly(address, privateKey, '', scope);
      if (cipher) {
        const { pvacManager } = await import('../pvac/PvacManager');
        const bytes = pvacManager.getCipherBytes(cipher);
        const check = await pvacManager.checkBoundProvable(bytes);
        const layers = check ? check.baseLayers : await pvacManager.baseLayerCount(bytes);
        if (!plausibleLayers(layers)) {
          return {
            success: false,
            error: 'Balance state unreadable - claim blocked to protect the balance',
          };
        }
        await seedClaimBudget(address, cipher, layers, net);
      } else {
        await seedClaimBudgetEmpty(address, net);
      }
    } catch {}
    try {
      const policy = await proofPolicyFor(address, scope);
      const { cipherBytes, commitmentBytes } = await pvacManager.encryptRawAsync(output.amount);
      const zeroProof = await pvacManager.makeBoundProof(
        cipherBytes,
        output.amount,
        output.blinding,
        policy
      );
      const claimData = JSON.stringify({
        version: 5,
        output_id: output.id,
        claim_cipher: pvacManager.encodeCipher(cipherBytes),
        commitment: bytesToBase64(commitmentBytes),
        claim_secret: output.claimSecret,
        zero_proof: zeroProof,
      });
      await requireProofPolicy(policy, address, scope);
      const state = await ledger.readClaimOutput(scope, outputId, epoch);
      if (state !== 'unspent') return ledger.claimOutputRefusal(state);
      const nonce = await this._ns.getNextNonce(address, scope);
      const signedTx = await this.buildClaimTransaction({
        from: address,
        nonce,
        privateKey,
        claimData,
        ou,
      });

      // Consumed at broadcast so a nonce or build failure never burns a slot.
      if (!(await consumeClaimSlot(address, net))) {
        return { success: false, error: 'Compact your balance first, then claim' };
      }
      const sent = await this._sendClaim(scope, outputId, signedTx, nonce);
      return sent.success ? { ...sent, amount: output.amount } : sent;
    } catch (error: unknown) {
      logger.error(`[PrivacyNet.claimPrivateTransfer] Error:`, error);
      return failed(error);
    }
  }

  /** `nonce` is null for a saved claim sent again: its slot and nonce were spent the first time. */
  private async _sendClaim(
    scope: TxScope,
    outputId: number,
    signedTx: SignedTransaction,
    nonce: number | null
  ): Promise<TransactionBroadcastResult & { code?: ClaimErrorCode }> {
    const address = scope.address;
    const net = scope.networkId;
    const [{ noteClaimSent, noteClaimOutcome, claimFaultCode }, { scopeKey, dropFromScope }] =
      await Promise.all([import('../privacy/claimLedger'), import('../privacy/stealthScan')]);
    const giveBack = async () => {
      if (nonce === null) return;
      await refundClaimSlot(address, net);
      this._ns.releaseNonce(address, nonce, net);
    };
    try {
      const local = await noteClaimSent(scope, address, outputId, signedTx);
      let result: any;
      try {
        result = await this._ns.jsonRpcCall('octra_submit', [signedTx], undefined, scope);
      } catch (e: unknown) {
        // Refused before any node saw it: the slot and nonce are free again.
        if (e instanceof TxScopeError) await giveBack();
        if (!isSubmitVerdict(e) && local) return unknownOutcome(local, e);
        if (local) await noteClaimOutcome(scope, address, outputId, local, 'rejected');
        throw e;
      }

      if (result.tx_hash || result.hash) {
        const txHash = result.tx_hash || result.hash;
        logger.debug(`[PrivacyNet.claimPrivateTransfer] Claimed successfully: txHash=${txHash}`);
        if (local) await noteClaimOutcome(scope, address, outputId, local, 'pending');
        dropFromScope(scopeKey(net, address), [outputId]);
        return { success: true, txHash, message: 'Private transfer claimed successfully' };
      } else if (result.status === 'rejected') {
        await giveBack(); // a node rejection is final: the cipher will not grow
        if (local) await noteClaimOutcome(scope, address, outputId, local, 'rejected');
        const reason = result.error?.reason || result.error?.message || 'Claim rejected';
        logger.error(`[PrivacyNet.claimPrivateTransfer] Claim rejected: ${reason}`);
        return { success: false, error: reason };
      }

      if (local) return unknownOutcome(local, 'The node returned no transaction hash');
      return { success: false, error: 'Claim failed - no tx_hash in response' };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[PrivacyNet.claimPrivateTransfer] Error:`, error);
      const code = claimFaultCode(error);
      return { success: false, error: message || 'Claim failed', ...(code ? { code } : {}) };
    }
  }
}
