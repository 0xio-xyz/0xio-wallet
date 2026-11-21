import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAIN_LIST_KEY,
  CHAIN_LIST_TTL_MS,
  CHAIN_LIST_URL,
  fitCache,
  isOfferableRpc,
  loadChainList,
  parseChainList,
  searchChainList,
  type ChainListEntry,
} from '../chainList';

const base = {
  name: 'Base',
  chainId: 8453,
  isTestnet: false,
  tvl: 9_305_474_749.37,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  explorers: [{ name: 'basescan', url: 'https://basescan.org/' }],
  rpc: [
    { url: 'https://base.gateway.tenderly.co', tracking: 'yes' },
    { url: 'https://mainnet.base.org/' },
    { url: 'wss://base-rpc.publicnode.com', tracking: 'none' },
    { url: 'https://base-rpc.publicnode.com', tracking: 'none' },
    { url: 'https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}' },
    { url: 'https://base.blockpi.network/v1/rpc/public', tracking: 'limited' },
    { url: 'https://mainnet.base.org' },
  ],
};

const RAW = [
  base,
  {
    name: 'Base Sepolia Testnet',
    chainId: 84532,
    isTestnet: true,
    tvl: 1,
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://sepolia.base.org'],
  },
  {
    name: 'Moonbase Alpha',
    chainId: 1287,
    isTestnet: false,
    slip44: 1,
    nativeCurrency: { name: 'Dev', symbol: 'DEV', decimals: 18 },
    rpc: ['https://rpc.api.moonbase.moonbeam.network'],
  },
  {
    name: 'Arbitrum One',
    chainId: 42161,
    isTestnet: false,
    tvl: 2_000_000_000,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [{ url: 'https://arb1.example', tracking: 'yes' }],
  },
  { name: 'Only wss', chainId: 5, nativeCurrency: { symbol: 'X', decimals: 18 }, rpc: ['wss://x'] },
  {
    name: 'Six decimals',
    chainId: 6,
    nativeCurrency: { symbol: 'SIX', decimals: 6 },
    rpc: ['https://six.example'],
  },
  {
    name: 'Flagged',
    chainId: 7,
    redFlags: ['reusedChainId'],
    nativeCurrency: { symbol: 'F', decimals: 18 },
    rpc: ['https://flag.example'],
  },
  {
    name: 'Old',
    chainId: 8,
    status: 'deprecated',
    nativeCurrency: { symbol: 'O', decimals: 18 },
    rpc: ['https://old.example'],
  },
  {
    name: 'Base copy',
    chainId: 8453,
    nativeCurrency: { symbol: 'X' },
    rpc: ['https://copy.example'],
  },
  { name: 'Bad id', chainId: -1, nativeCurrency: { symbol: 'B' }, rpc: ['https://bad.example'] },
  { chainId: 9, nativeCurrency: { symbol: 'N' }, rpc: ['https://noname.example'] },
  null,
  'junk',
  {
    name: 'Local',
    chainId: 1337,
    nativeCurrency: { symbol: 'L' },
    rpc: ['https://localhost:8545', 'https://127.0.0.1:8545'],
  },
];

describe('parseChainList', () => {
  it('keeps chains the wallet can add, with clean https RPCs first', () => {
    const list = parseChainList(RAW);
    expect(list.map((n) => n.chainId)).toEqual([8453, 42161, 84532, 1287]);
    const b = list[0];
    expect(b).toEqual({
      chainId: 8453,
      name: 'Base',
      symbol: 'ETH',
      nativeName: 'Ether',
      rpcs: [
        'https://base-rpc.publicnode.com',
        'https://mainnet.base.org',
        'https://base.blockpi.network/v1/rpc/public',
      ],
      explorer: 'https://basescan.org',
      testnet: false,
      tvl: 9_305_474_749,
    });
    expect(list[1].rpcs).toEqual(['https://arb1.example']);
    expect(list[2].testnet).toBe(true);
    expect(list[3].testnet).toBe(true);
  });

  it('returns nothing for a body that is not a list', () => {
    expect(parseChainList({ chains: RAW })).toEqual([]);
    expect(parseChainList(null)).toEqual([]);
  });

  it('never offers an RPC that needs a key or is not https', () => {
    expect(isOfferableRpc('https://rpc.example/v1')).toBe(true);
    expect(isOfferableRpc('http://rpc.example')).toBe(false);
    expect(isOfferableRpc('https://x.example/${INFURA_API_KEY}')).toBe(false);
    expect(isOfferableRpc('https://x.example/?apikey=abc')).toBe(false);
    expect(isOfferableRpc('https://localhost:8545')).toBe(false);
  });
});

