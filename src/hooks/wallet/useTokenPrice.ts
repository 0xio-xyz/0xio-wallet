import { useSyncExternalStore } from 'react';
import { logger } from 'src/utils/logger';

const ORACLE_BASE = 'https://oracle.0xio.xyz';
const ORACLE_URL = `${ORACLE_BASE}/api/prices`;
const POLL_INTERVAL = 30_000;
const HISTORY_TTL = 5 * 60_000;
const CACHE_KEY = '0xio_token_prices';
const HISTORY_CACHE_KEY = '0xio_price_history';
const CHANGE_KEY = 'OCT_24H_CHANGE';

interface PriceData {
  [symbol: string]: number;
}

export interface PricePoint {
  value: number;
  time: number;
}

const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function cleanPrices(raw: unknown): PriceData {
  const out: PriceData = {};
  if (!isRecord(raw)) return out;
  for (const [sym, v] of Object.entries(raw)) {
    if (sym !== CHANGE_KEY && isPrice(v)) out[sym] = v;
  }
  return out;
}

export function cleanHistory(raw: unknown): PricePoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is PricePoint => isRecord(p) && Number.isFinite(p.time) && isPrice(p.value))
    .map((p) => ({ time: p.time, value: p.value }));
}

const oracleHeaders = () => ({ Accept: 'application/json', 'x-0xio-client': 'extension' });

export async function fetchOctHistory(range: string, signal?: AbortSignal): Promise<PricePoint[]> {
  try {
    const resp = await fetch(`${ORACLE_BASE}/api/chart/history?pair=OCT&range=${range}`, {
      headers: oracleHeaders(),
      signal,
    });
    if (!resp.ok) return [];
    return cleanHistory(await resp.json());
  } catch {
    return [];
  }
}

interface Snapshot {
  prices: PriceData;
  priceHistory: PricePoint[];
}

let snapshot: Snapshot = { prices: {}, priceHistory: [] };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let hydrated = false;
let pricesBusy = false;
let historyBusy = false;
let historyAt = 0;

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const l of listeners) l();
}

function store(key: string, value: unknown) {
  try {
    chrome.storage.local.set({ [key]: value }).catch(() => {});
  } catch {}
}

const withChange = (prices: PriceData, change: unknown): PriceData =>
  typeof change === 'number' && Number.isFinite(change)
    ? { ...prices, [CHANGE_KEY]: change }
    : prices;

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const result = await chrome.storage.local.get([CACHE_KEY, HISTORY_CACHE_KEY]);
    const cached = result?.[CACHE_KEY];
    const prices = cleanPrices(cached);
    const history = cleanHistory(result?.[HISTORY_CACHE_KEY]);
    if (Object.keys(snapshot.prices).length === 0 && Object.keys(prices).length > 0) {
      publish({ prices: withChange(prices, isRecord(cached) ? cached[CHANGE_KEY] : undefined) });
    }
    if (snapshot.priceHistory.length === 0 && history.length > 0) {
      publish({ priceHistory: history });
    }
  } catch {}
}

async function fetchHistory() {
  if (historyBusy || document.hidden || Date.now() - historyAt < HISTORY_TTL) return;
  historyBusy = true;
  try {
    const resp = await fetch(`${ORACLE_BASE}/api/chart/history?pair=OCT`, {
      headers: oracleHeaders(),
    });
    if (!resp.ok) return;
    const data = cleanHistory(await resp.json());
    if (data.length === 0) return;
    historyAt = Date.now();
    publish({ priceHistory: data });
    store(HISTORY_CACHE_KEY, data);
    logger.debug(`[Price] History loaded: ${data.length} points`);
  } catch {
  } finally {
    historyBusy = false;
  }
}

async function fetchPrices() {
  if (pricesBusy || document.hidden) return;
  pricesBusy = true;
  try {
    const resp = await fetch(ORACLE_URL, { headers: oracleHeaders() });
    if (!resp.ok) return;
    const fresh = cleanPrices(await resp.json());
    if (Object.keys(fresh).length === 0) return;

    const prev = snapshot.prices;
    const changed =
      Object.keys(prev).length === 0 ||
      Object.entries(fresh).some(([sym, price]) => {
        const old = prev[sym];
        return !old || Math.abs(price - old) / old > 0.001;
      });
    if (!changed) return;

    let next: PriceData = { ...prev, ...fresh };
    try {
      const detailResp = await fetch(`${ORACLE_BASE}/api/price/oct/details`, {
        headers: oracleHeaders(),
      });
      if (detailResp.ok) {
        const detail = await detailResp.json();
        next = withChange(next, isRecord(detail) ? detail.priceChange24h : undefined);
      }
    } catch {}

    publish({ prices: next });
    store(CACHE_KEY, next);
    logger.debug(
      `[Price] Updated: OCT=$${next.OCT?.toFixed(6) ?? '?'} 24h=${next[CHANGE_KEY]?.toFixed(1) ?? '?'}%`
    );
  } catch {
  } finally {
    pricesBusy = false;
  }
}

function poll() {
  void fetchPrices();
  void fetchHistory();
}

function onVisibility() {
  if (!document.hidden) poll();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void hydrate();
    poll();
    timer = setInterval(poll, POLL_INTERVAL);
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

const getSnapshot = () => snapshot;

export function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return '< $0.01';
  if (value < 1) return `$${value.toFixed(4)}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function useTokenPrice() {
  const { prices, priceHistory } = useSyncExternalStore(subscribe, getSnapshot);

  const getPrice = (symbol: string): number | undefined => {
    const upper = symbol.toUpperCase();
    return prices[upper];
  };

  const getUsdValue = (symbol: string, amount: number): string | undefined => {
    const price = getPrice(symbol);
    if (!price || price <= 0) return undefined;
    return formatUsd(amount * price);
  };

  const formatPrice = (symbol: string): string => {
    const price = getPrice(symbol);
    if (!price) return '--';
    if (price < 0.001) return `$${price.toFixed(8)}`;
    if (price < 1) return `$${price.toFixed(6)}`;
    if (price < 100) return `$${price.toFixed(4)}`;
    return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  };

  return { prices, priceHistory, getPrice, getUsdValue, formatPrice };
}
