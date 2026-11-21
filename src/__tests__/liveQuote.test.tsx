import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchQuote = vi.fn();
vi.mock('src/services/bridge/relay/anyChain', () => ({
  fetchQuote: (r: unknown) => fetchQuote(r),
  feesUsd: () => 0.42,
  payRawOf: (q: { details?: { currencyIn?: { amount?: string } } }) =>
    q.details?.currencyIn?.amount ?? null,
}));

import {
  QUOTE_DELAY_MS,
  quoteKey,
  useLiveQuote,
  type QuoteRequest,
} from 'src/features/bridge/useLiveQuote';

const req = (
  amountRaw: string,
  chain = 8453,
  mode: QuoteRequest['mode'] = 'spend'
): QuoteRequest => ({
  user: '0xabc',
  originChainId: chain,
  originCurrency: '0x0',
  octraRecipient: 'octA',
  amountRaw,
  mode,
});
const priced = (outRaw: string, payRaw: string) => ({
  outRaw,
  quote: { details: { currencyIn: { amount: payRaw } } },
});

beforeEach(() => {
  vi.useFakeTimers();
  fetchQuote.mockReset();
});
afterEach(() => vi.useRealTimers());

const settle = async (ms = QUOTE_DELAY_MS) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('live quote', () => {
  it('asks once typing pauses and shows the answer', async () => {
    fetchQuote.mockResolvedValue({ outRaw: '5000000', quote: {} });
    const { result, rerender } = renderHook(({ r }) => useLiveQuote(r), {
      initialProps: { r: req('1') },
    });
    rerender({ r: req('12') });
    await settle(QUOTE_DELAY_MS - 1);
    expect(fetchQuote).not.toHaveBeenCalled();
    await settle(1);
    expect(fetchQuote).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ outRaw: '5000000', feesUsd: 0.42, loading: false });
  });

  it('keeps the last price while a new amount loads, and drops it on another chain', async () => {
    fetchQuote.mockResolvedValue({ outRaw: '5000000', quote: {} });
    const { result, rerender } = renderHook(({ r }) => useLiveQuote(r), {
      initialProps: { r: req('1') },
    });
    await settle();
    rerender({ r: req('2') });
    expect(result.current).toMatchObject({ outRaw: '5000000', loading: true });
    rerender({ r: req('2', 10) });
    expect(result.current.outRaw).toBeNull();
  });

  it('says it failed for that amount and asks nothing without a request', async () => {
    fetchQuote.mockRejectedValue(new Error('no route'));
    const { result, rerender } = renderHook(({ r }) => useLiveQuote(r), {
      initialProps: { r: req('1') as QuoteRequest | null },
    });
    await settle();
    expect(result.current).toMatchObject({ failed: true, loading: false });
    rerender({ r: null });
    expect(result.current).toMatchObject({ outRaw: null, loading: false, failed: false });
  });

  it('keys the price by mode and surfaces what it charges', async () => {
    expect(quoteKey(req('5000000', 8453, 'receive'))).not.toBe(quoteKey(req('5000000')));
    fetchQuote.mockResolvedValueOnce(priced('5000000', '2000'));
    const { result, rerender } = renderHook(({ r }) => useLiveQuote(r), {
      initialProps: { r: req('2000') },
    });
    await settle();
    expect(fetchQuote).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'spend' }));
    expect(result.current).toMatchObject({ outRaw: '5000000', payRaw: '2000', loading: false });

    fetchQuote.mockResolvedValueOnce(priced('7000000', '2800'));
    rerender({ r: req('7000000', 8453, 'receive') });
    expect(result.current).toMatchObject({ outRaw: '5000000', payRaw: '2000', loading: true });
    await settle();
    expect(fetchQuote).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'receive', amountRaw: '7000000' })
    );
    expect(result.current).toMatchObject({ outRaw: '7000000', payRaw: '2800', loading: false });
  });
});
