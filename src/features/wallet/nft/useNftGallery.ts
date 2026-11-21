import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from 'src/contexts/WalletContext';
import { logger } from 'src/utils/logger';
import {
  type NftCollection,
  OWNED_IDS_TTL,
  SNAPSHOT_FRESH_MS,
  _snapshotCtx,
  cardDetailCache,
  fetchGalleryCollections,
  getImportedNftAddresses,
  hydrateNftCaches,
  loadNftSnapshot,
  ownedIdsCache,
  saveImportedNftAddresses,
  scheduleSnapshotSave,
  setSnapshotCtx,
} from 'src/features/wallet/nft/nftData';
import {
  type NftHidden,
  NO_HIDDEN,
  hideSpamCollections,
  isCollectionHidden,
  loadHidden,
  pieceId,
  setCollectionHidden,
  setPieceHidden,
} from 'src/features/wallet/nft/hidden';
import {
  type FirstSeenMap,
  hydrateFirstSeen,
  stampFirstSeen,
} from 'src/features/wallet/nft/firstSeen';
import { pieceCacheKey } from 'src/features/wallet/nft/piece/pieceData';
import { joinOwnedScan, ownedIdsKey as idsKey } from 'src/features/wallet/nft/ownedScan';
import { collectionSpamReason } from 'src/services/tokens/tokenSpam';

const lc = (a: string) => a.toLowerCase();
const POLL_MS = 60_000;

const whenVisible = () =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', check);
      resolve();
    };
    document.addEventListener('visibilitychange', check);
    check();
  });

