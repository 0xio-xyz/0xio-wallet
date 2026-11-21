import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { balanceOfCalldata, fetchEvmBalances, fetchTokenBalance } from '../balances';
import { evmNetworksFor, type EvmNetwork } from '../networks';
import { CUSTOM_NETWORKS_KEY, networksFor } from '../registry';
import { rpcBatch } from '../rpc';
import { CUSTOM_TOKENS_KEY, evmTokensFor, type EvmToken } from '../tokens';

const ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

type Call = { id: number; method: string; params: unknown[] };

function word(n: bigint): string {
  return '0x' + n.toString(16).padStart(64, '0');
}

function mockFetch(handler: (url: string, body: Call | Call[]) => unknown, status = 200) {
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(handler(url, body)), { status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) =>
          Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE: EvmNetwork & { custom: true } = {
  custom: true,
  chainId: 8453,
  name: 'Base',
  rpcUrl: 'https://base.test',
  testnet: false,
  nativeSymbol: 'ETH',
  nativeName: 'Ether',
  logoChainId: 8453,
};

const TKN: EvmToken = {
  chainId: 8453,
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logo: null,
};

describe('evmNetworksFor', () => {
  it('maps devnet to testnets', () => {
    expect(evmNetworksFor('devnet').map((n) => n.chainId)).toEqual([11155111, 46630]);
    expect(evmNetworksFor('devnet').every((n) => n.testnet)).toBe(true);
  });

  it('maps mainnet, custom and missing ids to mainnets', () => {
    for (const id of ['mainnet', 'custom_abc', null, undefined]) {
      expect(evmNetworksFor(id).map((n) => n.chainId)).toEqual([1, 4663]);
    }
  });
});

describe('networksFor', () => {
  it('adds custom networks to their own side only', async () => {
    store[CUSTOM_NETWORKS_KEY] = [
      BASE,
      { ...BASE, chainId: 84532, name: 'Base Sepolia', testnet: true },
    ];
    expect((await networksFor('mainnet')).map((n) => n.chainId)).toEqual([1, 4663, 8453]);
    expect((await networksFor('devnet')).map((n) => n.chainId)).toEqual([11155111, 46630, 84532]);
  });

  it('drops stored entries that are not valid networks', async () => {
    store[CUSTOM_NETWORKS_KEY] = [{ ...BASE, rpcUrl: 'http://plain.test' }, { chainId: 5 }, BASE];
    expect((await networksFor('mainnet')).map((n) => n.chainId)).toEqual([1, 4663, 8453]);
  });
});

describe('evmTokensFor', () => {
  it('puts native first, then curated', () => {
    expect(evmTokensFor(1).map((t) => t.symbol)).toEqual(['ETH', 'USDC', 'USDT', 'wOCT']);
    expect(evmTokensFor(4663).map((t) => t.symbol)).toEqual(['ETH', 'USDG']);
    expect(evmTokensFor(11155111).map((t) => t.symbol)).toEqual(['ETH']);
    expect(evmTokensFor(1)[0].address).toBeNull();
  });

  it('gives a custom network its native coin plus its imported tokens', () => {
    expect(evmTokensFor(8453)).toEqual([]);
    const tokens = evmTokensFor(8453, {
      network: { ...BASE, nativeSymbol: 'XYZ', nativeName: 'Xyz' },
      custom: [TKN],
    });
    expect(tokens.map((t) => [t.symbol, t.address, t.custom ?? false])).toEqual([
      ['XYZ', null, false],
      ['USDC', TKN.address, true],
    ]);
    expect(tokens[0].name).toBe('Xyz');
    expect(tokens[0].decimals).toBe(18);
  });

  it('appends imported tokens on built-in chains, skipping curated and other chains', () => {
    const curatedDup = {
      ...TKN,
      chainId: 1,
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    };
    const extra = {
      ...TKN,
      chainId: 1,
      address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      symbol: 'DAI',
    };
    const tokens = evmTokensFor(1, { custom: [curatedDup, extra, TKN, extra] });
    expect(tokens.map((t) => t.symbol)).toEqual(['ETH', 'USDC', 'USDT', 'wOCT', 'DAI']);
  });
});

describe('balanceOfCalldata', () => {
  it('encodes selector plus left padded address', () => {
    const data = balanceOfCalldata(ADDR);
    expect(data).toBe('0x70a08231000000000000000000000000' + ADDR.slice(2).toLowerCase());
    expect(data.length).toBe(2 + 8 + 64);
  });
});

describe('rpcBatch', () => {
  it('maps out of order batch responses back by id', async () => {
    mockFetch((_url, body) => {
      const calls = body as Call[];
      return [...calls].reverse().map((c) => ({ jsonrpc: '2.0', id: c.id, result: `0x${c.id}` }));
    });
    const res = await rpcBatch('https://rpc.test', [
      { method: 'a', params: [] },
      { method: 'b', params: [] },
    ]);
    expect(res).toEqual(['0x1', '0x2']);
  });

  it('falls back to sequential calls when the response is not an array', async () => {
    const fn = mockFetch((_url, body) =>
      Array.isArray(body)
        ? { error: 'no batch' }
        : { jsonrpc: '2.0', id: body.id, result: body.method }
    );
    const res = await rpcBatch('https://rpc.test', [
      { method: 'x', params: [] },
      { method: 'y', params: [] },
    ]);
    expect(res).toEqual(['x', 'y']);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('fetchEvmBalances', () => {
  it('parses a batch and formats amounts', async () => {
    const fn = mockFetch((_url, body) =>
      (body as Call[]).map((c) => {
        if (c.method === 'eth_getBalance')
          return { jsonrpc: '2.0', id: c.id, result: '0xde0b6b3a7640000' };
        const { to, data } = c.params[0] as { to: string; data: string };
        expect(data).toBe(balanceOfCalldata(ADDR));
        const value = to.startsWith('0xA0b8') ? 1234500n : 0n;
        return { jsonrpc: '2.0', id: c.id, result: word(value) };
      })
    );
    const { rows, failedChains } = await fetchEvmBalances(
      ADDR,
      (await networksFor('mainnet')).slice(0, 1)
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(failedChains).toEqual([]);
    expect(rows.map((r) => [r.token.symbol, r.raw, r.amount])).toEqual([
      ['ETH', '1000000000000000000', '1'],
      ['USDC', '1234500', '1.2345'],
      ['USDT', '0', '0'],
      ['wOCT', '0', '0'],
    ]);
    expect(rows[0].chainName).toBe('Ethereum');
  });

  it('puts a failed chain in failedChains with no rows', async () => {
    mockFetch((url, body) => {
      const calls = body as Call[];
      if (url.includes('robinhood'))
        return calls.map((c) => ({
          jsonrpc: '2.0',
          id: c.id,
          error: { code: -32000, message: 'down' },
        }));
      return calls.map((c) => ({
        jsonrpc: '2.0',
        id: c.id,
        result: c.method === 'eth_getBalance' ? '0x1' : word(0n),
      }));
    });
    const { rows, failedChains } = await fetchEvmBalances(ADDR, await networksFor('mainnet'));
    expect(failedChains).toEqual([4663]);
    expect(rows.every((r) => r.chainId === 1)).toBe(true);
    expect(rows).toHaveLength(4);
  });

  it('treats HTTP errors and bad hex as a failed chain', async () => {
    mockFetch(() => ({}), 503);
    const http = await fetchEvmBalances(ADDR, evmNetworksFor('devnet'));
    expect(http.rows).toEqual([]);
    expect(http.failedChains).toEqual([11155111, 46630]);

    mockFetch((_url, body) =>
      (body as Call[]).map((c) => ({ jsonrpc: '2.0', id: c.id, result: 'nope' }))
    );
    const bad = await fetchEvmBalances(ADDR, evmNetworksFor('devnet'));
    expect(bad.rows).toEqual([]);
    expect(bad.failedChains).toEqual([11155111, 46630]);
  });

  it('reads custom networks and imported tokens from storage', async () => {
    store[CUSTOM_NETWORKS_KEY] = [BASE];
    store[CUSTOM_TOKENS_KEY] = { '8453': [TKN] };
    mockFetch((url, body) =>
      (body as Call[]).map((c) => ({
        jsonrpc: '2.0',
        id: c.id,
        result: c.method === 'eth_getBalance' ? '0x0' : word(url.includes('base') ? 2500000n : 0n),
      }))
    );
    const { rows, failedChains } = await fetchEvmBalances(ADDR, await networksFor('mainnet'));
    expect(failedChains).toEqual([]);
    const base = rows.filter((r) => r.chainId === 8453);
    expect(base.map((r) => [r.token.symbol, r.amount, r.chainName])).toEqual([
      ['ETH', '0', 'Base'],
      ['USDC', '2.5', 'Base'],
    ]);
  });

  it('leaves out an imported token that fails without failing its chain', async () => {
    store[CUSTOM_TOKENS_KEY] = {
      '1': [
        {
          ...TKN,
          chainId: 1,
          address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
          symbol: 'DAI',
        },
      ],
    };
    mockFetch((_url, body) =>
      (body as Call[]).map((c) => {
        if (c.method === 'eth_getBalance') return { jsonrpc: '2.0', id: c.id, result: '0x1' };
        const { to } = c.params[0] as { to: string };
        return to.startsWith('0x6B17')
          ? { jsonrpc: '2.0', id: c.id, result: '0x' }
          : { jsonrpc: '2.0', id: c.id, result: word(0n) };
      })
    );
    const { rows, failedChains } = await fetchEvmBalances(
      ADDR,
      evmNetworksFor('mainnet').slice(0, 1)
    );
    expect(failedChains).toEqual([]);
    expect(rows.map((r) => r.token.symbol)).toEqual(['ETH', 'USDC', 'USDT', 'wOCT']);
  });

  it('still fails the chain when a curated token fails', async () => {
    mockFetch((_url, body) =>
      (body as Call[]).map((c) => ({
        jsonrpc: '2.0',
        id: c.id,
        result: c.method === 'eth_getBalance' ? '0x1' : '0x',
      }))
    );
    const res = await fetchEvmBalances(ADDR, evmNetworksFor('mainnet').slice(0, 1));
    expect(res.failedChains).toEqual([1]);
  });

  it('rejects an address that is not 0x plus 40 hex', async () => {
    const fn = mockFetch(() => []);
    await expect(
      fetchEvmBalances('9858EfFD232B4033E47d90003D41EC34EcaEda94', evmNetworksFor('mainnet'))
    ).rejects.toThrow();
    await expect(fetchEvmBalances('octABC', evmNetworksFor('mainnet'))).rejects.toThrow();
    await expect(fetchEvmBalances('0x1234', evmNetworksFor('mainnet'))).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('fetchTokenBalance', () => {
  it('reads one ERC-20 balance with a single call', async () => {
    const fn = mockFetch((_url, body) => {
      const c = body as Call;
      expect(c.method).toBe('eth_call');
      return { jsonrpc: '2.0', id: c.id, result: word(42n) };
    });
    expect(await fetchTokenBalance(ADDR, BASE, TKN)).toBe(42n);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
