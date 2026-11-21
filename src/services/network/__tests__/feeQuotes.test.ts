import { describe, expect, it, vi } from 'vitest';
import {
  FEE_LIVE_MS,
  FEE_SHOW_MS,
  FEE_FLOORS,
  FEE_SIGN_MS,
  createFeeQuotes,
  parseFeeQuote,
  signable,
  validFeeQuote,
} from 'src/services/network/feeQuotes';
import { RpcHttpError, RpcResponseError } from 'src/services/network/txOutcome';

const pin = { networkId: 'mainnet' as const, rpcUrl: 'https://octra.network' };
const custom = { networkId: 'custom' as const, rpcUrl: 'https://my.node' };
const quote = { minimum: '1000', recommended: '3000', fast: '5000' };

const setup = () => {
  let now = 1_000_000;
  const call = vi.fn();
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const fees = createFeeQuotes({ call, now: () => now, sleep, random: () => 0.5 });
  return { fees, call, sleep, tick: (ms: number) => (now += ms) };
};

describe('fee quotes', () => {
  it('tries a busy node twice more with backoff on the same node', async () => {
    for (const busy of [
      new RpcHttpError('busy', 429),
      new RpcHttpError('bad gateway', 502),
      new RpcHttpError('unavailable', 503),
      new RpcHttpError('gateway timeout', 504),
      new Error('primary RPC timeout'),
    ]) {
      const { fees, call, sleep } = setup();
      call.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockResolvedValueOnce(quote);
      expect(await fees.read('call', pin)).toMatchObject({ kind: 'quote', quote });
      expect(call).toHaveBeenCalledTimes(3);
      expect(call.mock.calls.every(([, p]) => p === pin)).toBe(true);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([600, 1500]);
    }
  });

  it('gives up after three tries, and never retries a node error or a 500', async () => {
    const a = setup();
    a.call.mockRejectedValue(new RpcHttpError('busy', 429));
    expect(await a.fees.read('call', pin)).toEqual({ kind: 'failed', kept: null });
    expect(a.call).toHaveBeenCalledTimes(3);

    const b = setup();
    b.call.mockRejectedValue(new RpcHttpError('server error', 500));
    expect((await b.fees.read('call', pin)).kind).toBe('failed');
    expect(b.call).toHaveBeenCalledTimes(1);

    const c = setup();
    c.call.mockRejectedValue(new RpcResponseError('invalid op', {}));
    expect((await c.fees.read('call', pin)).kind).toBe('failed');
    expect(c.call).toHaveBeenCalledTimes(1);
  });

  it('shares one read between everyone asking while it runs', async () => {
    const { fees, call } = setup();
    let answer: (v: unknown) => void = () => {};
    call.mockReturnValue(new Promise((r) => (answer = r)));
    const reads = [fees.read('encrypt', pin), fees.read('encrypt', pin), fees.read('encrypt', pin)];
    answer(quote);
    const results = await Promise.all(reads);
    expect(call).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.kind === 'quote')).toBe(true);
  });

  it('keeps a quote live for 30 seconds per network, node and op', async () => {
    const { fees, call, tick } = setup();
    call.mockResolvedValue(quote);
    await fees.read('call', pin);
    await fees.read('call', pin);
    expect(call).toHaveBeenCalledTimes(1);
    await fees.read('transfer', pin);
    await fees.read('call', custom);
    expect(call).toHaveBeenCalledTimes(3);
    tick(FEE_LIVE_MS + 1);
    await fees.read('call', pin);
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('signs only a quote up to 60 seconds old and reads again past it', async () => {
    const { fees, call, tick } = setup();
    call.mockResolvedValue(quote);
    const first = await fees.read('call', pin);
    tick(45_000);
    expect(await fees.read('call', pin, { maxAgeMs: FEE_SIGN_MS })).toEqual(first);
    expect(call).toHaveBeenCalledTimes(1);
    tick(20_000);
    call.mockRejectedValue(new RpcHttpError('busy', 429));
    const late = await fees.read('call', pin, { maxAgeMs: FEE_SIGN_MS });
    expect(late.kind).toBe('failed');
    expect(call).toHaveBeenCalledTimes(4);
    expect(signable(1_000_000, 1_000_000 + FEE_SIGN_MS)).toBe(true);
    expect(signable(1_000_000, 1_000_001 + FEE_SIGN_MS)).toBe(false);
  });

  it('shows the last live quote for 5 minutes when a read fails, never a constant', async () => {
    const { fees, call, tick } = setup();
    call.mockResolvedValueOnce(quote);
    await fees.read('call', pin);
    call.mockRejectedValue(new RpcHttpError('busy', 429));
    tick(2 * 60_000);
    expect(await fees.read('call', pin)).toEqual({
      kind: 'failed',
      kept: { quote, at: 1_000_000 },
    });
    tick(FEE_SHOW_MS);
    expect(await fees.read('call', pin)).toEqual({ kind: 'failed', kept: null });
    expect(fees.last('call', pin)).toBeNull();

    const fresh = setup();
    fresh.call.mockRejectedValue(new RpcHttpError('busy', 429));
    expect(await fresh.fees.read('deploy', pin)).toEqual({ kind: 'failed', kept: null });
    fresh.call.mockResolvedValue({ minimum: '0', recommended: '' });
    fresh.tick(1);
    expect(await fresh.fees.read('deploy', pin)).toEqual({ kind: 'failed', kept: null });
  });

  it('tells a node without the fee method apart and does not ask it again at once', async () => {
    const { fees, call } = setup();
    call.mockRejectedValue(new RpcResponseError('Method not found', { code: -32601 }));
    expect(await fees.read('call', custom)).toEqual({ kind: 'unsupported' });
    expect(await fees.read('call', custom)).toEqual({ kind: 'unsupported' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('takes a quote only the way the webcli does', () => {
    expect(validFeeQuote({ minimum: 1000, recommended: '3000', fast: '5000' })).toEqual(quote);
    expect(validFeeQuote({ minimum: '1000', recommended: '3000' })).toEqual({
      minimum: '1000',
      recommended: '3000',
    });
    expect(validFeeQuote({ recommended: 3000 })).toEqual({ minimum: '3000', recommended: '3000' });
    expect(validFeeQuote({ base_fee: '2000', minimum: '1000' })).toEqual({
      minimum: '1000',
      recommended: '2000',
    });
    expect(validFeeQuote({ minimum: '1000' })).toEqual({ minimum: '1000', recommended: '1000' });
    expect(validFeeQuote({ recommended: 'x', base_fee: '0', minimum: '1500' })).toEqual({
      minimum: '1500',
      recommended: '1500',
    });
    expect(validFeeQuote({ minimum: '1000', recommended: '3000', fast: '2000' })).toEqual({
      minimum: '1000',
      recommended: '3000',
    });
    expect(validFeeQuote({ minimum: '1000', recommended: '3000', fast: '10000001' })).toEqual({
      minimum: '1000',
      recommended: '3000',
    });
    expect(validFeeQuote({ minimum: '1000', recommended: '900', fast: '5000' })).toBeNull();
    expect(validFeeQuote({ recommended: '10000001' })).toBeNull();
    expect(validFeeQuote({ recommended: '0' })).toBeNull();
    expect(validFeeQuote({ recommended: '01000' })).toBeNull();
    expect(validFeeQuote({ recommended: 1000.5 })).toBeNull();
    expect(validFeeQuote({ fast: '5000' })).toBeNull();
    expect(validFeeQuote({})).toBeNull();
    expect(validFeeQuote(null)).toBeNull();
  });

  it('lifts a quote to the op floor and drops one the floor pushes past the cap', () => {
    expect(FEE_FLOORS).toEqual({
      key_switch: 5000,
      encrypt: 5000,
      decrypt: 5000,
      stealth: 5000,
      claim: 3000,
    });
    expect(parseFeeQuote(quote, 'key_switch')).toEqual({
      minimum: '5000',
      recommended: '5000',
      fast: '5000',
    });
    expect(parseFeeQuote(quote, 'claim')).toEqual({
      minimum: '3000',
      recommended: '3000',
      fast: '5000',
    });
    expect(parseFeeQuote(quote, 'call')).toEqual(quote);
    expect(parseFeeQuote({ minimum: '1000', recommended: '2000' }, 'encrypt')).toEqual({
      minimum: '5000',
      recommended: '5000',
    });
    expect(parseFeeQuote({ recommended: '10000000' }, 'claim')).toEqual({
      minimum: '10000000',
      recommended: '10000000',
    });
    expect(parseFeeQuote({ recommended: '0' })).toBeNull();
    expect(parseFeeQuote({ minimum: '1000', recommended: '99999999' }, 'key_switch')).toBeNull();
    expect(parseFeeQuote({ minimum: '1000', recommended: '99999999' }, 'call')).toEqual({
      minimum: '1000',
      recommended: '1000',
    });
  });

  it('reads the floored quote per op', async () => {
    const { fees, call } = setup();
    call.mockResolvedValue({ minimum: '1000', recommended: '4000', fast: '9000' });
    expect(await fees.read('decrypt', pin)).toMatchObject({
      kind: 'quote',
      quote: { minimum: '5000', recommended: '5000', fast: '9000' },
    });
  });

  it('keeps a quote without fast as a live quote', async () => {
    const { fees, call } = setup();
    call.mockResolvedValue({ minimum: '1000', recommended: '4000' });
    expect(await fees.read('call', pin)).toMatchObject({
      kind: 'quote',
      quote: { minimum: '1000', recommended: '4000' },
    });
  });
});
