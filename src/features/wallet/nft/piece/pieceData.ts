import { networkService } from 'src/services/network/NetworkService';
import { logger } from 'src/utils/logger';
import { resolveXpectrumToken } from 'src/features/wallet/nft/xpectrum';
import { getActiveListing, type Listing } from 'src/features/wallet/nft/xpectrum/market';
import { getContractAbiMethods } from 'src/features/wallet/nft/abi';
import { withBusyRetry } from 'src/features/wallet/nft/euint/chainState';
import { reloadProgram } from 'src/features/wallet/nft/euint/program';
import { posterKey, removePoster } from 'src/features/wallet/nft/euint/posterCache';
import { posterQueue } from 'src/features/wallet/nft/euint/posterQueue';
import {
  type NftMeta,
  type NftTokenDetail,
  cardDetailCache,
  isLivingProgramUri,
  persistNftSnapshot,
  resolveNftMetadata,
  scheduleSnapshotSave,
} from 'src/features/wallet/nft/nftData';

export type BiontAttrs = { isAlive?: boolean; archetype?: number };

export interface PieceResolved {
  detail: NftTokenDetail;
  biontAttrs: BiontAttrs | null;
}

export const emptyDetail = (tokenId: string): NftTokenDetail => ({
  tokenId,
  uri: null,
  image: null,
  metaName: null,
  metaDescription: null,
  animationUrl: null,
  attributes: null,
  rarity: null,
  metaFetched: false,
});

export const pieceCacheKey = (
  networkId: string,
  contract: string,
  tokenId: string,
  wallet: string
) => `${networkId}:${contract}:${tokenId}:${wallet}`;

async function readBiont(
  networkId: string,
  contract: string,
  wallet: string
): Promise<BiontAttrs | null> {
  try {
    const methods = await getContractAbiMethods(networkId, contract);
    const views = (['is_alive', 'current_archetype'] as const).filter((m) => methods.includes(m));
    if (views.length === 0) return null;
    const values = await Promise.all(
      views.map((m) =>
        networkService
          .contractCallView(contract, m, [], wallet)
          .then((v): string => String(v))
          .catch((): null => null)
      )
    );
    const attrs: BiontAttrs = {};
    views.forEach((m, i) => {
      const v = values[i];
      if (v == null) return;
      if (m === 'is_alive') attrs.isAlive = v === '1' || v === 'true';
      else attrs.archetype = parseInt(v, 10);
    });
    return Object.keys(attrs).length > 0 ? attrs : null;
  } catch {
    return null;
  }
}

async function readPiece(
  networkId: string,
  contract: string,
  tokenId: string,
  wallet: string,
  fresh = false
): Promise<PieceResolved> {
  const raw = await withBusyRetry(() =>
    networkService.contractCallView(contract, 'token_uri', [parseInt(tokenId)], wallet)
  );
  const uri = raw != null ? String(raw) : null;
  const [meta, biontAttrs] = await Promise.all([
    (async () =>
      (await resolveXpectrumToken(uri, fresh)) ?? (await resolveNftMetadata(uri, fresh)))(),
    readBiont(networkId, contract, wallet),
  ]);
  const m = meta as NftMeta;
  return {
    detail: {
      tokenId,
      uri,
      image: meta.image,
      metaName: meta.name,
      metaDescription: meta.description,
      animationUrl: meta.animationUrl ?? null,
      attributes: m.attributes ?? null,
      rarity: m.rarity ?? null,
      metaFetched: true,
    },
    biontAttrs,
  };
}

const resolving = new Map<string, Promise<PieceResolved>>();
const refreshes = new Map<string, Promise<PieceRefreshed>>();
const refreshCount = new Map<string, number>();

