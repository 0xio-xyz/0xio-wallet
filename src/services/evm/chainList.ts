import { isHttpsUrl } from './networkPrefs';

export const CHAIN_LIST_URL = 'https://chainlist.org/rpcs.json';
export const CHAIN_LIST_KEY = 'evm_chain_list';
export const CHAIN_LIST_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_RESPONSE_CHARS = 8_000_000;
const MAX_CACHE_CHARS = 1_200_000;
const MAX_ENTRIES = 4000;
const RPCS_PER_CHAIN = 3;

export interface ChainListEntry {
  chainId: number;
  name: string;
  symbol: string;
  nativeName: string;
  rpcs: string[];
  explorer?: string;
  testnet: boolean;
  tvl: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const isChainId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

const TESTNET_NAME = /testnet|sepolia|goerli|holesky|hoodi|devnet/i;
const NEEDS_KEY = /[{}$]|api[-_]?key|apikey|access[-_]?token|infura_|alchemy_/i;
const LOCAL_HOST = /^https:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

export const isOfferableRpc = (url: unknown): url is string =>
  isHttpsUrl(url) && !NEEDS_KEY.test(url) && !LOCAL_HOST.test(url);

const TRACKING_RANK: Record<string, number> = { none: 0, limited: 2, yes: 3 };

function pickRpcs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ranked: { url: string; rank: number }[] = [];
  for (const item of raw) {
    const url = typeof item === 'string' ? item : isRecord(item) ? item.url : null;
    if (!isOfferableRpc(url)) continue;
    const clean = url.replace(/\/+$/, '');
    if (seen.has(clean)) continue;
    seen.add(clean);
    const tracking = isRecord(item) && typeof item.tracking === 'string' ? item.tracking : '';
    ranked.push({ url: clean, rank: TRACKING_RANK[tracking] ?? 1 });
  }
  const best = Math.min(...ranked.map((r) => r.rank));
  return ranked
    .filter((r) => r.rank < 3 || best === 3)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, RPCS_PER_CHAIN)
    .map((r) => r.url);
}

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

function fromChainlist(raw: unknown): ChainListEntry | null {
  if (!isRecord(raw) || !isChainId(raw.chainId)) return null;
  if (Array.isArray(raw.redFlags) && raw.redFlags.length) return null;
  if (raw.status === 'deprecated') return null;
  const name = text(raw.name, 40);
  const currency = isRecord(raw.nativeCurrency) ? raw.nativeCurrency : null;
  const symbol = text(currency?.symbol, 11);
  if (!name || !symbol) return null;
  if (currency?.decimals !== undefined && currency.decimals !== 18) return null;
  const rpcs = pickRpcs(raw.rpc);
  if (!rpcs.length) return null;
  const explorer = (Array.isArray(raw.explorers) ? raw.explorers : [])
    .map((e) => (isRecord(e) ? e.url : null))
    .find(isHttpsUrl);
  const tvl = typeof raw.tvl === 'number' && Number.isFinite(raw.tvl) && raw.tvl > 0 ? raw.tvl : 0;
  return {
    chainId: raw.chainId,
    name,
    symbol,
    nativeName: text(currency?.name, 40) || symbol,
    rpcs,
    ...(explorer ? { explorer: explorer.replace(/\/+$/, '') } : {}),
    testnet:
      raw.isTestnet === true || raw.testnet === true || raw.slip44 === 1 || TESTNET_NAME.test(name),
    tvl: Math.round(tvl),
  };
}

const byTvl = (a: ChainListEntry, b: ChainListEntry) =>
  b.tvl - a.tvl || a.name.localeCompare(b.name);

function dedupe(list: (ChainListEntry | null)[]): ChainListEntry[] {
  const seen = new Set<number>();
  const out: ChainListEntry[] = [];
  for (const n of list) {
    if (!n || seen.has(n.chainId)) continue;
    seen.add(n.chainId);
    out.push(n);
  }
  return out.sort(byTvl).slice(0, MAX_ENTRIES);
}

export function parseChainList(raw: unknown): ChainListEntry[] {
  return Array.isArray(raw) ? dedupe(raw.map(fromChainlist)) : [];
}

