import { networkService } from 'src/services/network/NetworkService';
import { logger } from 'src/utils/logger';
import { getCachedAsset, putCachedAsset } from 'src/features/wallet/nft/circleAssetCache';
import { circleAssetKey, isDurableAsset } from 'src/features/wallet/nft/circleAssetKey';
import {
  bytesToB64,
  CircleAssetError,
  resolveCircleAsset,
  type CircleAssetReply,
} from 'src/utils/octra/circleAsset';
import type { Manifest } from './types';

export function parseOctUri(uri: string): { circleId: string; path: string } | null {
  if (!uri || !uri.toLowerCase().startsWith('oct://')) return null;
  const rest = uri.slice(6).split(/[?#]/, 1)[0];
  if (!rest) return null;
  const si = rest.indexOf('/');
  if (si === -1) return { circleId: rest, path: '/' };
  const circleId = rest.slice(0, si);
  const path = rest.slice(si) || '/';
  return circleId ? { circleId, path } : null;
}

export { bytesToB64 };

const assetCache = new Map<string, Promise<Uint8Array | null>>();
export async function fetchCircleBytes(
  circleId: string,
  path: string,
  fresh = false
): Promise<Uint8Array | null> {
  const p = path.startsWith('/') ? path : `/${path}`;
  const networkId = await networkService.getCurrentNetworkId();
  const key = circleAssetKey(networkId, circleId, p);
  const hit = fresh ? undefined : assetCache.get(key);
  if (hit) return hit;
  const promise = (async () => {
    try {
      const cached = fresh || !isDurableAsset(p) ? null : await getCachedAsset(key);
      if (cached) return cached.bytes;
      const asset = await resolveCircleAsset(
        (item) =>
          networkService.jsonRpcCall('circle_asset', [circleId, item]) as Promise<CircleAssetReply>,
        p
      );
      if (!asset) return null;
      const { bytes } = asset;
      if ((await networkService.getCurrentNetworkId()) !== networkId) return null;
      if (isDurableAsset(p, asset.contentType)) {
        void putCachedAsset(key, { bytes, contentType: asset.contentType });
      }
      return bytes;
    } catch (e) {
      if (e instanceof CircleAssetError)
        logger.warn(`[circle] asset ${key} rejected: ${e.message}`);
      return null;
    }
  })();
  if (fresh) {
    return promise.then((bytes) => {
      if (bytes) assetCache.set(key, promise);
      return bytes;
    });
  }
  assetCache.set(key, promise);
  void promise.then((bytes) => {
    if (!bytes && assetCache.get(key) === promise) assetCache.delete(key);
  });
  return promise;
}

export async function refetchCircleBytes(
  circleId: string,
  path: string
): Promise<Uint8Array | null> {
  const bytes = await fetchCircleBytes(circleId, path, true);
  if (bytes) return bytes;
  if (await fetchCircleBytes(circleId, path)) throw new Error(`circle asset unavailable: ${path}`);
  return null;
}

export async function fetchCircleJson<T = Record<string, unknown>>(
  circleId: string,
  path: string,
  fresh = false
): Promise<T | null> {
  const bytes = await (fresh ? refetchCircleBytes : fetchCircleBytes)(circleId, path);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

const manifestCache = new Map<string, Promise<Manifest | null>>();
export async function getManifest(circleId: string, fresh = false): Promise<Manifest | null> {
  const key = `${await networkService.getCurrentNetworkId()}|${circleId}`;
  const hit = fresh ? undefined : manifestCache.get(key);
  if (hit) return hit;
  const p = fetchCircleJson<Manifest>(circleId, '/collection.json', fresh);
  if (fresh) {
    return p.then((manifest) => {
      if (manifest) manifestCache.set(key, p);
      return manifest;
    });
  }
  manifestCache.set(key, p);
  return p;
}

export function slug(s: string): string {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '')
    .replace(/-+/g, '-');
}

export function layerPath(traitName: string, value: unknown): string | null {
  if (value == null) return null;
  const t = slug(traitName);
  const v = slug(String(value));
  if (!t || !v) return null;
  return `/traits/${t}/${v}.png`;
}

export function sniffImageType(b: Uint8Array): string {
  if (!b || b.length < 4) return 'application/octet-stream';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return 'image/*';
}