export function resolvePiece(
  networkId: string,
  contract: string,
  tokenId: string,
  wallet: string
): Promise<PieceResolved> {
  const key = pieceCacheKey(networkId, contract, tokenId, wallet);
  const running = resolving.get(key);
  if (running) return running;
  const job = (async () => {
    const t0 = Date.now();
    const refreshed = refreshCount.get(key);
    const { detail, biontAttrs } = await readPiece(networkId, contract, tokenId, wallet);
    const prev = cardDetailCache.get(key);
    if (prev && refreshCount.get(key) !== refreshed) {
      return { detail: prev.detail, biontAttrs: prev.biontAttrs };
    }
    cardDetailCache.set(key, {
      ...prev,
      detail: prev?.detail.poster ? { ...detail, poster: prev.detail.poster } : detail,
      biontAttrs,
      ts: Date.now(),
    });
    scheduleSnapshotSave();
    logger.debug(
      `[NFT Piece] resolved #${tokenId} ${contract.slice(0, 10)}… | image=${detail.image ? 'yes' : 'none'} | ${Date.now() - t0}ms`
    );
    return { detail: cardDetailCache.get(key)!.detail, biontAttrs };
  })().finally(() => resolving.delete(key));
  resolving.set(key, job);
  return job;
}

export interface PieceRefreshed extends PieceResolved {
  imageUrl: string | null;
}

type RefreshListener = (key: string, piece: PieceRefreshed) => void;
const refreshListeners = new Set<RefreshListener>();

export function onPieceRefreshed(fn: RefreshListener): () => void {
  refreshListeners.add(fn);
  return () => {
    refreshListeners.delete(fn);
  };
}

export function refreshPiece(
  networkId: string,
  contract: string,
  tokenId: string,
  wallet: string
): Promise<PieceRefreshed> {
  const key = pieceCacheKey(networkId, contract, tokenId, wallet);
  const running = refreshes.get(key);
  if (running) return running;
  const job = (async () => {
    const onNetwork = async () => {
      if ((await networkService.getCurrentNetworkId()) !== networkId)
        throw new Error('network changed');
    };
    await onNetwork();
    const read = await readPiece(networkId, contract, tokenId, wallet, true);
    const { detail } = read;
    if (!detail.image && !detail.animationUrl) throw new Error('metadata unavailable');
    if (
      isLivingProgramUri(detail.animationUrl) &&
      !(await reloadProgram(networkId, detail.animationUrl!))
    ) {
      throw new Error('program unavailable');
    }
    const imageUrl = detail.image ? await imageBlobUrl(detail.image, true) : null;
    await onNetwork();
    await removePoster(networkId, contract, tokenId);
    posterQueue.forget(posterKey(networkId, contract, tokenId));
    const prev = cardDetailCache.get(key);
    const biontAttrs = read.biontAttrs ?? prev?.biontAttrs ?? null;
    cardDetailCache.set(key, { ...prev, detail, biontAttrs, ts: Date.now() });
    refreshCount.set(key, (refreshCount.get(key) ?? 0) + 1);
    void persistNftSnapshot();
    const piece = { detail, biontAttrs, imageUrl };
    for (const fn of [...refreshListeners]) fn(key, piece);
    return piece;
  })().finally(() => refreshes.delete(key));
  refreshes.set(key, job);
  return job;
}

// Remote images go through a blob URL (COEP blocks a cross-origin <img> in the extension).
const blobs = new Map<string, Promise<string>>();
const madeBlobs = new Map<string, string>();

export function peekImageBlobUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  return madeBlobs.get(url) ?? null;
}

export function imageBlobUrl(url: string, fresh = false): Promise<string> {
  if (url.startsWith('data:') || url.startsWith('blob:')) return Promise.resolve(url);
  const hit = fresh ? undefined : blobs.get(url);
  if (hit) return hit;
  const signal = AbortSignal.timeout(15000);
  const job: Promise<string> = fetch(url, fresh ? { signal, cache: 'reload' } : { signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const made = URL.createObjectURL(await res.blob());
      madeBlobs.set(url, made);
      return made;
    })
    .catch((e) => {
      if (blobs.get(url) === job) blobs.delete(url);
      throw e;
    });
  if (fresh) {
    return job.then((made) => {
      blobs.set(url, job);
      return made;
    });
  }
  blobs.set(url, job);
  return job;
}

const listingReads = new Map<string, Promise<Listing | null>>();

export function readListing(market: string, contract: string, tokenId: string) {
  const key = `${market}:${contract}:${tokenId}`;
  const running = listingReads.get(key);
  if (running) return running;
  const job = getActiveListing(market, contract, parseInt(tokenId)).finally(() =>
    listingReads.delete(key)
  );
  listingReads.set(key, job);
  return job;
}
