import { useEffect, useMemo, useState } from 'react';
import { thinSeries } from 'src/features/wallet/home/chartSeries';
import { fetchOctHistory, type PricePoint as OraclePoint } from 'src/hooks/wallet/useTokenPrice';
import type { ChartRange, PricePoint } from 'src/services/evm/prices';

type RemoteRange = Exclude<ChartRange, '1D'>;

const ORACLE_RANGE: Record<RemoteRange, string> = { '7D': '7d', '1M': '30d' };
const CHART_TTL_MS = 5 * 60_000;
const chartCache = new Map<RemoteRange, { at: number; points: PricePoint[] }>();

const toChart = (raw: OraclePoint[]): PricePoint[] =>
  thinSeries(
    raw
      .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value) && p.value > 0)
      .map((p) => ({ time: p.time, price: p.value }))
      .sort((a, b) => a.time - b.time),
    'price'
  );

export function useOctChart(
  range: ChartRange,
  enabled: boolean,
  day: OraclePoint[]
): { points: PricePoint[]; loading: boolean } {
  const remote: RemoteRange | null = enabled && range !== '1D' ? range : null;
  const dayPoints = useMemo(() => toChart(day), [day]);
  const [state, setState] = useState<{
    id: RemoteRange | null;
    points: PricePoint[];
    loading: boolean;
  }>(() => {
    const hit = remote ? chartCache.get(remote) : undefined;
    return { id: remote, points: hit?.points ?? [], loading: !!remote && !hit };
  });

  // effect:audited - fetches the OCT range history (external oracle); cleanup aborts
  useEffect(() => {
    if (!remote) return;
    const hit = chartCache.get(remote);
    if (hit && Date.now() - hit.at < CHART_TTL_MS) {
      setState({ id: remote, points: hit.points, loading: false });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ id: remote, points: s.id === remote ? s.points : [], loading: true }));
    void fetchOctHistory(ORACLE_RANGE[remote], ctrl.signal).then((raw) => {
      if (ctrl.signal.aborted) return;
      const points = toChart(raw);
      if (points.length) chartCache.set(remote, { at: Date.now(), points });
      setState({ id: remote, points, loading: false });
    });
    return () => ctrl.abort();
  }, [remote]);

  if (!enabled) return { points: [], loading: false };
  if (!remote) return { points: dayPoints, loading: false };
  if (state.id !== remote) return { points: chartCache.get(remote)?.points ?? [], loading: true };
  return { points: state.points, loading: state.loading };
}
