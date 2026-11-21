export const NFT_LIST_URL =
  'https://cdn.jsdelivr.net/gh/0xio-xyz/Token-lists@8777147d077e644227a80625ed19c14ed1c79b97/octra.nftlist.json';
export const NFT_REGISTRY_URL = 'https://indexer.0xio.xyz/api/nft/contracts';

export interface KnownCollection {
  address: string;
  name: string;
  symbol: string;
}

export interface ProbedCollection extends KnownCollection {
  count: number;
}

const ADDRESS = /^oct[1-9A-HJ-NP-Za-km-z]{44}$/;
const FETCH_TIMEOUT_MS = 10_000;
const LIST_TTL_MS = 30 * 60_000;
const REGISTRY_TTL_MS = 10 * 60_000;
const FAILED_RETRY_MS = 5 * 60_000;
const PROBE_TTL_MS = 5 * 60_000;
export const PROBE_CONCURRENCY = 4;
export const PROBE_MAX = 60;

const clean = (s: unknown, max: number) =>
  (typeof s === 'string' ? s : '').replace(/[^a-zA-Z0-9._\- ]/g, '').slice(0, max);

function entry(raw: unknown): KnownCollection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const address = typeof r.address === 'string' ? r.address.trim() : '';
  if (!ADDRESS.test(address)) return null;
  return { address, name: clean(r.name, 32), symbol: clean(r.symbol, 16) };
}

export function parseNftList(json: unknown, network: string): KnownCollection[] {
  const list = (json as { collections?: unknown } | null)?.collections;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => (c as { network?: unknown })?.network === network)
    .map(entry)
    .filter((c): c is KnownCollection => c !== null);
}

export function parseNftRegistry(json: unknown): KnownCollection[] {
  const r = json as { network?: unknown; contracts?: unknown } | null;
  if (r?.network !== 'mainnet' || !Array.isArray(r.contracts)) return [];
  return r.contracts.map(entry).filter((c): c is KnownCollection => c !== null);
}

export async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

interface Cached {
  at: number;
  ttl: number;
  json: unknown;
}

function cachedFetch(url: string, ttl: number) {
  let cached: Cached | null = null;
  let inFlight: Promise<unknown> | null = null;
  return {
    get(): Promise<unknown> {
      if (cached && Date.now() - cached.at < cached.ttl) return Promise.resolve(cached.json);
      inFlight ??= fetchJson(url)
        .then((json) => {
          cached = { at: Date.now(), ttl, json };
          return json;
        })
        .catch(() => {
          const json = cached?.json ?? null;
          cached = { at: Date.now(), ttl: Math.min(ttl, FAILED_RETRY_MS), json };
          return json;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    reset() {
      cached = null;
      inFlight = null;
    },
  };
}

const nftList = cachedFetch(NFT_LIST_URL, LIST_TTL_MS);
const registry = cachedFetch(NFT_REGISTRY_URL, REGISTRY_TTL_MS);

export async function knownCollections(networkId: string): Promise<KnownCollection[]> {
  if (networkId !== 'mainnet' && networkId !== 'devnet') return [];
  const [list, reg] = await Promise.all([
    nftList.get(),
    networkId === 'mainnet' ? registry.get() : Promise.resolve(null),
  ]);
  const out = new Map<string, KnownCollection>();
  for (const c of [...parseNftList(list, networkId), ...parseNftRegistry(reg)]) {
    const k = c.address.toLowerCase();
    const had = out.get(k);
    out.set(k, had ? { ...had, name: had.name || c.name, symbol: had.symbol || c.symbol } : c);
  }
  return [...out.values()];
}

const probeCache = new Map<string, { at: number; count: number }>();
const probeKey = (networkId: string, wallet: string, contract: string) =>
  `${networkId}:${wallet}:${contract.toLowerCase()}`;

export async function probeCollections(
  networkId: string,
  wallet: string,
  candidates: readonly KnownCollection[],
  skip: ReadonlySet<string>,
  readBalance: (contract: string) => Promise<number | null>,
  stillCurrent: () => boolean | Promise<boolean> = () => true
): Promise<ProbedCollection[]> {
  const counts = new Map<string, number>();
  const toProbe: KnownCollection[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  for (const c of candidates) {
    const k = c.address.toLowerCase();
    if (skip.has(k) || seen.has(k)) continue;
    seen.add(k);
    const hit = probeCache.get(probeKey(networkId, wallet, c.address));
    if (hit && now - hit.at < PROBE_TTL_MS) counts.set(k, hit.count);
    else if (toProbe.length < PROBE_MAX) toProbe.push(c);
  }
  for (let i = 0; i < toProbe.length; i += PROBE_CONCURRENCY) {
    await Promise.all(
      toProbe.slice(i, i + PROBE_CONCURRENCY).map(async (c) => {
        const count = await readBalance(c.address).catch((): null => null);
        if (count === null || !(await stillCurrent())) return;
        probeCache.set(probeKey(networkId, wallet, c.address), { at: Date.now(), count });
        counts.set(c.address.toLowerCase(), count);
      })
    );
  }
  const held: ProbedCollection[] = [];
  for (const c of candidates) {
    const k = c.address.toLowerCase();
    const count = counts.get(k);
    if (!count) continue;
    counts.delete(k);
    held.push({ ...c, count });
  }
  return held;
}

export function resetKnownCollectionCaches(): void {
  nftList.reset();
  registry.reset();
  probeCache.clear();
}
