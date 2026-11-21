// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evmNetworksFor, type EvmNetwork } from '../networks';
import {
  FeeCeilingError,
  estimateFees,
  feeCeilingProblem,
  feesFromGasPrice,
  feesFromHistory,
} from '../send';
import {
  deriveEvmPrivateKey,
  signEip1559,
  signEvmTx,
  signLegacyEip155,
  type Eip1559Tx,
} from '../tx';

const GWEI = 1_000_000_000n;
const q = (n: bigint) => '0x' + n.toString(16);
const ABANDON = [...Array(11).fill('abandon'), 'about'];

type Call = { id: number; method: string; params: unknown[] };
type Answer = unknown | Error | { http: number };

function mockRpc(handler: (call: Call) => Answer) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const c = JSON.parse(String(init.body)) as Call;
      calls.push(c);
      const out = handler(c);
      if (out && typeof out === 'object' && 'http' in out) {
        return new Response('busy', { status: (out as { http: number }).http });
      }
      return new Response(
        JSON.stringify(
          out instanceof Error
            ? {
                jsonrpc: '2.0',
                id: c.id,
                error: {
                  code: (out as Error & { code?: number }).code ?? -32601,
                  message: out.message,
                },
              }
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

const [ethereum] = evmNetworksFor('mainnet');
const custom: EvmNetwork = { ...ethereum, chainId: 777, name: 'Custom', rpcUrl: 'https://x.test' };
const history = (base: bigint, tip = 1n * GWEI) => ({
  baseFeePerGas: [q(base), q(base)],
  reward: [[q(tip)]],
});

describe('fee rules', () => {
  it('reads history with a base fee as type 2', () => {
    expect(feesFromHistory(history(10n * GWEI))).toEqual({
      baseFeePerGas: 10n * GWEI,
      maxPriorityFeePerGas: GWEI,
      maxFeePerGas: 21n * GWEI,
    });
  });

  it('treats a missing or zero base fee as a chain without EIP-1559', () => {
    expect(feesFromHistory(null)).toBeNull();
    expect(feesFromHistory({})).toBeNull();
    expect(feesFromHistory({ baseFeePerGas: [] })).toBeNull();
    expect(feesFromHistory(history(0n))).toBeNull();
  });

  it('caps a gas price fallback at twice the gas price when the chain has a base fee', () => {
    expect(feesFromGasPrice(12n * GWEI, 10n * GWEI)).toEqual({
      baseFeePerGas: 10n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
      maxFeePerGas: 24n * GWEI,
    });
  });

  it('never caps below twice the base fee plus the tip', () => {
    expect(feesFromGasPrice(5n * GWEI, 10n * GWEI).maxFeePerGas).toBe(20n * GWEI);
  });

  it('builds a legacy fee when the chain has no base fee', () => {
    expect(feesFromGasPrice(10n * GWEI, null)).toEqual({
      baseFeePerGas: null,
      maxPriorityFeePerGas: 12n * GWEI,
      maxFeePerGas: 12n * GWEI,
      legacy: true,
    });
  });

  it('refuses a fee far above the gas price or above a built-in cap', () => {
    expect(feeCeilingProblem(777, 20n * GWEI, GWEI)).toBeNull();
    expect(feeCeilingProblem(777, 21n * GWEI, GWEI)).toBe('relative');
    expect(feeCeilingProblem(1, 2_001n * GWEI, 2_000n * GWEI)).toBe('absolute');
    expect(feeCeilingProblem(4663, 101n * GWEI, 100n * GWEI)).toBe('absolute');
    expect(feeCeilingProblem(777, 5_000n * GWEI, 5_000n * GWEI)).toBeNull();
  });
});

describe('estimateFees', () => {
  it('uses fee history and reads the gas price once for the ceiling', async () => {
    const calls = mockRpc((c) =>
      c.method === 'eth_feeHistory' ? history(10n * GWEI) : q(11n * GWEI)
    );
    expect(await estimateFees(custom)).toMatchObject({ maxFeePerGas: 21n * GWEI });
    expect(calls.filter((c) => c.method === 'eth_gasPrice')).toHaveLength(1);
  });

  it('falls back to a type 2 fee at twice the gas price when only the method is missing', async () => {
    mockRpc((c) =>
      c.method === 'eth_feeHistory'
        ? Object.assign(new Error('the method eth_feeHistory does not exist'), { code: -32000 })
        : c.method === 'eth_getBlockByNumber'
          ? { baseFeePerGas: q(10n * GWEI) }
          : q(12n * GWEI)
    );
    expect(await estimateFees(custom)).toEqual({
      baseFeePerGas: 10n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
      maxFeePerGas: 24n * GWEI,
    });
  });

  it('goes legacy when fee history has no base fee', async () => {
    mockRpc((c) => (c.method === 'eth_feeHistory' ? { oldestBlock: '0x1' } : q(10n * GWEI)));
    expect(await estimateFees(custom)).toMatchObject({ legacy: true, maxFeePerGas: 12n * GWEI });
  });

  it('retries a transport failure once, then uses the answer', async () => {
    let n = 0;
    mockRpc((c) => {
      if (c.method === 'eth_feeHistory' && n++ === 0) return { http: 429 };
      return c.method === 'eth_feeHistory' ? history(10n * GWEI) : q(11n * GWEI);
    });
    expect(await estimateFees(custom)).toMatchObject({ baseFeePerGas: 10n * GWEI });
    expect(n).toBe(2);
  });

  it('never falls back to the gas price on a rate limit or outage', async () => {
    const calls = mockRpc((c) => (c.method === 'eth_feeHistory' ? { http: 429 } : q(GWEI)));
    await expect(estimateFees(custom)).rejects.toThrow('429');
    expect(calls.filter((c) => c.method === 'eth_feeHistory')).toHaveLength(2);
    expect(calls.some((c) => c.method === 'eth_getBlockByNumber')).toBe(false);
  });

  it('throws on any other node error instead of falling back', async () => {
    mockRpc((c) =>
      c.method === 'eth_feeHistory'
        ? Object.assign(new Error('header not ready'), { code: -32000 })
        : q(GWEI)
    );
    await expect(estimateFees(custom)).rejects.toThrow('header not ready');
  });

  it('refuses a fee history far above the gas price', async () => {
    mockRpc((c) => (c.method === 'eth_feeHistory' ? history(500n * GWEI) : q(GWEI)));
    await expect(estimateFees(custom)).rejects.toBeInstanceOf(FeeCeilingError);
  });

  it('refuses a fee above the cap of a built-in chain even when consistent', async () => {
    mockRpc((c) => (c.method === 'eth_feeHistory' ? history(5_000n * GWEI) : q(5_000n * GWEI)));
    await expect(estimateFees(ethereum)).rejects.toBeInstanceOf(FeeCeilingError);
  });
});

describe('signEvmTx', () => {
  const base: Eip1559Tx = {
    chainId: 56,
    nonce: 3,
    maxPriorityFeePerGas: 3n * GWEI,
    maxFeePerGas: 3n * GWEI,
    gasLimit: 21000n,
    to: '0x3535353535353535353535353535353535353535',
    value: 1n,
    data: '0x',
  };

  it('signs type 2 unless the tx is marked legacy', async () => {
    const key = await deriveEvmPrivateKey(ABANDON, 0);
    expect(signEvmTx(base, key)).toEqual(signEip1559(base, key));
    const legacy = signEvmTx({ ...base, legacy: true }, key);
    expect(parseInt(legacy.raw.slice(2, 4), 16)).toBeGreaterThanOrEqual(0xc0);
    expect(legacy).toEqual(
      signLegacyEip155(
        {
          chainId: 56,
          nonce: 3,
          gasPrice: 3n * GWEI,
          gasLimit: 21000n,
          to: base.to,
          value: 1n,
          data: '0x',
        },
        key
      )
    );
  });

  it('refuses a legacy tx with two different prices', async () => {
    const key = await deriveEvmPrivateKey(ABANDON, 0);
    expect(() => signEvmTx({ ...base, legacy: true, maxPriorityFeePerGas: GWEI }, key)).toThrow(
      'one gas price'
    );
  });
});
