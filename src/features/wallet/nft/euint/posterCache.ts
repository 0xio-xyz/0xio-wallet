import {
  deleteCachedAsset,
  getCachedAsset,
  putCachedAsset,
} from 'src/features/wallet/nft/circleAssetCache';
import { isSafePosterDataUrl } from 'src/features/wallet/nft/euint/LivingNftFrame';
import { base64ToBytes, bytesToBase64 } from 'src/lib/encoding';

const mem = new Map<string, string>();

export const posterKey = (networkId: string, contract: string, tokenId: string) =>
  `poster:${networkId}:${contract}:${tokenId}`;

type PosterListener = (key: string, dataUrl: string) => void;
const listeners = new Set<PosterListener>();

export function onPosterSaved(fn: PosterListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The cached poster as a data URL, or null. Checked again on read: disk is not a trust boundary
 *  for output an untrusted program produced. */
export async function getPoster(
  networkId: string,
  contract: string,
  tokenId: string
): Promise<string | null> {
  const k = posterKey(networkId, contract, tokenId);
  const hit = mem.get(k);
  if (hit) return hit;
  const asset = await getCachedAsset(k);
  if (!asset) return null;
  const url = `data:${asset.contentType};base64,${bytesToBase64(asset.bytes)}`;
  if (!isSafePosterDataUrl(url)) return null;
  mem.set(k, url);
  return url;
}

export async function savePoster(
  networkId: string,
  contract: string,
  tokenId: string,
  dataUrl: string
): Promise<void> {
  if (!isSafePosterDataUrl(dataUrl)) return;
  const k = posterKey(networkId, contract, tokenId);
  mem.set(k, dataUrl);
  for (const fn of [...listeners]) fn(k, dataUrl);
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) return;
  await putCachedAsset(k, { bytes: base64ToBytes(m[2]), contentType: m[1] });
}

export async function removePoster(
  networkId: string,
  contract: string,
  tokenId: string
): Promise<void> {
  const k = posterKey(networkId, contract, tokenId);
  mem.delete(k);
  await deleteCachedAsset(k);
}
