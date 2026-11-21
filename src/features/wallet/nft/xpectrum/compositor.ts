import { fetchCircleBytes, layerPath, refetchCircleBytes, sniffImageType } from './circle';
import type { Manifest, TokenAttr } from './types';

const COMPOSITE_PREFIX = 'xnft_composite:';
async function loadComposite(key: string): Promise<string | null> {
  try {
    const k = COMPOSITE_PREFIX + key;
    const r = await chrome.storage.local.get(k);
    const v = r?.[k];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
function saveComposite(key: string, dataUrl: string): void {
  try {
    void chrome.storage.local.set({ [COMPOSITE_PREFIX + key]: dataUrl });
  } catch {}
}

const bitmapCache = new Map<string, Promise<ImageBitmap | null>>();
function loadLayerBitmap(
  circleId: string,
  path: string,
  fresh = false
): Promise<ImageBitmap | null> {
  const key = `${circleId}|${path}`;
  const hit = fresh ? undefined : bitmapCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const bytes = await (fresh ? refetchCircleBytes : fetchCircleBytes)(circleId, path);
    if (!bytes) return null;
    try {
      return await createImageBitmap(
        new Blob([bytes as unknown as BlobPart], { type: sniffImageType(bytes) })
      );
    } catch {
      return null;
    }
  })();
  if (fresh) {
    return p.then((bitmap) => {
      if (bitmap) bitmapCache.set(key, p);
      return bitmap;
    });
  }
  bitmapCache.set(key, p);
  return p;
}

const compositeCache = new Map<string, Promise<string | null>>();

export function compositeToken(
  circleId: string,
  manifest: Manifest,
  attributes: TokenAttr[],
  fresh = false
): Promise<string | null> {
  const traitTypes = manifest?.trait_types;
  if (!circleId || !Array.isArray(traitTypes) || !Array.isArray(attributes))
    return Promise.resolve(null);

  const ordered = [...traitTypes].sort((a, b) => (a.layer_order ?? 0) - (b.layer_order ?? 0));
  const valueFor = (name: string) =>
    attributes.find((a) => (a.trait_type ?? a.traitType) === name)?.value;
  const paths = ordered
    .map((tt) => layerPath(tt.name, valueFor(tt.name)))
    .filter((p): p is string => !!p);
  if (!paths.length) return Promise.resolve(null);

  const key = `${circleId}|${paths.join('|')}`;
  const hit = fresh ? undefined : compositeCache.get(key);
  if (hit) return hit;

  const p = (async () => {
    const persisted = fresh ? null : await loadComposite(key);
    if (persisted) return persisted;

    const bitmaps = (
      await Promise.all(paths.map((pp) => loadLayerBitmap(circleId, pp, fresh)))
    ).filter((b): b is ImageBitmap => !!b);
    if (!bitmaps.length) return null;

    const w = bitmaps[0].width;
    const h = bitmaps[0].height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    for (const bm of bitmaps) ctx.drawImage(bm, 0, 0, w, h);

    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL('image/webp', 0.9);
    } catch {
      dataUrl = canvas.toDataURL('image/png');
    }
    saveComposite(key, dataUrl);
    return dataUrl;
  })();
  if (fresh) {
    return p.then((dataUrl) => {
      if (dataUrl) compositeCache.set(key, p);
      return dataUrl;
    });
  }
  compositeCache.set(key, p);
  return p;
}
