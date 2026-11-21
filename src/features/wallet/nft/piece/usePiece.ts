import { useEffect, useRef, useState } from 'react';
import { useWallet } from 'src/contexts/WalletContext';
import { logger } from 'src/utils/logger';
import { xpectrumConfig } from 'src/features/wallet/nft/xpectrum/config';
import type { Listing } from 'src/features/wallet/nft/xpectrum/market';
import { isSafePosterDataUrl } from 'src/features/wallet/nft/euint/LivingNftFrame';
import {
  getPoster,
  onPosterSaved,
  posterKey,
  savePoster,
} from 'src/features/wallet/nft/euint/posterCache';
import { posterQueue } from 'src/features/wallet/nft/euint/posterQueue';
import { isRevertError } from 'src/features/wallet/nft/euint/chainState';
import {
  type NftTokenDetail,
  CARD_DETAIL_TTL,
  cardDetailCache,
  isLivingProgramUri,
  scheduleSnapshotSave,
} from 'src/features/wallet/nft/nftData';
import { useOnsContract } from 'src/hooks/wallet/useOnsContract';
import { onsContractFor } from 'src/services/names/ons';
import { useOnsPiece } from 'src/features/wallet/nft/useOnsPiece';
import {
  type BiontAttrs,
  emptyDetail,
  imageBlobUrl,
  onPieceRefreshed,
  peekImageBlobUrl,
  pieceCacheKey,
  readListing,
  refreshPiece,
  resolvePiece,
} from 'src/features/wallet/nft/piece/pieceData';

interface Options {
  onGone?: () => void;
  readMarket?: boolean;
  capturePoster?: boolean;
  checkOwner?: boolean;
}

const isName = async (networkId: string, contract: string) =>
  (await onsContractFor(networkId).catch((): null => null)) === contract;

