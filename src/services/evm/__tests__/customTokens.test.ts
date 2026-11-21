import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EvmTokenError,
  addCustomEvmToken,
  decodeAbiString,
  detectEvmTokens,
  loadCustomEvmTokens,
  removeCustomEvmToken,
} from '../customTokens';
import { NETWORK_PREFS_KEY } from '../networkPrefs';
import { CUSTOM_NETWORKS_KEY, findNetwork } from '../registry';
import { CUSTOM_TOKENS_KEY } from '../tokens';

type Call = { id: number; method: string; params: unknown[] };

const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CHECKSUM = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');

function abiString(s: string): string {
  const hex = Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join(
    ''
  );
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, '0');
  return '0x' + word(32) + word(hex.length / 2) + padded;
}

function bytes32(s: string): string {
  const hex = Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join(
    ''
  );
  return '0x' + hex.padEnd(64, '0');
}

let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {
    [CUSTOM_NETWORKS_KEY]: [
      {
        custom: true,
        chainId: 8453,
        name: 'Base',
        rpcUrl: 'https://base.test',
        testnet: false,
        nativeSymbol: 'ETH',
        nativeName: 'Ether',
        logoChainId: 8453,
      },
    ],
  };
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

function chain(answers: { code?: string; symbol?: string; name?: string; decimals?: string }) {
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const calls = JSON.parse(String(init.body)) as Call[];
    return new Response(
      JSON.stringify(
        calls.map((c) => {
          if (c.method === 'eth_getCode')
            return { jsonrpc: '2.0', id: c.id, result: answers.code ?? '0x6080' };
          const data = (c.params[0] as { data: string }).data;
          const value =
            data === '0x95d89b41'
              ? answers.symbol
              : data === '0x06fdde03'
                ? answers.name
                : answers.decimals;
          return value === undefined
            ? { jsonrpc: '2.0', id: c.id, error: { code: -32000, message: 'execution reverted' } }
            : { jsonrpc: '2.0', id: c.id, result: value };
        })
      )
    );
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const USDC = {
  symbol: abiString('USDC'),
  name: abiString('USD Coin'),
  decimals: '0x' + word(6),
};

describe('decodeAbiString', () => {
  it('decodes dynamic strings and bytes32', () => {
    expect(decodeAbiString(abiString('Wrapped Ether'))).toBe('Wrapped Ether');
    expect(decodeAbiString(abiString(''))).toBe('');
    expect(decodeAbiString(bytes32('MKR'))).toBe('MKR');
  });

  it('rejects truncated or lying payloads', () => {
    expect(decodeAbiString('0x')).toBeNull();
    expect(decodeAbiString('0x' + word(32) + word(1000))).toBeNull();
    expect(decodeAbiString('nope')).toBeNull();
  });
});

describe('addCustomEvmToken', () => {
  it('reads symbol, name and decimals on chain in one batch and stores the token', async () => {
    const fn = chain(USDC);
    const token = await addCustomEvmToken({ chainId: 8453, address: TOKEN });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe('https://base.test');
    expect(token).toEqual({
      chainId: 8453,
      address: CHECKSUM,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      logo: null,
      custom: true,
    });
    expect(await loadCustomEvmTokens(8453)).toEqual([token]);
    expect(await loadCustomEvmTokens()).toHaveLength(1);
    expect(await loadCustomEvmTokens(1)).toEqual([]);
  });

  it('reads through the active RPC of a network that is off and turns it on', async () => {
    store[NETWORK_PREFS_KEY] = {
      '8453': { enabled: false, rpcs: ['https://mine.test'], activeRpc: 'https://mine.test' },
    };
    const fn = chain(USDC);
    await addCustomEvmToken({ chainId: 8453, address: TOKEN });
    expect(fn.mock.calls[0][0]).toBe('https://mine.test');
    expect((await findNetwork(8453))?.enabled).toBe(true);
  });

  it('keeps a given symbol and name, and a bundled or inline logo only', async () => {
    chain(USDC);
    const remote = await addCustomEvmToken({
      chainId: 8453,
      address: TOKEN,
      symbol: 'USDbC',
      name: 'Bridged',
      decimals: 6,
      logo: 'https://evil.test/logo.png',
    });
    expect(remote).toMatchObject({ symbol: 'USDbC', name: 'Bridged', logo: null });
    const inline = await addCustomEvmToken({
      chainId: 8453,
      address: TOKEN,
      logo: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(inline.logo).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(await loadCustomEvmTokens(8453)).toHaveLength(1);
  });

  it('refuses decimals that disagree with the contract or fall outside 0 to 36', async () => {
    chain(USDC);
    await expect(
      addCustomEvmToken({ chainId: 8453, address: TOKEN, decimals: 18 })
    ).rejects.toMatchObject({ problem: 'decimalsMismatch' });
    await expect(
      addCustomEvmToken({ chainId: 8453, address: TOKEN, decimals: 37 })
    ).rejects.toMatchObject({ problem: 'decimals' });
    await expect(
      addCustomEvmToken({ chainId: 8453, address: TOKEN, decimals: 1.5 })
    ).rejects.toMatchObject({ problem: 'decimals' });
    chain({ ...USDC, decimals: '0x' + word(77) });
    await expect(addCustomEvmToken({ chainId: 8453, address: TOKEN })).rejects.toMatchObject({
      problem: 'unreadable',
    });
    expect(store[CUSTOM_TOKENS_KEY]).toBeUndefined();
  });

  it('refuses bad addresses, unknown networks, curated tokens and long symbols', async () => {
    const fn = chain(USDC);
    await expect(addCustomEvmToken({ chainId: 8453, address: '0x1234' })).rejects.toMatchObject({
      problem: 'address',
    });
    await expect(addCustomEvmToken({ chainId: 999, address: TOKEN })).rejects.toMatchObject({
      problem: 'network',
    });
    await expect(
      addCustomEvmToken({ chainId: 1, address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' })
    ).rejects.toMatchObject({ problem: 'listed' });
    await expect(
      addCustomEvmToken({ chainId: 8453, address: TOKEN, symbol: 'TWELVECHARSX' })
    ).rejects.toMatchObject({ problem: 'symbol' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses an address with no contract and a contract with no symbol', async () => {
    chain({ ...USDC, code: '0x' });
    const err = await addCustomEvmToken({ chainId: 8453, address: TOKEN }).catch((e) => e);
    expect(err).toBeInstanceOf(EvmTokenError);
    expect(err.problem).toBe('noContract');
    chain({ decimals: USDC.decimals });
    await expect(addCustomEvmToken({ chainId: 8453, address: TOKEN })).rejects.toMatchObject({
      problem: 'unreadable',
    });
  });

  it('strips hidden characters from on-chain names', async () => {
    chain({ ...USDC, symbol: abiString('US\u202eDC'), name: abiString('\u200bUSD Coin\u0000') });
    const token = await addCustomEvmToken({ chainId: 8453, address: TOKEN });
    expect(token.symbol).toBe('USDC');
    expect(token.name).toBe('USD Coin');
  });

  it('removes one token and keeps the rest', async () => {
    chain(USDC);
    await addCustomEvmToken({ chainId: 8453, address: TOKEN });
    await addCustomEvmToken({
      chainId: 8453,
      address: '0x4200000000000000000000000000000000000006',
    });
    await removeCustomEvmToken(8453, CHECKSUM.toLowerCase());
    expect((await loadCustomEvmTokens(8453)).map((t) => t.address)).toEqual([
      '0x4200000000000000000000000000000000000006',
    ]);
  });
});

describe('detectEvmTokens', () => {
  it('returns held, reputable tokens as suggestions only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('eth.blockscout.com/api/v2/addresses/');
        return new Response(
          JSON.stringify({
            items: [
              {
                token: {
                  address_hash: TOKEN,
                  symbol: 'AAA',
                  name: 'Aaa',
                  decimals: '18',
                  reputation: 'ok',
                },
                value: '5',
              },
              {
                token: {
                  address_hash: TOKEN,
                  symbol: 'SPAM',
                  name: 'Claim',
                  decimals: '18',
                  reputation: 'scam',
                },
                value: '5',
              },
              {
                token: {
                  address_hash: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                  symbol: 'USDC',
                  decimals: '6',
                },
                value: '5',
              },
              { token: { address_hash: TOKEN, symbol: 'ZERO', decimals: '18' }, value: '0' },
            ],
          })
        );
      })
    );
    const found = await detectEvmTokens(1, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(found.map((d) => d.symbol)).toEqual(['AAA']);
    expect(store[CUSTOM_TOKENS_KEY]).toBeUndefined();
    expect(await detectEvmTokens(8453, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toEqual([]);
  });
});
