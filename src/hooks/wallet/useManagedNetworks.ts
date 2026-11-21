import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomEvmVersion } from 'src/hooks/wallet/useEvmBalances';
import {
  allNetworksFor,
  findNetwork,
  setNetworkEnabled,
  type ManagedEvmNetwork,
} from 'src/services/evm/registry';

type Side = 'mainnet' | 'devnet';

export function useManagedEvmNetworks(octraNetworkId: string | null | undefined) {
  const version = useCustomEvmVersion();
  const side: Side = octraNetworkId === 'devnet' ? 'devnet' : 'mainnet';
  const [state, setState] = useState<{ side: Side; list: ManagedEvmNetwork[] } | null>(null);
  const [reload, setReload] = useState(0);

  // effect:audited - reads networks and their settings from chrome.storage (external system) per side; drops a late answer after a switch
  useEffect(() => {
    let live = true;
    allNetworksFor(side, { includeDisabled: true })
      .then((list) => {
        if (live) setState({ side, list });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [side, version, reload]);

  const setEnabled = useCallback(async (chainId: number, enabled: boolean) => {
    setState((s) =>
      s ? { ...s, list: s.list.map((n) => (n.chainId === chainId ? { ...n, enabled } : n)) } : s
    );
    try {
      await setNetworkEnabled(chainId, enabled);
      return true;
    } catch {
      setReload((r) => r + 1);
      return false;
    }
  }, []);

  return { networks: state?.side === side ? state.list : null, setEnabled };
}

export function useSettledOrder(list: ManagedEvmNetwork[] | null): ManagedEvmNetwork[] | null {
  const order = useRef<number[] | null>(null);
  return useMemo(() => {
    if (!list) return null;
    const byId = new Map(list.map((n) => [n.chainId, n]));
    const next = (order.current ?? []).filter((id) => byId.has(id));
    const known = new Set(next);
    const fresh = list.filter((n) => !known.has(n.chainId));
    for (const n of fresh.filter((f) => f.enabled)) {
      let at = 0;
      next.forEach((id, i) => {
        if (byId.get(id)?.enabled) at = i + 1;
      });
      next.splice(at, 0, n.chainId);
    }
    for (const n of fresh.filter((f) => !f.enabled)) next.push(n.chainId);
    order.current = next;
    return next.map((id) => byId.get(id)).filter((n): n is ManagedEvmNetwork => !!n);
  }, [list]);
}

export function useManagedEvmNetwork(chainId: number | null) {
  const version = useCustomEvmVersion();
  const [state, setState] = useState<{ chainId: number | null; network: ManagedEvmNetwork | null }>(
    { chainId: null, network: null }
  );
  const [reload, setReload] = useState(0);

  // effect:audited - reads one network and its settings from chrome.storage (external system); reloads when they change
  useEffect(() => {
    if (chainId === null) return;
    let live = true;
    findNetwork(chainId)
      .then((network) => {
        if (live) setState({ chainId, network });
      })
      .catch(() => {
        if (live) setState({ chainId, network: null });
      });
    return () => {
      live = false;
    };
  }, [chainId, version, reload]);

  const change = useCallback(
    async (shown: Partial<ManagedEvmNetwork>, write: () => Promise<unknown>): Promise<boolean> => {
      setState((s) => (s.network ? { ...s, network: { ...s.network, ...shown } } : s));
      try {
        await write();
        return true;
      } catch {
        setReload((r) => r + 1);
        return false;
      }
    },
    []
  );

  const loaded = chainId !== null && state.chainId === chainId;
  return {
    network: loaded ? state.network : null,
    loaded: loaded || chainId === null,
    change,
  };
}
