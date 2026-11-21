import { registerSessionCache } from 'src/utils/sessionCaches';

export interface ChartPoint {
  time: number;
  val: number;
}

const NONE: ChartPoint[] = [];
const lastDrawn = new Map<string, ChartPoint[]>();
registerSessionCache(() => lastDrawn.clear());

export function chartSeries(scope: string, fresh: ChartPoint[], ready: boolean): ChartPoint[] {
  if (!ready) return lastDrawn.get(scope) ?? NONE;
  if (fresh.length >= 2) lastDrawn.set(scope, fresh);
  else lastDrawn.delete(scope);
  return fresh;
}

const MAX_DRAWN = 96;

export function thinSeries<K extends string, T extends { time: number } & Record<K, number>>(
  points: T[],
  key: K,
  max = MAX_DRAWN
): T[] {
  if (points.length <= max) return points;
  const first = points[0];
  const last = points[points.length - 1];
  const buckets = max - 2;
  const span = last.time - first.time || 1;
  const sums = Array.from({ length: buckets }, () => ({ time: 0, val: 0, n: 0 }));
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const at = Math.min(buckets - 1, Math.floor(((p.time - first.time) / span) * buckets));
    const b = sums[Math.max(0, at)];
    b.time += p.time;
    b.val += p[key];
    b.n++;
  }
  const middle = sums
    .filter((b) => b.n > 0)
    .map((b) => ({ time: b.time / b.n, [key]: b.val / b.n }) as T);
  return [first, ...middle, last];
}
