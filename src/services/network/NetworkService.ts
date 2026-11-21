import { ZeroXIOConfig, NetworkId } from 'src/utils/config';
import { networkCapabilities, getNetworkConfig } from 'src/utils/network';
import { historyReadNetworks, isNotFoundError, isDeadStatus } from '../wallet/historyRows';
import { logger } from 'src/utils/logger';
import { cryptoManager, CryptoManager } from '../crypto/CryptoManager';
import { NonceManager, noteNonceUsed } from './NonceManager';
import { PrivacyNetworkService } from './PrivacyNetworkService';
import { enrichTokenTransfers, type TransferDeps } from '../tokens/tokenTransfers';
import { readAllTokensByAddress } from '../tokens/tokensByAddress';
import type {
  BalanceResult,
  TransactionBroadcastResult,
  TransactionStatusResult,
  BatchTransactionResult,
  BatchTransactionResultItem,
} from 'src/types/network';
import type {
  SignedTransaction,
  TransactionHistoryItem,
  PendingTransaction,
} from 'src/types/transaction';
import { txTimestamp } from 'src/utils/txTimestamp';
import { FeeUnavailableError } from 'src/utils/octra/dappTx';
import { isOctAddress } from 'src/utils/octra/address';
import { toUnits } from 'src/utils/amount';
import { registerSessionCache } from 'src/utils/sessionCaches';
import { MEMO_MAX_BYTES, memoBytes } from 'src/utils/octra/memo';
import {
  assertTxScope,
  captureTxScope,
  isTxScope,
  onPinnedNetwork,
  resolveNetworkPin,
  rpcUrlFor,
  storedNetworkId,
  TxScopeError,
  type NetworkPin,
  type TxScope,
} from './txScope';
import {
  RESEND_BACKOFF_MS,
  RpcHttpError,
  RpcResponseError,
  SUBMIT_ATTEMPTS,
  SUBMIT_REFUSAL_TEXT,
  TxOutcomeUnknownError,
  TxSubmitError,
  submitRefusal,
  submitRefusalOf,
} from './txOutcome';
import {
  localTxHash,
  plainDigits,
  trackedTxHash,
  txSigningJson,
  withoutEmptyOptionals,
} from 'src/utils/octra/txHash';
import { FEE_READ_MS, createFeeQuotes, type FeeQuote, type FeeRead } from './feeQuotes';
import {
  linkOf,
  retryAfterSeconds,
  rpcCondition,
  rpcExchange,
  rpcFetch,
  RpcUnsentError,
  rpcWrite,
  type RpcLane,
  type RpcLink,
  type RpcReply,
} from './rpcExchange';

interface BackgroundResponse {
  success: boolean;
  status?: number;
  text?: string;
  json?: any;
  error?: string;
  data?: any;
  retryAfter?: number | null;
}

export interface RpcCallOptions {
  timeoutMs?: number;
  lane?: RpcLane;
}

interface TxBuildParams {
  from: string;
  to: string;
  amount: string;
  amountInOCT?: number;
  nonce: string | number;
  privateKey: string;
  publicKey?: string;
  message?: string;
  ou: string;
}

interface SendTxParams {
  from: string;
  to: string;
  amount: number | string;
  privateKey: string;
  publicKey?: string;
  message?: string;
  ou: string;
  scope?: TxScope;
}

/** A node nonce the webcli accepts: a whole JSON number from 0 below 2^31 - 1, else null. */
export const rpcNonce = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2147483647 ? v : null;

const isPositiveOu = (ou: unknown): ou is string =>
  typeof ou === 'string' && /^\d+$/.test(ou) && BigInt(ou) > 0n;

interface BalanceCacheEntry {
  balance: number;
  nonce: number;
  timestamp: number;
}

// Idempotent reads whose first try is cut short. Never a submit: a timed-out request is not
// cancelled, so a second try could submit twice.
const FAILOVER_TIMEOUT_METHODS = new Set([
  'octra_tokensByAddress',
  'octra_contractAbi',
  'contract_call',
  'circle_asset',
  'octra_balance',
  'octra_account',
  'octra_transaction',
  'octra_transactionsByAddress',
]);

const SUBMIT_METHODS = new Set(['octra_submit', 'octra_submitBatch']);

export type DetectedChain = 'mainnet' | 'devnet' | 'unknown';

type TokenRow = {
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
};

async function accountFingerprint(rpcBase: string, address: string): Promise<string | null> {
  try {
    const res = await rpcFetch(
      `${rpcBase}/rpc`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'octra_balance', params: [address], id: 1 }),
      },
      { timeoutMs: 12_000 }
    );
    const data = await res.json();
    const r = data?.result;
    if (!r) return null;
    return `${r.nonce ?? '?'}|${r.balance_raw ?? r.balance ?? '?'}|${r.has_public_key ?? '?'}`;
  } catch {
    return null;
  }
}

// Octra has no chain id, so match the user's own account against the known chains. An unused
// address looks the same everywhere and reads as unknown.
export async function detectChain(rpcBase: string, address: string): Promise<DetectedChain> {
  if (!address) return 'unknown';
  const [custom, main, dev] = await Promise.all([
    accountFingerprint(rpcBase, address),
    accountFingerprint(ZeroXIOConfig.NETWORKS.mainnet.rpc_url, address),
    accountFingerprint(ZeroXIOConfig.NETWORKS.devnet.rpc_url, address),
  ]);
  if (!custom) return 'unknown';
  if (/^0\|(0|\?)\|/.test(custom)) return 'unknown';
  if (custom === main) return 'mainnet';
  if (custom === dev) return 'devnet';
  return 'unknown';
}

export function pendingTxInScope(
  tx: Partial<PendingTransaction> | undefined,
  address: string,
  networks: readonly string[]
): boolean {
  if (!tx) return false;
  if ((tx.from || '').toLowerCase() !== address.toLowerCase()) return false;
  if (tx.network) return networks.includes(tx.network);
  return networks.includes('mainnet') || networks.includes('devnet');
}

export function mapHistoryTx(
  tx: any,
  status: 'success' | 'failed',
  address: string,
  networkId: NetworkId
): TransactionHistoryItem {
  const addrLower = address.toLowerCase();
  const hash = tx.hash || '';
  const from = tx.from || '';
  const to = tx.to || '';
  const amount = parseInt(tx.amount || '0') / 1000000;
  let timestamp = tx.timestamp || Date.now();
  if (timestamp < 100000000000) timestamp *= 1000;
  const isStealth = to === 'stealth';
  const isIncoming =
    !isStealth && to.toLowerCase() === addrLower && from.toLowerCase() !== addrLower;

  let token_transfer: TransactionHistoryItem['token_transfer'] = undefined;
  if (tx.op_type === 'call' && typeof tx.encrypted_data === 'string') {
    const parts = tx.encrypted_data.split('|');
    if (parts[0] === 'transfer' && parts.length >= 4) {
      token_transfer = {
        contract_address: to,
        recipient: parts[1],
        raw_amount: parts[2],
        decimals: parseInt(parts[3]) || 0,
        symbol: parts[4] || '',
      };
    }
  }

  return {
    hash,
    timestamp,
    type: isIncoming ? 'incoming' : 'outgoing',
    amount,
    from,
    to,
    address: token_transfer ? token_transfer.recipient : isIncoming ? from : to,
    nonce: tx.nonce ? parseInt(tx.nonce) : 0,
    epoch: tx.epoch || 0,
    confirmed: status === 'success',
    status,
    finality: status === 'failed' ? 'rejected' : 'confirmed',
    source: 'indexer',
    message: tx.message || null,
    opType: tx.op_type && tx.op_type !== 'standard' ? tx.op_type : undefined,
    token_transfer,
    network: networkId,
    ou: tx.ou != null && /^\d+$/.test(String(tx.ou)) ? String(tx.ou) : undefined,
  };
}

const MESSAGE_TIMEOUT = 'ExtensionMessageTimeout';
const QUEUE_REPLY_MS = 120_000;

export interface PvacMigrationStatus {
  address?: string;
  proof_math?: string;
  proof_key?: boolean;
  cipher_proof_rule?: string;
  cipher_format?: string;
  cipher_class?: string;
  key_class?: string;
  can_key_switch?: boolean;
  can_v3_migrate?: boolean;
  /** Devnet routes with no client support yet (webcli has none): never read as open. */
  can_owner_proof_migrate?: boolean;
  can_cipher_proof_migrate?: boolean;
  migration_route?: string;
  needs_legacy_public_replay?: boolean;
  reason?: string;
  legacy_public_replay?: {
    audit_class?: string;
    can_public_migrate?: boolean;
    public_net?: string | number | null;
    public_net_raw?: string | null;
    commitment_net?: string | null;
    reason?: string;
  };
}

export type PvacMigrationRead =
  | { kind: 'ok'; status: PvacMigrationStatus }
  | { kind: 'unsupported' }
  | { kind: 'failed'; error: string };

const migrationStatusUnsupported = new Set<string>();

export function resetMigrationStatusSupportForTests(): void {
  migrationStatusUnsupported.clear();
}

const PROXY_FEE_READ_MS = 15_000;

let submitRetrySleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function setSubmitRetrySleepForTests(sleep: (ms: number) => Promise<void>): void {
  submitRetrySleep = sleep;
}

