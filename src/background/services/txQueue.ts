import { ZeroXIOConfig, isCustomNetworkId, resolveCustomNetwork } from '../../utils/config';
import { logger } from '../../utils/logger';
import {
  SCOPE_CHANGED,
  captureTxScope,
  isTxScope,
  txScopeMismatch,
  type TxScope,
} from 'src/services/network/txScope';
import { sendTxEvent } from './dappConnections';
import { noteNonceUsed } from 'src/services/network/NonceManager';
import {
  RESEND_BACKOFF_MS,
  SUBMIT_ATTEMPTS,
  SUBMIT_REFUSAL_TEXT,
  submitRefusal,
} from 'src/services/network/txOutcome';
import { localTxHash, trackedTxHash } from '../../utils/octra/txHash';
import { rpcFetch, RpcUnsentError } from 'src/services/network/rpcExchange';

export interface QueuedTransaction {
  id: string;
  txId?: string;
  opType?: 'encrypt' | 'decrypt' | 'transfer' | 'claim' | 'stealth' | 'key_switch';
  type?: string;
  address?: string;
  from?: string;
  to?: string;
  amount?: number;
  amountRaw?: string;
  nonce?: number;
  message?: string;
  signedTransaction?: Record<string, unknown>;
  signature?: string;
  status: 'pending' | 'processing' | 'retrying' | 'completed' | 'failed' | 'error';
  addedAt: number;
  attempts: number;
  maxAttempts: number;
  txHash?: string;
  completedAt?: number;
  failedAt?: number;
  error?: string;
  nextRetryAt?: number;
  /** Persisted: a retry after the wallet moved is refused, never re-targeted. */
  scope?: TxScope;
  /** An attempt may have reached a node, so the tx can no longer be cancelled. */
  sent?: boolean;
  /** Only this site hears the outcome; a popup tx has none. */
  origin?: string;
  tabId?: number;
  frameId?: number;
}

export interface TxSite {
  origin: string;
  tabId?: number;
  frameId?: number;
}

interface SendResult {
  success: boolean;
  txHash?: string;
  finality?: string;
  error?: string;
  errorType?: string;
  /** The node said the same signed bytes may go again. */
  resend?: boolean;
}

/** `outcomeUnknown`: an attempt may have reached a node and no verdict came back. */
export interface BroadcastOutcome {
  success: boolean;
  txHash?: string;
  error?: string;
  errorType?: string;
  outcomeUnknown?: boolean;
}

export const CANCELLED = 'cancelled';

