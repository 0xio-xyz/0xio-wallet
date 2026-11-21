import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeeRead } from 'src/services/network/feeQuotes';

const h = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('src/services/network/NetworkService', () => ({
  networkService: { readFeeQuote: h.read },
}));
vi.mock('src/services/network/txScope', () => ({
  resolveNetworkPin: async (networkId: string) => ({ networkId, rpcUrl: 'https://node' }),
}));

import { feeView, useLiveFee } from 'src/hooks/wallet/useLiveFee';
import { usePrivacyFees } from 'src/hooks/privacy/usePrivacyFees';

const quote = { minimum: '1000', recommended: '3000', fast: '5000' };

beforeEach(() => h.read.mockReset());

describe('fee row states', () => {
  it('dims a kept quote with its age and blocks nothing it cannot read', () => {
    expect(feeView(null, 0)).toEqual({ quote: null, state: 'loading', ageMs: null });
    expect(feeView({ kind: 'quote', quote, at: 5 }, 9)).toEqual({
      quote,
      state: 'ready',
      ageMs: null,
    });
    expect(feeView({ kind: 'failed', kept: { quote, at: 1_000 } }, 121_000)).toEqual({
      quote,
      state: 'stale',
      ageMs: 120_000,
    });
    expect(feeView({ kind: 'failed', kept: null }, 9).state).toBe('failed');
    expect(feeView({ kind: 'unsupported' }, 9).state).toBe('unsupported');
  });
});

describe('useLiveFee', () => {
  it('signs only a quote read in the last 60 seconds', async () => {
    h.read.mockResolvedValue({ kind: 'quote', quote, at: Date.now() } satisfies FeeRead);
    const { result } = renderHook(() => useLiveFee('call', 'mainnet'));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    h.read.mockResolvedValue({ kind: 'failed', kept: { quote, at: Date.now() - 90_000 } });
    let signed: unknown;
    await act(async () => {
      signed = await result.current.fresh();
    });
    expect(signed).toBeNull();
    expect(h.read).toHaveBeenLastCalledWith('call', expect.anything(), { maxAgeMs: 60_000 });
    expect(result.current.state).toBe('stale');
    expect(result.current.quote).toEqual(quote);
  });
});

describe('fee reads on demand', () => {
  const live = () => ({ kind: 'quote', quote, at: Date.now() }) satisfies FeeRead;

  it('reads once on open, again only when the popup comes back after 30 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.read.mockImplementation(async () => live());
      const { result } = renderHook(() => useLiveFee('call', 'mainnet'));
      await waitFor(() => expect(result.current.state).toBe('ready'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(h.read).toHaveBeenCalledTimes(1);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(h.read).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(h.read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one op live every 30 seconds only while its review is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.read.mockImplementation(async () => live());
      const { result, rerender } = renderHook(
        ({ reviewing }) => useLiveFee('transfer', 'mainnet', reviewing),
        { initialProps: { reviewing: true } }
      );
      await waitFor(() => expect(result.current.state).toBe('ready'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(h.read).toHaveBeenCalledTimes(3);
      rerender({ reviewing: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(h.read).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes only the reviewed private op, not all three', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.read.mockImplementation(async () => live());
      const { result } = renderHook(() => usePrivacyFees('mainnet', 'decrypt'));
      await waitFor(() => expect(result.current.fees?.claim).toEqual(quote));
      h.read.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(h.read.mock.calls.map(([op]) => op)).toEqual(['decrypt']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('usePrivacyFees', () => {
  it('reads the three private ops one after another', async () => {
    let running = 0;
    let most = 0;
    h.read.mockImplementation(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { kind: 'quote', quote, at: Date.now() } satisfies FeeRead;
    });
    const { result } = renderHook(() => usePrivacyFees('mainnet'));
    await waitFor(() => expect(result.current.fees?.claim).toEqual(quote));
    expect(h.read.mock.calls.map(([op]) => op)).toEqual(['encrypt', 'decrypt', 'claim']);
    expect(most).toBe(1);
  });
});
