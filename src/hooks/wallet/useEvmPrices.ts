import { useEffect, useMemo, useState } from 'react';
import {
  fetchEvmChart,
  fetchEvmPrices,
  type ChartRange,
  type PricePoint,
} from 'src/services/evm/prices';
import type { EvmBalanceRow } from 'src/services/evm/balances';
import { isBuiltinChain } from 'src/services/evm/registry';

const POLL_MS = 60_000;
const CACHE_CAP = 200;
const spotCache = new Map<string, number>();
const chartCache = new Map<string, { at: number; points: PricePoint[] }>();
const CHART_TTL_MS = 5 * 60_000;

export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, cap = CACHE_CAP): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

const spotSnapshot = (): Record<string, number> => Object.fromEntries(spotCache);

type PricedRow = Pick<EvmBalanceRow, 'chainId' | 'testnet' | 'token'>;

export const isTrustedStable = (row: PricedRow): boolean =>
  !!row.token.stable && !row.token.custom && isBuiltinChain(row.chainId);

export function evmRowUsd(
  row: PricedRow,
  amount: number,
  llamaPrice: number | undefined,
  ethPrice: number
): number | null {
  if (row.testnet) return null;
  if (llamaPrice !== undefined && Number.isFinite(llamaPrice)) return amount * llamaPrice;
  if (isTrustedStable(row)) return amount;
  const builtinEth =
    row.token.address === null && row.token.symbol === 'ETH' && isBuiltinChain(row.chainId);
  return builtinEth && Number.isFinite(ethPrice) && ethPrice > 0 ? amount * ethPrice : null;
}

export function useEvmPrices(keys: string[]): Record<string, number> {
  return useEvmPriceState(keys).prices;
}

export function useEvmPriceState(keys: string[]): {
  prices: Record<string, number>;
  settled: boolean;
} {
  const joined = [...new Set(keys)].sort().join(',');
  const [prices, setPrices] = useState<Record<string, number>>(spotSnapshot);
  const [settledFor, setSettledFor] = useState<string | null>(null);

  // effect:audited - polls DefiLlama (external system) for the listed coins; skipped while hidden, cleanup aborts
  useEffect(() => {
    if (!joined) return;
    let cancelled = false;
    const ctrl = new AbortController();
    const run = async () => {
      if (document.hidden) return;
      try {
        const next = await fetchEvmPrices(joined.split(','), ctrl.signal);
        if (cancelled) return;
        for (const [k, v] of Object.entries(next)) lruSet(spotCache, k, v);
        setPrices(spotSnapshot());
      } catch {
      } finally {
        if (!cancelled) setSettledFor(joined);
      }
    };
    const onVisible = () => {
      if (!document.hidden) void run();
    };
    void run();
    const timer = setInterval(run, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [joined]);

  const known = joined ? joined.split(',').every((k) => k in prices) : true;
  return { prices, settled: known || settledFor === joined };
}

export function useEvmChart(
  key: string | null,
  range: ChartRange
): { points: PricePoint[]; loading: boolean } {
  const id = key ? `${key}|${range}` : null;
  const cached = id ? chartCache.get(id) : undefined;
  const [state, setState] = useState<{ id: string | null; points: PricePoint[]; loading: boolean }>(
    { id, points: cached?.points ?? [], loading: !!id && !cached }
  );

  // effect:audited - fetches the chart (external system) per coin and range; cleanup aborts
  useEffect(() => {
    if (!id || !key) return;
    const hit = chartCache.get(id);
    if (hit && Date.now() - hit.at < CHART_TTL_MS) {
      setState({ id, points: hit.points, loading: false });
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setState((s) => ({ id, points: s.id === id ? s.points : [], loading: true }));
    fetchEvmChart(key, range, ctrl.signal)
      .then((points) => {
        if (cancelled || ctrl.signal.aborted) return;
        lruSet(chartCache, id, { at: Date.now(), points });
        setState({ id, points, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ id, points: [], loading: false });
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [id, key, range]);

  if (!id) return { points: [], loading: false };
  if (state.id !== id) return { points: chartCache.get(id)?.points ?? [], loading: true };
  return { points: state.points, loading: state.loading };
}

export interface ValuePoint {
  time: number;
  val: number;
}

const chartHit = (key: string): readonly PricePoint[] | null => {
  const hit = chartCache.get(`${key}|1D`);
  return hit && Date.now() - hit.at < CHART_TTL_MS ? hit.points : null;
};

function valueSeries(
  charts: Map<string, readonly PricePoint[]>,
  held: { key: string; amount: number }[],
  stableUsd: number
): ValuePoint[] {
  const grid = [...new Set([...charts.values()].flatMap((pts) => pts.map((p) => p.time)))].sort(
    (a, b) => a - b
  );
  const priceAt = (pts: readonly PricePoint[], t: number) => {
    let v = pts[0]?.price ?? 0;
    for (const p of pts) {
      if (p.time > t) break;
      v = p.price;
    }
    return v;
  };
  return grid.map((t) => ({
    time: t * 1000,
    val: stableUsd + held.reduce((n, h) => n + h.amount * priceAt(charts.get(h.key) ?? [], t), 0),
  }));
}

export function useEvmValueSeries(
  holdings: { key: string | null; amount: number; stable?: boolean }[]
): ValuePoint[] | null {
  const priced = holdings.filter((h) => h.key && h.amount > 0);
  const charted = [...new Set(priced.filter((h) => !h.stable).map((h) => h.key!))].sort();
  const stableUsd = priced.filter((h) => h.stable).reduce((n, h) => n + h.amount, 0);
  const held = priced.filter((h) => !h.stable).map((h) => ({ key: h.key!, amount: h.amount }));
  const amounts = held
    .map((h) => `${h.key}=${h.amount}`)
    .sort()
    .join('|');
  const [series, setSeries] = useState<{ id: string; points: ValuePoint[] }>({
    id: '',
    points: [],
  });
  const id = `${amounts}|${stableUsd}`;

  // effect:audited - fetches 1D charts (external system) for the held coins; cleanup aborts
  useEffect(() => {
    if (priced.length === 0) return;
    let cancelled = false;
    const ctrl = new AbortController();
    const load = async () => {
      const charts = await Promise.all(
        charted.map(async (key) => {
          const hit = chartHit(key);
          if (hit) return [key, hit] as const;
          try {
            const points = await fetchEvmChart(key, '1D', ctrl.signal);
            if (!ctrl.signal.aborted) lruSet(chartCache, `${key}|1D`, { at: Date.now(), points });
            return [key, points] as const;
          } catch {
            return [key, [] as PricePoint[]] as const;
          }
        })
      );
      if (cancelled) return;
      setSeries({ id, points: valueSeries(new Map(charts), held, stableUsd) });
    };
    void load();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // the id captures every input that changes the series
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const warm = useMemo(() => {
    if (series.id === id) return null;
    const charts = new Map<string, readonly PricePoint[]>();
    for (const key of charted) {
      const hit = chartHit(key);
      if (!hit) return null;
      charts.set(key, hit);
    }
    return valueSeries(charts, held, stableUsd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, series.id]);

  if (priced.length === 0) return [];
  if (series.id === id) return series.points;
  return warm;
}
