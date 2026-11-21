import { useState, useEffect, useCallback, useRef } from 'react';
import { networkService, pendingTxInScope } from 'src/services/network/NetworkService';
import { resolveNetworkPin } from 'src/services/network/txScope';
import { useWallet } from '../../contexts/WalletContext';
import {
  CONFIRMED_MARKER_TTL_MS,
  cancellableIds,
  dropExpiredFailed,
  historyReadNetworks,
  isConfirmedMarker,
  legacyNetwork,
  looseConfirmedMatch,
  mergeHistory,
  pendingToRow,
  statusOutcome,
  toMs,
  type StatusOutcome,
} from 'src/services/wallet/historyRows';
import type { NetworkId } from '../../utils/config';
import type { TransactionHistoryItem, PendingTransaction } from '../../types/transaction';
import { logger } from '../../utils/logger';

const CACHE_PREFIX = 'tx_history_';
const NO_TRANSACTIONS: TransactionHistoryItem[] = [];
const NO_IDS: string[] = [];
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = 3;
const FAILED_RECORD_MS = 10 * 60 * 1000;
const GHOST_AFTER_MS = 5 * 60 * 1000;
const STALE_PENDING_MS = 24 * 60 * 60 * 1000;
const QUEUE_KEY = 'tx_queue_state';

const cacheKeyOf = (net: string, addr: string) =>
  `${CACHE_PREFIX}${net}_${addr.toLowerCase()}_v${CACHE_VERSION}`;

const sameRow = (a: TransactionHistoryItem, b: TransactionHistoryItem) =>
  (!!a.txId && a.txId === b.txId) || (!!a.hash && a.hash === b.hash);

async function loadCache(nets: NetworkId[], addr: string): Promise<TransactionHistoryItem[]> {
  try {
    const stale = Array.from(
      { length: CACHE_VERSION },
      (_, i) => `${CACHE_PREFIX}${addr.toLowerCase()}_v${i + 1}`
    );
    void chrome.storage.local.remove(stale).catch(() => {});
    const keys = nets.map((net) => cacheKeyOf(net, addr));
    const result = await chrome.storage.local.get(keys);
    const me = addr.toLowerCase();
    const rows: TransactionHistoryItem[] = [];
    for (const net of nets) {
      const cached = result[cacheKeyOf(net, addr)];
      if (!cached || !Array.isArray(cached.transactions) || cached.version !== CACHE_VERSION) {
        continue;
      }
      if (Date.now() - (cached.timestamp || 0) > CACHE_TTL) continue;
      for (const tx of cached.transactions as TransactionHistoryItem[]) {
        if ((tx.network || net) !== net) continue;
        if (tx.source === 'indexer' || !tx.from || tx.from.toLowerCase() === me) {
          rows.push({ ...tx, network: net });
        }
      }
    }
    return dropExpiredFailed(rows);
  } catch {
    return [];
  }
}

async function saveCache(nets: NetworkId[], addr: string, txs: TransactionHistoryItem[]) {
  try {
    const timestamp = Date.now();
    const entries = Object.fromEntries(
      nets.map((net) => [
        cacheKeyOf(net, addr),
        {
          transactions: txs.filter((tx) => tx.network === net),
          timestamp,
          version: CACHE_VERSION,
        },
      ])
    );
    await chrome.storage.local.set(entries);
  } catch (error) {
    logger.error('Cache save error:', error);
  }
}

async function removeRecord(tx: PendingTransaction) {
  if (tx.txId) {
    await chrome.storage.local.remove(`pending_tx_${tx.txId}`);
  } else if (tx.nonce !== undefined && tx.from) {
    await networkService.removePendingTransactionByNonce(tx.from, tx.nonce, tx.network);
  } else if (tx.hash) {
    await networkService.removePendingTransaction(tx.hash);
  } else if (tx.storageKey) {
    await networkService.removePendingTransactionByKey(tx.storageKey);
  }
}