describe('searchChainList', () => {
  const list = parseChainList(RAW);

  it('matches name, symbol or chain id on one side, exact first', () => {
    expect(searchChainList(list, 'base', { testnet: false }).map((n) => n.chainId)).toEqual([8453]);
    expect(searchChainList(list, 'base', { testnet: true }).map((n) => n.chainId)).toEqual([
      84532, 1287,
    ]);
    expect(searchChainList(list, 'moon', { testnet: false })).toEqual([]);
    expect(searchChainList(list, '42161', { testnet: false })[0].name).toBe('Arbitrum One');
    expect(searchChainList(list, 'eth', { testnet: false }).map((n) => n.chainId)).toEqual([
      8453, 42161,
    ]);
    expect(searchChainList(list, 'arb', { testnet: false, exclude: new Set([42161]) })).toEqual([]);
    expect(searchChainList(list, '  ', { testnet: false })).toEqual([]);
    expect(searchChainList(list, 'e', { testnet: false, limit: 1 })).toHaveLength(1);
  });
});

describe('fitCache', () => {
  it('drops the smallest chains until the list fits', () => {
    const many: ChainListEntry[] = Array.from({ length: 500 }, (_, i) => ({
      chainId: i + 1,
      name: `Chain ${i + 1}`,
      symbol: 'C',
      nativeName: 'C',
      rpcs: [`https://rpc${i}.example`],
      testnet: false,
      tvl: 500 - i,
    }));
    const fit = fitCache(many, 10_000);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(10_000);
    expect(fit.length).toBeGreaterThan(0);
    expect(fit[0].chainId).toBe(1);
    expect(fitCache(many)).toHaveLength(500);
  });
});

describe('loadChainList', () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))
          ),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(store, JSON.parse(JSON.stringify(items)));
          }),
        },
      },
    });
  });

  const answer = (body: unknown, init?: ResponseInit) =>
    vi.fn(async () => new Response(JSON.stringify(body), init)) as unknown as typeof fetch;

  it('downloads once, then serves the cached copy for a day', async () => {
    const fetchImpl = answer(RAW);
    const first = await loadChainList({ now: 1_000, fetchImpl });
    expect(first.map((n) => n.chainId)).toEqual([8453, 42161, 84532, 1287]);
    expect(fetchImpl).toHaveBeenCalledWith(CHAIN_LIST_URL, expect.anything());
    expect((store[CHAIN_LIST_KEY] as { at: number }).at).toBe(1_000);

    const again = await loadChainList({ now: 1_000 + CHAIN_LIST_TTL_MS - 1, fetchImpl });
    expect(again).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await loadChainList({ now: 1_000 + CHAIN_LIST_TTL_MS, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps an older copy when the download fails, and fails with none', async () => {
    await expect(
      loadChainList({ now: 0, fetchImpl: answer('nope', { status: 503 }) })
    ).rejects.toThrow();
    await loadChainList({ now: 0, fetchImpl: answer(RAW) });
    const stale = await loadChainList({
      now: CHAIN_LIST_TTL_MS * 3,
      fetchImpl: answer({}, { status: 500 }),
    });
    expect(stale.map((n) => n.chainId)).toEqual([8453, 42161, 84532, 1287]);
    store = {};
    await expect(loadChainList({ now: 0, fetchImpl: answer([]) })).rejects.toThrow('empty');
  });

  it('checks the cached copy again when reading it back', async () => {
    store[CHAIN_LIST_KEY] = {
      at: 0,
      chains: [
        { chainId: 10, name: 'Good', symbol: 'G', rpcs: ['https://good.example'], tvl: 1 },
        { chainId: 11, name: 'Bad rpc', symbol: 'B', rpcs: ['http://bad.example'] },
        { chainId: 'x', name: 'Bad id', symbol: 'B', rpcs: ['https://x.example'] },
        { chainId: 12, name: 'Key', symbol: 'K', rpcs: ['https://k.example/${KEY}'] },
      ],
    };
    const fetchImpl = answer(RAW);
    const list = await loadChainList({ now: 10, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(list).toEqual([
      {
        chainId: 10,
        name: 'Good',
        symbol: 'G',
        nativeName: 'G',
        rpcs: ['https://good.example'],
        testnet: false,
        tvl: 1,
      },
    ]);
  });

  it('refuses an oversized body', async () => {
    const huge = vi.fn(
      async () => new Response('[]', { headers: { 'content-length': String(9_000_000) } })
    ) as unknown as typeof fetch;
    await expect(loadChainList({ now: 0, fetchImpl: huge })).rejects.toThrow('too large');
  });
});
