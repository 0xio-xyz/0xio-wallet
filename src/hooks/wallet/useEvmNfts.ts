import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvmNetworks } from 'src/hooks/wallet/useEvmBalances';
import { isEvmAddress } from 'src/services/evm/balances';
import type { EvmNetwork } from 'src/services/evm/networks';
import {
  collectEvmNfts,
  loadImportedNfts,
  nftKey,
  removeImportedNft,
  type EvmNft,
} from 'src/services/evm/nfts';
import { collectionSpamReason } from 'src/services/tokens/tokenSpam';
import {
  NO_HIDDEN,
  hideSpamCollections,
  loadHidden,
  pieceId,
  setCollectionHidden,
  setPieceHidden,
  type NftHidden,
} from 'src/features/wallet/nft/hidden';
import { registerSessionCache } from 'src/utils/sessionCaches';

const POLL_MS = 120_000;
const EMPTY: EvmNft[] = [];

interface Snapshot {
  items: EvmNft[];
  failedChains: number[];
}

interface State extends Snapshot {
  scope: string | null;
  loading: boolean;
}

export type EvmHiddenMap = Record<number, NftHidden>;

const memCache = new Map<string, Snapshot>();
const hiddenCache = new Map<string, EvmHiddenMap>();
registerSessionCache(() => {
  memCache.clear();
  hiddenCache.clear();
});

export const evmNftCacheKey = (octraNetworkId: string | null | undefined, address: string) =>
  `evm_nfts:${octraNetworkId === 'devnet' ? 'testnet' : 'mainnet'}:${address.toLowerCase()}`;

export const evmHiddenScope = (chainId: number, address: string) => ({
  networkId: `evm${chainId}`,
  wallet: address.toLowerCase(),
});

export function mergeNfts(prev: Snapshot | undefined, next: Snapshot): Snapshot {
  if (!prev || next.failedChains.length === 0) return next;
  const have = new Set(next.items.map(nftKey));
  const kept = prev.items.filter(
    (n) => next.failedChains.includes(n.chainId) && !have.has(nftKey(n))
  );
  return kept.length ? { ...next, items: [...next.items, ...kept] } : next;
}

export function spamCollectionsByChain(
  items: readonly EvmNft[],
  imported: Readonly<Record<number, readonly EvmNft[]>>
): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const n of items) {
    const mine = imported[n.chainId] ?? [];
    if (mine.some((x) => x.contract.toLowerCase() === n.contract.toLowerCase())) continue;
    if (!collectionSpamReason(n.collection)) continue;
    const list = (out[n.chainId] ??= []);
    if (!list.some((c) => c.toLowerCase() === n.contract.toLowerCase())) list.push(n.contract);
  }
  return out;
}

async function hideSpam(items: EvmNft[], networks: EvmNetwork[], address: string): Promise<void> {
  const imported = Object.fromEntries(
    await Promise.all(
      networks.map(async (n) => [n.chainId, await loadImportedNfts(n.chainId, address)] as const)
    )
  );
  const spam = spamCollectionsByChain(items, imported);
  await Promise.all(
    Object.entries(spam).map(([chainId, contracts]) => {
      const s = evmHiddenScope(Number(chainId), address);
      return hideSpamCollections(s.networkId, s.wallet, contracts).catch(() => NO_HIDDEN);
    })
  );
}

