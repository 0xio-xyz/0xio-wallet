import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tokensByAddress: vi.fn(),
  storage: vi.fn(),
}));

vi.mock('src/services/network/NetworkService', () => ({
  networkService: {
    getTokensByAddressStrict: (...a: unknown[]) => h.tokensByAddress(...a),
    getContractStorageStrict: (...a: unknown[]) => h.storage(...a),
  },
}));
vi.mock('src/services/network/txScope', () => ({
  resolveNetworkPin: async (networkId: string) => ({ networkId, rpcUrl: 'http://node' }),
}));

import {
  TOKEN_LIST_CACHE_KEY,
  TOKEN_META_KEY,
  loadTokenList,
  readOctraHoldings,
  readTokenMeta,
  resetOctraTokenCaches,
  tokensForNetwork,
} from 'src/services/tokens/octraTokens';
import { useOctraTokens } from 'src/hooks/wallet/useOctraTokens';
import {
  octraNative,
  pricedHoldings,
  type EvmHolding,
} from 'src/features/wallet/home/pricedHoldings';
import {
  appendSnapshot,
  getSnapshots,
  stripPrivateFromSnapshots,
} from 'src/services/wallet/BalanceHistory';
import { formatUnits } from 'src/utils/amount';
import { lruSet } from 'src/hooks/wallet/useEvmPrices';
import { merge } from 'src/hooks/wallet/useEvmBalances';
import { clearSessionCaches } from 'src/utils/sessionCaches';

const WOCT_DEVNET = 'octCcgs68MFeeG8kpcwpHjdfD1M7tvjLKMvxkKMRkbNPmVs';
const ADDR = 'octWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN = 'octTOKENBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const IMPORT = 'octIMPORTCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

let local: Record<string, unknown> = {};
let session: Record<string, unknown> = {};

const pick = (store: Record<string, unknown>, keys: unknown) => {
  if (keys === null || keys === undefined) return { ...store };
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
  const out: Record<string, unknown> = {};
  for (const k of list) if (k in store) out[k as string] = store[k as string];
  return out;
};

beforeEach(() => {
  local = {};
  session = { wallet_unlocked: true };
  const c = chrome as unknown as Record<string, any>;
  c.storage.local.get = vi.fn(async (keys: unknown) => pick(local, keys));
  c.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(local, items);
  });
  c.storage.local.remove = vi.fn(async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete local[k];
  });
  c.storage.session.get = vi.fn(async (keys: unknown) => pick(session, keys));
  c.storage.session.set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(session, items);
  });
  c.storage.session.remove = vi.fn(async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete session[k];
  });
  h.tokensByAddress.mockReset();
  h.storage.mockReset();
  resetOctraTokenCaches();
  clearSessionCaches();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

describe('Octra contract-token reads', () => {
  it('keeps the last balances when a strict read fails, never zeros', async () => {
    local[TOKEN_LIST_CACHE_KEY] = {
      at: Date.now(),
      tokens: [
        {
          network: 'octra-devnet',
          address: 'native',
          symbol: 'OCT',
          name: 'Octra',
          tags: ['native'],
        },
        { network: 'octra-devnet', address: TOKEN, symbol: 'TKN', name: 'Token', decimals: 6 },
      ],
    };
    h.tokensByAddress.mockResolvedValueOnce([
      { contractAddress: TOKEN, symbol: 'TKN', name: 'Token', decimals: 6, balance: '2500000' },
    ]);
    const { result, rerender } = renderHook(() => useOctraTokens(ADDR, 'devnet'));
    await flush();
    expect(result.current.balances).toEqual({ [TOKEN]: '2500000' });

    h.tokensByAddress.mockRejectedValueOnce(new Error('503'));
    await act(async () => {
      await result.current.refresh();
    });
    await flush();
    rerender();
    expect(result.current.balances).toEqual({ [TOKEN]: '2500000' });
    expect(result.current.state).toBe('known');
  });

  it('shows unknown, not 0, when the first read fails', async () => {
    local[TOKEN_LIST_CACHE_KEY] = {
      at: Date.now(),
      tokens: [{ network: 'octra-devnet', address: TOKEN, symbol: 'TKN', name: 'Token' }],
    };
    h.tokensByAddress.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useOctraTokens(ADDR, 'devnet'));
    await flush();
    expect(result.current.balances).toBeNull();
    expect(result.current.state).toBe('failed');
  });

  it('does not carry one wallet holdings over to another', async () => {
    local[TOKEN_LIST_CACHE_KEY] = {
      at: Date.now(),
      tokens: [{ network: 'octra-devnet', address: TOKEN, symbol: 'TKN', name: 'Token' }],
    };
    h.tokensByAddress.mockResolvedValueOnce([
      { contractAddress: TOKEN, symbol: 'TKN', name: 'Token', decimals: 6, balance: '7' },
    ]);
    const { result, rerender } = renderHook(({ a }) => useOctraTokens(a, 'devnet'), {
      initialProps: { a: ADDR },
    });
    await flush();
    expect(result.current.balances).toEqual({ [TOKEN]: '7' });
    h.tokensByAddress.mockReturnValue(new Promise(() => {}));
    rerender({ a: 'octOTHER' });
    expect(result.current.balances).toBeNull();
  });

  it('throws on a failed holdings read so the caller keeps its rows', async () => {
    h.tokensByAddress.mockRejectedValue(new Error('timeout'));
    await expect(
      readOctraHoldings({ networkId: 'devnet', address: ADDR, imports: [IMPORT] })
    ).rejects.toThrow('timeout');
    expect(h.storage).not.toHaveBeenCalled();
  });
});

