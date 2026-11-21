import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvmToken } from 'src/services/evm/tokens';

const h = vi.hoisted(() => ({
  fetchEvmChart: vi.fn(),
}));

vi.mock('src/services/evm/prices', () => ({
  fetchEvmChart: h.fetchEvmChart,
  fetchEvmPrices: vi.fn(async () => ({})),
}));

import { evmRowUsd, isTrustedStable, useEvmValueSeries } from 'src/hooks/wallet/useEvmPrices';

const native = (chainId: number, symbol = 'ETH'): EvmToken => ({
  chainId,
  address: null,
  symbol,
  name: symbol,
  decimals: 18,
  logo: null,
});

const row = (chainId: number, token: EvmToken, testnet = false) => ({ chainId, token, testnet });

describe('evmRowUsd', () => {
  it('prices the native ETH of a built-in chain at the oracle ETH price', () => {
    expect(evmRowUsd(row(1, native(1)), 2, undefined, 3000)).toBe(6000);
    expect(evmRowUsd(row(4663, native(4663)), 1, undefined, 3000)).toBe(3000);
  });

  it('leaves a custom chain that names its coin ETH unpriced', () => {
    expect(evmRowUsd(row(424242, native(424242)), 1_000_000, undefined, 3000)).toBeNull();
  });

  it('prefers the DefiLlama price and never prices a testnet', () => {
    expect(evmRowUsd(row(1, native(1)), 2, 2500, 3000)).toBe(5000);
    expect(evmRowUsd(row(11155111, native(11155111), true), 2, undefined, 3000)).toBeNull();
  });

  it('counts only curated stablecoins on built-in chains at $1', () => {
    const usdc: EvmToken = { ...native(1, 'USDC'), address: '0x' + 'a'.repeat(40), stable: true };
    expect(evmRowUsd(row(1, usdc), 5, undefined, 3000)).toBe(5);
    expect(isTrustedStable(row(1, { ...usdc, custom: true }))).toBe(false);
    expect(evmRowUsd(row(424242, { ...usdc, chainId: 424242 }), 5, undefined, 3000)).toBeNull();
  });
});

describe('useEvmValueSeries chart cache', () => {
  beforeEach(() => {
    h.fetchEvmChart.mockReset();
  });

  it('does not cache a fetch that was aborted by cleanup', async () => {
    h.fetchEvmChart.mockImplementation(
      (_key: string, _range: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const holdings = [{ key: 'coingecko:aborted', amount: 1 }];
    const first = renderHook(() => useEvmValueSeries(holdings));
    await waitFor(() => expect(h.fetchEvmChart).toHaveBeenCalledTimes(1));
    first.unmount();
    await Promise.resolve();

    h.fetchEvmChart.mockResolvedValue([{ time: 100, price: 2 }]);
    const second = renderHook(() => useEvmValueSeries(holdings));
    await waitFor(() => expect(h.fetchEvmChart).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current).toEqual([{ time: 100_000, val: 2 }]));
    second.unmount();
  });

  it('does not cache a failed fetch', async () => {
    h.fetchEvmChart.mockRejectedValueOnce(new Error('HTTP 500'));
    const holdings = [{ key: 'coingecko:failing', amount: 1 }];
    const first = renderHook(() => useEvmValueSeries(holdings));
    await waitFor(() => expect(h.fetchEvmChart).toHaveBeenCalledTimes(1));
    first.unmount();

    h.fetchEvmChart.mockResolvedValue([{ time: 100, price: 3 }]);
    const second = renderHook(() => useEvmValueSeries(holdings));
    await waitFor(() => expect(second.result.current).toEqual([{ time: 100_000, val: 3 }]));
    expect(h.fetchEvmChart).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it('serves a successful chart from the cache', async () => {
    h.fetchEvmChart.mockResolvedValue([{ time: 100, price: 4 }]);
    const holdings = [{ key: 'coingecko:cached', amount: 1 }];
    const first = renderHook(() => useEvmValueSeries(holdings));
    await waitFor(() => expect(first.result.current).toEqual([{ time: 100_000, val: 4 }]));
    first.unmount();

    const second = renderHook(() => useEvmValueSeries(holdings));
    await waitFor(() => expect(second.result.current).toEqual([{ time: 100_000, val: 4 }]));
    expect(h.fetchEvmChart).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  it('is null while a chart loads and serves a cached chart on the first render', async () => {
    h.fetchEvmChart.mockResolvedValue([{ time: 100, price: 5 }]);
    const holdings = [{ key: 'coingecko:warm', amount: 2 }];
    const first = renderHook(() => useEvmValueSeries(holdings));
    expect(first.result.current).toBeNull();
    await waitFor(() => expect(first.result.current).toEqual([{ time: 100_000, val: 10 }]));
    first.unmount();

    const seen: unknown[] = [];
    const second = renderHook(() => {
      const series = useEvmValueSeries(holdings);
      seen.push(series);
      return series;
    });
    expect(seen[0]).toEqual([{ time: 100_000, val: 10 }]);
    second.unmount();
  });

  it('is empty, not loading, when nothing priced is held', () => {
    const none = renderHook(() => useEvmValueSeries([{ key: 'coingecko:none', amount: 0 }]));
    expect(none.result.current).toEqual([]);
    none.unmount();
  });
});
