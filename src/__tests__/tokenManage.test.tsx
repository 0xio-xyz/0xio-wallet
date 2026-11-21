import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ tokensByAddress: vi.fn(), storage: vi.fn() }));

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
  DETECT_TTL_MS,
  cleanDetectedRecord,
  detectedKey,
  detectedSpamReason,
  fetchOracleTokens,
  parseOracleTokens,
  planEvmTokens,
  readDetected,
  refreshDetection,
  type DetectedRecord,
  type DetectedToken,
} from 'src/services/evm/detectedTokens';
import { balanceOfCalldata, fetchEvmBalances } from 'src/services/evm/balances';
import { evmNetworksFor } from 'src/services/evm/networks';
import { CUSTOM_TOKENS_KEY, type EvmToken } from 'src/services/evm/tokens';
import {
  cleanVisMap,
  evmVisKey,
  octraVisKey,
  peekVisibility,
  readVisibility,
  setTokenShown,
} from 'src/services/tokens/tokenVisibility';
import { evmRowShown } from 'src/hooks/wallet/useEvmBalances';
import { useOctraTokens } from 'src/hooks/wallet/useOctraTokens';
import {
  TOKEN_LIST_CACHE_KEY,
  readOctraHoldings,
  resetOctraTokenCaches,
} from 'src/services/tokens/octraTokens';
import { pricedHoldings, type EvmHolding } from 'src/features/wallet/home/pricedHoldings';
import {
  evmCollectionRows,
  evmManageRows,
  octraCollectionRows,
  octraManageRows,
  splitByVerdict,
} from 'src/features/settings/tokens/manageRows';
import {
  hideSpamCollections,
  isCollectionHidden,
  loadHidden,
  setCollectionHidden,
} from 'src/features/wallet/nft/hidden';
import { evmHiddenScope, spamCollectionsByChain } from 'src/hooks/wallet/useEvmNfts';
import { deriveEvmGallery } from 'src/features/wallet/nft/evm/deriveEvmGallery';
import type { EvmNft } from 'src/services/evm/nfts';
import type { NftCollection } from 'src/features/wallet/nft/nftData';
import { keysForRemovedAddresses } from 'src/services/wallet/WalletStorage';
import { clearSessionCaches } from 'src/utils/sessionCaches';

const ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ADDR2 = '0xabcdef0000000000000000000000000000000002';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SPAM = '0x2222222222222222222222222222222222222222';
const GOOD = '0x3333333333333333333333333333333333333333';
const MINE = '0x4444444444444444444444444444444444444444';
const OCT_ADDR = 'octWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WOCT_DEVNET = 'octCcgs68MFeeG8kpcwpHjdfD1M7tvjLKMvxkKMRkbNPmVs';
const OCT_GOOD = `oct${'Good'.repeat(11)}`;
const OCT_SPAM = `oct${'Spam'.repeat(11)}`;
const OCT_IMPORT = `oct${'Kmpt'.repeat(11)}`;

let local: Record<string, unknown> = {};

const pick = (keys: unknown) => {
  if (keys === null || keys === undefined) return { ...local };
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
  return Object.fromEntries(list.filter((k) => k in local).map((k) => [k, local[k as string]]));
};

beforeEach(() => {
  local = {};
  const c = chrome as unknown as Record<string, any>;
  c.storage.local.get = vi.fn(async (keys: unknown) => pick(keys));
  c.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(local, structuredClone(items));
  });
  c.storage.local.remove = vi.fn(async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete local[k];
  });
  h.tokensByAddress.mockReset();
  h.storage.mockReset();
  resetOctraTokenCaches();
  clearSessionCaches();
});

