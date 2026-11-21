const KEY = '0xio_nft_first_seen_v1';
const OLD_KEY = '0xio_nft_first_seen';
export const BASELINE_WINDOW_MS = 5 * 60 * 1000;

export type FirstSeenMap = Record<string, number>;

export interface PieceRef {
  contract: string;
  tokenId: string;
}

let cache: FirstSeenMap | null = null;
let loading: Promise<FirstSeenMap> | null = null;

const scopeKey = (networkId: string, wallet: string) => `scope:${networkId}:${wallet}`;
export const pieceKey = (networkId: string, wallet: string, contract: string, tokenId: string) =>
  `${networkId}:${wallet}:${contract}:${tokenId}`;

export function hydrateFirstSeen(): Promise<FirstSeenMap> {
  if (cache) return Promise.resolve(cache);
  loading ??= chrome.storage.local
    .get(KEY)
    .then((r) => {
      const stored = r[KEY] as unknown;
      cache = stored && typeof stored === 'object' ? { ...(stored as FirstSeenMap) } : {};
      void chrome.storage.local.remove(OLD_KEY).catch(() => {});
      return cache;
    })
    .catch(() => {
      cache = {};
      return cache;
    });
  return loading;
}

export function stampPieces(
  map: FirstSeenMap,
  networkId: string,
  wallet: string,
  pieces: readonly PieceRef[],
  now: number
): FirstSeenMap {
  const sk = scopeKey(networkId, wallet);
  const baseline = map[sk];
  const inBaseline = baseline === undefined || now - baseline < BASELINE_WINDOW_MS;
  let next: FirstSeenMap | null = null;
  for (const p of pieces) {
    const k = pieceKey(networkId, wallet, p.contract, p.tokenId);
    if (k in map) continue;
    next ??= { ...map };
    next[k] = inBaseline ? 0 : now;
  }
  if (baseline === undefined) {
    next ??= { ...map };
    next[sk] = now;
  }
  return next ?? map;
}

export function stampFirstSeen(
  networkId: string,
  wallet: string,
  pieces: readonly PieceRef[]
): FirstSeenMap {
  const map = cache ?? {};
  const next = stampPieces(map, networkId, wallet, pieces, Date.now());
  if (next !== map) {
    cache = next;
    void chrome.storage.local.set({ [KEY]: next }).catch(() => {});
  }
  return next;
}

export const seenAt = (
  map: FirstSeenMap,
  networkId: string,
  wallet: string,
  contract: string,
  tokenId: string
) => map[pieceKey(networkId, wallet, contract, tokenId)] ?? 0;

export function newestFirst<T extends PieceRef>(
  pieces: readonly T[],
  map: FirstSeenMap,
  networkId: string,
  wallet: string,
  limit: number
): T[] {
  return pieces
    .map((p, i) => ({ p, i, at: seenAt(map, networkId, wallet, p.contract, p.tokenId) }))
    .sort((a, b) => b.at - a.at || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.p);
}