describe('imported token metadata', () => {
  it('reads metadata once, then treats a token the node leaves out as a real 0', async () => {
    h.tokensByAddress.mockResolvedValue([]);
    h.storage.mockImplementation(async (_c: string, key: string) =>
      key === 'symbol' ? 'IMP' : key === 'name' ? 'Imported' : '8'
    );
    const first = await readOctraHoldings({
      networkId: 'devnet',
      address: ADDR,
      imports: [IMPORT],
    });
    expect(first.imported).toEqual([
      { contractAddress: IMPORT, symbol: 'IMP', name: 'Imported', decimals: 8, balance: '0' },
    ]);
    expect(h.storage).toHaveBeenCalledTimes(3);

    await readOctraHoldings({ networkId: 'devnet', address: ADDR, imports: [IMPORT] });
    expect(h.storage).toHaveBeenCalledTimes(3);
    expect((local[TOKEN_META_KEY] as Record<string, unknown>)[`devnet:${IMPORT}`]).toEqual({
      symbol: 'IMP',
      name: 'Imported',
      decimals: 8,
    });
  });

  it('survives a restart through chrome.storage', async () => {
    local[TOKEN_META_KEY] = { [`devnet:${IMPORT}`]: { symbol: 'IMP', name: 'I', decimals: 2 } };
    expect(await readTokenMeta('devnet', IMPORT)).toEqual({
      symbol: 'IMP',
      name: 'I',
      decimals: 2,
    });
    expect(h.storage).not.toHaveBeenCalled();
  });

  it('keeps an import with its last metadata when the storage read fails', async () => {
    h.tokensByAddress.mockResolvedValue([]);
    h.storage.mockRejectedValue(new Error('503'));
    const prev = [
      { contractAddress: IMPORT, symbol: 'IMP', name: 'Imported', decimals: 8, balance: '5' },
    ];
    const res = await readOctraHoldings({
      networkId: 'devnet',
      address: ADDR,
      imports: [IMPORT],
      previous: prev,
    });
    expect(res.imported.map((t) => t.contractAddress)).toEqual([IMPORT]);
  });
});

describe('token list cache', () => {
  it('falls back to a stale cached list when GitHub fails', async () => {
    const stale = {
      at: Date.now() - 7 * 60 * 60_000,
      tokens: [{ network: 'octra-devnet', address: TOKEN, symbol: 'TKN', name: 'Token' }],
    };
    local[TOKEN_LIST_CACHE_KEY] = stale;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const entry = await loadTokenList();
    expect(entry?.tokens.map((t) => t.address)).toEqual([TOKEN]);
  });

  it('still lists native and encrypted OCT with no list at all', () => {
    const rows = tokensForNetwork([], 'octra-devnet', true);
    expect(rows.map((t) => t.address)).toEqual(['native', 'native-private']);
    expect(tokensForNetwork([], undefined, false).map((t) => t.address)).toEqual(['native']);
  });
});