function fromCache(raw: unknown): ChainListEntry | null {
  if (!isRecord(raw) || !isChainId(raw.chainId)) return null;
  const name = text(raw.name, 40);
  const symbol = text(raw.symbol, 11);
  const rpcs = Array.isArray(raw.rpcs)
    ? raw.rpcs.filter(isOfferableRpc).slice(0, RPCS_PER_CHAIN)
    : [];
  if (!name || !symbol || !rpcs.length) return null;
  return {
    chainId: raw.chainId,
    name,
    symbol,
    nativeName: text(raw.nativeName, 40) || symbol,
    rpcs,
    ...(isHttpsUrl(raw.explorer) ? { explorer: raw.explorer } : {}),
    testnet: raw.testnet === true,
    tvl: typeof raw.tvl === 'number' && Number.isFinite(raw.tvl) && raw.tvl > 0 ? raw.tvl : 0,
  };
}

export function fitCache(list: ChainListEntry[], maxChars = MAX_CACHE_CHARS): ChainListEntry[] {
  let out = list;
  let size = JSON.stringify(out).length;
  while (size > maxChars && out.length) {
    out = out.slice(0, Math.floor(out.length * (maxChars / size) * 0.95));
    size = JSON.stringify(out).length;
  }
  return out;
}

async function readCache(): Promise<{ at: number; chains: ChainListEntry[] } | null> {
  try {
    const stored = await chrome.storage.local.get([CHAIN_LIST_KEY]);
    const raw = stored?.[CHAIN_LIST_KEY];
    if (!isRecord(raw) || typeof raw.at !== 'number' || !Array.isArray(raw.chains)) return null;
    const chains = dedupe(raw.chains.map(fromCache));
    return chains.length ? { at: raw.at, chains } : null;
  } catch {
    return null;
  }
}

async function download(fetchImpl: typeof fetch): Promise<ChainListEntry[]> {
  const res = await fetchImpl(CHAIN_LIST_URL, {
    signal: AbortSignal.timeout(20_000),
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`The chain list answered HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_RESPONSE_CHARS) throw new Error('The chain list is too large');
  const body = await res.text();
  if (body.length > MAX_RESPONSE_CHARS) throw new Error('The chain list is too large');
  const list = parseChainList(JSON.parse(body));
  if (!list.length) throw new Error('The chain list was empty');
  return list;
}

let inflight: Promise<ChainListEntry[]> | null = null;

export function loadChainList(
  opts: { now?: number; fetchImpl?: typeof fetch } = {}
): Promise<ChainListEntry[]> {
  if (inflight) return inflight;
  const now = opts.now ?? Date.now();
  const run = (async () => {
    const cached = await readCache();
    if (cached && now - cached.at >= 0 && now - cached.at < CHAIN_LIST_TTL_MS) {
      return cached.chains;
    }
    try {
      const list = await download(opts.fetchImpl ?? fetch);
      await chrome.storage.local
        .set({ [CHAIN_LIST_KEY]: { at: now, chains: fitCache(list) } })
        .catch(() => {});
      return list;
    } catch (e) {
      if (cached) return cached.chains;
      throw e;
    }
  })();
  inflight = run;
  run.then(
    () => {
      inflight = null;
    },
    () => {
      inflight = null;
    }
  );
  return run;
}

export function searchChainList(
  list: ChainListEntry[],
  query: string,
  opts: { testnet: boolean; exclude?: ReadonlySet<number>; limit?: number }
): ChainListEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { n: ChainListEntry; score: number }[] = [];
  for (const n of list) {
    if (n.testnet !== opts.testnet || opts.exclude?.has(n.chainId)) continue;
    const name = n.name.toLowerCase();
    const id = String(n.chainId);
    const symbol = n.symbol.toLowerCase();
    const score =
      id === q || name === q
        ? 0
        : name.startsWith(q) || symbol === q
          ? 1
          : name.includes(q) || id.startsWith(q)
            ? 2
            : -1;
    if (score >= 0) scored.push({ n, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || byTvl(a.n, b.n))
    .slice(0, opts.limit ?? 20)
    .map((s) => s.n);
}