const rpcErrorOf = (json: unknown): { message?: string; code?: unknown } | null => {
  const data = typeof json === 'string' ? safeJson(json) : json;
  const err = (data as { error?: unknown } | null)?.error;
  return err && typeof err === 'object' ? (err as { message?: string; code?: unknown }) : null;
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function withTrackedHash(result: any, local: string | null): any {
  if (!result || typeof result !== 'object') return result;
  const node = result.tx_hash || result.hash;
  if (node) {
    const hash = trackedTxHash(node, local);
    return { ...result, tx_hash: hash, ...(result.hash ? { hash } : {}) };
  }
  const refused = result.error || result.status === 'rejected' || result.status === 'dropped';
  return !refused && local ? { ...result, tx_hash: local } : result;
}

let feeRetrySleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function setFeeRetrySleepForTests(sleep: (ms: number) => Promise<void>): void {
  feeRetrySleep = sleep;
}

export class NetworkService {
  requestTimeout: number;
  balanceCache: Map<string, BalanceCacheEntry>;
  cacheTTL: number;
  rpcGapFilledHashes: Set<string>;
  private _nonceManager!: NonceManager;
  txDetailCache: Map<string, TransactionHistoryItem> = new Map();
  private _historyInFlight: Map<string, Promise<TransactionHistoryItem[]>> = new Map();
  private _historyCache: Map<string, { data: TransactionHistoryItem[]; ts: number }> = new Map();
  private _historyCacheTTL = 10_000;
  // Opt-in: only an explicit true routes calls through the proxy, and it is never a fallback.
  private _proxyEnabled = false;
  private _slowSince = 0;

  private _tokensCache = new Map<string, { ts: number; rows: Promise<TokenRow[]> }>();

  private readonly _fees = createFeeQuotes({
    call: (op, pin, timeoutMs) =>
      this.jsonRpcCall('octra_recommendedFee', [op], undefined, pin, {
        timeoutMs: this._proxyEnabled ? Math.max(timeoutMs, PROXY_FEE_READ_MS) : timeoutMs,
      }),
    sleep: (ms) => feeRetrySleep(ms),
  });

  constructor() {
    this.requestTimeout = ZeroXIOConfig.REQUEST_TIMEOUT;
    this.balanceCache = new Map();
    this.cacheTTL = ZeroXIOConfig.WALLET.BALANCE_CACHE_TTL;
    this.rpcGapFilledHashes = new Set();
    this._nonceManager = new NonceManager(this);
    void this._initProxyFlag();
    registerSessionCache(() => {
      this.balanceCache.clear();
      this._tokensCache.clear();
    });
  }

  isNetworkSlow(): boolean {
    return this._slowSince > 0 && Date.now() - this._slowSince < 30_000;
  }

  private async _initProxyFlag(): Promise<void> {
    try {
      const r = await chrome.storage.local.get('0xio_rpc_proxy');
      this._proxyEnabled = r['0xio_rpc_proxy'] === true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if ('0xio_rpc_proxy' in changes) {
          this._proxyEnabled = changes['0xio_rpc_proxy'].newValue === true;
          logger.debug(`[rpc] proxy ${this._proxyEnabled ? 'enabled' : 'disabled'}`);
        }
        if (ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK in changes) {
          this._slowSince = 0;
          logger.debug('[rpc] network changed -> cleared "slow" flag');
        }
      });
    } catch {}
  }

  async _sendExtensionMessage(message: any, timeout = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
      let isSettled = false;
      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          const err = new Error('Request timed out - Please reload the extension');
          err.name = MESSAGE_TIMEOUT;
          reject(err);
        }
      }, timeout);

      try {
        chrome.runtime.sendMessage(message, (response: any) => {
          if (isSettled) return;
          clearTimeout(timer);
          isSettled = true;

          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } catch (e: unknown) {
        if (!isSettled) {
          clearTimeout(timer);
          isSettled = true;
          reject(e);
        }
      }
    });
  }

  async makeBackgroundRequest(
    url: string,
    method: string,
    headers?: Record<string, string>,
    body?: any,
    quiet = false,
    // 0 = no timeout. A dead node holds the socket until the OS TCP timeout (~20 min), so the fetch
    // must be aborted, not just raced.
    timeoutMs = 0
  ): Promise<BackgroundResponse> {
    const t0 = Date.now();
    const directFetch = async (): Promise<BackgroundResponse> => {
      const ft0 = Date.now();
      const controller = timeoutMs > 0 ? new AbortController() : undefined;
      const abortTimer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      try {
        const options: RequestInit = {
          method: method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
        };
        if (body && method !== 'GET') {
          options.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        if (controller) options.signal = controller.signal;
        const res = await fetch(url, options);
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_e: unknown) {}

        logger.debug(
          `[net] directFetch ${method} ${url.slice(-30)} -> ${res.status} (${text.length}B) in ${Date.now() - ft0}ms`
        );
        return {
          success: res.ok,
          status: res.status,
          text,
          json,
          retryAfter: retryAfterSeconds(res.headers?.get?.('Retry-After')),
        };
      } catch (err: unknown) {
        const aborted = (err as { name?: string })?.name === 'AbortError';
        const message = aborted
          ? `aborted after ${timeoutMs}ms (node unreachable)`
          : err instanceof Error
            ? err.message
            : String(err);
        logger.error(`[net] directFetch ${method} FAILED in ${Date.now() - ft0}ms:`, message);
        throw Object.assign(new Error(`Direct fetch failed: ${message}`), { link: linkOf(err) });
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
      }
    };

    const isBackground =
      typeof self !== 'undefined' &&
      (self as any).ServiceWorkerGlobalScope &&
      self instanceof (self as any).ServiceWorkerGlobalScope;

    const isExtensionContext = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

    if (isBackground || isExtensionContext) {
      return directFetch();
    }

    try {
      const response = await this._sendExtensionMessage({
        type: 'NETWORK_REQUEST',
        url,
        method,
        headers,
        body,
      });
      if (!quiet) logger.debug(`[net] bgRequest ${url.slice(-30)} via SW in ${Date.now() - t0}ms`);
      return response || { success: false, error: 'No response from background' };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[net] SW unreachable (${Date.now() - t0}ms), falling back to directFetch:`,
        errorMessage
      );
      try {
        return await directFetch();
      } catch (fallbackError: unknown) {
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(errorMessage + ' AND ' + fallbackMessage);
      }
    }
  }

  async jsonRpcCall(
    method: string,
    params: any[] = [],
    quietOverride?: boolean,
    at?: NetworkPin,
    opts?: RpcCallOptions
  ): Promise<any> {
    if (opts?.timeoutMs !== undefined && SUBMIT_METHODS.has(method))
      throw new Error(`${method} cannot be cut short`);
    if (SUBMIT_METHODS.has(method)) {
      if (!isTxScope(at))
        throw new Error(`${method} needs the scope the transaction was signed under`);
      await assertTxScope(at);
      return this._submit(method, params, quietOverride, at);
    }
    return this._rpc(method, params, quietOverride, at, opts);
  }

  /**
   * Re-sends the same bytes (three tries in all) only when the node says they may go again (107, 110,
   * 117, -32005); a refusal comes back as TxSubmitError and is never re-signed.
   */
  private async _submit(
    method: string,
    params: any[],
    quietOverride: boolean | undefined,
    scope: TxScope
  ) {
    const batch = method === 'octra_submitBatch';
    const tx = (batch ? params[0]?.[0] : params[0]) ?? {};
    const local = batch ? null : localTxHash(tx);
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this._rpc(method, params, quietOverride, scope);
        return batch ? result : withTrackedHash(result, local);
      } catch (e) {
        if (e instanceof RpcUnsentError) {
          throw new TxSubmitError('not_accepted', e.message, null, e.fault);
        }
        const refusal = submitRefusalOf(e);
        if (!refusal) throw e;
        if (refusal === 'resend' && attempt < SUBMIT_ATTEMPTS) {
          logger.warn(`[rpc] ${method} not accepted (${(e as RpcResponseError).code}), resending`);
          await submitRetrySleep(RESEND_BACKOFF_MS[attempt - 1]);
          continue;
        }
        if (refusal === 'nonce_used') {
          await noteNonceUsed(scope.networkId, String(tx.from ?? scope.address), Number(tx.nonce));
        }
        throw new TxSubmitError(
          refusal === 'resend' ? 'not_accepted' : refusal,
          (e as Error).message,
          { code: (e as RpcResponseError).code }
        );
      }
    }
  }

  private async _rpc(
    method: string,
    params: any[],
    quietOverride: boolean | undefined,
    at: NetworkPin | undefined,
    opts?: RpcCallOptions
  ): Promise<any> {
    const t0 = Date.now();
    const { networkId, rpcUrl: networkUrl } = at ?? (await resolveNetworkPin());
    const quiet = quietOverride ?? method === 'octra_contractStorage';
    const once = opts?.timeoutMs !== undefined;

    const builtIn = networkId === 'mainnet' || networkId === 'devnet';
    const viaProxy = builtIn && this._proxyEnabled;
    const route = viaProxy
      ? {
          endpoint: `https://rpc-proxy.0xio.xyz/rpc/${networkId}`,
          headers: { 'Content-Type': 'application/json', 'x-0xio-client': 'extension' },
          label: `rpc-proxy(${networkId})`,
        }
      : {
          endpoint: `${networkUrl}/rpc`,
          headers: { 'Content-Type': 'application/json' },
          label: networkUrl,
        };
    if (!quiet) logger.debug(`[rpc] ${method} -> ${route.label}`);

    const write = rpcWrite(method);
    const body = { jsonrpc: '2.0', method, params, id: Date.now() };
    const responses = new WeakMap<RpcReply, BackgroundResponse>();
    const sent = await rpcExchange({
      method,
      write,
      timeoutMs: once ? opts!.timeoutMs! : 60_000,
      lane: opts?.lane,
      once,
      firstAttemptMs:
        !once && builtIn && !viaProxy && FAILOVER_TIMEOUT_METHODS.has(method) ? 12_000 : undefined,
      onRetry: (step) => {
        if (step.fault === 'network') this._slowSince = Date.now();
      },
      send: async (ms) => {
        try {
          const response = await this.makeBackgroundRequest(
            route.endpoint,
            'POST',
            route.headers,
            body,
            quiet,
            ms
          );
          const reply: RpcReply = {
            link: response.status || response.success ? 'answered' : 'broken',
            status: response.status ?? (response.success ? 200 : 0),
            body: response.text ?? '',
            retryAfter: response.retryAfter ?? null,
          };
          responses.set(reply, response);
          return reply;
        } catch (cause) {
          return {
            link: (cause as { link?: RpcLink })?.link ?? 'broken',
            status: 0,
            body: '',
            retryAfter: null,
            cause,
          };
        }
      },
    });

    const { reply } = sent;
    const detail = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ''));
    if (sent.fault === 'busy' && !write) throw new Error(rpcCondition('busy'));
    if (sent.gaveUp && write && sent.unsent) {
      throw new RpcUnsentError(sent.fault, reply.cause ? detail(reply.cause) : undefined);
    }
    const response = responses.get(reply);
    if (!response) {
      const netErr = reply.cause ?? new Error(rpcCondition(sent.fault));
      if (viaProxy) {
        throw new Error(
          `${detail(netErr) || 'Network error'}. The RPC proxy is not answering; turn it off in Settings to use the node directly.`
        );
      }
      if (sent.gaveUp) throw new Error(`${rpcCondition(sent.fault)}: ${detail(netErr)}`);
      throw netErr;
    }
    if (sent.gaveUp && sent.fault === 'capacity') {
      throw new RpcHttpError(rpcCondition('capacity'), reply.status || 429);
    }
    if (sent.gaveUp && sent.fault === 'state') {
      const err = rpcErrorOf(response.json);
      throw new RpcResponseError(rpcCondition('state'), err);
    }

    const verdict =
      !response.success && SUBMIT_METHODS.has(method) && response.status !== 413
        ? rpcErrorOf(response.json)
        : null;
    if (verdict) {
      logger.error(`[rpc] ${method} ERROR in ${Date.now() - t0}ms:`, verdict.message);
      throw new RpcResponseError(verdict.message || JSON.stringify(verdict), verdict);
    }
    if (response.success && response.json) {
      const data = typeof response.json === 'string' ? JSON.parse(response.json) : response.json;
      if (data.error) {
        const err = data.error;
        if (!quiet)
          logger.error(`[rpc] ${method} ERROR in ${Date.now() - t0}ms:`, err.message || err.data);
        throw new RpcResponseError(err.message || err.data || JSON.stringify(err), err);
      }
      if (!quiet) logger.debug(`[rpc] ${method} OK in ${Date.now() - t0}ms`);
      return data.result;
    }
    logger.error(`[rpc] ${method} FAILED in ${Date.now() - t0}ms: ${response.error || 'no json'}`);
    const failure = response.error || response.text || 'JSON-RPC request failed';
    if (response.status && response.status >= 400) throw new RpcHttpError(failure, response.status);
    throw new Error(failure);
  }

  async getCurrentNetworkUrl(): Promise<string> {
    try {
      return await rpcUrlFor(await storedNetworkId());
    } catch (_error: unknown) {
      return ZeroXIOConfig.NETWORKS.mainnet.rpc_url;
    }
  }

  async getCurrentNetworkId(): Promise<NetworkId> {
    return storedNetworkId();
  }

  async resolveNetwork(): Promise<NetworkPin> {
    return resolveNetworkPin();
  }

  async isDevnet(): Promise<boolean> {
    try {
      const result = await chrome.storage.local.get([ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK]);
      return (result[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet') === 'devnet';
    } catch (_error: unknown) {
      return false;
    }
  }

  async getBalance(address: string, forceRefresh = false, at?: NetworkPin): Promise<BalanceResult> {
    if (!address) return { success: false, balance: null, nonce: null, error: 'Address required' };

    const pin = at ?? (await resolveNetworkPin());
    const cacheKey = `${pin.rpcUrl}|${address}`;

    if (!forceRefresh) {
      const cached = this.balanceCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        logger.debug(
          `[balance] cache hit for ${address.slice(0, 8)}… (age=${((Date.now() - cached.timestamp) / 1000).toFixed(0)}s)`
        );
        return { success: true, balance: cached.balance, nonce: cached.nonce, cached: true };
      }
    }

    const t0 = Date.now();
    try {
      const data = await this.jsonRpcCall('octra_balance', [address], undefined, pin);

      // balance_raw is micro-OCT; balance is an OCT string.
      let balance: number;
      if (data.balance_raw != null) {
        const microOCT =
          typeof data.balance_raw === 'number' ? data.balance_raw : parseInt(data.balance_raw) || 0;
        balance = microOCT / 1_000_000;
      } else {
        balance = parseFloat(data.balance || 0);
      }
      const nonce = parseInt(data.nonce ?? 0);
      const pendingNonce =
        data.pending_nonce === undefined ? undefined : rpcNonce(data.pending_nonce);

      this.balanceCache.set(cacheKey, { balance, nonce, timestamp: Date.now() });
      logger.debug(
        `[balance] ${address.slice(0, 8)}… = ${balance} OCT (nonce=${nonce}) in ${Date.now() - t0}ms`
      );
      return { success: true, balance, nonce, pendingNonce };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // "sender not found" is a fresh wallet: balance 0.
      if (message?.includes('sender not found')) {
        logger.debug(`[balance] ${address.slice(0, 8)}… new wallet (sender not found) -> 0 OCT`);
        this.balanceCache.set(cacheKey, { balance: 0, nonce: 0, timestamp: Date.now() });
        return { success: true, balance: 0, nonce: 0 };
      }
      // The scanner answers a never-used address with a policy error: empty only when it has no history.
      if (message?.includes('scanner policy check unavailable')) {
        try {
          const page = await this.jsonRpcCall(
            'octra_transactionsByAddress',
            [address, 1, 0],
            undefined,
            pin
          );
          if (page?.total === 0) {
            this.balanceCache.set(cacheKey, { balance: 0, nonce: 0, timestamp: Date.now() });
            return { success: true, balance: 0, nonce: 0 };
          }
        } catch {}
      }
      logger.error(
        `[balance] fetch failed for ${address.slice(0, 8)}… in ${Date.now() - t0}ms:`,
        error
      );
      return { success: false, balance: null, nonce: null, error: message };
    }
  }

  getCachedNonce(address: string, rpcUrl: string): number | null {
    return this.balanceCache.get(`${rpcUrl}|${address}`)?.nonce ?? null;
  }

  async probeNonce(address: string, at?: NetworkPin): Promise<number | null> {
    const pin = at ?? (await resolveNetworkPin());
    const readBalanceNonce = async (): Promise<number | null> => {
      try {
        const data = await this.jsonRpcCall('octra_balance', [address], undefined, pin);
        const n = data?.nonce != null ? parseInt(data.nonce) : NaN;
        if (!Number.isFinite(n)) return null;
        const balance =
          data.balance_raw != null
            ? (typeof data.balance_raw === 'number'
                ? data.balance_raw
                : parseInt(data.balance_raw) || 0) / 1_000_000
            : parseFloat(data.balance || 0);
        this.balanceCache.set(`${pin.rpcUrl}|${address}`, {
          balance,
          nonce: n,
          timestamp: Date.now(),
        });
        return n;
      } catch {
        return null;
      }
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const n = await readBalanceNonce();
      if (n != null) {
        logger.warn(
          `[probeNonce] recovered nonce ${n} for ${address.slice(0, 8)}… (attempt ${attempt + 1})`
        );
        return n;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }

    try {
      const acct = await this.jsonRpcCall('octra_account', [address, 1], undefined, pin);
      const n = acct?.nonce != null ? parseInt(acct.nonce) : NaN;
      if (Number.isFinite(n)) {
        logger.warn(
          `[probeNonce] recovered nonce ${n} for ${address.slice(0, 8)}… via octra_account`
        );
        return n;
      }
    } catch {}
    return null;
  }

  async getNextNonce(address: string, at?: NetworkPin): Promise<number> {
    return this._nonceManager.getNextNonce(address, at);
  }

  /** Free a nonce reserved on `networkId` whose tx definitively never reached that node. */
  releaseNonce(address: string, nonce: number, networkId: string): void {
    this._nonceManager.release(address, nonce, networkId);
  }

  async reserveNonceRange(scope: TxScope, count: number): Promise<number> {
    return this._nonceManager.reserveRange(scope, count);
  }

  releaseNonceRange(address: string, first: number, count: number, networkId: string): void {
    this._nonceManager.releaseRange(address, first, count, networkId);
  }

  hexToText(hex: string): string {
    try {
      if (!hex || typeof hex !== 'string') return hex;
      const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

      if (!/^[0-9a-fA-F]+$/.test(cleanHex)) return hex;

      let str = '';
      for (let i = 0; i < cleanHex.length; i += 2) {
        str += String.fromCharCode(parseInt(cleanHex.substr(i, 2), 16));
      }

      return str;
    } catch (_e: unknown) {
      return hex;
    }
  }

  async getTransactionHistory(
    address: string,
    limit = Infinity,
    force = false
  ): Promise<TransactionHistoryItem[]> {
    const active = await this.getCurrentNetworkId();
    const nets = historyReadNetworks(active);
    const t0 = Date.now();
    const perNetwork = await Promise.all(
      nets.map((net) => this._networkHistory(address, limit, net, force))
    );
    const txMap = new Map<string, TransactionHistoryItem>();
    perNetwork.flat().forEach((tx) => {
      const key = `${tx.network || 'unknown'}:${tx.hash}`;
      if (!txMap.has(key)) txMap.set(key, tx);
    });
    const merged = Array.from(txMap.values()).sort((a, b) => b.timestamp - a.timestamp);
    logger.debug(
      `[History] merged: ${nets.map((n, i) => `${n}=${perNetwork[i].length}`).join(' ')} total=${merged.length} in ${Date.now() - t0}ms`
    );
    try {
      const pin = await resolveNetworkPin(active);
      return await enrichTokenTransfers(merged, address, this.transferDeps(pin, address));
    } catch (e: unknown) {
      logger.warn('[History] token transfer read failed:', e);
      return merged;
    }
  }

  private async _networkHistory(
    address: string,
    limit: number,
    networkId: NetworkId,
    force: boolean
  ): Promise<TransactionHistoryItem[]> {
    const key = `${networkId}:${address}:${limit}`;
    if (!force) {
      const cached = this._historyCache.get(key);
      if (cached && Date.now() - cached.ts < this._historyCacheTTL) return cached.data;
      const inflight = this._historyInFlight.get(key);
      if (inflight) return inflight;
    }
    const p = this._fetchNetworkHistory(address, limit, networkId)
      .then((data) => {
        if (data) this._historyCache.set(key, { data, ts: Date.now() });
        return data ?? [];
      })
      .finally(() => {
        if (this._historyInFlight.get(key) === p) this._historyInFlight.delete(key);
      });
    this._historyInFlight.set(key, p);
    return p;
  }

  private transferDeps(pin: NetworkPin, address: string): TransferDeps {
    let held: Promise<TokenRow[]> | null = null;
    const view = async (contract: string, method: string): Promise<string | undefined> => {
      const r = await this.contractCallView(contract, method, [], contract, pin).catch(
        (): null => null
      );
      return r != null && r !== '' ? String(r) : undefined;
    };
    return {
      networkId: pin.networkId,
      rpc: (method, params) => this.jsonRpcCall(method, params, true, pin),
      abiMethods: async (contract) => {
        const abi = await this.jsonRpcCall('octra_contractAbi', [contract], true, pin);
        const list = Array.isArray(abi) ? abi : abi?.methods || abi?.abi || [];
        return (list as Array<{ name?: string } | string>)
          .map((m) => (typeof m === 'string' ? m : (m?.name ?? '')))
          .filter(Boolean);
      },
      held: () => (held ??= this.getTokensByAddress(address, pin).catch((): TokenRow[] => [])),
      nftInfo: async (contract) => {
        const [collection, plain, getName, symbol] = await Promise.all([
          view(contract, 'collection_name'),
          view(contract, 'name'),
          view(contract, 'get_name'),
          view(contract, 'symbol'),
        ]);
        const name = collection || plain || getName;
        return name || symbol ? { name, symbol } : null;
      },
      tokenInfo: async (contract) => {
        const [symbol, decimals] = await Promise.all([
          this.getContractStorage(contract, 'symbol', pin),
          this.getContractStorage(contract, 'decimals', pin),
        ]);
        return {
          symbol: symbol || undefined,
          decimals: decimals ? parseInt(decimals) || 0 : undefined,
        };
      },
      stillOn: () => onPinnedNetwork(pin),
    };
  }

  private async _fetchNetworkHistory(
    address: string,
    limit: number,
    networkId: NetworkId
  ): Promise<TransactionHistoryItem[] | null> {
    const nt0 = Date.now();
    try {
      let useProxy = false;
      try {
        const proxyState = await chrome.storage.local.get(['0xio_rpc_proxy']);
        useProxy = proxyState['0xio_rpc_proxy'] === true;
      } catch {}
      if (!networkCapabilities(networkId).proxy) useProxy = false;

      const rpcLimit = Math.min(limit === Infinity ? 50 : limit, 500);

      const parseRpcJson = (json: any): { result: any; retryLimit?: number } => {
        if (json.error) {
          if (json.error.code === 116) {
            const missing = json.error.data?.missing;
            if (typeof missing === 'number' && missing > 0 && missing < rpcLimit) {
              const reduced = rpcLimit - missing;
              logger.debug(
                `[History] ${networkId}: index incomplete (missing ${missing}), retrying with limit=${reduced}`
              );
              return { result: null, retryLimit: reduced };
            }
            logger.debug(
              `[History] ${networkId}: history index incomplete (missing=${missing ?? '?'}), skipping`
            );
          } else {
            logger.warn(
              `[History] ${networkId}: RPC error ${json.error.code}: ${json.error.message}`
            );
          }
          return { result: null };
        }
        return { result: json.result ?? null };
      };

      const doFetch = async (fetchLimit: number): Promise<any> => {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          method: 'octra_transactionsByAddress',
          params: [address, fetchLimit, 0],
          id: 1,
        });

        if (useProxy) {
          const proxyUrl = `https://rpc-proxy.0xio.xyz/rpc/${networkId}`;
          logger.debug(`[History] ${networkId}: fetching via proxy (limit=${fetchLimit})`);
          const res = await rpcFetch(
            proxyUrl,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-0xio-client': 'extension',
              },
              body,
            },
            { lane: 'poll' }
          );
          const parsed = parseRpcJson(await res.json());
          if (parsed.retryLimit) return doFetch(parsed.retryLimit);
          return parsed.result;
        }

        const builtIn: Record<string, string> = {
          mainnet: 'https://octra.network/rpc',
          devnet: 'https://devnet.octrascan.io/rpc',
        };
        const endpoint = builtIn[networkId] ?? `${getNetworkConfig(networkId).rpc_url}/rpc`;
        logger.debug(
          `[History] ${networkId}: fetching via direct RPC (limit=${fetchLimit}, url=${endpoint})`
        );
        const res = await rpcFetch(
          endpoint,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
          { lane: 'poll' }
        );
        const parsed = parseRpcJson(await res.json());
        if (parsed.retryLimit) return doFetch(parsed.retryLimit);
        return parsed.result;
      };

      const result = await doFetch(rpcLimit);
      if (!result) {
        logger.debug(`[History] ${networkId}: no result in ${Date.now() - nt0}ms`);
        return [];
      }

      const confirmed = (result.transactions || []).map((tx: any) =>
        mapHistoryTx(tx, 'success', address, networkId)
      );
      const rejected = (result.rejected || []).map((tx: any) =>
        mapHistoryTx(tx, 'failed', address, networkId)
      );
      logger.debug(
        `[History] ${networkId}: ${confirmed.length} confirmed + ${rejected.length} rejected in ${Date.now() - nt0}ms${useProxy ? ' (proxy)' : ' (direct)'}`
      );
      return [...confirmed, ...rejected];
    } catch (e: unknown) {
      logger.warn(`[History] ${networkId} fetch failed in ${Date.now() - nt0}ms:`, e);
      return null;
    }
  }

  /**
   * 'unknown' means the node answered that it does not know the hash; 'error' means no answer,
   * which says nothing about the tx and must never be read as not found.
   */
  async getTransactionStatus(txHash: string, at?: NetworkPin): Promise<TransactionStatusResult> {
    let data: any;
    try {
      data = await this.jsonRpcCall('octra_transaction', [txHash], undefined, at);
    } catch (rpcError: unknown) {
      const message = rpcError instanceof Error ? rpcError.message : String(rpcError);
      if (isNotFoundError(message)) return { status: 'unknown', confirmed: false };
      logger.warn(`[getTransactionStatus] lookup failed for ${txHash.slice(0, 8)}...: ${message}`);
      return { status: 'error', confirmed: false, errorReason: message };
    }
    if (data == null || typeof data !== 'object') return { status: 'unknown', confirmed: false };

    const status = String(data.status || data.finality || 'pending');
    const finality = data.finality || data.status || 'pending';
    const result: TransactionStatusResult = {
      status,
      confirmed: finality === 'confirmed',
      finality,
      epoch: data.epoch || null,
      txHash: data.tx_hash || txHash,
      from: data.from,
      to: data.to,
      amount: data.amount,
      timestamp: data.timestamp,
    };

    if (isDeadStatus(status)) {
      const err = data.error;
      result.errorType =
        typeof err === 'string' ? err : err?.type || err?.code || status.toLowerCase();
      result.errorReason =
        typeof err === 'string'
          ? err
          : err?.reason || err?.message || (err ? JSON.stringify(err) : status.toLowerCase());
      logger.warn(
        `[getTransactionStatus] TX ${txHash.slice(0, 8)}... ${status}: ${result.errorReason}`
      );
    }

    return result;
  }

  /**
   * A broadcast is mempool only; the node can still reject, drop or expire the tx. 'pending' when
   * neither confirmed nor rejected before the timeout.
   */
  async verifyTxExecution(
    txHash: string,
    timeoutMs = 45000,
    pollMs = 4000,
    at?: NetworkPin
  ): Promise<{ status: 'confirmed' | 'rejected' | 'pending'; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = 'unknown';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const res = await this.getTransactionStatus(txHash, at);
      lastStatus = res.status;
      if (res.status === 'error') continue;
      if (isDeadStatus(res.status) || isDeadStatus(res.finality)) {
        return { status: 'rejected', error: res.errorReason || res.errorType || res.status };
      }
      if (res.confirmed || res.finality === 'confirmed') {
        return { status: 'confirmed' };
      }
    }
    logger.debug(
      `[verifyTxExecution] ${txHash.slice(0, 8)}... still '${lastStatus}' after ${timeoutMs}ms - treating as pending`
    );
    return { status: 'pending' };
  }

  async getTransactionStatuses(
    txHashes: string[],
    at?: NetworkPin
  ): Promise<Map<string, TransactionStatusResult>> {
    const results = new Map<string, TransactionStatusResult>();

    const BATCH_SIZE = 5;
    for (let i = 0; i < txHashes.length; i += BATCH_SIZE) {
      const batch = txHashes.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (hash) => {
        const status = await this.getTransactionStatus(hash, at);
        return { hash, status };
      });

      const batchResults = await Promise.all(promises);
      batchResults.forEach(({ hash, status }) => {
        results.set(hash, status);
      });
    }

    return results;
  }

  isValidAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    return isOctAddress(address);
  }

  async getPublicKey(
    address: string
  ): Promise<{ success: boolean; publicKey?: string; error?: string }> {
    try {
      const data = await this.jsonRpcCall('octra_publicKey', [address]);

      if (data.public_key) {
        return { success: true, publicKey: data.public_key };
      }
      return { success: false, error: 'Public key not found' };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async buildAndSignTransaction(txData: TxBuildParams): Promise<SignedTransaction> {
    const operationalUnit = String(txData.ou ?? '');
    if (!isPositiveOu(operationalUnit)) throw new Error('No network fee for this transaction');
    const timestamp = txTimestamp();

    const tx: any = {
      from: txData.from,
      to_: txData.to,
      amount: plainDigits(txData.amount),
      nonce: parseInt(String(txData.nonce)),
      ou: plainDigits(operationalUnit),
      timestamp: timestamp,
      op_type: 'standard',
    };

    if (txData.message) {
      if (memoBytes(txData.message) > MEMO_MAX_BYTES) throw new Error('Message is too long');
      tx.message = txData.message;
    }

    const signature = cryptoManager.signTransaction(txSigningJson(tx), txData.privateKey);

    let publicKey = txData.publicKey;
    if (!publicKey) {
      const tempManager = new CryptoManager();
      tempManager.setPrivateKey(txData.privateKey);
      publicKey = tempManager.getPublicKey();
    }

    return withoutEmptyOptionals({
      ...tx,
      signature,
      public_key: publicKey,
    });
  }

  async broadcastTransaction(
    signedTx: SignedTransaction,
    scope: TxScope
  ): Promise<TransactionBroadcastResult> {
    try {
      await assertTxScope(scope);
      const localHash = localTxHash(signedTx);

      const response = await this.makeBackgroundRequest(
        `${scope.rpcUrl}/rpc`,
        'POST',
        { 'Content-Type': 'application/json' },
        { jsonrpc: '2.0', method: 'octra_submit', params: [signedTx], id: Date.now() }
      );

      if (response.success && response.json) {
        const rpc = typeof response.json === 'string' ? JSON.parse(response.json) : response.json;

        if (rpc.error) {
          const err = rpc.error;
          const errText = err.message || err.data || JSON.stringify(err);
          this.logTxDiagnostics('broadcastTransaction', signedTx, errText);
          const refusal = submitRefusal(err.code);
          if (refusal === 'nonce_used') {
            await noteNonceUsed(scope.networkId, signedTx.from, Number(signedTx.nonce));
          }
          const verdict = refusal === 'resend' ? 'not_accepted' : refusal;
          return {
            success: false,
            error: verdict ? new TxSubmitError(verdict, errText).message : errText,
            errorType: err.data?.type || verdict || undefined,
          };
        }

        const data = rpc.result;
        if (
          data.success ||
          data.status === 'accepted' ||
          data.txHash ||
          data.hash ||
          data.tx_hash
        ) {
          return {
            success: true,
            txHash: trackedTxHash(
              data.txHash || data.hash || data.tx_hash || data.transaction_hash,
              localHash
            ),
            finality: data.finality || 'pending',
            message: data.message || 'Transaction sent successfully',
          };
        } else if (data.error) {
          const errText =
            typeof data.error === 'string'
              ? data.error
              : data.error.reason || JSON.stringify(data.error);
          this.logTxDiagnostics('broadcastTransaction', signedTx, errText);
          return {
            success: false,
            error: errText,
            errorType: data.error_type || data.error?.type || undefined,
          };
        }
      }

      if (response.status === 413) {
        return {
          success: false,
          error: SUBMIT_REFUSAL_TEXT.too_large,
          errorType: 'too_large',
        };
      }

      let errorMessage = response.text || 'Transaction broadcast failed';
      if (response.text && response.text.includes('<html>')) {
        if (response.text.includes('502 Bad Gateway')) {
          errorMessage = 'Server temporarily unavailable. Please try again in a moment.';
        } else if (response.text.includes('503 Service Unavailable')) {
          errorMessage = 'Service temporarily unavailable. Please try again later.';
        } else if (response.text.includes('504 Gateway Timeout')) {
          errorMessage = 'Request timeout. Please try again.';
        } else {
          errorMessage = 'Server error. Please try again later.';
        }
      }

      return {
        success: false,
        error: errorMessage,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: message || 'Network error',
      };
    }
  }

  async broadcastBatchTransaction(
    signedTxs: SignedTransaction[],
    scope: TxScope
  ): Promise<BatchTransactionResult> {
    try {
      const byNonce = new Map(signedTxs.map((tx) => [Number(tx.nonce), tx]));
      const settled = new Map<SignedTransaction, BatchTransactionResultItem>();
      let pending = signedTxs;
      let data: any = null;
      for (let attempt = 1; pending.length; attempt++) {
        data = await this.jsonRpcCall('octra_submitBatch', [pending], undefined, scope);
        const items: any[] = Array.isArray(data?.results) ? data.results : [];
        if (!items.length) break;
        const again: SignedTransaction[] = [];
        for (const [i, item] of items.entries()) {
          const tx = (typeof item?.nonce === 'number' && byNonce.get(item.nonce)) || pending[i];
          if (!tx) continue;
          const verdict = await this.batchVerdict(item, tx, scope);
          if (verdict === 'resend' && attempt < SUBMIT_ATTEMPTS) again.push(tx);
          else settled.set(tx, this.batchItem(item, tx, verdict));
        }
        pending = again;
        if (pending.length) {
          logger.warn(`[rpc] octra_submitBatch resending ${pending.length} not accepted`);
          await submitRetrySleep(RESEND_BACKOFF_MS[attempt - 1]);
        }
      }
      const results = signedTxs.flatMap((tx): BatchTransactionResultItem[] => {
        const item = settled.get(tx);
        return item ? [item] : [];
      });
      if (!results.length) {
        return {
          success: true,
          total: data?.total || signedTxs.length,
          accepted: data?.accepted || 0,
          rejected: data?.rejected || 0,
          results: data?.results || [],
        };
      }
      const accepted = results.filter((r) => r.status === 'accepted').length;
      return {
        success: true,
        total: signedTxs.length,
        accepted,
        rejected: results.length - accepted,
        results,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // A node verdict or a scope refusal sent nothing; any other failure may have landed.
      const refused = error instanceof RpcResponseError || error instanceof TxScopeError;
      return {
        success: false,
        total: signedTxs.length,
        accepted: 0,
        rejected: refused ? signedTxs.length : 0,
        results: [],
        error: message || 'Network error',
        outcomeUnknown: !refused,
      };
    }
  }

  private async batchVerdict(
    item: any,
    tx: SignedTransaction,
    scope: TxScope
  ): Promise<ReturnType<typeof submitRefusal>> {
    if (item?.status !== 'rejected') return null;
    const refusal = submitRefusal(item?.error?.code ?? item?.code);
    if (refusal === 'nonce_used') await noteNonceUsed(scope.networkId, tx.from, Number(tx.nonce));
    return refusal;
  }

  private batchItem(
    item: any,
    tx: SignedTransaction,
    refusal: ReturnType<typeof submitRefusal>
  ): BatchTransactionResultItem {
    if (item?.status === 'accepted') {
      const hash = trackedTxHash(item.tx_hash || item.hash, localTxHash(tx));
      return { ...item, nonce: Number(tx.nonce), ...(hash ? { tx_hash: hash } : {}) };
    }
    if (!refusal) return { ...item, nonce: Number(tx.nonce) };
    const verdict = refusal === 'resend' ? 'not_accepted' : refusal;
    return {
      ...item,
      status: 'rejected',
      nonce: Number(tx.nonce),
      error: { type: verdict, reason: new TxSubmitError(verdict, item?.error?.reason).message },
    };
  }

  async sendTransaction(txParams: SendTxParams): Promise<TransactionBroadcastResult> {
    let pendingTx: PendingTransaction | null = null;
    try {
      logger.debug('[sendTransaction] Starting transaction:', {
        from: txParams.from,
        to: txParams.to,
        amount: txParams.amount,
        message: txParams.message,
      });

      const scope = txParams.scope ?? (await captureTxScope(txParams.from));
      if (scope.address !== txParams.from) throw new Error('Sender does not match this wallet');
      await assertTxScope(scope);
      const nonceInt = await this.getNextNonce(txParams.from, scope);
      const nonce = nonceInt.toString();
      logger.debug('[sendTransaction] Nonce calculated:', nonce);

      const amountUnits = toUnits(txParams.amount, 6);
      if (amountUnits <= 0n) throw new Error('Invalid amount');
      const amountMicroOCT = amountUnits.toString();
      logger.debug('[sendTransaction] Amount in microOCT:', amountMicroOCT);

      const signedTx = await this.buildAndSignTransaction({
        from: txParams.from,
        to: txParams.to,
        amount: amountMicroOCT,
        amountInOCT: Number(txParams.amount),
        nonce: nonce,
        privateKey: txParams.privateKey,
        publicKey: txParams.publicKey,
        message: txParams.message || '',
        ou: txParams.ou,
      });
      logger.debug('[sendTransaction] Transaction signed:', {
        hasSignature: !!signedTx.signature,
        hasPublicKey: !!signedTx.public_key,
      });

      pendingTx = await this.storePendingTransaction({
        from: txParams.from,
        to: txParams.to,
        amount: Number(txParams.amount),
        nonce: parseInt(nonce),
        message: txParams.message || '',
        timestamp: Date.now(),
        type: 'outgoing',
        opType: 'transfer',
        confirmed: false,
        pending: true,
        network: scope.networkId,
      });
      logger.debug('[sendTransaction] Stored as pending:', pendingTx?.txId);

      logger.debug('[sendTransaction] Sending to background queue...');
      let response;
      try {
        response = await this._sendExtensionMessage(
          {
            type: 'QUEUE_TRANSACTION',
            transaction: {
              txId: pendingTx?.txId,
              signedTransaction: signedTx,
              opType: 'transfer',
              type: 'broadcast_only',
              scope,
            },
          },
          QUEUE_REPLY_MS
        );
      } catch (e) {
        // No answer is not a refusal: the tx may be on the node. Keep it pending so History
        // settles it, and never offer the form again.
        if (e instanceof Error && e.name === MESSAGE_TIMEOUT) {
          logger.warn('[sendTransaction] queue reply timed out; outcome unknown', pendingTx?.txId);
          return { success: true, txHash: null, message: 'Transaction queued' };
        }
        if (!/Receiving end does not exist|Could not establish connection/i.test(String(e))) {
          logger.warn('[sendTransaction] queue reply lost; outcome unknown', pendingTx?.txId);
          return { success: false, outcomeUnknown: true, error: String(e) };
        }
        throw e;
      }

      if (response?.success) {
        logger.debug('[sendTransaction] Transaction queued successfully:', pendingTx?.txId);
        return {
          success: true,
          txHash: response.txHash || response.data?.txHash || null,
          message: 'Transaction queued',
        };
      }
      // Only a server verdict proves the tx never entered the mempool; anything else may have landed.
      if (!response?.errorType) {
        logger.warn('[sendTransaction] no verdict from the node; outcome unknown', pendingTx?.txId);
        return {
          success: false,
          outcomeUnknown: true,
          error: response?.error || 'The node did not confirm receipt',
        };
      }
      this.releaseNonce(signedTx.from, signedTx.nonce, scope.networkId);
      throw new RpcResponseError(response.error || 'Failed to queue transaction', {
        data: { type: response.errorType },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[sendTransaction] Error:', message, error);
      if (pendingTx) await this.removePendingTransaction(pendingTx.txId);

      return {
        success: false,
        error: message || 'Transaction failed',
        errorType: error instanceof RpcResponseError ? (error.errorType as any) : undefined,
      };
    }
  }

  generateTxId(): string {
    return crypto.randomUUID();
  }

  async storePendingTransaction(
    tx: Partial<PendingTransaction>
  ): Promise<PendingTransaction | null> {
    try {
      const network = tx.network ?? (await this.getCurrentNetworkId());
      if (tx.nonce !== undefined) {
        const existing = await (chrome.storage.local.get(null) as unknown as Promise<
          Record<string, any>
        >);
        const pendingKeys = Object.keys(existing).filter((k) => k.startsWith('pending_tx_'));

        for (const key of pendingKeys) {
          const existingTx = existing[key];
          if (
            existingTx.from === tx.from &&
            existingTx.nonce === tx.nonce &&
            existingTx.network === network
          ) {
            logger.debug('Pending transaction with same nonce already exists, returning existing');
            return existingTx;
          }
        }
      }

      const txId = tx.txId || this.generateTxId();
      const key = `pending_tx_${txId}`;
      const txWithKey = { ...tx, network, storageKey: key, txId } as PendingTransaction;

      await chrome.storage.local.set({ [key]: txWithKey });
      logger.debug(`Stored pending transaction with txId: ${txId}, nonce: ${tx.nonce}`);
      return txWithKey;
    } catch (error: unknown) {
      logger.error('Failed to store pending transaction:', error);
      return null;
    }
  }

  async updatePendingTransaction(
    txHash: string,
    updates: Partial<PendingTransaction>
  ): Promise<void> {
    try {
      const result = await (chrome.storage.local.get(null) as unknown as Promise<
        Record<string, any>
      >);
      const pendingKeys = Object.keys(result).filter((k) => k.startsWith('pending_tx_'));

      if (updates.txId) {
        const key = `pending_tx_${updates.txId}`;
        const tx = result[key];
        if (tx) {
          await chrome.storage.local.set({
            [key]: { ...tx, ...updates, hash: txHash },
          });
          logger.debug(`Updated pending transaction ${updates.txId} with hash: ${txHash}`);
          return;
        }
      }

      if (updates.nonce !== undefined && updates.from) {
        for (const key of pendingKeys) {
          const tx = result[key];
          if (
            tx.nonce === updates.nonce &&
            tx.from === updates.from &&
            (!updates.network || tx.network === updates.network)
          ) {
            await chrome.storage.local.set({
              [key]: { ...tx, ...updates, hash: txHash },
            });
            logger.debug(
              `Updated pending transaction by nonce ${updates.nonce} with hash: ${txHash}`
            );
            return;
          }
        }
      }

      logger.warn(`No matching pending transaction found for hash: ${txHash}`);
    } catch (error: unknown) {
      logger.error('Failed to update pending transaction:', error);
    }
  }

  async getTransactionDetails(txHash: string): Promise<{
    hash: string;
    from: string;
    to: string;
    amount: any;
    nonce: number;
    timestamp: any;
    finality?: string;
  } | null> {
    try {
      const data = await this.jsonRpcCall('octra_transaction', [txHash]);

      return {
        hash: txHash,
        from: data.from,
        to: data.to,
        amount: data.amount,
        nonce: data.nonce || 0,
        timestamp: data.timestamp,
        finality: data.finality || data.status,
      };
    } catch (error: unknown) {
      logger.error('Failed to get transaction details:', error);
      return null;
    }
  }

  async getPendingTransactions(
    address: string,
    networks: readonly string[]
  ): Promise<PendingTransaction[]> {
    try {
      const result = await (chrome.storage.local.get(null) as unknown as Promise<
        Record<string, any>
      >);
      const pendingKeys = Object.keys(result).filter((k) => k.startsWith('pending_tx_'));
      const pending: PendingTransaction[] = [];

      for (const key of pendingKeys) {
        const tx = result[key];
        if (pendingTxInScope(tx, address, networks)) pending.push(tx);
      }

      return pending;
    } catch (error: unknown) {
      logger.error('Failed to get pending transactions:', error);
      return [];
    }
  }

  async removePendingTransaction(txHashOrId: string): Promise<void> {
    try {
      const result = await (chrome.storage.local.get(null) as unknown as Promise<
        Record<string, any>
      >);
      const pendingKeys = Object.keys(result).filter((k) => k.startsWith('pending_tx_'));

      for (const key of pendingKeys) {
        const tx = result[key];
        if (tx.hash === txHashOrId || tx.txId === txHashOrId) {
          await chrome.storage.local.remove(key);
          break;
        }
      }
    } catch (error: unknown) {
      logger.error('Failed to remove pending transaction:', error);
    }
  }

  async removePendingTransactionByKey(storageKey: string): Promise<void> {
    try {
      await chrome.storage.local.remove(storageKey);
    } catch (error: unknown) {
      logger.error('Failed to remove pending transaction by key:', error);
    }
  }

  async removePendingTransactionByNonce(
    address: string,
    nonce: number,
    network?: string
  ): Promise<void> {
    try {
      const result = await (chrome.storage.local.get(null) as unknown as Promise<
        Record<string, any>
      >);
      const pendingKeys = Object.keys(result).filter((k) => k.startsWith('pending_tx_'));

      for (const key of pendingKeys) {
        const tx = result[key];
        if (tx.from === address && tx.nonce === nonce && (!network || tx.network === network)) {
          await chrome.storage.local.remove(key);
        }
      }
    } catch (error: unknown) {
      logger.error('Failed to remove pending transaction by nonce:', error);
    }
  }

  async contractCallView(
    contract: string,
    method: string,
    params: any,
    caller: string,
    at?: NetworkPin
  ): Promise<any> {
    try {
      const result = await this.jsonRpcCall(
        'contract_call',
        [contract, method, params || '', caller],
        true,
        at
      );
      return result?.result !== undefined ? result.result : result;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('bytecode not found')) {
        logger.debug(
          `[contractCallView] ${contract}.${method}: bytecode not found (contract may not exist on this network)`
        );
      } else {
        logger.error('Contract view call error:', error);
      }
      throw error;
    }
  }

  /**
   * The node verifies the signature over the exact JSON bytes in a fixed field order, so this logs
   * those bytes and the order. Never logs keys.
   */
  private logTxDiagnostics(context: string, signedTx: unknown, errorText: string): void {
    try {
      const tx = (signedTx ?? {}) as Record<string, unknown>;
      const order = Object.keys(tx);
      const canonical = JSON.stringify(tx);
      const preview = canonical.length > 700 ? `${canonical.slice(0, 700)}…` : canonical;
      logger.error(
        `[tx-diag] ${context} rejected: ${errorText}\n` +
          `  field order: [${order.join(', ')}]\n` +
          `  from=${tx.from} to=${tx.to ?? tx.to_} amount=${tx.amount} nonce=${tx.nonce} ` +
          `ou=${tx.ou} timestamp=${tx.timestamp} op_type=${tx.op_type}\n` +
          `  signature=${tx.signature ? 'present' : 'MISSING'} ` +
          `public_key=${(tx.public_key ?? tx.pubkey) ? 'present' : 'MISSING'} ` +
          `encrypted_data.len=${typeof tx.encrypted_data === 'string' ? (tx.encrypted_data as string).length : '-'} ` +
          `message.len=${typeof tx.message === 'string' ? (tx.message as string).length : '-'}\n` +
          `  canonical bytes=${canonical.length}: ${preview}`
      );
      if (/malformed/i.test(errorText)) {
        // The node rebuilds and re-hashes this exact order; any reorder, extra or missing field breaks
        // signature verification.
        const EXPECTED = [
          'from',
          'to_',
          'amount',
          'nonce',
          'ou',
          'timestamp',
          'op_type',
          'encrypted_data',
          'message',
        ];
        const coreOrder = order.filter((k) => EXPECTED.includes(k));
        const orderOk = coreOrder.join(',') === EXPECTED.filter((k) => k in tx).join(',');
        const missing = EXPECTED.filter(
          (k) => !(k in tx) && k !== 'encrypted_data' && k !== 'message'
        );
        logger.error(
          `[tx-diag] MALFORMED - node re-hashes the exact JSON byte order.\n` +
            `  expected core order: [${EXPECTED.join(', ')}]\n` +
            `  actual core order:   [${coreOrder.join(', ')}] -> order ${orderOk ? 'OK' : 'MISMATCH'}\n` +
            `  missing required: [${missing.join(', ') || 'none'}]`
        );
      }
    } catch (e) {
      logger.warn(`[tx-diag] failed to build diagnostics: ${e}`);
    }
  }

  async contractCall(
    contract: string,
    method: string,
    params: any,
    fromAddress: string,
    privateKey: string,
    ou: string | undefined,
    scope: TxScope
  ): Promise<string> {
    try {
      if (!isTxScope(scope)) throw new Error('This transaction has no network attached');
      if (scope.address !== fromAddress) throw new Error('Sender does not match this wallet');
      await assertTxScope(scope);
      if (ou !== undefined && !isPositiveOu(ou)) throw new Error('Invalid network fee');
      const callOu = ou ?? (await this.getRecommendedFeeStrict('call', scope))?.recommended;
      if (!callOu) throw new FeeUnavailableError();
      logger.info(`[contractCall] ${method}(): resolving nonce for ${fromAddress.slice(0, 10)}…`);
      const nonce = await this.getNextNonce(fromAddress, scope);
      logger.info(`[contractCall] ${method}(): nonce=${nonce}`);

      const signedTx = await this.buildContractCallTransaction({
        from: fromAddress,
        contract,
        method,
        callParams: params,
        nonce,
        ou: callOu,
        privateKey,
      });

      const pendingTx = await this.storePendingTransaction({
        from: fromAddress,
        to: contract,
        amount: 0,
        nonce,
        message: `${method}(${JSON.stringify(params)})`,
        timestamp: Date.now(),
        type: 'outgoing',
        opType: 'call',
        confirmed: false,
        pending: true,
        network: scope.networkId,
      });

      const _tx = signedTx as unknown as Record<string, unknown>;
      logger.info(
        `[contractCall] submitting ${method}() | from=${String(_tx.from).slice(0, 10)}… ` +
          `to_=${String(_tx.to_ ?? _tx.to).slice(0, 10)}… amount=${_tx.amount} nonce=${_tx.nonce} ` +
          `ou=${_tx.ou} timestamp=${_tx.timestamp} op_type=${_tx.op_type} ` +
          `encrypted_data=${_tx.encrypted_data} message=${typeof _tx.message === 'string' ? (_tx.message as string).slice(0, 80) : '-'}`
      );
      let result;
      try {
        result = await this.jsonRpcCall('octra_submit', [signedTx], undefined, scope);
      } catch (submitErr) {
        if (submitErr instanceof TxScopeError) {
          if (pendingTx) await this.removePendingTransaction(pendingTx.txId);
          this.releaseNonce(fromAddress, nonce, scope.networkId);
          throw submitErr;
        }
        const msg = submitErr instanceof Error ? submitErr.message : String(submitErr);
        this.logTxDiagnostics(`contractCall ${method}()`, signedTx, msg);
        // A JSON-RPC error is the node's verdict: nothing entered the mempool.
        if (submitErr instanceof RpcResponseError) {
          if (pendingTx) await this.removePendingTransaction(pendingTx.txId);
          this.releaseNonce(fromAddress, nonce, scope.networkId);
          throw submitErr;
        }
        // Any other failure lost the receipt, not the tx: it stays pending with its nonce so
        // History settles it and a retry never collides on the same nonce.
        throw new TxOutcomeUnknownError(
          'Submitted, but the node did not confirm receipt. It may still go through. Check History before retrying.'
        );
      }

      if (result?.tx_hash || result?.hash) {
        const txHash = result.tx_hash || result.hash;
        if (pendingTx) {
          await this.updatePendingTransaction(txHash, {
            txId: pendingTx.txId,
            hash: txHash,
            status: 'success',
          });
        }
        return txHash;
      } else if (result?.status === 'rejected') {
        if (pendingTx) await this.removePendingTransaction(pendingTx.txId);
        this.releaseNonce(fromAddress, nonce, scope.networkId);
        const reason = result.error?.reason || result.error?.message || 'Transaction rejected';
        this.logTxDiagnostics(`contractCall ${method}()`, signedTx, reason);
        throw new RpcResponseError(reason, result.error);
      }

      throw new TxOutcomeUnknownError(
        'The node took the call without a transaction hash. It may still go through. Check History before retrying.'
      );
    } catch (error: unknown) {
      logger.error('Contract call error:', error);
      throw error;
    }
  }

  /** A signed contract call: op_type 'call', encrypted_data = method, message = JSON params. */
  async buildContractCallTransaction(params: {
    from: string;
    contract: string;
    method: string;
    callParams: any;
    /** The arguments as JSON text, signed byte for byte instead of `callParams`. */
    rawMessage?: string;
    amount?: string;
    nonce: number;
    ou: string;
    privateKey: string;
    publicKey?: string;
  }): Promise<SignedTransaction> {
    const operationalUnit = params.ou;
    if (!isPositiveOu(operationalUnit)) throw new FeeUnavailableError();
    const timestamp = txTimestamp();

    const tx: any = withoutEmptyOptionals({
      from: params.from,
      to_: params.contract,
      amount: plainDigits(params.amount || '0'),
      nonce: parseInt(String(params.nonce)),
      ou: plainDigits(operationalUnit),
      timestamp: timestamp,
      op_type: 'call',
      encrypted_data: params.method,
      message: params.rawMessage ?? JSON.stringify(params.callParams),
    });

    const signatureData = txSigningJson(tx);
    logger.debug(
      `[NetworkService.buildContractCall] ${params.method} on ${params.contract.slice(0, 16)}...`
    );
    const signature = cryptoManager.signTransaction(signatureData, params.privateKey);

    let publicKey = params.publicKey;
    if (!publicKey) {
      const { CryptoManager: CM } = await import('../crypto/CryptoManager');
      const tempManager = new CM();
      tempManager.setPrivateKey(params.privateKey);
      publicKey = tempManager.getPublicKey();
    }

    return withoutEmptyOptionals({
      ...tx,
      signature,
      public_key: publicKey,
    });
  }

  async predictContractAddress(
    bytecodeB64: string,
    deployer: string,
    nonce: number,
    at: NetworkPin
  ): Promise<string> {
    const result = await this.jsonRpcCall(
      'octra_computeContractAddress',
      [bytecodeB64, deployer, nonce],
      undefined,
      at
    );
    const address = typeof result?.address === 'string' ? result.address : '';
    if (!isOctAddress(address)) throw new Error('The node did not return a contract address');
    return address;
  }

  /** A signed deploy: the same canonical field order as a contract call, op_type 'deploy'. */
  async buildDeployTransaction(params: {
    from: string;
    bytecodeB64: string;
    constructorParams?: string;
    nonce: number;
    ou: string;
    toAddress: string;
    privateKey: string;
    publicKey?: string;
  }): Promise<SignedTransaction> {
    const tx: Omit<SignedTransaction, 'signature' | 'public_key'> = withoutEmptyOptionals({
      from: params.from,
      to_: params.toAddress,
      amount: '0',
      nonce: parseInt(String(params.nonce)),
      ou: plainDigits(params.ou),
      timestamp: txTimestamp(),
      op_type: 'deploy',
      encrypted_data: params.bytecodeB64,
    });
    if (params.constructorParams) tx.message = params.constructorParams;

    const signature = cryptoManager.signTransaction(txSigningJson(tx), params.privateKey);

    let publicKey = params.publicKey;
    if (!publicKey) {
      const tempManager = new CryptoManager();
      tempManager.setPrivateKey(params.privateKey);
      publicKey = tempManager.getPublicKey();
    }

    return withoutEmptyOptionals({ ...tx, signature, public_key: publicKey });
  }

  signMessage(message: string, privateKeyBase64: string): string {
    return cryptoManager.signTransaction(message, privateKeyBase64);
  }

  async getContractStorage(
    contractAddress: string,
    key: string,
    at?: NetworkPin
  ): Promise<string | null> {
    try {
      return await this.getContractStorageStrict(contractAddress, key, at);
    } catch {
      return null;
    }
  }

  async getContractStorageStrict(
    contractAddress: string,
    key: string,
    at?: NetworkPin
  ): Promise<string | null> {
    const result = await this.jsonRpcCall(
      'octra_contractStorage',
      [contractAddress, key],
      undefined,
      at
    );
    return result?.value != null ? String(result.value) : null;
  }

  async getContractParamNames(
    contractAddress: string,
    methodName: string
  ): Promise<string[] | null> {
    try {
      const networkId = await this.getCurrentNetworkId();
      const registryAddr = ZeroXIOConfig.CONTRACTS.PARAM_REGISTRY[networkId] || '';
      if (!registryAddr) return null;

      const result = await this.jsonRpcCall('contract_call', [
        registryAddr,
        'get_params',
        [contractAddress, methodName],
        contractAddress,
      ]);

      const raw: string = result?.result ?? result ?? '';
      if (!raw || typeof raw !== 'string') return null;
      // Plain identifiers only, so chain data cannot inject misleading labels.
      const PARAM_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/;
      const names = raw
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => PARAM_NAME_RE.test(s));
      return names.length > 0 ? names : null;
    } catch {
      return null;
    }
  }

  async getTokensByAddressStrict(address: string, at?: NetworkPin): Promise<TokenRow[]> {
    const pin = at ?? (await resolveNetworkPin());
    const key = `${pin.networkId}|${pin.rpcUrl}:${address}`;
    const hit = this._tokensCache.get(key);
    const rows =
      hit && Date.now() - hit.ts < 10_000 ? hit.rows : this._fetchTokensByAddress(address, pin);
    if (rows !== hit?.rows) {
      this._tokensCache.set(key, { ts: Date.now(), rows });
      rows.catch(() => {
        if (this._tokensCache.get(key)?.rows === rows) this._tokensCache.delete(key);
      });
    }
    return (await rows).map((r) => ({ ...r }));
  }

  // Every page: a page that fails fails the read, so part of the holdings never passes for all.
  private async _fetchTokensByAddress(address: string, pin: NetworkPin): Promise<TokenRow[]> {
    const tokens = await readAllTokensByAddress(
      (method, params) => this.jsonRpcCall(method, params, undefined, pin),
      address
    );
    // Mirrors webcli sanitize_display so a hostile token name or symbol cannot impersonate another.
    const sanitizeDisplay = (s: string, maxLen: number): string =>
      (s || '').replace(/[^a-zA-Z0-9._\- ]/g, '').slice(0, maxLen);
    return tokens.map((t: any) => ({
      contractAddress: t.contract_address || t.contractAddress || t.address || '',
      symbol: sanitizeDisplay(t.symbol || '', 16),
      name: sanitizeDisplay(t.name || t.symbol || '', 32),
      decimals: parseInt(t.decimals || '0') || 0,
      balance: t.balance != null ? String(t.balance) : '0',
    }));
  }

  async getTokensByAddress(address: string, at?: NetworkPin): Promise<TokenRow[]> {
    try {
      return await this.getTokensByAddressStrict(address, at);
    } catch (e: any) {
      logger.debug(`[getTokensByAddress] failed for ${address?.slice(0, 8)}: ${e?.message}`);
      return [];
    }
  }

  /**
   * The node's live fee quote for an op on one network (read in the last 30 seconds, or now), or
   * null when it could not be read. What a review signs; never a kept or fixed value.
   */
  async getRecommendedFeeStrict(
    opType: string,
    pin?: NetworkPin,
    once?: { timeoutMs: number }
  ): Promise<FeeQuote | null> {
    const read = await this.readFeeQuote(opType, pin, { timeoutMs: once?.timeoutMs });
    return read.kind === 'quote' ? read.quote : null;
  }

  async readFeeQuote(
    opType: string,
    pin?: NetworkPin,
    opts: { maxAgeMs?: number; timeoutMs?: number } = {}
  ): Promise<FeeRead> {
    const at = pin ?? (await resolveNetworkPin());
    return this._fees.read(opType, at, {
      maxAgeMs: opts.maxAgeMs,
      timeoutMs: opts.timeoutMs ?? FEE_READ_MS,
    });
  }

  lastFeeQuote(opType: string, pin: NetworkPin, maxAgeMs?: number) {
    return this._fees.last(opType, pin, maxAgeMs);
  }

  forgetFeeQuotes(): void {
    this._fees.forget();
  }

  async getPvacMigrationStatus(
    address: string,
    at?: NetworkPin
  ): Promise<PvacMigrationStatus | null> {
    const read = await this.readPvacMigrationStatus(address, at);
    return read.kind === 'ok' ? read.status : null;
  }

  async readPvacMigrationStatus(address: string, at?: NetworkPin): Promise<PvacMigrationRead> {
    const pin = at ?? (await resolveNetworkPin());
    const nodeKey = `${pin.networkId}|${pin.rpcUrl}`;
    if (migrationStatusUnsupported.has(nodeKey)) return { kind: 'unsupported' };
    try {
      const status = await this.jsonRpcCall('octra_pvacMigrationStatus', [address], undefined, pin);
      if (!status || typeof status !== 'object') {
        return { kind: 'failed', error: 'empty migration status' };
      }
      return { kind: 'ok', status: status as PvacMigrationStatus };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (/method not found|-32601/i.test(message)) {
        migrationStatusUnsupported.add(nodeKey);
        return { kind: 'unsupported' };
      }
      return { kind: 'failed', error: message };
    }
  }

  /**
   * The highest nonce `address` holds in the node's staging pool, 0 when it holds none. Throws
   * when the pool cannot be read or a row is malformed, as the webcli does.
   */
  async stagingNonce(address: string, at: NetworkPin): Promise<number> {
    const result = await this.jsonRpcCall('staging_view', [], undefined, at);
    const rows = (result as { transactions?: unknown } | null)?.transactions;
    if (!Array.isArray(rows)) throw new Error('Cannot read pending transactions');
    let highest = 0;
    for (const tx of rows) {
      if (!tx || typeof tx !== 'object' || typeof (tx as { from?: unknown }).from !== 'string') {
        throw new Error('Invalid pending transaction');
      }
      if ((tx as { from: string }).from !== address) continue;
      const n = rpcNonce((tx as { nonce?: unknown }).nonce);
      if (n == null) throw new Error('Pending transaction nonce missing');
      highest = Math.max(highest, n);
    }
    return highest;
  }

  async getStagingView(): Promise<any[]> {
    try {
      const result = await this.jsonRpcCall('staging_view', []);
      const rows = Array.isArray(result) ? result : (result as any)?.transactions || [];
      // staging_view gives `amount` in OCT and micro-OCT in `amount_raw`; normalize to micro-OCT.
      return rows.map((t: any) => ({ ...t, amount: t.amount_raw ?? t.amount }));
    } catch {
      return [];
    }
  }

  async getContractAbi(address: string): Promise<any[] | null> {
    try {
      const result = await this.jsonRpcCall('octra_contractAbi', [address]);
      return Array.isArray(result) ? result : (result as any)?.abi || null;
    } catch {
      return null;
    }
  }

  async listContracts(): Promise<Array<{ address: string; owner: string }>> {
    try {
      const result = await this.jsonRpcCall('octra_listContracts', []);
      return Array.isArray(result) ? result : (result as any)?.contracts || [];
    } catch {
      return [];
    }
  }
}

export const networkService = new NetworkService();
export const privacyNetworkService = new PrivacyNetworkService(networkService);
