import { describe, expect, it } from 'vitest';
import { chartSeries, thinSeries } from 'src/features/wallet/home/chartSeries';
import { clearSessionCaches } from 'src/utils/sessionCaches';

const line = (a: number, b: number) => [
  { time: 1, val: a },
  { time: 2, val: b },
];

describe('chartSeries', () => {
  it('shows nothing while loading when no line was drawn for the scope', () => {
    expect(chartSeries('devnet:octA:all', line(1, 1), false)).toEqual([]);
  });

  it('keeps the last line of the scope while the next one loads', () => {
    const real = line(1, 2);
    expect(chartSeries('devnet:octB:all', real, true)).toBe(real);
    expect(chartSeries('devnet:octB:all', line(3, 3), false)).toBe(real);
    const next = line(2, 4);
    expect(chartSeries('devnet:octB:all', next, true)).toBe(next);
  });

  it('never lends a line to another network, address or view', () => {
    chartSeries('devnet:octC:all', line(1, 2), true);
    expect(chartSeries('mainnet:octC:all', [], false)).toEqual([]);
    expect(chartSeries('devnet:octD:all', [], false)).toEqual([]);
    expect(chartSeries('devnet:octC:evm', [], false)).toEqual([]);
  });

  it('forgets a line once the scope has none, and on lock', () => {
    chartSeries('devnet:octE:oct', line(1, 2), true);
    chartSeries('devnet:octE:oct', [], true);
    expect(chartSeries('devnet:octE:oct', [], false)).toEqual([]);

    chartSeries('devnet:octF:oct', line(1, 2), true);
    clearSessionCaches();
    expect(chartSeries('devnet:octF:oct', [], false)).toEqual([]);
  });
});

describe('thinSeries', () => {
  const dense = Array.from({ length: 2880 }, (_, i) => ({ time: i * 30, val: i % 2 ? 2 : 4 }));

  it('leaves a short series alone', () => {
    const short = dense.slice(0, 96);
    expect(thinSeries(short, 'val')).toBe(short);
  });

  it('caps a dense series and keeps both ends', () => {
    const thin = thinSeries(dense, 'val');
    expect(thin.length).toBeLessThanOrEqual(96);
    expect(thin[0]).toBe(dense[0]);
    expect(thin[thin.length - 1]).toBe(dense[dense.length - 1]);
  });

  it('averages each bucket and stays in time order', () => {
    const thin = thinSeries(dense, 'val');
    for (let i = 1; i < thin.length; i++) expect(thin[i].time).toBeGreaterThan(thin[i - 1].time);
    for (const p of thin.slice(1, -1)) expect(p.val).toBeCloseTo(3, 1);
  });

  it('skips empty buckets', () => {
    const gappy = [...dense.slice(0, 200), ...dense.slice(2600)];
    const thin = thinSeries(gappy, 'val');
    expect(thin.every((p) => Number.isFinite(p.val) && Number.isFinite(p.time))).toBe(true);
  });
});
