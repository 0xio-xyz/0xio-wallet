import { useCallback, useEffect, useRef, useState } from 'react';
import { useCustomEvmVersion } from 'src/hooks/wallet/useEvmBalances';
import {
  detectContract,
  isContractAddress,
  type DetectKind,
  type DetectMatch,
  type DetectResult,
} from 'src/services/evm/detect';
import type { EvmNetwork } from 'src/services/evm/networks';
import { loadRecentNetworks, noteRecentNetwork } from 'src/services/evm/recentNetworks';
import { allNetworks } from 'src/services/evm/registry';

export function useAllEvmNetworks(): EvmNetwork[] | null {
  const version = useCustomEvmVersion();
  const [list, setList] = useState<EvmNetwork[] | null>(null);
  // effect:audited - reads custom networks from chrome.storage (external system); reloads when they change
  useEffect(() => {
    let live = true;
    allNetworks()
      .then((l) => live && setList(l))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [version]);
  return list;
}

export type DetectPhase = 'idle' | 'detecting' | 'done';

interface DetectState {
  address: string;
  phase: DetectPhase;
  matches: DetectMatch[];
  unreachable: EvmNetwork[];
  asked: number;
}

const IDLE: DetectState = { address: '', phase: 'idle', matches: [], unreachable: [], asked: 0 };

export function useNetworkDetect(kind: DetectKind) {
  const all = useAllEvmNetworks();
  const [state, setState] = useState<DetectState>(IDLE);
  const [picked, setPicked] = useState<EvmNetwork | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [recent, setRecent] = useState<number[]>([]);
  const run = useRef(0);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    void loadRecentNetworks().then(setRecent);
  }, []);

  const closeSearch = useCallback(() => setSearchOpen(false), []);

  const reset = useCallback(() => {
    run.current++;
    setState(IDLE);
    setPicked(null);
    setSearchOpen(false);
  }, []);

  const start = useCallback(
    async (
      address: string,
      extra: { owner?: string | null; tokenId?: string | null } = {}
    ): Promise<DetectResult | null> => {
      const id = ++run.current;
      setPicked(null);
      setSearchOpen(false);
      if (!isContractAddress(address)) {
        setState(IDLE);
        return null;
      }
      const networks = await allNetworks();
      if (id !== run.current) return null;
      setState({
        address,
        phase: 'detecting',
        matches: [],
        unreachable: [],
        asked: networks.length,
      });
      const res = await detectContract(address, networks, { kind, ...extra });
      if (id !== run.current) return null;
      setState({ address, phase: 'done', ...res, asked: networks.length });
      if (res.matches.length === 0) openSearch();
      return res;
    },
    [kind, openSearch]
  );

  const pick = useCallback((network: EvmNetwork, remember = true) => {
    setPicked(network);
    setSearchOpen(false);
    if (remember) void noteRecentNetwork(network.chainId).then(setRecent);
  }, []);

  const network =
    picked ??
    (state.phase === 'done' && state.matches.length === 1 ? state.matches[0].network : null);
  const match = network
    ? (state.matches.find((m) => m.network.chainId === network.chainId) ?? null)
    : null;

  return {
    ...state,
    networks: all ?? [],
    network,
    match,
    start,
    reset,
    pick,
    searchOpen,
    openSearch,
    closeSearch,
    recent,
  };
}

export type NetworkDetect = ReturnType<typeof useNetworkDetect>;