export class TransactionQueue {
  queue: QueuedTransaction[];
  processing: boolean;
  currentTransaction: QueuedTransaction | null;
  STORAGE_KEY: string;
  private _broadcastResolvers: Map<string, (result: BroadcastOutcome) => void> = new Map();

  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentTransaction = null;
    this.STORAGE_KEY = 'tx_queue_state';
  }

  async initialize() {
    try {
      const result = await chrome.storage.local.get([this.STORAGE_KEY]);
      if (result[this.STORAGE_KEY]) {
        const savedState = result[this.STORAGE_KEY];
        this.queue = savedState.queue || [];
        this.processing = false;

        if (this.queue.length > 0) {
          this.process();
        }
      }
    } catch (error) {
      logger.error('[TX Queue] Error rehydrating queue:', error);
    }
  }

  async saveState() {
    try {
      await chrome.storage.local.set({
        [this.STORAGE_KEY]: {
          queue: this.queue,
          processing: this.processing,
          lastUpdate: Date.now(),
        },
      });
    } catch (error) {
      logger.error('[TX Queue] Error saving state:', error);
    }
  }

  async add(
    transaction: Partial<QueuedTransaction>,
    site?: TxSite
  ): Promise<{
    txId: string;
    broadcastResult?: Promise<BroadcastOutcome>;
  }> {
    if ('privateKey' in transaction) {
      throw new Error('Only signed transactions can be queued. Nothing was sent.');
    }
    const txId = transaction.txId || crypto.randomUUID();

    const signer = String(
      transaction.signedTransaction?.from || transaction.from || transaction.address || ''
    );
    // A caller that signed without stamping a scope is pinned to the network current at enqueue.
    const scope = isTxScope(transaction.scope)
      ? transaction.scope
      : signer
        ? await captureTxScope(signer)
        : undefined;

    const queuedTx = {
      id: txId,
      ...transaction,
      scope,
      origin: site?.origin,
      tabId: site?.tabId,
      frameId: site?.frameId,
      status: 'pending' as const,
      addedAt: Date.now(),
      attempts: 0,
      maxAttempts: SUBMIT_ATTEMPTS,
    };

    this.queue.push(queuedTx);
    await this.saveState();

    let broadcastResult: Promise<BroadcastOutcome> | undefined;
    if (transaction.type === 'broadcast_only') {
      broadcastResult = new Promise((resolve) => {
        this._broadcastResolvers.set(txId, resolve);
      });
    }

    if (!this.processing) {
      this.process();
    }

    return { txId, broadcastResult };
  }

  /** False once any attempt went out or one is in flight. */
  async cancel(txId: string): Promise<boolean> {
    const index = this.queue.findIndex((q) => q.id === txId);
    if (index < 0) return false;
    const tx = this.queue[index];
    if (tx.sent || tx.status === 'processing' || tx.status === 'completed') return false;
    this.queue.splice(index, 1);
    await this.saveState();
    await chrome.storage.local.remove(`pending_tx_${txId}`).catch(() => {});
    this._resolveBroadcast(txId, {
      success: false,
      error: 'Cancelled. Nothing was sent.',
      errorType: CANCELLED,
    });
    return true;
  }

  async process() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    await this.saveState();

    while (this.queue.length > 0) {
      const tx = this.queue[0];
      this.currentTransaction = tx;

      try {
        tx.status = 'processing';
        tx.attempts++;
        await this.saveState();

        let result;
        logger.debug(
          `[TX Queue] Processing tx ${tx.id}: opType=${tx.opType}, type=${tx.type}, attempt=${tx.attempts}/${tx.maxAttempts}`
        );
        if (tx.opType === 'encrypt') {
          result = await this.processEncrypt(tx);
        } else if (tx.opType === 'decrypt') {
          result = await this.processDecrypt(tx);
        } else {
          result = await this.sendTransaction(tx);
        }
        logger.debug(
          `[TX Queue] Tx ${tx.id} result: success=${result.success}, txHash=${result.txHash || 'none'}, error=${result.error || 'none'}`
        );

        if (result.success) {
          tx.status = 'completed';
          tx.txHash = result.txHash;
          tx.completedAt = Date.now();
          this.queue.shift();
          await this.saveState();

          this._resolveBroadcast(tx.id, result);
          this.notifyCompletion(tx, result);
        } else {
          // A server verdict will not change on retry; bare digits would also match amounts.
          const errText = result.error || '';
          const isFatal =
            !result.resend &&
            !!errText &&
            (!!result.errorType ||
              /nonce/i.test(errText) ||
              /\bHTTP (400|403|409)\b/.test(errText));

          if (result.resend && tx.attempts >= tx.maxAttempts) result.errorType = 'not_accepted';
          if (isFatal || tx.attempts >= tx.maxAttempts) {
            tx.status = 'failed';
            tx.error = result.error;
            tx.failedAt = Date.now();
            this.queue.shift();
            await this.saveState();
            logger.error(
              `[TX Queue] Transaction ${tx.id} failed permanently (${isFatal ? 'Fatal' : 'Max Attempts'}): ${result.error}`
            );

            const outcomeUnknown = !!tx.sent && !isFatal;
            this._resolveBroadcast(tx.id, {
              success: false,
              error: result.error,
              errorType: result.errorType,
              ...(outcomeUnknown ? { outcomeUnknown } : {}),
            });
            if (!outcomeUnknown) this.notifyFailure(tx, result.error);
          } else {
            const backoffMs = result.resend
              ? RESEND_BACKOFF_MS[tx.attempts - 1]
              : Math.pow(2, tx.attempts) * 1000;
            tx.status = 'retrying';
            tx.nextRetryAt = Date.now() + backoffMs;
            await this.saveState();
            await this.sleep(backoffMs);
          }
        }
      } catch (error) {
        logger.error(`[TX Queue] Error processing ${tx.id}:`, error);
        tx.status = 'error';
        tx.error = error.message;
        await this.saveState();

        if (tx.attempts >= tx.maxAttempts) {
          this.queue.shift();
          await this.saveState();
          const outcomeUnknown = !!tx.sent;
          this._resolveBroadcast(tx.id, {
            success: false,
            error: error.message,
            ...(outcomeUnknown ? { outcomeUnknown } : {}),
          });
          if (!outcomeUnknown) this.notifyFailure(tx, error.message);
        }
      }

      if (this.queue.length > 0) {
        await this.sleep(1000);
      }
    }

    this.processing = false;
    this.currentTransaction = null;
    await this.saveState();
  }

  async storePendingTransaction(tx: QueuedTransaction) {
    try {
      const txId = tx.id || crypto.randomUUID();
      const key = `pending_tx_${txId}`;

      let amountMicroOCT = tx.signedTransaction?.amount || tx.amount;
      let amountOCT;

      if (typeof amountMicroOCT === 'string') {
        amountOCT = parseInt(amountMicroOCT) / 1000000;
      } else {
        amountOCT = amountMicroOCT;
      }

      const pendingTx = {
        from: tx.signedTransaction?.from || tx.from,
        to: tx.to || tx.signedTransaction?.to_ || tx.signedTransaction?.to,
        amount: amountOCT,
        nonce: tx.signedTransaction?.nonce || tx.nonce,
        message: tx.signedTransaction?.message || tx.message || '',
        timestamp: Date.now(),
        type: 'outgoing',
        opType: tx.opType || 'transfer',
        confirmed: false,
        pending: true,
        txId: txId,
        storageKey: key,
        network: tx.scope?.networkId,
      };

      await chrome.storage.local.set({ [key]: pendingTx });
      return pendingTx;
    } catch (error) {
      logger.error('[TX Queue] Failed to store pending transaction:', error);
      return null;
    }
  }

  async updatePendingTransaction(txId: string, txHash: string, serverHash: string | null = null) {
    try {
      const key = `pending_tx_${txId}`;
      const result = await chrome.storage.local.get(key);
      const tx = result[key];

      if (tx) {
        const update = { ...tx, hash: txHash };
        if (serverHash) {
          update.serverHash = serverHash;
        }
        await chrome.storage.local.set({
          [key]: update,
        });
      }
    } catch (error) {
      logger.error('[TX Queue] Failed to update pending transaction:', error);
    }
  }

  async sendTransaction(tx: QueuedTransaction): Promise<SendResult> {
    const isLargePayload = ['stealth', 'key_switch', 'decrypt', 'encrypt'].includes(
      tx.opType || ''
    );
    const timeoutMs = isLargePayload ? 120000 : 30000;
    try {
      const payload = tx.signedTransaction;

      const refusal = !payload
        ? 'This transaction is not signed. Nothing was sent.'
        : !tx.scope
          ? 'This transaction has no network attached. Nothing was sent. Send it again.'
          : payload.from && payload.from !== tx.scope.address
            ? 'This transaction was signed by a different wallet. Nothing was sent.'
            : await txScopeMismatch(tx.scope);
      if (refusal) {
        logger.warn(`[TX Queue] refusing ${tx.id}: ${refusal}`);
        return { success: false, error: refusal, errorType: SCOPE_CHANGED };
      }
      const networkUrl = tx.scope.rpcUrl;

      const pendingTx = await this.storePendingTransaction(tx);
      const sentBefore = !!tx.sent;
      tx.sent = true;
      await this.saveState();
      const refused = (result: SendResult): SendResult => {
        tx.sent = sentBefore;
        return result;
      };

      const computedHash = localTxHash(payload);

      logger.debug('[Background] Broadcasting transaction:', {
        txId: tx.id,
        type: tx.type,
        opType: tx.opType,
        networkUrl: networkUrl,
        hasSignature: !!payload.signature,
        computedHash: computedHash,
      });

      let response: Response;
      try {
        response = await rpcFetch(
          `${networkUrl}/rpc`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'octra_submit',
              params: [payload],
              id: Date.now(),
            }),
          },
          { timeoutMs }
        );
      } catch (error) {
        if (!(error instanceof RpcUnsentError)) throw error;
        return refused({
          success: false,
          error: SUBMIT_REFUSAL_TEXT.not_accepted,
          errorType: 'not_accepted',
        });
      }
      logger.debug('[Background] Network response status:', response.status);

      if (response.status === 413) {
        return refused({
          success: false,
          error: SUBMIT_REFUSAL_TEXT.too_large,
          errorType: 'too_large',
        });
      }

      const text = await response.text();
      let rpc;

      try {
        rpc = JSON.parse(text);
        logger.debug('[Background] Parsed response:', rpc);
      } catch (_e) {
        logger.error('[Background] RPC returned non-JSON:', text);
        return { success: false, error: text || `HTTP ${response.status}` };
      }

      if (rpc.error) {
        const err = rpc.error;
        const detail = err.message || err.data || JSON.stringify(err);
        const refusal = submitRefusal(err.code);
        if (refusal === 'resend') {
          return refused({ success: false, error: SUBMIT_REFUSAL_TEXT.not_accepted, resend: true });
        }
        if (refusal === 'nonce_used') {
          await noteNonceUsed(tx.scope.networkId, tx.scope.address, Number(payload.nonce));
          return refused({
            success: false,
            error: SUBMIT_REFUSAL_TEXT.nonce_used,
            errorType: 'nonce_used',
          });
        }
        if (refusal === 'rejected') {
          return refused({
            success: false,
            error: `${SUBMIT_REFUSAL_TEXT.rejected}: ${detail}`,
            errorType: err.data?.type || 'rejected',
          });
        }
        return refused({
          success: false,
          error: detail,
          errorType: err.data?.type || undefined,
        });
      }

      const data = rpc.result ?? {};
      if (data.success || data.status === 'accepted' || data.txHash || data.hash || data.tx_hash) {
        const serverHash = data.txHash || data.hash || data.tx_hash || data.transaction_hash;
        const txHash = trackedTxHash(serverHash, computedHash);
        const knownHash: string | null = txHash;

        logger.debug('[Background] Transaction broadcast successful:', {
          serverHash: serverHash,
          computedHash: computedHash,
          usingHash: txHash,
          finality: data.finality,
        });

        if (pendingTx && txHash) {
          await this.updatePendingTransaction(pendingTx.txId, txHash, knownHash);
          logger.debug('[Background] Updated pending transaction with hash:', pendingTx.txId);
        } else if (pendingTx && !txHash) {
          logger.warn('[Background] No hash available for pending transaction:', pendingTx.txId);
        }

        return {
          success: true,
          txHash: txHash,
          finality: data.finality || 'pending',
        };
      } else {
        // A server verdict: fatal, and its type lets the sender free the nonce.
        const err = data.error;
        const reason =
          typeof err === 'string'
            ? err
            : err?.reason || err?.message || (err ? JSON.stringify(err) : data.message);
        const errorType =
          data.error_type ||
          (typeof err === 'object' && err ? err.type : undefined) ||
          (data.status === 'rejected' ? 'rejected' : undefined);
        return refused({
          success: false,
          error: reason || 'Transaction failed',
          errorType,
        });
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        logger.error(`[Background] Transaction broadcast timeout (${timeoutMs / 1000}s):`, tx.id);
        return {
          success: false,
          error: 'Network timeout - transaction will be retried',
        };
      }

      logger.error('[Background] Transaction broadcast error:', error.message);
      return {
        success: false,
        error: error.message || 'Network error',
      };
    }
  }

  private _resolveBroadcast(txId: string, result: BroadcastOutcome) {
    const resolver = this._broadcastResolvers.get(txId);
    if (resolver) {
      resolver(result);
      this._broadcastResolvers.delete(txId);
    }
  }

  private notifySite(tx: QueuedTransaction, eventData: Record<string, unknown>) {
    if (!tx.origin) return;
    const signer = String(tx.scope?.address || tx.signedTransaction?.from || tx.from || '');
    void sendTxEvent(
      { origin: tx.origin, tabId: tx.tabId, frameId: tx.frameId, signer },
      eventData
    ).catch(() => {});
  }

  notifyCompletion(tx: QueuedTransaction, result: { txHash?: string }) {
    this.notifySite(tx, {
      type: 'transactionConfirmed',
      data: {
        txId: tx.id,
        txHash: result.txHash,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
      },
    });
  }

  async notifyFailure(tx: QueuedTransaction, error: string) {
    if (tx.id) {
      const key = `pending_tx_${tx.id}`;
      try {
        const result = await chrome.storage.local.get(key);
        if (result[key]) {
          await chrome.storage.local.set({
            [key]: {
              ...result[key],
              status: 'failed',
              error: error,
              failedAt: Date.now(),
              pending: false,
            },
          });
        }
      } catch (_e) {
        chrome.storage.local.remove(key).catch(() => {});
      }
    }

    this.notifySite(tx, {
      type: 'transactionFailed',
      data: {
        txId: tx.id,
        error,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
      },
    });
  }

  async getNetworkUrl() {
    const storage = await chrome.storage.local.get([ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK]);
    const networkId = storage[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet';
    if (networkId === 'devnet') {
      return ZeroXIOConfig.NETWORKS.devnet.rpc_url;
    }
    if (isCustomNetworkId(networkId)) {
      const net = await resolveCustomNetwork(networkId);
      if (net?.rpc_url) return net.rpc_url;
    }
    return ZeroXIOConfig.NETWORKS.mainnet.rpc_url;
  }

  async isDevnet(): Promise<boolean> {
    const storage = await chrome.storage.local.get([ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK]);
    return (storage[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet') === 'devnet';
  }

  async processEncrypt(tx: QueuedTransaction) {
    logger.debug(`[TX Queue] processEncrypt: broadcasting pre-signed HFHE tx`);
    return await this.sendTransaction(tx);
  }

  async processDecrypt(tx: QueuedTransaction) {
    logger.debug(`[TX Queue] processDecrypt: broadcasting pre-signed HFHE tx`);
    return await this.sendTransaction(tx);
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentTransaction: this.currentTransaction
        ? {
            id: this.currentTransaction.id,
            status: this.currentTransaction.status,
            attempts: this.currentTransaction.attempts,
          }
        : null,
      pending: this.queue.filter((tx) => tx.status === 'pending').length,
      retrying: this.queue.filter((tx) => tx.status === 'retrying').length,
    };
  }

  async clearHistory() {
    this.queue = this.queue.filter(
      (tx) => tx.status === 'pending' || tx.status === 'processing' || tx.status === 'retrying'
    );
    await this.saveState();
  }

  sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const txQueue = new TransactionQueue();