const realFetch = globalThis.fetch;
const stubFetch = (fn: unknown) => {
  globalThis.fetch = fn as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

const item = (over: Partial<DetectedToken> & { contract: string }): DetectedToken => ({
  symbol: 'TKN',
  name: 'Token',
  decimals: 18,
  balance: '1000',
  price: null,
  verified: null,
  spam: false,
  spamReason: null,
  logo: null,
  ...over,
});

const record = (items: DetectedToken[], sent: string[] = []): DetectedRecord => ({
  at: Date.now(),
  indexed: true,
  complete: true,
  items,
  sent,
});

describe('oracle response validation', () => {
  it('keeps only items whose every field checks out', () => {
    const parsed = parseOracleTokens({
      complete: true,
      items: [
        { contract: GOOD.toLowerCase(), symbol: 'GOOD', name: 'Good', decimals: 6, balance: '5' },
        { contract: '0x1234', symbol: 'BAD', decimals: 6, balance: '5' },
        { contract: SPAM, symbol: 'X', decimals: 37, balance: '5' },
        { contract: SPAM, symbol: 'X', decimals: 6.5, balance: '5' },
        { contract: SPAM, symbol: 'X', decimals: 6, balance: '0' },
        { contract: SPAM, symbol: 'X', decimals: 6, balance: '0x10' },
        { contract: SPAM, symbol: 'X', decimals: 6, balance: '1'.repeat(79) },
        {
          contract: MINE,
          symbol: 'ABCDEFGHIJKL',
          name: 'n'.repeat(41),
          decimals: 0,
          balance: '7',
          price: -1,
          verified: 'yes',
          spam: true,
          spamReason: 'made_up',
        },
        { contract: GOOD, symbol: 'DUP', decimals: 6, balance: '9' },
        'junk',
        null,
      ],
    });
    expect(parsed?.complete).toBe(true);
    expect(parsed?.items).toEqual([
      {
        contract: GOOD,
        symbol: 'GOOD',
        name: 'Good',
        decimals: 6,
        balance: '5',
        price: null,
        verified: null,
        spam: null,
        spamReason: null,
        logo: null,
      },
      {
        contract: MINE,
        symbol: null,
        name: null,
        decimals: 0,
        balance: '7',
        price: null,
        verified: null,
        spam: true,
        spamReason: 'flagged',
        logo: null,
      },
    ]);
  });

  it('refuses a body of the wrong shape', () => {
    expect(parseOracleTokens(null)).toBeNull();
    expect(parseOracleTokens([])).toBeNull();
    expect(parseOracleTokens({ items: 'x' })).toBeNull();
    expect(parseOracleTokens({ items: [] })).toEqual({ items: [], complete: false });
  });

  it('reads 400, 402, 404 and 503 as not indexed, and throws on other failures', async () => {
    for (const status of [400, 402, 404, 503]) {
      stubFetch(vi.fn(async () => new Response('{}', { status })));
      expect(await fetchOracleTokens(1, ADDR)).toBeNull();
    }
    stubFetch(vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(fetchOracleTokens(1, ADDR)).rejects.toThrow('HTTP 500');
    stubFetch(vi.fn(async () => new Response('{"nope":1}', { status: 200 })));
    await expect(fetchOracleTokens(1, ADDR)).rejects.toThrow();
  });

  it('checks a stored record again on read', () => {
    expect(cleanDetectedRecord({ at: 'x', items: [] })).toBeNull();
    const rec = cleanDetectedRecord({
      at: 5,
      items: [{ contract: GOOD, decimals: 6, balance: '1' }, { contract: 'bad' }],
      sent: [SPAM, 'nope'],
    });
    expect(rec?.items.map((i) => i.contract)).toEqual([GOOD]);
    expect(rec?.sent).toEqual([SPAM.toLowerCase()]);
  });
});

describe('detection reads', () => {
  const oracle = (items: unknown[]) => ({ items, complete: true });

  it('reads once per ten minutes unless forced, and keeps the record when a read fails', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/api/evm/tokens')) {
        return new Response(
          JSON.stringify(
            oracle([{ contract: GOOD, symbol: 'GOOD', name: 'Good', decimals: 6, balance: '5' }])
          ),
          { status: 200 }
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    stubFetch(fetchFn);
    const first = await refreshDetection(ADDR, [1]);
    expect(first[1]?.items.map((i) => i.symbol)).toEqual(['GOOD']);
    expect(local[detectedKey(1, ADDR)]).toBeTruthy();
    await refreshDetection(ADDR, [1]);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    fetchFn.mockImplementation(async () => new Response('{}', { status: 500 }));
    const kept = await refreshDetection(ADDR, [1], { force: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(kept[1]?.items.map((i) => i.symbol)).toEqual(['GOOD']);

    (local[detectedKey(1, ADDR)] as DetectedRecord).at = Date.now() - DETECT_TTL_MS - 1;
    clearSessionCaches();
    await refreshDetection(ADDR, [1]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('asks history what the wallet sent only when something looks like spam', async () => {
    const urls: string[] = [];
    stubFetch(
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes('/api/evm/tokens')) {
          return new Response(
            JSON.stringify(
              oracle([
                {
                  contract: SPAM,
                  symbol: 'FREE',
                  name: 'free.xyz',
                  decimals: 6,
                  balance: '5',
                  spam: true,
                  spamReason: 'link',
                },
              ])
            ),
            { status: 200 }
          );
        }
        const transfer = {
          from: { hash: ADDR },
          to: { hash: GOOD },
          token: { address_hash: SPAM },
        };
        if (url.includes('/api/evm/history')) {
          return new Response(JSON.stringify({ transactions: [], token_transfers: [transfer] }), {
            status: 200,
          });
        }
        if (url.includes('token-transfers')) {
          return new Response(JSON.stringify({ items: [transfer] }), { status: 200 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      })
    );
    const recs = await refreshDetection(ADDR, [1]);
    expect(urls.some((u) => u.includes('token-transfers') || u.includes('/api/evm/history'))).toBe(
      true
    );
    expect(recs[1]?.sent).toEqual([SPAM.toLowerCase()]);
    expect(
      detectedSpamReason(1, recs[1]!.items[0], {
        imported: new Set(),
        sent: new Set(recs[1]!.sent),
      })
    ).toBeNull();
  });

  it('marks a chain the oracle does not index, with no error', async () => {
    stubFetch(vi.fn(async () => new Response('{}', { status: 402 })));
    const recs = await refreshDetection(ADDR, [8453]);
    expect(recs[8453]).toMatchObject({ indexed: false, items: [] });
  });
});

describe('never spam', () => {
  const spam = item({ contract: USDC, symbol: 'USDC', spam: true, spamReason: 'flagged' });
  const none = { imported: new Set<string>(), sent: new Set<string>() };

  it('curated tokens, imports and tokens the wallet sent are never spam', () => {
    expect(detectedSpamReason(1, spam, none)).toBeNull();
    const other = item({ contract: SPAM, spam: true, spamReason: 'bait' });
    expect(detectedSpamReason(1, other, none)).toBe('bait');
    expect(
      detectedSpamReason(1, other, { imported: new Set([SPAM.toLowerCase()]), sent: new Set() })
    ).toBeNull();
    expect(
      detectedSpamReason(1, other, { imported: new Set(), sent: new Set([SPAM.toLowerCase()]) })
    ).toBeNull();
  });

  it('falls back to the wallet rules when the oracle gave no verdict', () => {
    const unjudged = item({ contract: SPAM, symbol: 'X', name: 'Claim now', spam: null });
    expect(detectedSpamReason(1, unjudged, none)).toBe('bait');
    const priced = item({ contract: SPAM, symbol: 'X', name: 'Claim now', spam: null, price: 2 });
    expect(detectedSpamReason(1, priced, none)).toBeNull();
    const cleared = item({ contract: SPAM, symbol: 'X', name: 'Claim now', spam: false });
    expect(detectedSpamReason(1, cleared, none)).toBeNull();
  });
});

describe('switches win over detection', () => {
  const imported: EvmToken = {
    chainId: 1,
    address: MINE,
    symbol: 'MINE',
    name: 'Mine',
    decimals: 18,
    logo: null,
    custom: true,
  };
  const detected = {
    1: record([
      item({ contract: GOOD, symbol: 'GOOD' }),
      item({ contract: SPAM, symbol: 'FREE', spam: true, spamReason: 'bait' }),
    ]),
  };
  const keys = (list: EvmToken[]) => list.map((t) => t.symbol);

  it('adds detected tokens that are not spam, as detected', () => {
    const plan = planEvmTokens({ chainIds: [1], imported: [imported], detected, vis: {} });
    expect(keys(plan.custom)).toEqual(['MINE', 'GOOD']);
    expect(plan.custom[1]).toMatchObject({ detected: true, custom: true, address: GOOD });
    expect(plan.exclude.size).toBe(0);
  });

  it('a spam token switched on shows, a clean one switched off does not', () => {
    const vis = {
      1: { [SPAM.toLowerCase()]: true, [GOOD.toLowerCase()]: false, [USDT.toLowerCase()]: false },
    };
    const plan = planEvmTokens({ chainIds: [1], imported: [imported], detected, vis });
    expect(keys(plan.custom)).toEqual(['MINE', 'FREE']);
    expect([...plan.exclude]).toEqual([`1:${USDT.toLowerCase()}`]);
    expect(plan.shown.has(`1:${USDT.toLowerCase()}`)).toBe(false);
    expect(plan.shown.has(`1:${USDC.toLowerCase()}`)).toBe(true);
  });

  it('an import switched off is not read', () => {
    const vis = { 1: { [MINE.toLowerCase()]: false } };
    const plan = planEvmTokens({ chainIds: [1], imported: [imported], detected: {}, vis });
    expect(keys(plan.custom)).toEqual([]);
  });

  it('Settings puts rows in sections by verdict and keeps them there when switched', () => {
    const rows = evmManageRows({
      address: ADDR,
      networks: [{ chainId: 1, name: 'Ethereum' }],
      imported: [imported],
      detected,
      vis: { [evmVisKey(1, ADDR)]: { [SPAM.toLowerCase()]: true } },
      balances: [],
    });
    const { regular, spam } = splitByVerdict(rows);
    expect(regular.map((r) => [r.symbol, r.origin, r.shown])).toEqual([
      ['USDC', 'listed', true],
      ['USDT', 'listed', true],
      ['wOCT', 'listed', true],
      ['MINE', 'imported', true],
      ['GOOD', 'detected', true],
    ]);
    expect(spam.map((r) => [r.symbol, r.spam, r.shown, r.amount])).toEqual([
      ['FREE', 'bait', true, '< 0.000001'],
    ]);
  });
});

describe('hidden tokens on Home', () => {
  const ethereum = evmNetworksFor('mainnet').filter((n) => n.chainId === 1);
  const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

  it('are never read, never listed and never counted', async () => {
    const calls: { to?: string; method: string }[] = [];
    stubFetch(
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          id: number;
          method: string;
          params: unknown[];
        }[];
        return new Response(
          JSON.stringify(
            body.map((c) => {
              const to = (c.params[0] as { to?: string; data?: string })?.to;
              calls.push({ to, method: c.method });
              if (c.method === 'eth_getBalance') return { jsonrpc: '2.0', id: c.id, result: '0x0' };
              expect((c.params[0] as { data: string }).data).toBe(balanceOfCalldata(ADDR));
              return { jsonrpc: '2.0', id: c.id, result: word(2_000_000n) };
            })
          ),
          { status: 200 }
        );
      })
    );
    const plan = planEvmTokens({
      chainIds: [1],
      imported: [],
      detected: {},
      vis: { 1: { [USDC.toLowerCase()]: false } },
    });
    const { rows } = await fetchEvmBalances(ADDR, ethereum, {
      custom: plan.custom,
      exclude: plan.exclude,
    });
    expect(calls.some((c) => c.to?.toLowerCase() === USDC.toLowerCase())).toBe(false);
    expect(rows.map((r) => r.token.symbol)).toEqual(['ETH', 'USDT', 'wOCT']);

    const holdings: EvmHolding[] = rows.map((r) => ({
      ...r,
      usd: r.token.symbol === 'USDT' ? 2 : null,
    }));
    const priced = pricedHoldings({
      view: 'evm',
      networkId: 'mainnet',
      octPrice: 1,
      octTotal: 0,
      octra: { tokens: [], balances: {}, imported: [], state: 'known' },
      evm: { on: true, rows: holdings, loading: false, failedChains: [] },
    });
    expect(priced.totalUsd).toBe(2);
  });

  it('a switch turned off drops a cached row at once', async () => {
    const token: EvmToken = {
      chainId: 1,
      address: USDC,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      logo: null,
    };
    const row = { chainId: 1, token };
    expect(evmRowShown(row, ADDR, undefined)).toBe(true);
    const write = setTokenShown(evmVisKey(1, ADDR), USDC, false);
    expect(evmRowShown(row, ADDR, undefined)).toBe(false);
    await write;
    expect(evmRowShown(row, ADDR2, undefined)).toBe(true);
    expect(evmRowShown({ ...row, token: { ...row.token, address: null } }, ADDR, undefined)).toBe(
      true
    );
  });

  it('Octra: hidden curated tokens and imports leave the rows and the total; spam stays off', async () => {
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
        {
          network: 'octra-devnet',
          address: WOCT_DEVNET,
          symbol: 'WOCT',
          name: 'Wrapped',
          decimals: 6,
        },
      ],
    };
    local['imported_tokens_devnet'] = [OCT_IMPORT];
    local[octraVisKey('devnet', OCT_ADDR)] = { [WOCT_DEVNET]: false, [OCT_IMPORT]: false };
    h.tokensByAddress.mockResolvedValue([
      {
        contractAddress: WOCT_DEVNET,
        symbol: 'WOCT',
        name: 'Wrapped',
        decimals: 6,
        balance: '5000000',
      },
      { contractAddress: OCT_GOOD, symbol: 'GOOD', name: 'Good', decimals: 6, balance: '1000000' },
      {
        contractAddress: OCT_SPAM,
        symbol: 'FREE',
        name: 'Claim at x.com',
        decimals: 6,
        balance: '1',
      },
      { contractAddress: OCT_IMPORT, symbol: 'IMP', name: 'Imp', decimals: 6, balance: '3' },
    ]);
    const { result } = renderHook(() => useOctraTokens(OCT_ADDR, 'devnet'));
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.state).toBe('known');
    expect(result.current.tokens.map((t) => t.address).sort()).toEqual([
      'native',
      'native-private',
    ]);
    expect(result.current.imported).toEqual([]);
    expect(result.current.detected.map((t) => t.symbol)).toEqual(['GOOD']);
    expect(h.storage).not.toHaveBeenCalled();

    const priced = pricedHoldings({
      view: 'oct',
      networkId: 'devnet',
      octPrice: 2,
      octTotal: 10,
      octra: result.current,
      evm: { on: false, rows: [], loading: false, failedChains: [] },
    });
    expect(priced.totalUsd).toBe(20);
    expect(priced.contractUsd[WOCT_DEVNET]).toBeUndefined();
  });

  it('Octra: a hidden import is never read; detected tokens exclude curated and imports', async () => {
    h.tokensByAddress.mockResolvedValue([
      { contractAddress: OCT_IMPORT, symbol: 'IMP', name: 'Imp', decimals: 6, balance: '3' },
      { contractAddress: OCT_GOOD, symbol: 'GOOD', name: 'Good', decimals: 6, balance: '1' },
      { contractAddress: OCT_SPAM, symbol: 'NFT', name: 'Art', decimals: 0, balance: '1' },
    ]);
    const res = await readOctraHoldings({
      networkId: 'devnet',
      address: OCT_ADDR,
      imports: [],
      known: [OCT_IMPORT],
    });
    expect(res.held.map((t) => t.contractAddress)).toEqual([OCT_GOOD]);
    expect(h.storage).not.toHaveBeenCalled();
  });

  it('Octra rows in Settings carry the verdict and the switch', () => {
    const rows = octraManageRows({
      networkId: 'devnet',
      networkName: 'Devnet',
      address: OCT_ADDR,
      listed: [{ address: WOCT_DEVNET, symbol: 'WOCT', name: 'Wrapped', decimals: 6 }],
      importAddrs: [OCT_IMPORT],
      importMeta: { [OCT_IMPORT]: { symbol: 'IMP', name: 'Imp', decimals: 6 } },
      held: [
        {
          contractAddress: OCT_GOOD,
          symbol: 'GOOD',
          name: 'Good',
          decimals: 6,
          balance: '1500000',
        },
        { contractAddress: OCT_SPAM, symbol: 'OCT', name: 'Octra', decimals: 6, balance: '1' },
      ],
      balances: { [WOCT_DEVNET]: '2000000' },
      vis: { [OCT_IMPORT]: false, [OCT_SPAM]: true },
    });
    expect(rows.map((r) => [r.symbol, r.origin, r.spam, r.shown, r.amount])).toEqual([
      ['WOCT', 'listed', null, true, '2'],
      ['IMP', 'imported', null, false, '0'],
      ['GOOD', 'detected', null, true, '1.5'],
      ['OCT', 'detected', 'impersonation', true, '0.000001'],
    ]);
  });
});

describe('scope keys', () => {
  it('names every switch and detection record by network and address', () => {
    expect(evmVisKey(1, ADDR)).toBe(`0xio_token_vis_evm_1_${ADDR.toLowerCase()}`);
    expect(evmVisKey(4663, ADDR)).not.toBe(evmVisKey(1, ADDR));
    expect(evmVisKey(1, ADDR2)).not.toBe(evmVisKey(1, ADDR));
    expect(octraVisKey('devnet', OCT_ADDR)).toBe(`0xio_token_vis_oct_devnet_${OCT_ADDR}`);
    expect(octraVisKey('mainnet', OCT_ADDR)).not.toBe(octraVisKey('devnet', OCT_ADDR));
    expect(detectedKey(1, ADDR)).toBe(`0xio_evm_detected_1_${ADDR.toLowerCase()}`);
  });

  it('a switch on one chain or address leaves the others alone', async () => {
    await setTokenShown(evmVisKey(1, ADDR), USDC, false);
    const maps = await readVisibility([
      evmVisKey(1, ADDR),
      evmVisKey(4663, ADDR),
      evmVisKey(1, ADDR2),
    ]);
    expect(maps[evmVisKey(1, ADDR)]).toEqual({ [USDC.toLowerCase()]: false });
    expect(maps[evmVisKey(4663, ADDR)]).toEqual({});
    expect(maps[evmVisKey(1, ADDR2)]).toEqual({});
  });

  it('keeps the window copy when the write fails, then puts the switch back', async () => {
    const c = chrome as unknown as Record<string, any>;
    c.storage.local.set = vi.fn(async () => {
      throw new Error('quota');
    });
    await expect(setTokenShown(evmVisKey(1, ADDR), USDC, false)).rejects.toThrow('quota');
    expect(peekVisibility(evmVisKey(1, ADDR))).toEqual({});
  });

  it('drops anything off in a stored map', () => {
    expect(
      cleanVisMap(evmVisKey(1, ADDR), {
        [USDC.toLowerCase()]: false,
        [USDC]: true,
        x: true,
        [SPAM]: 1,
      })
    ).toEqual({ [USDC.toLowerCase()]: false });
    expect(cleanVisMap(octraVisKey('devnet', OCT_ADDR), { [OCT_GOOD]: true, bad: false })).toEqual({
      [OCT_GOOD]: true,
    });
    expect(cleanVisMap(evmVisKey(1, ADDR), ['x'])).toEqual({});
  });

  it('reads detection records per chain and address only', async () => {
    local[detectedKey(1, ADDR)] = record([item({ contract: GOOD })]);
    const mine = await readDetected([1, 4663], ADDR);
    expect(mine[1]?.items).toHaveLength(1);
    expect(mine[4663]).toBeUndefined();
    expect((await readDetected([1], ADDR2))[1]).toBeUndefined();
  });

  it('removing a wallet sweeps its switches, detection records and shown collections', () => {
    const gone = ADDR.toLowerCase();
    const keys = [
      evmVisKey(1, ADDR),
      octraVisKey('devnet', OCT_ADDR),
      detectedKey(1, ADDR),
      `0xio_nft_shown_colls_evm1_${gone}`,
      `0xio_nft_shown_colls_devnet_${OCT_ADDR}`,
      evmVisKey(1, ADDR2),
    ];
    expect(keysForRemovedAddresses(keys, [OCT_ADDR, ADDR], [ADDR2])).toEqual(keys.slice(0, 5));
  });
});

describe('NFT collections', () => {
  const nft = (contract: string, tokenId: string, collection: string | null): EvmNft => ({
    chainId: 1,
    contract,
    tokenId,
    standard: 'ERC-721',
    amount: '1',
    name: null,
    collection,
    image: null,
  });

  it('spam-looking collections start hidden, once; a collection shown by hand stays shown', async () => {
    const s = evmHiddenScope(1, ADDR);
    let hidden = await hideSpamCollections(s.networkId, s.wallet, [SPAM]);
    expect(isCollectionHidden(hidden, SPAM)).toBe(true);
    await setCollectionHidden(s.networkId, s.wallet, SPAM, false);
    hidden = await hideSpamCollections(s.networkId, s.wallet, [SPAM]);
    expect(isCollectionHidden(hidden, SPAM)).toBe(false);
    await setCollectionHidden(s.networkId, s.wallet, SPAM, true);
    expect(isCollectionHidden(await loadHidden(s.networkId, s.wallet), SPAM)).toBe(true);
    expect(isCollectionHidden(await loadHidden('evm1', ADDR2.toLowerCase()), SPAM)).toBe(false);
  });

  it('hiding removes the collection from the NFT list, imported ones are never spam', async () => {
    const items = [
      nft(SPAM, '1', 'Claim at drop.xyz'),
      nft(GOOD, '2', 'Apes'),
      nft(MINE, '3', 'Free gift'),
    ];
    const spam = spamCollectionsByChain(items, { 1: [nft(MINE, '3', 'Free gift')] });
    expect(spam).toEqual({ 1: [SPAM] });
    const s = evmHiddenScope(1, ADDR);
    const hidden = await hideSpamCollections(s.networkId, s.wallet, spam[1]);
    const g = deriveEvmGallery(items, { 1: hidden });
    expect(g.collections.map((c) => c.contract)).toEqual([GOOD, MINE]);
    expect(g.hiddenItems.map((n) => n.contract)).toEqual([SPAM]);

    const rows = evmCollectionRows({
      items,
      hidden: { 1: hidden },
      imported: { 1: [MINE] },
      networks: [{ chainId: 1, name: 'Ethereum' }],
    });
    expect(rows.map((r) => [r.name, r.spam, r.shown, r.count])).toEqual([
      ['Claim at drop.xyz', 'link', false, 1],
      ['Apes', null, true, 1],
      ['Free gift', null, true, 1],
    ]);
  });

  it('Octra collection rows: verdict by name, imports exempt, switch from the hide store', () => {
    const coll = (contractAddress: string, name: string, imported = false): NftCollection => ({
      contractAddress,
      name,
      symbol: '',
      totalSupply: null,
      ownedCount: 2,
      ownedTokenIds: [],
      imported,
    });
    const rows = octraCollectionRows({
      collections: [coll(OCT_SPAM, 'Visit claim.io'), coll(OCT_GOOD, 'Free stuff', true)],
      ids: { [OCT_SPAM]: ['4'] },
      hidden: { collections: [OCT_SPAM], pieces: [] },
      networkName: 'Devnet',
    });
    expect(rows.map((r) => [r.spam, r.shown, r.count, r.coverId])).toEqual([
      ['link', false, 1, '4'],
      [null, true, 2, null],
    ]);
  });
});

describe('imported EVM tokens stay global', () => {
  it('reads imports from the shared store', async () => {
    local[CUSTOM_TOKENS_KEY] = {
      '1': [{ chainId: 1, address: MINE, symbol: 'MINE', name: 'Mine', decimals: 18 }],
    };
    const { loadEvmTokenPlan } = await import('src/services/evm/detectedTokens');
    const plan = await loadEvmTokenPlan(ADDR, [1]);
    expect(plan.custom.map((t) => t.symbol)).toEqual(['MINE']);
  });
});
