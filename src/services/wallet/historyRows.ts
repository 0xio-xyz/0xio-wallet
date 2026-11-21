import type { PendingTransaction, TransactionHistoryItem } from 'src/types/transaction';
import type { TransactionStatusResult } from 'src/types/network';
import { isCustomNetworkId, type NetworkId } from 'src/utils/config';

export const FAILED_ROW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LOOSE_MATCH_WINDOW_MS = 5 * 60 * 1000;
export const CONFIRMED_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

export function historyReadNetworks(activeId: NetworkId): NetworkId[] {
  return isCustomNetworkId(activeId) ? ['mainnet', 'devnet', activeId] : ['mainnet', 'devnet'];
}

export function legacyNetwork(activeId: NetworkId): NetworkId {
  return isCustomNetworkId(activeId) ? 'mainnet' : activeId;
}

export const toMs = (ts: number | undefined): number => {
  const n = Number(ts) || 0;
  return n > 0 && n < 1e12 ? n * 1000 : n;
};

const DEAD_STATUSES = new Set(['rejected', 'dropped', 'expired', 'failed']);

export const isDeadStatus = (status: string | undefined | null): boolean =>
  !!status && DEAD_STATUSES.has(String(status).toLowerCase());

export type StatusOutcome = 'confirmed' | 'rejected' | 'pending' | 'notFound' | 'error';

/** One status lookup read for reconciliation. A failed lookup ('error') is never "not found". */
export function statusOutcome(
  res: Pick<TransactionStatusResult, 'status' | 'confirmed' | 'finality'>
): StatusOutcome {
  if (res.status === 'error') return 'error';
  if (isDeadStatus(res.status) || isDeadStatus(res.finality)) return 'rejected';
  if (res.confirmed || res.finality === 'confirmed' || res.status === 'confirmed') {
    return 'confirmed';
  }
  if (res.status === 'unknown') return 'notFound';
  return 'pending';
}

/** A node's JSON-RPC answer for a hash it does not know. Rate limits and timeouts are not this. */
export const isNotFoundError = (message: string): boolean =>
  /\b(transaction|tx)\s+not\s+found\b/i.test(message) || /^not found$/i.test(message.trim());

export const isConfirmedMarker = (tx: Partial<PendingTransaction>): boolean =>
  tx.confirmed === true || tx.status === 'success';

export const isLocalRow = (tx: Pick<TransactionHistoryItem, 'source'>): boolean =>
  tx.source !== 'indexer' && tx.source !== 'rpc';

export function detectOpType(
  tx: Pick<TransactionHistoryItem, 'opType' | 'message' | 'to'>
): TransactionHistoryItem['opType'] {
  if (tx.opType && tx.opType !== 'transfer') return tx.opType;
  const message = (tx.message || '').toUpperCase();
  if (message.includes('ENCRYPT_BALANCE')) return 'encrypt';
  if (message.includes('DECRYPT_BALANCE')) return 'decrypt';
  if (message.includes('PRIVATE_TRANSFER')) return 'private_transfer';
  if (message.includes('ENCRYPTION KEY SWITCH')) return 'key_switch';
  if (tx.to === 'stealth') return 'stealth';
  return 'transfer';
}

export function pendingToRow(
  tx: PendingTransaction,
  fallbackNetwork: NetworkId
): TransactionHistoryItem {
  const confirmed = isConfirmedMarker(tx);
  const failed = tx.status === 'failed';
  return {
    hash: tx.hash || '',
    timestamp: tx.timestamp,
    type: tx.type,
    amount: tx.amount,
    from: tx.from,
    to: tx.to,
    address: tx.from,
    nonce: tx.nonce,
    confirmed,
    status: confirmed ? 'success' : failed ? 'failed' : 'processing',
    opType: detectOpType(tx),
    txId: tx.txId,
    pending: !confirmed && !failed,
    message: tx.message,
    error: tx.error,
    failedAt: tx.failedAt,
    network: tx.network || fallbackNetwork,
  };
}

const rowKey = (tx: TransactionHistoryItem): string => {
  if (tx.hash) return `hash_${tx.hash}`;
  if (tx.txId) return `txId_${tx.txId}`;
  if (tx.nonce !== undefined && tx.from) return `nonce_${tx.network ?? ''}_${tx.from}_${tx.nonce}`;
  return `fallback_${tx.from}_${tx.to}_${tx.amount}_${tx.timestamp}`;
};

