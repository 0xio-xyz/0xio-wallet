import type { PricePoint } from 'src/services/evm/prices';

const MAX_POINTS = 160;

export const thinPoints = (points: PricePoint[], max = MAX_POINTS): PricePoint[] => {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
};

export const pointMs = (time: number) => (time > 1e12 ? time : time * 1000);

export const fmtUsd = (n: number) =>
  `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 1 ? 4 : 2,
  })}`;