export function usePiece(contract: string, tokenId: string, opts: Options = {}) {
  const { networkId, activeWallet } = useWallet();
  const wallet = activeWallet?.address ?? '';
  const key = pieceCacheKey(networkId, contract, tokenId, wallet);
  const market = xpectrumConfig(networkId)?.market ?? null;
  const onGone = useRef(opts.onGone);
  onGone.current = opts.onGone;
  const isOns = useOnsContract(networkId) === contract;
  const held = useOnsPiece(networkId, contract, tokenId, wallet, !!opts.checkOwner);
  const [lapsed, setLapsed] = useState<string | null>(null);
  const ons =
    held && lapsed === key ? { ...held, active: false, inactive: true, expired: true } : held;

  const [detail, setDetail] = useState<NftTokenDetail>(
    () => cardDetailCache.get(key)?.detail ?? emptyDetail(tokenId)
  );
  const [biontAttrs, setBiontAttrs] = useState<BiontAttrs | null>(
    () => cardDetailCache.get(key)?.biontAttrs ?? null
  );
  const [listing, setListing] = useState<Listing | null>(
    () => cardDetailCache.get(key)?.listing ?? null
  );
  const [marketApproved, setMarketApproved] = useState(
    () => cardDetailCache.get(key)?.marketApproved ?? false
  );
  const [blob, setBlob] = useState<{ from: string; url: string | null; failed: boolean } | null>(
    () => {
      const from = cardDetailCache.get(key)?.detail.image;
      const url = peekImageBlobUrl(from);
      return from && url ? { from, url, failed: false } : null;
    }
  );
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [burned, setBurned] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const refreshRunning = useRef(false);

  const cacheMarketState = (patch: { listing?: Listing | null; marketApproved?: boolean }) => {
    const prev = cardDetailCache.get(key);
    cardDetailCache.set(key, { ...(prev ?? { detail, biontAttrs }), ...patch, ts: Date.now() });
    scheduleSnapshotSave();
  };

  const adoptPoster = (dataUrl: string) => {
    setDetail((d) => (d.poster === dataUrl ? d : { ...d, poster: dataUrl }));
    const prev = cardDetailCache.get(key);
    if (prev && prev.detail.poster !== dataUrl) {
      cardDetailCache.set(key, {
        ...prev,
        detail: { ...prev.detail, poster: dataUrl },
        ts: Date.now(),
      });
      scheduleSnapshotSave();
    }
  };

  const cachePoster = (dataUrl: string) => {
    if (!isSafePosterDataUrl(dataUrl) || detail.poster === dataUrl) return;
    void savePoster(networkId, contract, tokenId, dataUrl);
    adoptPoster(dataUrl);
  };

  const refresh = () => {
    setBlob(null);
    setDetail((p) => ({ ...p, metaFetched: false }));
    setRefreshNonce((n) => n + 1);
  };

  const refreshMetadata = async () => {
    if (refreshRunning.current) return;
    refreshRunning.current = true;
    setRefreshing(true);
    try {
      await refreshPiece(networkId, contract, tokenId, wallet);
    } catch (e) {
      logger.warn(`[NFT Piece] metadata refresh failed #${tokenId}: ${e}`);
      if (isRevertError(e)) {
        if (await isName(networkId, contract)) {
          setLapsed(key);
        } else {
          cardDetailCache.delete(key);
          setBurned(true);
          onGone.current?.();
        }
      }
    } finally {
      refreshRunning.current = false;
      setRefreshing(false);
    }
  };

  // effect:audited - a metadata refresh run anywhere reaches every tile showing the piece.
  useEffect(
    () =>
      onPieceRefreshed((k, r) => {
        if (k !== key) return;
        setDetail(r.detail);
        setBiontAttrs(r.biontAttrs);
        setBlob(
          r.detail.image && r.imageUrl
            ? { from: r.detail.image, url: r.imageUrl, failed: false }
            : null
        );
        setRevision((n) => n + 1);
      }),
    [key]
  );

  // effect:audited - the remote image becomes a blob URL; re-runs when the metadata names another.
  useEffect(() => {
    const src = detail.image;
    if (!src) return;
    let alive = true;
    imageBlobUrl(src)
      .then((url) => alive && setBlob({ from: src, url, failed: false }))
      .catch(() => {
        if (!alive) return;
        logger.warn(`[NFT Piece] image fetch failed #${tokenId}`);
        setBlob({ from: src, url: null, failed: true });
      });
    return () => {
      alive = false;
    };
  }, [detail.image, tokenId]);

  // effect:audited - brings a living piece's poster back from disk once the metadata says it is
  // one; animationUrl arrives after the resolve, so this cannot run on mount alone.
  const isLiving = !isOns && isLivingProgramUri(detail.animationUrl);
  useEffect(() => {
    if (!isLiving || detail.poster) return;
    let alive = true;
    void getPoster(networkId, contract, tokenId).then((p) => {
      if (alive && p) setDetail((d) => (d.poster ? d : { ...d, poster: p }));
    });
    return () => {
      alive = false;
    };
  }, [isLiving, detail.poster, networkId, contract, tokenId]);

  // effect:audited - the listing for the tile's price tag. A node that does not answer keeps the
  // last known listing; only a read that answered clears it.
  const readMarket = !!opts.readMarket && !isOns;
  useEffect(() => {
    if (!readMarket || !market) return;
    let alive = true;
    readListing(market, contract, tokenId)
      .then((l) => {
        if (!alive) return;
        setListing(l);
        const prev = cardDetailCache.get(key);
        if (prev) cardDetailCache.set(key, { ...prev, listing: l });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [readMarket, market, contract, tokenId, key]);

  // effect:audited - resolves token_uri and metadata unless a fresh cached card is shown already;
  // refresh() forces it. A revert means burned: the piece leaves the gallery.
  useEffect(() => {
    const cached = cardDetailCache.get(key);
    if (
      refreshNonce === 0 &&
      cached?.detail.metaFetched &&
      Date.now() - cached.ts < CARD_DETAIL_TTL
    ) {
      return;
    }
    let alive = true;
    resolvePiece(networkId, contract, tokenId, wallet)
      .then(async (r) => {
        const keep =
          !r.detail.image && !!cached?.detail.image && (await isName(networkId, contract));
        if (!alive) return;
        if (keep) {
          const now = cardDetailCache.get(key);
          if (now) cardDetailCache.set(key, { ...now, detail: cached.detail });
          scheduleSnapshotSave();
          setDetail((d) => ({ ...d, metaFetched: true }));
          return;
        }
        setDetail((d) => ({ ...r.detail, poster: r.detail.poster ?? d.poster }));
        if (r.biontAttrs) setBiontAttrs(r.biontAttrs);
      })
      .catch(async (e) => {
        const reverted = isRevertError(e);
        const name = reverted && (await isName(networkId, contract));
        if (!alive) return;
        logger.warn(`[NFT Piece] resolve failed #${tokenId}: ${e}`);
        if (name) setLapsed(key);
        if (reverted && !name) {
          cardDetailCache.delete(key);
          setBurned(true);
          onGone.current?.();
          return;
        }
        setDetail((p) => ({ ...p, metaFetched: true }));
      });
    return () => {
      alive = false;
    };
  }, [key, refreshNonce, networkId, contract, tokenId, wallet]);

  // effect:audited - a poster saved anywhere this session (the piece page, a background capture)
  // reaches every tile showing the piece.
  const myPosterKey = posterKey(networkId, contract, tokenId);
  const adoptRef = useRef(adoptPoster);
  adoptRef.current = adoptPoster;
  useEffect(
    () =>
      onPosterSaved((k, dataUrl) => {
        if (k === myPosterKey && isSafePosterDataUrl(dataUrl)) adoptRef.current(dataUrl);
      }),
    [myPosterKey]
  );

  const shownBlob = blob && blob.from === detail.image ? blob : null;
  const imageUrl = detail.image && shownBlob && !shownBlob.failed ? shownBlob.url : null;
  const staticFailed = !detail.image || !!shownBlob?.failed;

  // effect:audited - a living tile with no still and no poster asks the background queue for one;
  // leaving the screen, or the piece getting art, withdraws the request.
  const wantsCapture =
    !!opts.capturePoster &&
    isLiving &&
    detail.metaFetched &&
    !detail.poster &&
    staticFailed &&
    !!wallet;
  const animationUrl = detail.animationUrl;
  useEffect(() => {
    if (!wantsCapture || !animationUrl) return;
    return posterQueue.request({
      networkId,
      contract,
      tokenId,
      uri: animationUrl,
      scope: `${networkId}:${wallet}`,
    });
  }, [wantsCapture, animationUrl, networkId, contract, tokenId, wallet]);
  const artUrl = !detail.metaFetched
    ? null
    : (imageUrl ?? (isLiving && detail.poster ? detail.poster : null));

  return {
    key,
    market,
    detail,
    biontAttrs,
    listing,
    setListing,
    marketApproved,
    setMarketApproved,
    imageUrl,
    artUrl,
    artPending: !detail.metaFetched || (!!detail.image && !shownBlob),
    isLiving,
    burned,
    name: ons?.title || detail.metaName || `#${tokenId}`,
    isOns,
    ons,
    refresh,
    refreshMetadata,
    refreshing,
    revision,
    cachePoster,
    cacheMarketState,
  };
}

export type PieceState = ReturnType<typeof usePiece>;
