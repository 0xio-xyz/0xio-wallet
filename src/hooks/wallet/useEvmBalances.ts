import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  evmTokenKey,
  fetchEvmBalances,
  isEvmAddress,
  type EvmBalanceRow,
} from 'src/services/evm/balances';
import { evmNetworksFor, type EvmNetwork } from 'src/services/evm/networks';
import { NETWORK_PREFS_KEY } from 'src/services/evm/networkPrefs';
import { CUSTOM_NETWORKS_KEY, networksFor } from 'src/services/evm/registry';
import { CUSTOM_TOKENS_KEY } from 'src/services/evm/tokens';
import { loadEvmTokenPlan, type EvmTokenPlan } from 'src/services/evm/detectedTokens';
import { evmVisKey, peekVisibility } from 'src/services/tokens/tokenVisibility';
import { useTokenPrefsVersion } from 'src/hooks/wallet/useTokenPrefs';
import { registerSessionCache } from 'src/utils/sessionCaches';
import { registerScopeWarmer } from 'src/utils/scopeWarmers';

const POLL_MS = 30_000;
const EMPTY_ROWS: EvmBalanceRow[] = [];
const EMPTY_FAILED: number[] = [];
const NO_NETWORKS: EvmNetwork[] = [];

interface Snapshot {
  rows: EvmBalanceRow[];
  failedChains: number[];
  at: number;
}

interface State extends Snapshot {
  scope: string | null;
  loading: boolean;
}

const memCache = new Map<string, Snapshot>();
const planCache = new Map<string, EvmTokenPlan>();
registerSessionCache(() => {
  memCache.clear();
  planCache.clear();
});

export const evmBalanceCacheKey = (octraNetworkId: string | null | undefined, address: string) =>
  `evm_bal:${octraNetworkId}:${address.toLowerCase()}`;

function isSnapshot(value: unknown): value is Snapshot {
  const v = value as Snapshot | null;
  return !!v && Array.isArray(v.rows) && Array.isArray(v.failedChains) && typeof v.at === 'number';
}

export function evmRowShown(
  row: Pick<EvmBalanceRow, 'chainId' | 'token'>,
  address: string,
  plan: EvmTokenPlan | undefined
): boolean {
  if (row.token.address === null) return true;
  const c = row.token.address.toLowerCase();
  if (peekVisibility(evmVisKey(row.chainId, address))?.[c] === false) return false;
  return !plan || plan.shown.has(evmTokenKey(row.chainId, row.token));
}

function keepShown(
  rows: EvmBalanceRow[],
  address: string,
  plan: EvmTokenPlan | undefined
): EvmBalanceRow[] {
  return rows.every((r) => evmRowShown(r, address, plan))
    ? rows
    : rows.filter((r) => evmRowShown(r, address, plan));
}

export async function readEvmBalanceSnapshot(
  octraNetworkId: string | null | undefined,
  address: string
): Promise<EvmBalanceRow[]> {
  const key = evmBalanceCacheKey(octraNetworkId, address);
  const snap = memCache.get(key) ?? (await readPersisted(key));
  return snap?.rows ?? [];
}

async function readPersisted(key: string): Promise<Snapshot | null> {
  try {
    const stored = await chrome.storage.local.get([key]);
    return isSnapshot(stored?.[key]) ? stored[key] : null;
  } catch {
    return null;
  }
}

registerScopeWarmer(async ({ networkId, wallet }) => {
  const address = wallet.metadata?.evm?.address;
  if (!isEvmAddress(address)) return;
  const key = evmBalanceCacheKey(networkId, address);
  if (memCache.has(key)) return;
  const stored = await readPersisted(key);
  if (stored && !memCache.has(key)) memCache.set(key, stored);
});

function persist(key: string, snap: Snapshot) {
  try {
    chrome.storage.local.set({ [key]: snap }).catch(() => {});
  } catch {}
}

export function merge(
  prev: Snapshot | undefined,
  rows: EvmBalanceRow[],
  failedChains: number[],
  failedTokens: string[] = []
): EvmBalanceRow[] {
  if (!prev || (failedChains.length === 0 && failedTokens.length === 0)) return rows;
  const kept = prev.rows.filter(
    (r) =>
      failedChains.includes(r.chainId) || failedTokens.includes(evmTokenKey(r.chainId, r.token))
  );
  return kept.length ? [...rows, ...kept] : rows;
}

export function useCustomEvmVersion(): number {
  const [version, setVersion] = useState(0);
  // effect:audited - subscribes to chrome.storage (external system) so networks and tokens added in Settings or by a site show without a reload
  useEffect(() => {
    const changed = globalThis.chrome?.storage?.onChanged;
    if (!changed) return;
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (
        area === 'local' &&
        (CUSTOM_NETWORKS_KEY in changes ||
          NETWORK_PREFS_KEY in changes ||
          CUSTOM_TOKENS_KEY in changes)
      ) {
        setVersion((v) => v + 1);
      }
    };
    changed.addListener(listener);
    return () => changed.removeListener(listener);
  }, []);
  return version;
}

const netCache = new Map<string, EvmNetwork[]>();
const netKey = (list: EvmNetwork[]) => list.map((n) => JSON.stringify(n)).join(',');

