import { useCallback, useEffect, useState } from 'react';
import { evmTokenKey, isEvmAddress } from 'src/services/evm/balances';
import { loadEvmTokenPlan, type EvmTokenPlan } from 'src/services/evm/detectedTokens';
import { fetchEvmHistory, type EvmHistoryItem } from 'src/services/evm/history';
import type { EvmNetwork } from 'src/services/evm/networks';
import type { EvmToken } from 'src/services/evm/tokens';
import { useCustomEvmVersion } from 'src/hooks/wallet/useEvmBalances';
import { useTokenPrefsVersion } from 'src/hooks/wallet/useTokenPrefs';
import { allNetworks } from 'src/services/evm/registry';
import { registerSessionCache } from 'src/utils/sessionCaches';

const FRESH_MS = 30_000;
const EMPTY: EvmHistoryItem[] = [];
const NONE: EvmChainRef[] = [];

export type EvmChainRef = Pick<EvmNetwork, 'chainId' | 'name' | 'testnet'>;

interface Snapshot {
  items: EvmHistoryItem[];
  failedChains: number[];
  unavailableChains?: number[];
}

interface State {
  scope: string | null;
  items: EvmHistoryItem[];
  failed: EvmChainRef[];
  unavailable: EvmChainRef[];
  loading: boolean;
}

const memCache = new Map<string, Snapshot>();
const fetchedAt = new Map<string, number>();
registerSessionCache(() => {
  memCache.clear();
  fetchedAt.clear();
});

export const evmHistoryCacheKey = (address: string) => `evm_hist:${address.toLowerCase()}`;

function isSnapshot(value: unknown): value is Snapshot {
  const v = value as Snapshot | null;
  return !!v && Array.isArray(v.items) && Array.isArray(v.failedChains);
}

async function readPersisted(key: string): Promise<Snapshot | null> {
  try {
    const stored = await chrome.storage.local.get([key]);
    return isSnapshot(stored?.[key]) ? stored[key] : null;
  } catch {
    return null;
  }
}

function persist(key: string, snap: Snapshot) {
  try {
    chrome.storage.local.set({ [key]: snap }).catch(() => {});
  } catch {}
}

function planned(snap: Snapshot, plan: EvmTokenPlan): Snapshot {
  const shown = (chainId: number, token: EvmToken | null | undefined) =>
    !token?.detected || plan.shown.has(evmTokenKey(chainId, token));
  const clean = (raw: EvmHistoryItem): EvmHistoryItem | null => {
    const i =
      raw.call?.token && !shown(raw.chainId, raw.call.token)
        ? { ...raw, call: { ...raw.call, token: null } }
        : raw;
    const moved = i.moved?.filter((m) => shown(i.chainId, m.token));
    if (moved && moved.length !== i.moved?.length) {
      if (!moved.length && !i.call) return null;
      return { ...i, moved, token: moved[0]?.token ?? null, amount: moved[0]?.amount ?? '' };
    }
    return shown(i.chainId, i.token) ? i : null;
  };
  const items = snap.items.map(clean);
  return items.every((i, n) => i === snap.items[n])
    ? snap
    : { ...snap, items: items.filter((i): i is EvmHistoryItem => i !== null) };
}

function merge(prev: Snapshot | undefined, next: Snapshot): Snapshot {
  if (!prev || next.failedChains.length === 0) return next;
  const kept = prev.items.filter((i) => next.failedChains.includes(i.chainId));
  const items = [...next.items, ...kept].sort((a, b) => b.timestamp - a.timestamp);
  return { ...next, items };
}

export function useEvmHistory(
  address: string | null | undefined,
  enabled: boolean
): {
  items: EvmHistoryItem[];
  loading: boolean;
  failed: EvmChainRef[];
  unavailable: EvmChainRef[];
  refresh: () => void;
} {
  const scope = enabled && isEvmAddress(address) ? evmHistoryCacheKey(address) : null;
  const [state, setState] = useState<State>({
    scope: null,
    items: [],
    failed: [],
    unavailable: [],
    loading: false,
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => {
    if (scope) fetchedAt.delete(scope);
    setTick((t) => t + 1);
  }, [scope]);
  const version = useCustomEvmVersion();
  const prefs = useTokenPrefsVersion();

  // effect:audited - reads the explorer APIs (external system) per address scope on open and refresh; cleanup drops late responses
  useEffect(() => {
    if (!scope || !isEvmAddress(address)) return;
    let cancelled = false;
    const ctrl = new AbortController();
    let networks: EvmChainRef[] | null = null;
    const apply = (snap: Snapshot, loading: boolean) => {
      const list = networks;
      const on = list ? new Set(list.map((n) => n.chainId)) : null;
      const items = on ? snap.items.filter((i) => on.has(i.chainId)) : snap.items;
      const refs = (ids: readonly number[] = []) =>
        (list ?? []).filter((n) => ids.includes(n.chainId));
      setState((s) =>
        cancelled
          ? s
          : {
              scope,
              items,
              failed: refs(snap.failedChains),
              unavailable: refs(snap.unavailableChains),
              loading,
            }
      );
    };

    const run = async () => {
      try {
        if (!memCache.has(scope)) {
          const stored = await readPersisted(scope);
          if (cancelled) return;
          if (stored && !memCache.has(scope)) memCache.set(scope, stored);
        }
        const all = await allNetworks({ includeDisabled: false });
        if (cancelled) return;
        networks = all.map(({ chainId, name, testnet }) => ({ chainId, name, testnet }));
        const plan = await loadEvmTokenPlan(
          address,
          all.map((n) => n.chainId)
        );
        if (cancelled) return;
        const cached = memCache.get(scope);
        if (cached) memCache.set(scope, planned(cached, plan));
        const fresh = Date.now() - (fetchedAt.get(scope) ?? 0) < FRESH_MS;
        const skip = fresh || document.hidden;
        apply(memCache.get(scope) ?? { items: [], failedChains: [] }, !skip);
        if (skip) return;
        const res = await fetchEvmHistory(address, all, {
          signal: ctrl.signal,
          detected: plan.custom.filter((t) => t.detected),
        });
        if (cancelled) return;
        const snap = planned(merge(memCache.get(scope), res), plan);
        memCache.set(scope, snap);
        fetchedAt.set(scope, Date.now());
        persist(scope, snap);
        apply(snap, false);
      } catch {
        if (cancelled) return;
        apply({ items: memCache.get(scope)?.items ?? [], failedChains: [] }, false);
      }
    };

    void run();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [scope, address, tick, version, prefs]);

  if (!scope) return { items: EMPTY, loading: false, failed: NONE, unavailable: NONE, refresh };
  if (state.scope === scope) {
    return {
      items: state.items,
      loading: state.loading,
      failed: state.failed,
      unavailable: state.unavailable,
      refresh,
    };
  }
  return {
    items: memCache.get(scope)?.items ?? EMPTY,
    loading: true,
    failed: NONE,
    unavailable: NONE,
    refresh,
  };
}
