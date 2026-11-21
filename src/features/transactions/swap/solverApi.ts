import type { ChainsConfig, SwapQuote, SwapRecord, RegisterSwapBody, SwapAsset } from './types';

export const SOLVER_API = 'https://solver.0xio.xyz';

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${SOLVER_API}${path}`);
  return (await r.json()) as T;
}

export function getChains(): Promise<ChainsConfig> {
  return getJson<ChainsConfig>('/api/chains');
}

export function getPrice(): Promise<Record<string, { usd?: number }>> {
  return getJson<Record<string, { usd?: number }>>('/api/price');
}

export function getQuote(args: {
  from: SwapAsset;
  to: SwapAsset;
  amount: string;
}): Promise<SwapQuote> {
  const { from, to, amount } = args;
  return getJson<SwapQuote>(
    `/api/quote?from=${from}&to=${to}&amount=${encodeURIComponent(amount)}`
  );
}

export function getSwaps(opts: { limit?: number } = {}): Promise<{ swaps?: SwapRecord[] }> {
  const q = opts.limit != null ? `?limit=${opts.limit}` : '';
  return getJson<{ swaps?: SwapRecord[] }>(`/api/swaps${q}`);
}

export function registerSwap(body: RegisterSwapBody): Promise<Response> {
  return fetch(`${SOLVER_API}/api/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