const isSettled = (tx: TransactionHistoryItem) => tx.confirmed || tx.status === 'success';

export function mergeHistory(
  cached: TransactionHistoryItem[],
  fresh: TransactionHistoryItem[]
): TransactionHistoryItem[] {
  const freshIds = new Set(fresh.map((t) => t.txId).filter(Boolean));
  const map = new Map<string, TransactionHistoryItem>();
  const keyOfTxId = new Map<string, string>();

  const add = (tx: TransactionHistoryItem) => {
    const key = rowKey(tx);
    const earlier = tx.txId ? keyOfTxId.get(tx.txId) : undefined;
    const viaTxId = earlier && earlier !== key ? map.get(earlier) : undefined;
    const existing = map.get(key) ?? viaTxId;
    const row = { ...tx, opType: detectOpType(tx) };
    let next: TransactionHistoryItem;
    if (!existing) next = row;
    else if (isSettled(tx)) next = { ...row, txId: existing.txId || tx.txId };
    else if (!isSettled(existing)) next = { ...existing, ...row, hash: row.hash || existing.hash };
    else next = existing;
    const nextKey = rowKey(next);
    if (viaTxId && earlier !== nextKey) map.delete(earlier!);
    map.set(nextKey, next);
    if (next.txId) keyOfTxId.set(next.txId, nextKey);
  };

  const cachedHash = new Map(
    cached.filter((t) => t.txId && t.hash).map((t) => [t.txId as string, t.hash])
  );
  cached.filter((t) => !t.txId || !freshIds.has(t.txId)).forEach(add);
  fresh.forEach((t) =>
    add(!t.hash && t.txId && cachedHash.has(t.txId) ? { ...t, hash: cachedHash.get(t.txId)! } : t)
  );
  return Array.from(map.values()).sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp));
}

export function dropExpiredFailed(
  rows: TransactionHistoryItem[],
  now = Date.now()
): TransactionHistoryItem[] {
  return rows.filter(
    (tx) =>
      !(
        tx.status === 'failed' &&
        isLocalRow(tx) &&
        now - toMs(tx.failedAt ?? tx.timestamp) > FAILED_ROW_TTL_MS
      )
  );
}

const CALL_OPS = new Set(['call', 'deploy']);

/**
 * The confirmed row a pending record most likely became when its own hash cannot speak for it
 * (the submit hash can differ from the chain's). Only this wallet's own sends, only a record
 * that was broadcast (a hashless record is still queued), never a contract call, and never a
 * hash another record already holds. Returns the matched hash or null.
 */
export function looseConfirmedMatch(
  tx: PendingTransaction,
  history: TransactionHistoryItem[],
  me: string,
  claimed: Set<string>,
  networkOf: (t: { network?: string }) => string
): string | null {
  const self = me.toLowerCase();
  if (!tx.hash || !tx.to) return null;
  if ((tx.from || '').toLowerCase() !== self) return null;
  if (CALL_OPS.has(tx.opType || '')) return null;
  const to = tx.to.toLowerCase();
  const match = history.find(
    (h) =>
      !!h.hash &&
      !claimed.has(h.hash) &&
      (h.from || '').toLowerCase() === self &&
      !CALL_OPS.has(h.opType || '') &&
      networkOf(h) === networkOf(tx) &&
      (h.to || '').toLowerCase() === to &&
      Math.abs(Number(h.amount) - Number(tx.amount)) < 0.000001 &&
      Math.abs(toMs(h.timestamp) - toMs(tx.timestamp)) < LOOSE_MATCH_WINDOW_MS
  );
  if (!match) return null;
  claimed.add(match.hash);
  return match.hash;
}

interface QueueItemLike {
  id?: string;
  status?: string;
  sent?: boolean;
}

export function cancellableIds(state: unknown): string[] {
  const queue = (state as { queue?: unknown } | null)?.queue;
  if (!Array.isArray(queue)) return [];
  return (queue as QueueItemLike[])
    .filter(
      (q) =>
        typeof q?.id === 'string' &&
        !q.sent &&
        (q.status === 'pending' || q.status === 'retrying' || q.status === 'error')
    )
    .map((q) => q.id as string);
}