export function useNftGallery() {
  const { activeWallet, networkId } = useWallet();
  const wallet = activeWallet?.address ?? '';

  const [collections, setCollections] = useState<NftCollection[]>([]);
  const [ids, setIds] = useState<Record<string, string[]>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [hidden, setHidden] = useState<NftHidden>(NO_HIDDEN);
  const [firstSeen, setFirstSeen] = useState<FirstSeenMap>({});
  const [scanNonce, setScanNonce] = useState(0);

  const collectionsRef = useRef(collections);
  collectionsRef.current = collections;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const fetchingRef = useRef<string | null>(null);
  const loadEpochRef = useRef(0);
  const settledRef = useRef(false);
  const lastLoadRef = useRef(0);

  const loadCollections = useCallback(async () => {
    if (!wallet || !networkId) return;
    const myEpoch = ++loadEpochRef.current;
    fetchingRef.current = networkId;
    lastLoadRef.current = Date.now();
    try {
      if (collectionsRef.current.length === 0) {
        const seed = (await getImportedNftAddresses(networkId, wallet)).map(
          (addr): NftCollection => ({
            contractAddress: addr,
            name: `${addr.slice(0, 6)}…${addr.slice(-4)}`,
            symbol: '',
            totalSupply: null,
            ownedCount: 0,
            ownedTokenIds: [],
            imported: true,
          })
        );
        if (loadEpochRef.current !== myEpoch) return;
        if (seed.length) setCollections((prev) => (prev.length ? prev : seed));
      }
      const prevByAddr = new Map(collectionsRef.current.map((c) => [c.contractAddress, c]));
      const result = await fetchGalleryCollections(networkId, wallet, prevByAddr);
      if (loadEpochRef.current !== myEpoch) return;
      setCollections(result);
      if (_snapshotCtx) _snapshotCtx.collections = result;
      scheduleSnapshotSave();
      const spam = result
        .filter((c) => !c.imported && collectionSpamReason(c.name))
        .map((c) => c.contractAddress);
      if (spam.length) {
        const h = await hideSpamCollections(networkId, wallet, spam);
        if (loadEpochRef.current === myEpoch) setHidden(h);
      }
    } catch (err) {
      logger.error('[NFT] loadCollections failed:', err);
    } finally {
      if (loadEpochRef.current === myEpoch) {
        fetchingRef.current = null;
        settledRef.current = true;
        setInitialLoading(false);
      }
    }
  }, [wallet, networkId]);

  // effect:audited - per network and wallet: drop the previous state, hydrate the snapshot for an
  // instant reopen, load hidden and first-seen, refresh, then poll every 60 seconds; skipped while
  // hidden, and coming back after more than 60 seconds refreshes once.
  useEffect(() => {
    if (!wallet || !networkId) return;
    let alive = true;
    setSnapshotCtx({ networkId, wallet, collections: [] });
    collectionsRef.current = [];
    settledRef.current = false;
    lastLoadRef.current = Date.now();
    setCollections([]);
    setIds({});
    setFailed({});
    setHidden(NO_HIDDEN);
    setInitialLoading(true);
    void loadHidden(networkId, wallet)
      .then((h) => alive && setHidden(h))
      .catch(() => {});
    void hydrateFirstSeen().then((m) => alive && setFirstSeen(m));
    void (async () => {
      const snap = await loadNftSnapshot(networkId, wallet);
      if (!alive) return;
      let fresh = false;
      if (snap && snap.collections.length > 0) {
        hydrateNftCaches(networkId, wallet, snap);
        const hydrated = snap.collections.map((c) => ({
          ...c,
          ownedCount: snap.owned[c.contractAddress]?.length || c.ownedCount,
        }));
        setCollections(hydrated);
        settledRef.current = true;
        setInitialLoading(false);
        setSnapshotCtx({ networkId, wallet, collections: hydrated });
        fresh = Date.now() - (snap.ts || 0) < SNAPSHOT_FRESH_MS;
        if (fresh) lastLoadRef.current = snap.ts;
      }
      if (!fresh) await loadCollections();
      else setInitialLoading(false);
    })();
    const interval = setInterval(() => {
      if (!document.hidden && fetchingRef.current === null) void loadCollections();
    }, POLL_MS);
    const onVisible = () => {
      if (document.hidden || fetchingRef.current !== null) return;
      if (Date.now() - lastLoadRef.current >= POLL_MS) void loadCollections();
    };
    document.addEventListener('visibilitychange', onVisible);
    const epoch = loadEpochRef;
    return () => {
      alive = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      epoch.current++;
      fetchingRef.current = null;
    };
  }, [wallet, networkId, loadCollections]);

  // effect:audited - owned ids per collection, one collection at a time: parallel owner_of scans on
  // top of the popup's opening burst trip octra.network's rate limit into empty answers. Visible
  // collections go first, hidden ones last. Cached ids (OWNED_IDS_TTL, same count) cost nothing;
  // older ones with the same count are asked for by id before any scan. A scan is shared with any
  // other user of this hook, and none starts while the page is hidden.
  const collKey = collections.map((c) => `${c.contractAddress}:${c.ownedCount}`).join(',');
  useEffect(() => {
    if (!wallet || !networkId) return;
    if (collectionsRef.current.length === 0 && !settledRef.current) return;
    let cancelled = false;
    let leave: (() => void) | null = null;
    const list = [...collectionsRef.current].sort(
      (a, b) =>
        Number(isCollectionHidden(hiddenRef.current, a.contractAddress)) -
        Number(isCollectionHidden(hiddenRef.current, b.contractAddress))
    );
    const initial: Record<string, string[]> = {};
    for (const c of list) {
      const hit = ownedIdsCache.get(idsKey(networkId, c.contractAddress, wallet));
      if (hit) initial[c.contractAddress] = hit.ids;
    }
    setIds(initial);
    void (async () => {
      const found: Record<string, string[]> = { ...initial };
      for (const c of list) {
        if (cancelled) return;
        const ck = idsKey(networkId, c.contractAddress, wallet);
        const hit = ownedIdsCache.get(ck);
        if (hit && Date.now() - hit.ts < OWNED_IDS_TTL && hit.count === c.ownedCount) {
          if (found[c.contractAddress] !== hit.ids) {
            found[c.contractAddress] = hit.ids;
            setIds((prev) => ({ ...prev, [c.contractAddress]: hit.ids }));
          }
          continue;
        }
        if (document.hidden) await whenVisible();
        if (cancelled) return;
        const scan = joinOwnedScan(networkId, wallet, c);
        leave = scan.leave;
        const settled = await scan.result;
        scan.leave();
        if (cancelled || !settled) return;
        const next = settled.ids;
        if (next) found[c.contractAddress] = next;
        setIds((prev) => {
          const out = { ...prev };
          if (next) out[c.contractAddress] = next;
          return out;
        });
        setFailed((prev) => ({ ...prev, [c.contractAddress]: settled.failed }));
      }
      if (cancelled) return;
      await hydrateFirstSeen();
      if (cancelled) return;
      const pieces = Object.entries(found).flatMap(([contract, list]) =>
        list.map((tokenId) => ({ contract, tokenId }))
      );
      setFirstSeen(stampFirstSeen(networkId, wallet, pieces));
    })();
    return () => {
      cancelled = true;
      leave?.();
    };
  }, [collKey, wallet, networkId, scanNonce, initialLoading]);

  const retryScan = () => setScanNonce((n) => n + 1);

  const dropPiece = (contract: string, tokenId: string) => {
    const ck = idsKey(networkId, contract, wallet);
    const hit = ownedIdsCache.get(ck);
    if (hit) ownedIdsCache.set(ck, { ...hit, ids: hit.ids.filter((x) => x !== tokenId) });
    cardDetailCache.delete(pieceCacheKey(networkId, contract, tokenId, wallet));
    scheduleSnapshotSave();
    setIds((prev) =>
      prev[contract] ? { ...prev, [contract]: prev[contract].filter((x) => x !== tokenId) } : prev
    );
    setCollections((prev) =>
      prev.map((c) =>
        c.contractAddress === contract ? { ...c, ownedCount: Math.max(0, c.ownedCount - 1) } : c
      )
    );
  };

  const reload = () => {
    if (fetchingRef.current === null) void loadCollections();
  };

  const applyHidden = async (next: NftHidden, write: () => Promise<NftHidden>) => {
    const before = hiddenRef.current;
    setHidden(next);
    try {
      setHidden(await write());
      return true;
    } catch {
      setHidden(before);
      return false;
    }
  };

  const hideCollection = (contract: string, hide: boolean) => {
    const h = hiddenRef.current;
    const rest = h.collections.filter((a) => lc(a) !== lc(contract));
    return applyHidden({ ...h, collections: hide ? [...rest, contract] : rest }, () =>
      setCollectionHidden(networkId, wallet, contract, hide)
    );
  };

  const hidePiece = (contract: string, tokenId: string, hide: boolean) => {
    const h = hiddenRef.current;
    const id = pieceId(contract, tokenId);
    const rest = h.pieces.filter((k) => k !== id);
    return applyHidden({ ...h, pieces: hide ? [...rest, id] : rest }, () =>
      setPieceHidden(networkId, wallet, contract, tokenId, hide)
    );
  };

  const importCollection = async (address: string) => {
    if (!wallet || !networkId) return;
    const existing = await getImportedNftAddresses(networkId, wallet);
    if (!existing.some((a) => lc(a) === lc(address))) {
      await saveImportedNftAddresses(networkId, wallet, [...existing, address]);
    }
    if (isCollectionHidden(hiddenRef.current, address)) await hideCollection(address, false);
    await loadCollections();
  };

  return {
    networkId,
    wallet,
    collections,
    ids,
    failed,
    initialLoading,
    hidden,
    firstSeen,
    retryScan,
    dropPiece,
    reload,
    hideCollection,
    hidePiece,
    importCollection,
  };
}
