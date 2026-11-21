// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evmNetworksFor } from '../networks';
import { settleAfterTimeout, watchTransaction } from '../send';

const [ethereum] = evmNetworksFor('mainnet');
const FROM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const HASH = '0x' + 'ab'.repeat(32);

type Call = { id: number; method: string; params: unknown[] };

function mockRpc(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const c = JSON.parse(String(init.body)) as Call;
      calls.push(c);
      const out = handler(c);
      return new Response(
        JSON.stringify(
          out instanceof Error
            ? { jsonrpc: '2.0', id: c.id, error: { code: -32000, message: out.message } }
            : { jsonrpc: '2.0', id: c.id, result: out }
        )
      );
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settleAfterTimeout', () => {
  it('prefers a receipt', () => {
    expect(settleAfterTimeout({ status: 'success', blockNumber: 9 }, 12, 5)).toEqual({
      state: 'success',
      blockNumber: 9,
    });
    expect(settleAfterTimeout({ status: 'failed', blockNumber: 9 }, null, 5).state).toBe('failed');
  });

  it('reads a later nonce without a receipt as replaced or dropped', () => {
    expect(settleAfterTimeout(null, 6, 5)).toEqual({ state: 'replaced', blockNumber: null });
  });

  it('stays pending while the nonce is not used yet or unknown', () => {
    expect(settleAfterTimeout(null, 5, 5).state).toBe('pending');
    expect(settleAfterTimeout(null, null, 5).state).toBe('pending');
  });
});

describe('watchTransaction', () => {
  it('follows the local hash until the receipt', async () => {
    let polls = 0;
    const calls = mockRpc((c) => {
      if (c.method === 'eth_getTransactionReceipt') {
        expect(c.params).toEqual([HASH]);
        return ++polls < 3 ? null : { status: '0x1', blockNumber: '0x10' };
      }
      return '0x5';
    });
    expect(
      await watchTransaction(ethereum, { hash: HASH, nonce: 5, from: FROM }, { intervalMs: 1 })
    ).toEqual({ state: 'success', blockNumber: 16 });
    expect(calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('sends the same signed bytes once more when the first reply was lost', async () => {
    let polls = 0;
    const calls = mockRpc((c) => {
      if (c.method === 'eth_sendRawTransaction') return new Error('already known');
      if (c.method === 'eth_getTransactionReceipt') {
        return ++polls < 4 ? null : { status: '0x1', blockNumber: '0x1' };
      }
      return '0x5';
    });
    await watchTransaction(
      ethereum,
      { hash: HASH, nonce: 5, from: FROM, raw: '0x02c0' },
      { intervalMs: 1 }
    );
    const resent = calls.filter((c) => c.method === 'eth_sendRawTransaction');
    expect(resent).toHaveLength(1);
    expect(resent[0].params).toEqual(['0x02c0']);
  });

  it('ends as replaced when the nonce moved on twice without a receipt', async () => {
    const calls = mockRpc((c) => (c.method === 'eth_getTransactionReceipt' ? null : '0x6'));
    expect(
      await watchTransaction(
        ethereum,
        { hash: HASH, nonce: 5, from: FROM },
        { intervalMs: 1, nonceEvery: 1, timeoutMs: 10_000 }
      )
    ).toEqual({ state: 'replaced', blockNumber: null });
    expect(calls.find((c) => c.method === 'eth_getTransactionCount')?.params).toEqual([
      FROM,
      'latest',
    ]);
  });

  it('ends as still pending after the timeout while the nonce is unused', async () => {
    mockRpc((c) => (c.method === 'eth_getTransactionReceipt' ? null : '0x5'));
    expect(
      await watchTransaction(
        ethereum,
        { hash: HASH, nonce: 5, from: FROM },
        { intervalMs: 1, timeoutMs: 5 }
      )
    ).toEqual({ state: 'pending', blockNumber: null });
  });

  it('ends as replaced after the timeout when the nonce moved on', async () => {
    mockRpc((c) => (c.method === 'eth_getTransactionReceipt' ? null : '0x9'));
    expect(
      await watchTransaction(
        ethereum,
        { hash: HASH, nonce: 5, from: FROM },
        { intervalMs: 1, timeoutMs: 1, nonceEvery: 1000 }
      )
    ).toEqual({ state: 'replaced', blockNumber: null });
  });

  it('keeps going through read errors and stops on abort', async () => {
    mockRpc(() => new Error('busy'));
    const ctrl = new AbortController();
    const run = watchTransaction(
      ethereum,
      { hash: HASH, nonce: 5, from: FROM },
      { intervalMs: 20, signal: ctrl.signal }
    );
    ctrl.abort(new Error('Stopped'));
    await expect(run).rejects.toThrow();
  });
});