describe('priced holdings', () => {
  const base = {
    view: 'all' as const,
    octPrice: 2,
    octTotal: 10,
    evm: { on: false, rows: [] as EvmHolding[], loading: false, failedChains: [] as number[] },
  };

  it('never prices an Octra contract token by its symbol', () => {
    const fake = 'octFAKEWOCTDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    const p = pricedHoldings({
      ...base,
      networkId: 'mainnet',
      octra: {
        tokens: [{ address: fake, symbol: 'WOCT', name: 'Wrapped OCT', decimals: 6 }],
        balances: { [fake]: '5000000' },
        imported: [],
        state: 'known',
      },
    });
    expect(p.contractUsd[fake]).toBeNull();
    expect(p.totalUsd).toBe(20);
  });

  it('prices the real wOCT contract at the OCT price, in rows and total alike', () => {
    const p = pricedHoldings({
      ...base,
      networkId: 'devnet',
      octra: {
        tokens: [{ address: WOCT_DEVNET, symbol: 'WOCT', name: 'Wrapped OCT', decimals: 6 }],
        balances: { [WOCT_DEVNET]: '5000000' },
        imported: [],
        state: 'known',
      },
    });
    expect(p.contractUsd[WOCT_DEVNET]).toBe(10);
    expect(p.totalUsd).toBe(30);
    expect(p.state).toBe('known');
  });

  it('is loading before any Octra read and partial when a priced read failed', () => {
    const octra = {
      tokens: [{ address: WOCT_DEVNET, symbol: 'WOCT', name: 'W', decimals: 6 }],
      balances: null as Record<string, string> | null,
      imported: null as null,
      state: 'failed' as const,
    };
    expect(pricedHoldings({ ...base, networkId: 'devnet', octra, octTotal: null }).state).toBe(
      'loading'
    );
    expect(pricedHoldings({ ...base, networkId: 'devnet', octra }).state).toBe('partial');
  });

  it('counts a row waiting for its price as still loading, not $0', () => {
    const p = pricedHoldings({
      ...base,
      networkId: 'mainnet',
      octra: { tokens: [], balances: {}, imported: [], state: 'known' },
      evm: {
        on: true,
        loading: false,
        failedChains: [],
        rows: [
          {
            chainId: 1,
            chainName: 'Ethereum',
            testnet: false,
            token: {
              chainId: 1,
              address: null,
              symbol: 'ETH',
              name: 'E',
              decimals: 18,
              logo: null,
            },
            raw: '1',
            amount: '1',
            usd: null,
            priceLoading: true,
          },
        ],
      },
    });
    expect(p.state).toBe('pending');
    expect(p.totalUsd).toBe(20);
  });

  it('is pending, not loading, while only the private half or the token read is out', () => {
    const octra = {
      tokens: [{ address: WOCT_DEVNET, symbol: 'WOCT', name: 'W', decimals: 6 }],
      balances: null as Record<string, string> | null,
      imported: null as null,
      state: 'loading' as const,
    };
    const p = pricedHoldings({ ...base, networkId: 'devnet', octra, octMissing: 'pending' });
    expect(p.state).toBe('pending');
    expect(p.totalUsd).toBe(20);
    const settled = pricedHoldings({
      ...base,
      networkId: 'devnet',
      octra: { ...octra, state: 'known' as const, balances: {} },
      octMissing: null,
    });
    expect(settled.state).toBe('known');
  });

  it('reads the public half with the private one missing, never a false zero', () => {
    expect(octraNative('10', null, true)).toEqual({ value: 10, missing: 'pending' });
    expect(octraNative('10', null, true, true)).toEqual({ value: 10, missing: null });
    expect(octraNative('10', '15', true)).toEqual({ value: 15, missing: null });
    expect(octraNative(null, null, true)).toEqual({ value: null, missing: null });
    expect(octraNative('10', null, false)).toEqual({ value: 10, missing: null });
  });
});

describe('balance history', () => {
  it('stores only the public half on disk and the private half in the session', async () => {
    await appendSnapshot(ADDR, 'devnet', 10, 5);
    const onDisk = JSON.stringify(local);
    expect(onDisk).toContain('"pub":10');
    expect(onDisk).not.toContain('"bal"');
    expect(onDisk).not.toContain('"priv"');
    expect(JSON.stringify(session)).toContain('"priv":5');
    const snaps = await getSnapshots(ADDR, 'devnet');
    expect(snaps.map((s) => s.bal)).toEqual([15]);
  });

  it('falls back to the shown private balance once the session is gone', async () => {
    await appendSnapshot(ADDR, 'devnet', 10, 5);
    session = {};
    expect((await getSnapshots(ADDR, 'devnet', 24, 3)).map((s) => s.bal)).toEqual([13]);
  });

  it('strips old totals that mixed in the private half', async () => {
    const now = Math.floor(Date.now() / 1000);
    local[`0xio_bal_hist_devnet_${ADDR}`] = [
      { time: now - 100, bal: 15 },
      { time: now - 50, pub: 10 },
    ];
    local['0xio_bal_hist_mainnet_octOLD'] = [{ time: now, bal: 99 }];
    await stripPrivateFromSnapshots();
    expect(local[`0xio_bal_hist_devnet_${ADDR}`]).toEqual([{ time: now - 50, pub: 10 }]);
    expect('0xio_bal_hist_mainnet_octOLD' in local).toBe(false);
  });
});

describe('small helpers', () => {
  it('formats huge raw balances exactly', () => {
    expect(formatUnits('123456789012345678901234567', 18)).toBe('123,456,789.012345');
    expect(formatUnits('1000000', 6)).toBe('1');
    expect(formatUnits('1500', 0)).toBe('1,500');
  });

  it('caps an LRU map and drops the oldest entry', () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 5; i++) lruSet(m, `k${i}`, i, 3);
    expect([...m.keys()]).toEqual(['k2', 'k3', 'k4']);
  });

  it('keeps the last row of an imported ERC-20 that failed one read', () => {
    const row = {
      chainId: 1,
      chainName: 'Ethereum',
      testnet: false,
      token: {
        chainId: 1,
        address: '0x' + 'a'.repeat(40),
        symbol: 'IMP',
        name: 'I',
        decimals: 18,
        logo: null as string | null,
        custom: true,
      },
      raw: '5',
      amount: '0.000000000000000005',
    };
    const kept = merge({ rows: [row], failedChains: [], at: 1 }, [], [], [`1:0x${'a'.repeat(40)}`]);
    expect(kept).toEqual([row]);
  });
});