export function useEvmNetworks(octraNetworkId: string | null | undefined): {
  networks: EvmNetwork[];
  ready: boolean;
  version: number;
} {
  const version = useCustomEvmVersion();
  const side = octraNetworkId === 'devnet' ? 'devnet' : 'mainnet';
  const builtins = useMemo(() => evmNetworksFor(side), [side]);
  const [loaded, setLoaded] = useState<{ side: string; list: EvmNetwork[] } | null>(() => {
    const cached = netCache.get(side);
    return cached ? { side, list: cached } : null;
  });

  // effect:audited - reads custom networks from chrome.storage (external system) per Mainnet/Testnet side; drops a late answer after a switch
  useEffect(() => {
    let live = true;
    networksFor(side)
      .then((list) => {
        if (!live) return;
        const prev = netCache.get(side);
        const next = prev && netKey(prev) === netKey(list) ? prev : list;
        netCache.set(side, next);
        setLoaded((s) => (s?.side === side && s.list === next ? s : { side, list: next }));
      })
      .catch(() => {
        if (live) setLoaded((s) => (s?.side === side ? s : { side, list: builtins }));
      });
    return () => {
      live = false;
    };
  }, [side, version, builtins]);

  return loaded?.side === side
    ? { networks: loaded.list, ready: true, version }
    : { networks: NO_NETWORKS, ready: false, version };
}

export function useEvmBalances(
  address: string | null | undefined,
  octraNetworkId: string | null | undefined,
  enabled: boolean
): {
  rows: EvmBalanceRow[];
  loading: boolean;
  failedChains: number[];
  refresh: () => void;
  networks: EvmNetwork[];
} {
  const { networks, ready, version } = useEvmNetworks(octraNetworkId);
  const prefs = useTokenPrefsVersion();
  const active = enabled && isEvmAddress(address);
  const scope = active ? evmBalanceCacheKey(octraNetworkId, address) : null;
  const [state, setState] = useState<State>({
    scope: null,
    rows: [],
    failedChains: [],
    at: 0,
    loading: false,
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // effect:audited - polls EVM RPCs (external system) per network+address scope; cleanup drops late responses
  useEffect(() => {
    if (!scope || !ready || !isEvmAddress(address)) return;
    let cancelled = false;
    let inFlight = false;
    const ctrl = new AbortController();
    const live = () => !cancelled;

    const chains = new Set(networks.map((n) => n.chainId));
    const shown = (r: EvmBalanceRow) =>
      chains.has(r.chainId) && evmRowShown(r, address, planCache.get(scope));
    const apply = (snap: Snapshot, loading: boolean) => {
      const rows = snap.rows.filter(shown);
      setState((s) => (live() ? { ...snap, rows, scope, loading } : s));
    };

    const run = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        if (!memCache.has(scope)) {
          const stored = await readPersisted(scope);
          if (!live()) return;
          if (stored && !memCache.has(scope)) memCache.set(scope, stored);
        }
        const plan = await loadEvmTokenPlan(
          address,
          networks.map((n) => n.chainId)
        );
        if (!live()) return;
        planCache.set(scope, plan);
        const cached = memCache.get(scope) ?? { rows: [], failedChains: [], at: 0 };
        apply(cached, true);
        const res = await fetchEvmBalances(address, networks, {
          signal: ctrl.signal,
          custom: plan.custom,
          exclude: plan.exclude,
        });
        if (!live()) return;
        const snap: Snapshot = {
          rows: merge(memCache.get(scope), res.rows, res.failedChains, res.failedTokens).filter(
            (r) => evmRowShown(r, address, plan)
          ),
          failedChains: res.failedChains,
          at: Date.now(),
        };
        memCache.set(scope, snap);
        persist(scope, snap);
        apply(snap, false);
      } catch {
        if (!live()) return;
        const cached = memCache.get(scope);
        apply(
          {
            rows: cached?.rows ?? [],
            failedChains: networks.map((n) => n.chainId),
            at: cached?.at ?? 0,
          },
          false
        );
      } finally {
        inFlight = false;
      }
    };

    const onVisible = () => {
      if (!document.hidden) void run();
    };
    void run();
    const timer = setInterval(run, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [scope, address, networks, ready, tick, version, prefs]);

  if (!scope || !isEvmAddress(address)) {
    return { rows: EMPTY_ROWS, loading: false, failedChains: EMPTY_FAILED, refresh, networks };
  }
  const plan = planCache.get(scope);
  if (state.scope === scope) {
    return {
      rows: keepShown(state.rows, address, plan),
      loading: state.loading,
      failedChains: state.failedChains,
      refresh,
      networks,
    };
  }
  const cached = memCache.get(scope);
  const on = new Set(networks.map((n) => n.chainId));
  return {
    rows:
      ready && cached
        ? cached.rows.filter((r) => on.has(r.chainId) && evmRowShown(r, address, plan))
        : EMPTY_ROWS,
    loading: true,
    failedChains: ready && cached ? cached.failedChains.filter((c) => on.has(c)) : EMPTY_FAILED,
    refresh,
    networks,
  };
}