async function loadHiddenMap(networks: EvmNetwork[], address: string): Promise<EvmHiddenMap> {
  const entries = await Promise.all(
    networks.map(async (n) => {
      const s = evmHiddenScope(n.chainId, address);
      try {
        return [n.chainId, await loadHidden(s.networkId, s.wallet)] as const;
      } catch {
        return [n.chainId, NO_HIDDEN] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

export function useEvmNfts(
  address: string | null | undefined,
  octraNetworkId: string | null | undefined,
  enabled: boolean
) {
  const { networks, ready } = useEvmNetworks(octraNetworkId);
  const active = enabled && isEvmAddress(address);
  const scope = active ? evmNftCacheKey(octraNetworkId, address) : null;
  const [state, setState] = useState<State>({
    scope: null,
    items: [],
    failedChains: [],
    loading: false,
  });
  const [hidden, setHidden] = useState<{ scope: string | null; map: EvmHiddenMap }>({
    scope: null,
    map: {},
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  // effect:audited - reads the NFT index and chain RPCs (external systems) per side and address; cleanup drops late answers
  useEffect(() => {
    if (!scope || !ready || !isEvmAddress(address)) return;
    let cancelled = false;
    let inFlight = false;
    const ctrl = new AbortController();
    const chains = new Set(networks.map((n) => n.chainId));
    const apply = (snap: Snapshot, loading: boolean) =>
      setState((s) =>
        cancelled
          ? s
          : {
              items: snap.items.filter((n) => chains.has(n.chainId)),
              failedChains: snap.failedChains,
              scope,
              loading,
            }
      );

    const run = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        apply(memCache.get(scope) ?? { items: [], failedChains: [] }, true);
        const res = await collectEvmNfts(address, networks, { signal: ctrl.signal });
        if (cancelled) return;
        await hideSpam(res.items, networks, address);
        const map = await loadHiddenMap(networks, address);
        if (cancelled) return;
        const snap = mergeNfts(memCache.get(scope), res);
        memCache.set(scope, snap);
        hiddenCache.set(scope, map);
        setHidden({ scope, map });
        apply(snap, false);
      } catch {
        if (cancelled) return;
        apply(
          {
            items: memCache.get(scope)?.items ?? [],
            failedChains: networks.map((n) => n.chainId),
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
  }, [scope, address, networks, ready, tick]);

  const current: Snapshot & { loading: boolean } = !scope
    ? { items: EMPTY, failedChains: [], loading: false }
    : state.scope === scope
      ? state
      : { ...(memCache.get(scope) ?? { items: EMPTY, failedChains: [] }), loading: true };
  const hiddenMap: EvmHiddenMap =
    scope && hidden.scope === scope ? hidden.map : ((scope && hiddenCache.get(scope)) ?? {});

  const writeHidden = async (
    chainId: number,
    next: NftHidden,
    write: () => Promise<NftHidden>
  ): Promise<boolean> => {
    if (!scope) return false;
    const before = hiddenMap;
    setHidden({ scope, map: { ...before, [chainId]: next } });
    try {
      const saved = await write();
      const latest = hiddenRef.current.scope === scope ? hiddenRef.current.map : before;
      const map = { ...latest, [chainId]: saved };
      hiddenCache.set(scope, map);
      setHidden({ scope, map });
      return true;
    } catch {
      setHidden({ scope, map: before });
      return false;
    }
  };

  const hidePiece = (n: Pick<EvmNft, 'chainId' | 'contract' | 'tokenId'>, hide: boolean) => {
    if (!isEvmAddress(address)) return Promise.resolve(false);
    const h = hiddenMap[n.chainId] ?? NO_HIDDEN;
    const id = pieceId(n.contract, n.tokenId);
    const rest = h.pieces.filter((k) => k !== id);
    const s = evmHiddenScope(n.chainId, address);
    return writeHidden(n.chainId, { ...h, pieces: hide ? [...rest, id] : rest }, () =>
      setPieceHidden(s.networkId, s.wallet, n.contract, n.tokenId, hide)
    );
  };

  const hideCollection = (chainId: number, contract: string, hide: boolean) => {
    if (!isEvmAddress(address)) return Promise.resolve(false);
    const h = hiddenMap[chainId] ?? NO_HIDDEN;
    const rest = h.collections.filter((a) => a.toLowerCase() !== contract.toLowerCase());
    const s = evmHiddenScope(chainId, address);
    return writeHidden(chainId, { ...h, collections: hide ? [...rest, contract] : rest }, () =>
      setCollectionHidden(s.networkId, s.wallet, contract, hide)
    );
  };

  const dropItem = (n: EvmNft, sent: bigint = BigInt(n.amount)) => {
    if (!scope || !isEvmAddress(address)) return;
    const k = nftKey(n);
    const left = BigInt(n.amount) - sent;
    const update = (items: EvmNft[]) =>
      left > 0n
        ? items.map((x) => (nftKey(x) === k ? { ...x, amount: left.toString() } : x))
        : items.filter((x) => nftKey(x) !== k);
    const cached = memCache.get(scope);
    if (cached) memCache.set(scope, { ...cached, items: update(cached.items) });
    setState((s) => (s.scope === scope ? { ...s, items: update(s.items) } : s));
    if (left <= 0n) void removeImportedNft(address, n).catch(() => {});
  };

  return {
    items: current.items,
    failedChains: current.failedChains,
    loading: current.loading,
    networks,
    hidden: hiddenMap,
    refresh,
    hidePiece,
    hideCollection,
    dropItem,
  };
}

export type EvmNftsState = ReturnType<typeof useEvmNfts>;
