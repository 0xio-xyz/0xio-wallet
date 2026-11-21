import { BRIDGE } from '../bridge/constants';
import type { EvmToken } from './tokens';

const LLAMA = 'https://coins.llama.fi';
const TIMEOUT_MS = 10_000;

const LLAMA_CHAIN: Record<number, { chain: string; native: string }> = {
  1: { chain: 'ethereum', native: 'coingecko:ethereum' },
  4663: { chain: 'robinhood', native: 'coingecko:ethereum' },
  8453: { chain: 'base', native: 'coingecko:ethereum' },
  42161: { chain: 'arbitrum', native: 'coingecko:ethereum' },
  10: { chain: 'optimism', native: 'coingecko:ethereum' },
  137: { chain: 'polygon', native: 'coingecko:polygon-ecosystem-token' },
};

export type ChartRange = '1D' | '7D' | '1M';

const RANGE: Record<ChartRange, { seconds: number; span: number; period: string }> = {
  '1D': { seconds: 86_400, span: 48, period: '30m' },
  '7D': { seconds: 7 * 86_400, span: 84, period: '2h' },
  '1M': { seconds: 30 * 86_400, span: 60, period: '12h' },
};

export interface PricePoint {
  time: number;
  price: number;
}

export function llamaKey(chainId: number, token: Pick<EvmToken, 'address'>): string | null {
  const known = LLAMA_CHAIN[chainId];
  if (!known) return null;
  return token.address === null ? known.native : `${known.chain}:${token.address}`;
}

async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body || typeof body !== 'object') throw new Error('Bad response');
    return body as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

export async function fetchEvmPrices(
  keys: string[],
  signal?: AbortSignal
): Promise<Record<string, number>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return {};
  const body = await getJson(`${LLAMA}/prices/current/${unique.join(',')}`, signal);
  const coins = (body.coins ?? {}) as Record<string, { price?: unknown }>;
  const out: Record<string, number> = {};
  for (const k of unique) {
    const p = finite(coins[k]?.price);
    if (p !== null) out[k] = p;
  }
  return out;
}

export const chartsAsOct = (chainId: number, token: Pick<EvmToken, 'address'>): boolean =>
  chainId === BRIDGE.ethChainId && token.address?.toLowerCase() === BRIDGE.wOCT.toLowerCase();

export const chartUrl = (key: string, range: ChartRange, nowSec: number): string => {
  const r = RANGE[range];
  const start = nowSec - r.seconds;
  return `${LLAMA}/chart/${key}?start=${start}&span=${r.span}&period=${r.period}&searchWidth=${r.period}`;
};

export async function fetchEvmChart(
  key: string,
  range: ChartRange,
  signal?: AbortSignal
): Promise<PricePoint[]> {
  const body = await getJson(chartUrl(key, range, Math.floor(Date.now() / 1000)), signal);
  const coin = ((body.coins ?? {}) as Record<string, { prices?: unknown }>)[key];
  const raw = Array.isArray(coin?.prices) ? coin.prices : [];
  return raw
    .map((p: { timestamp?: unknown; price?: unknown }) => ({
      time: typeof p.timestamp === 'number' ? p.timestamp : NaN,
      price: finite(p.price) ?? NaN,
    }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.price))
    .sort((a, b) => a.time - b.time);
}