async function updateRecord(tx: PendingTransaction, patch: Record<string, unknown>) {
  const key = tx.txId ? `pending_tx_${tx.txId}` : tx.storageKey;
  if (!key) return false;
  const result = await chrome.storage.local.get(key);
  if (!result[key]) return false;
  await chrome.storage.local.set({ [key]: { ...result[key], ...patch } });
  return true;
}

export type CancelOutcome = 'cancelled' | 'sent';

export const useTransactionHistory = (
  address: string | undefined,
  onTransactionConfirmed?: (completedPending: PendingTransaction[]) => void
) => {
  const { networkId } = useWallet();
  const [transactions, setTransactions] = useState<TransactionHistoryItem[]>([]);
  const [cancellable, setCancellable] = useState<string[]>(NO_IDS);
  const [listScope, setListScope] = useState(() => `${networkId}:${address ?? ''}`);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef(3000);
  const consecutiveEmptyCountRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastHistoryHashRef = useRef<string | null>(null);
  const hiddenRef = useRef(new Set<string>());
  const confirmedRef = useRef(onTransactionConfirmed);
  confirmedRef.current = onTransactionConfirmed;
  const scopeKey = `${networkId}:${address ?? ''}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const lastScopeRef = useRef<string | null>(null);

  const visible = useCallback(
    (rows: TransactionHistoryItem[]) =>
      rows.filter(
        (t) => !hiddenRef.current.has(t.txId || '') && !hiddenRef.current.has(t.hash || '')
      ),
    []
  );

  const readCancellable = useCallback(async () => {
    try {
      const r = await chrome.storage.local.get(QUEUE_KEY);
      setCancellable(cancellableIds(r[QUEUE_KEY]));
    } catch {
      setCancellable(NO_IDS);
    }
  }, []);

  const loadHistory = useCallback(
    async (forceRefresh = false) => {
      if (!address) return;
      const t0 = Date.now();

      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;
      const currentAddress = address;
      const nets = historyReadNetworks(networkId);
      const fallbackNet = legacyNetwork(networkId);
      const key = `${networkId}:${currentAddress}`;
      const stale = () => signal.aborted || scopeRef.current !== key;
      const netOf = (tx: { network?: string }) => tx.network || fallbackNet;

      const isInitialLoad = !forceRefresh && lastHistoryHashRef.current === null;
      if (isInitialLoad || forceRefresh) setIsLoading(true);
      setError(null);
      let cached: TransactionHistoryItem[] = [];
      let pending: PendingTransaction[] = [];

      try {
        cached = visible(await loadCache(nets, currentAddress));
        if (stale()) return;
        if (isInitialLoad && cached.length > 0) {
          setTransactions(cached);
          setIsLoading(false);
        }

        pending = await networkService.getPendingTransactions(currentAddress, nets);
        void readCancellable();
        if (stale()) return;

        if (isInitialLoad && cached.length === 0 && pending.length > 0) {
          setTransactions(visible(pending.map((tx) => pendingToRow(tx, fallbackNet))));
          setIsLoading(false);
        }

        const history = await networkService.getTransactionHistory(
          currentAddress,
          undefined,
          forceRefresh
        );
        if (stale()) return;

        const listed = new Set(history.map((tx) => tx.hash).filter(Boolean));
        const me = currentAddress.toLowerCase();
        const confirmedNonces = new Set(
          history
            .filter((tx) => (tx.from || '').toLowerCase() === me && tx.nonce)
            .map((tx) => `${netOf(tx)}:${Number(tx.nonce)}`)
        );

        const outcomes = new Map<string, StatusOutcome>();
        const reasons = new Map<string, string>();
        const toCheck = pending.filter(
          (tx) =>
            tx.hash &&
            tx.network &&
            !listed.has(tx.hash) &&
            tx.status !== 'failed' &&
            !isConfirmedMarker(tx)
        );
        const byNetwork = new Map<string, string[]>();
        for (const tx of toCheck) {
          byNetwork.set(tx.network!, [...(byNetwork.get(tx.network!) ?? []), tx.hash!]);
        }
        for (const [net, hashes] of byNetwork) {
          const statuses = await networkService.getTransactionStatuses(
            hashes,
            await resolveNetworkPin(net as NetworkId)
          );
          if (stale()) return;
          statuses.forEach((res, hash) => {
            outcomes.set(hash, statusOutcome(res));
            if (res.errorReason) reasons.set(hash, res.errorReason);
          });
        }

        const now = Date.now();
        for (const tx of toCheck) {
          const outcome = outcomes.get(tx.hash!);
          if (outcome === 'rejected') {
            const reason = reasons.get(tx.hash!);
            const patch = {
              status: 'failed' as const,
              error: reason ? `Rejected: ${reason}` : 'Rejected by the network',
              failedAt: now,
              pending: false,
            };
            if (await updateRecord(tx, patch).catch(() => false)) Object.assign(tx, patch);
          } else if (outcome === 'confirmed') {
            const patch = { status: 'success' as const, confirmed: true, pending: false };
            if (await updateRecord(tx, { ...patch, confirmedAt: now }).catch(() => false)) {
              Object.assign(tx, patch);
            }
          }
        }
        if (stale()) return;

        const claimed = new Set(pending.map((tx) => tx.hash).filter(Boolean) as string[]);
        const completed: PendingTransaction[] = [];
        const expired: PendingTransaction[] = [];
        const kept = pending.filter((tx) => {
          if (isConfirmedMarker(tx)) {
            if (
              (tx.hash && listed.has(tx.hash)) ||
              now - toMs(tx.timestamp) > CONFIRMED_MARKER_TTL_MS
            ) {
              expired.push(tx);
              return false;
            }
            return true;
          }
          if (tx.status === 'failed') {
            if (tx.failedAt && now - tx.failedAt > FAILED_RECORD_MS) {
              expired.push(tx);
              return false;
            }
            return true;
          }
          if (tx.hash && listed.has(tx.hash)) {
            completed.push(tx);
            return false;
          }
          const outcome = tx.hash ? outcomes.get(tx.hash) : undefined;
          if (outcome === 'pending' || outcome === 'error') return true;
          if (outcome === 'notFound' && now - toMs(tx.timestamp) > GHOST_AFTER_MS) {
            expired.push(tx);
            return false;
          }
          if (
            (tx.from || '').toLowerCase() === me &&
            tx.nonce &&
            confirmedNonces.has(`${netOf(tx)}:${Number(tx.nonce)}`)
          ) {
            completed.push(tx);
            return false;
          }
          if (looseConfirmedMatch(tx, history, me, claimed, netOf)) {
            completed.push(tx);
            return false;
          }
          if (now - toMs(tx.timestamp) > STALE_PENDING_MS) {
            expired.push(tx);
            return false;
          }
          return true;
        });

        for (const tx of [...completed, ...expired]) {
          await removeRecord(tx).catch(() => {});
        }
        if (completed.length > 0) confirmedRef.current?.(completed);

        const liveIds = new Set(kept.map((tx) => tx.txId).filter(Boolean));
        const validCached = cached.filter((tx) => {
          if (tx.confirmed || tx.status === 'success' || tx.status === 'failed') return true;
          if (tx.pending || tx.queued || tx.status === 'processing' || tx.status === 'pending') {
            return !!tx.txId && liveIds.has(tx.txId);
          }
          return true;
        });

        const all = visible(
          dropExpiredFailed(
            mergeHistory(validCached, [
              ...kept.map((tx) => pendingToRow(tx, fallbackNet)),
              ...history.map((tx) => ({ ...tx, network: netOf(tx) })),
            ])
          )
        );
        if (stale()) return;
        logger.debug(
          `[History] ${all.length} rows over ${nets.join(', ')}, ${kept.length} local records in ${Date.now() - t0}ms`
        );
        setTransactions(all);

        const newHash = all.map((tx) => `${tx.hash || tx.txId || ''}:${tx.status || ''}`).join('|');
        const hasChanges = lastHistoryHashRef.current !== newHash;
        lastHistoryHashRef.current = newHash;
        const live = kept.some((tx) => !isConfirmedMarker(tx) && tx.status !== 'failed');
        if (!live && !hasChanges) {
          consecutiveEmptyCountRef.current++;
          pollIntervalRef.current = Math.min(3000 * 2 ** consecutiveEmptyCountRef.current, 60000);
        } else {
          consecutiveEmptyCountRef.current = 0;
          pollIntervalRef.current = 3000;
        }

        if (history.length > 0 || cached.length === 0) {
          await saveCache(nets, currentAddress, all);
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        logger.error('History load error:', err);
        setError(err.message);
        if (pending.length > 0 && !stale()) {
          const rows = pending
            .filter(
              (tx) => tx.status !== 'failed' || Date.now() - (tx.failedAt || 0) < FAILED_RECORD_MS
            )
            .map((tx) => pendingToRow(tx, fallbackNet));
          setTransactions(visible(mergeHistory(cached, rows)));
        }
      } finally {
        if (!stale()) setIsLoading(false);
      }
    },
    [address, networkId, visible, readCancellable]
  );

  const hideTransaction = useCallback(
    async (tx: TransactionHistoryItem) => {
      if (!address) return false;
      if (tx.txId) hiddenRef.current.add(tx.txId);
      if (tx.hash) hiddenRef.current.add(tx.hash);
      setTransactions((prev) => prev.filter((t) => !sameRow(t, tx)));
      try {
        if (tx.txId) await chrome.storage.local.remove(`pending_tx_${tx.txId}`);
        const net = tx.network || legacyNetwork(networkId);
        const key = cacheKeyOf(net, address);
        const stored = (await chrome.storage.local.get(key))[key];
        if (stored && Array.isArray(stored.transactions)) {
          await chrome.storage.local.set({
            [key]: {
              ...stored,
              transactions: (stored.transactions as TransactionHistoryItem[]).filter(
                (t) => !sameRow(t, tx)
              ),
            },
          });
        }
        return true;
      } catch (err) {
        logger.error('Failed to hide transaction:', err);
        return false;
      }
    },
    [address, networkId]
  );

  const cancelTransaction = useCallback(
    async (tx: TransactionHistoryItem): Promise<CancelOutcome> => {
      if (!tx.txId) return 'sent';
      let cancelled = false;
      try {
        const res = await chrome.runtime.sendMessage({ type: 'CANCEL_QUEUED', txId: tx.txId });
        cancelled = res?.cancelled === true;
      } catch {
        cancelled = false;
      }
      if (!cancelled) {
        void readCancellable();
        return 'sent';
      }
      hiddenRef.current.add(tx.txId);
      setTransactions((prev) => prev.filter((t) => !sameRow(t, tx)));
      setCancellable((prev) => prev.filter((id) => id !== tx.txId));
      return 'cancelled';
    },
    [readCancellable]
  );

  // effect:audited - polls the nodes and listens to chrome.storage (external systems) per wallet + network; cleanup stops both
  useEffect(() => {
    if (lastScopeRef.current !== scopeKey) {
      lastScopeRef.current = scopeKey;
      setTransactions([]);
      setCancellable(NO_IDS);
      setListScope(scopeKey);
      setError(null);
      lastHistoryHashRef.current = null;
      consecutiveEmptyCountRef.current = 0;
      pollIntervalRef.current = 3000;
    }

    if (!address) {
      setIsLoading(false);
      return;
    }

    loadHistory();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let isCleanedUp = false;
    const schedulePoll = () => {
      if (isCleanedUp) return;
      timeoutId = setTimeout(() => {
        if (isCleanedUp) return;
        loadHistory(false).then(() => {
          if (!isCleanedUp) schedulePoll();
        });
      }, pollIntervalRef.current);
    };
    schedulePoll();

    const nets = historyReadNetworks(networkId);
    const fallbackNet = legacyNetwork(networkId);
    const storageListener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName !== 'local') return;
      try {
        if (QUEUE_KEY in changes) setCancellable(cancellableIds(changes[QUEUE_KEY].newValue));
        const pendingChanges = Object.entries(changes).filter(([k]) => k.startsWith('pending_tx_'));
        if (pendingChanges.length === 0) return;
        consecutiveEmptyCountRef.current = 0;
        pollIntervalRef.current = 3000;

        const rows: TransactionHistoryItem[] = [];
        const nowConfirmed: PendingTransaction[] = [];
        for (const [, change] of pendingChanges) {
          const tx = change.newValue as PendingTransaction | undefined;
          if (!tx || !tx.from || !tx.timestamp || !pendingTxInScope(tx, address, nets)) continue;
          rows.push(pendingToRow(tx, fallbackNet));
          const before = change.oldValue as PendingTransaction | undefined;
          if (isConfirmedMarker(tx) && !(before && isConfirmedMarker(before)))
            nowConfirmed.push(tx);
        }
        if (rows.length > 0) setTransactions((prev) => visible(mergeHistory(prev, rows)));
        if (nowConfirmed.length > 0) confirmedRef.current?.(nowConfirmed);
        loadHistory(false);
      } catch (err) {
        if (!err.message?.includes('Extension context invalidated')) {
          logger.error('[useTransactionHistory] Storage listener error:', err);
        }
      }
    };

    try {
      chrome.storage.onChanged.addListener(storageListener);
    } catch (err) {
      logger.error('[useTransactionHistory] Failed to add storage listener:', err);
    }

    return () => {
      isCleanedUp = true;
      if (timeoutId) clearTimeout(timeoutId);
      abortControllerRef.current?.abort();
      try {
        chrome.storage.onChanged.removeListener(storageListener);
      } catch {}
    };
  }, [address, networkId, scopeKey, loadHistory, visible]);

  const inScope = listScope === scopeKey;
  return {
    transactions: inScope ? transactions : NO_TRANSACTIONS,
    cancellable: inScope ? cancellable : NO_IDS,
    isLoading: inScope ? isLoading : true,
    error,
    reload: () => loadHistory(true),
    hideTransaction,
    cancelTransaction,
  };
};

export interface MempoolTx {
  hash: string;
  from: string;
  to: string;
  amount: number;
  nonce: number;
  opType?: string;
  timestamp: number;
  network: NetworkId;
}

const NO_MEMPOOL: MempoolTx[] = [];

/** staging_view rows of one address. The node reports `amount` in OCT and `amount_raw` in micro-OCT. */
export function mempoolRows(rows: unknown, address: string, network: NetworkId): MempoolTx[] {
  const list = Array.isArray(rows)
    ? rows
    : ((rows as { transactions?: unknown[] } | null)?.transactions ?? []);
  const me = address.toLowerCase();
  return (list as Array<Record<string, any>>)
    .filter((t) => typeof t?.from === 'string' && t.from.toLowerCase() === me)
    .map((t) => {
      const raw = Number(t.amount_raw ?? NaN);
      const amount = Number.isFinite(raw) ? raw / 1_000_000 : Number(t.amount) || 0;
      return {
        hash: String(t.hash || t.tx_hash || ''),
        from: t.from,
        to: String(t.to || t.to_ || ''),
        amount,
        nonce: Number(t.nonce) || 0,
        opType: typeof t.op_type === 'string' ? t.op_type : undefined,
        timestamp: toMs(Number(t.timestamp)) || Date.now(),
        network,
      };
    });
}

export const useMempoolTxs = (address: string | undefined, networkId: NetworkId): MempoolTx[] => {
  const scope = `${networkId}:${address ?? ''}`;
  const [state, setState] = useState<{ scope: string; rows: MempoolTx[] }>({
    scope: '',
    rows: NO_MEMPOOL,
  });

  // effect:audited - polls the active network's mempool (external system) per wallet + network; cleanup drops late answers
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const pin = await resolveNetworkPin(networkId);
        const result = await networkService.jsonRpcCall('staging_view', [], true, pin);
        if (!cancelled) setState({ scope, rows: mempoolRows(result, address, pin.networkId) });
      } catch {}
    };
    void poll();
    const interval = setInterval(poll, 20_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address, networkId, scope]);

  return state.scope === scope ? state.rows : NO_MEMPOOL;
};
