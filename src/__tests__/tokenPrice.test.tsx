import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanHistory, cleanPrices } from 'src/hooks/wallet/useTokenPrice';

describe('oracle price validation', () => {
  it('keeps only finite prices above zero', () => {
    expect(
      cleanPrices({ OCT: 0.5, ETH: '3000', BAD: -1, ZERO: 0, NAN: NaN, INF: Infinity, N: null })
    ).toEqual({ OCT: 0.5 });
    expect(cleanPrices([1, 2])).toEqual({});
    expect(cleanPrices(null)).toEqual({});
  });

  it('keeps only history points with a finite time and price', () => {
    expect(
      cleanHistory([
        { time: 1, value: 0.4 },
        { time: 2, value: -1 },
        { time: '3', value: 0.4 },
        { time: 4, value: Infinity },
        null,
        { time: 5, value: 0.5, extra: 'x' },
      ])
    ).toEqual([
      { time: 1, value: 0.4 },
      { time: 5, value: 0.5 },
    ]);
    expect(cleanHistory({ time: 1, value: 1 })).toEqual([]);
  });
});

describe('useTokenPrice store', () => {
  let priceAnswers: unknown[];
  let hidden = false;

  beforeEach(() => {
    vi.resetModules();
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    priceAnswers = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/prices')) {
          return new Response(JSON.stringify(priceAnswers.shift() ?? {}), { status: 200 });
        }
        if (url.includes('/details')) {
          return new Response(JSON.stringify({ priceChange24h: -2.5 }), { status: 200 });
        }
        return new Response(JSON.stringify([{ time: 1, value: 0.5 }]), { status: 200 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const priceCalls = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) =>
      String(u).endsWith('/api/prices')
    ).length;

  it('shares one poller and keeps the last good price over a bad answer', async () => {
    const { useTokenPrice } = await import('src/hooks/wallet/useTokenPrice');
    priceAnswers.push({ OCT: 0.5, ETH: 3000 }, { OCT: null, ETH: -1 });
    const a = renderHook(() => useTokenPrice());
    const b = renderHook(() => useTokenPrice());
    await waitFor(() => expect(a.result.current.getPrice('OCT')).toBe(0.5));
    expect(b.result.current.getPrice('ETH')).toBe(3000);
    expect(a.result.current.prices.OCT_24H_CHANGE).toBe(-2.5);
    expect(priceCalls()).toBe(1);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(priceCalls()).toBe(2));
    expect(a.result.current.getPrice('OCT')).toBe(0.5);
    expect(a.result.current.getPrice('ETH')).toBe(3000);
    a.unmount();
    b.unmount();
  });

  it('skips polls while the page is hidden', async () => {
    const { useTokenPrice } = await import('src/hooks/wallet/useTokenPrice');
    hidden = true;
    const a = renderHook(() => useTokenPrice());
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(priceCalls()).toBe(0);

    priceAnswers.push({ OCT: 0.7 });
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(a.result.current.getPrice('OCT')).toBe(0.7));
    a.unmount();
  });
});
