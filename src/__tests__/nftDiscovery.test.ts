import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpc, holdings, network } = vi.hoisted(() => ({
  rpc: vi.fn(),
  holdings: vi.fn(),
  network: { id: 'mainnet' },
}));
vi.mock('src/services/network/NetworkService', () => ({
  networkService: {
    getCurrentNetworkId: async () => network.id,
    jsonRpcCall: (method: string, params: unknown[]) => rpc(method, params),
    contractCallView: async (c: string, m: string, p: unknown, caller: string) => {
      const r = await rpc('contract_call', [c, m, p || '', caller]);
      return r?.result !== undefined ? r.result : r;
    },
    getTokensByAddressStrict: () => holdings(),
  },
}));

import { readAllTokensByAddress, TOKENS_MAX_PAGES } from 'src/services/tokens/tokensByAddress';
import { busyRetry, keepKnownIds, withBusyRetry } from 'src/features/wallet/nft/euint/chainState';
import {
  NFT_LIST_URL,
  NFT_REGISTRY_URL,
  probeCollections,
  resetKnownCollectionCaches,
} from 'src/features/wallet/nft/knownCollections';
import { fetchGalleryCollections, fetchOwnedTokenIds } from 'src/features/wallet/nft/nftData';
import { clearAbiCache } from 'src/features/wallet/nft/abi';

const W = 'oct2qyupyPfAof4kJ8LcTdN7fyQkLxiKhfemLCz94NNoxio';
const XPECTRA = 'octC4PvHrT8U1vDsZ5ejEBj6UgW2fRoLfohFBSCePdstZfQ';
const TUNGSTEN = 'oct6gz4LUn5NAePzgis2PdBBQrUMLZv8uuZS9ZCPecxaRXA';
const BUSY = 'octHWfjg87B9Li57tgHc3d1ZKWYHY1ijwyFdvDNDTnSsY6o';
const REVERTS = 'octH9hzVMGgvCieiERVZGMfXvTa1FHGneESb28212yPPu6J';
const COLONIES = 'octEYrJrypHj2xndM39PokSMM5gGoxEEncKB8k9qGFyhrym';
const busy = () => new Error('Program view busy');
const revert = () => new Error('execution reverted');

const row = (address: string, extra: Record<string, unknown> = {}) => ({
  address,
  name: 'T',
  symbol: 'T',
  decimals: '0',
  balance: '1',
  ...extra,
});

beforeEach(() => {
  rpc.mockReset();
  holdings.mockReset();
  clearAbiCache();
  resetKnownCollectionCaches();
  busyRetry.delaysMs = [0, 0, 0];
  network.id = 'mainnet';
  vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
});

describe('readAllTokensByAddress', () => {
  const page = (n: number, size: number) =>
    Array.from({ length: size }, (_, i) => row(`page${n}-${i}`));

  it('follows next_offset while the page is full and limited', async () => {
    const read = vi.fn(async (_m: string, p: unknown[]) => {
      const offset = p[1] as number;
      if (offset === 0) return { tokens: page(0, 100), limited: true, next_offset: 100 };
      if (offset === 100) return { tokens: page(1, 100), limited: true, next_offset: 200 };
      return { tokens: page(2, 7), limited: false, next_offset: 207 };
    });
    expect(await readAllTokensByAddress(read, W)).toHaveLength(207);
    expect(read.mock.calls.map((c) => c[1])).toEqual([
      [W, 0, 100],
      [W, 100, 100],
      [W, 200, 100],
    ]);
  });

  it('ends on a short page even when the node still says limited (devnet does)', async () => {
    const read = vi.fn(async () => ({ tokens: [row(XPECTRA)], limited: true, next_offset: 1 }));
    expect(await readAllTokensByAddress(read, W)).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads at most ten pages', async () => {
    let next = 0;
    const endless = vi.fn(async () => {
      next += 100;
      return { tokens: page(next, 100), limited: true, next_offset: next };
    });
    await readAllTokensByAddress(endless, W);
    expect(endless).toHaveBeenCalledTimes(TOKENS_MAX_PAGES);
  });

  it('fails the whole read when a later page fails', async () => {
    const read = vi.fn(async (_m: string, p: unknown[]) => {
      if (p[1] === 0) return { tokens: page(0, 100), limited: true, next_offset: 100 };
      throw new Error('HTTP 503');
    });
    await expect(readAllTokensByAddress(read, W)).rejects.toThrow('HTTP 503');
  });
});

describe('withBusyRetry', () => {
  it('asks again while the view is busy, and never retries a revert', async () => {
    const read = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue('ok');
    await expect(withBusyRetry(read)).resolves.toBe('ok');
    expect(read).toHaveBeenCalledTimes(2);

    const stillBusy = vi.fn().mockRejectedValue(busy());
    await expect(withBusyRetry(stillBusy)).rejects.toThrow('Program view busy');
    expect(stillBusy).toHaveBeenCalledTimes(4);

    const reverted = vi.fn().mockRejectedValue(revert());
    await expect(withBusyRetry(reverted)).rejects.toThrow('execution reverted');
    expect(reverted).toHaveBeenCalledTimes(1);
  });
});

describe('owner scan', () => {
  function contract(opts: { pages?: boolean; busyStarts?: number[]; owned: number[] }) {
    rpc.mockImplementation(async (method: string, params: unknown[]) => {
      if (method === 'octra_contractAbi') {
        const methods = ['owner_of', 'balance_of', 'get_next_id'];
        if (opts.pages) methods.push('owners_page');
        return { methods: methods.map((name) => ({ name })) };
      }
      const [, view, args] = params as [string, string, number[]];
      if (view === 'get_next_id') return { result: '75' };
      if (view === 'owners_page') {
        const [start, count] = args;
        if (opts.busyStarts?.includes(start)) throw busy();
        const owners = Array.from({ length: count }, (_, i) =>
          opts.owned.includes(start + i) ? W : '-'
        );
        return { result: owners.join(',') };
      }
      if (view === 'owner_of') {
        return { result: opts.owned.includes(args[0]) ? W : 'octSomeoneElse' };
      }
      throw revert();
    });
  }

  it('pages owners_page up to get_next_id, the last page cut to fit', async () => {
    contract({ pages: true, owned: [3, 74] });
    expect(await fetchOwnedTokenIds('octPaged', W, '4', 2)).toEqual({
      ids: ['3', '74'],
      complete: true,
    });
    const pages = rpc.mock.calls
      .filter(([, p]) => (p as unknown[])[1] === 'owners_page')
      .map(([, p]) => (p as unknown[])[2]);
    expect(pages).toEqual([
      [0, 50],
      [50, 25],
    ]);
  });

  it('comes back incomplete with what it found when a page stays busy', async () => {
    contract({ pages: true, owned: [3, 74], busyStarts: [50] });
    expect(await fetchOwnedTokenIds('octPagedBusy', W, '4', 2)).toEqual({
      ids: ['3'],
      complete: false,
    });
    expect(keepKnownIds(['3', '74'], ['3'])).toEqual(['3', '74']);
  });
});

describe('known collections', () => {
  const list = {
    name: '0xio NFT collections',
    version: { major: 1, minor: 0, patch: 0 },
    collections: [
      { network: 'mainnet', address: XPECTRA, name: 'Xpectra', symbol: 'XPC' },
      { network: 'mainnet', address: TUNGSTEN, name: 'tungstenoct', symbol: 'TUNG' },
      { network: 'mainnet', address: REVERTS, name: 'Reverts', symbol: 'RVT' },
      { network: 'devnet', address: COLONIES, name: 'Colonies', symbol: 'COLONIES' },
    ],
  };
  const registry = {
    network: 'mainnet',
    updated_at: '2026-10-11T00:00:00Z',
    contracts: [{ address: BUSY, name: 'Busy', symbol: 'BSY', has_next_id: true }],
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === NFT_LIST_URL) return new Response(JSON.stringify(list));
        if (url === NFT_REGISTRY_URL) return new Response(JSON.stringify(registry));
        return new Response('', { status: 404 });
      })
    );
    rpc.mockImplementation(async (method: string, params: unknown[]) => {
      if (method !== 'contract_call') throw new Error(`unexpected ${method}`);
      const [contract, view] = params as [string, string];
      if (view !== 'balance_of') throw revert();
      if (contract === TUNGSTEN) return { result: '2' };
      if (contract === XPECTRA) return { result: '0' };
      if (contract === BUSY) throw busy();
      if (contract === REVERTS) throw revert();
      throw new Error(`unexpected contract ${contract}`);
    });
  });

  const probed = () =>
    rpc.mock.calls
      .filter(([, p]) => (p as unknown[])[1] === 'balance_of')
      .map(([, p]) => (p as unknown[])[0]);

  const brief = (cs: Awaited<ReturnType<typeof fetchGalleryCollections>>) =>
    cs.map((c) => ({
      contractAddress: c.contractAddress,
      name: c.name,
      ownedCount: c.ownedCount,
      imported: c.imported,
    }));

  it('lists what the wallet holds without an import, plus the known ones the read left out', async () => {
    holdings.mockResolvedValue([
      { contractAddress: XPECTRA, name: 'Xpectra', symbol: 'XPC', decimals: 0, balance: '1' },
    ]);
    expect(brief(await fetchGalleryCollections('mainnet', W))).toEqual([
      { contractAddress: XPECTRA, name: 'Xpectra', ownedCount: 1, imported: false },
      { contractAddress: TUNGSTEN, name: 'tungstenoct', ownedCount: 2, imported: false },
    ]);
    expect(new Set(probed())).toEqual(new Set([TUNGSTEN, REVERTS, BUSY]));
  });

  it('keeps imported contracts, held or not', async () => {
    holdings.mockResolvedValue([]);
    const IMPORTED = 'oct' + 'B'.repeat(44);
    vi.mocked(chrome.storage.local.get).mockImplementation((async (key: unknown) =>
      key === `imported_nfts_mainnet_${W}` ? { [key as string]: [IMPORTED] } : {}) as never);
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method: string, params: unknown[]) => {
      if (method === 'octra_contractAbi') throw new Error('HTTP 503');
      const [contract, view] = params as [string, string];
      if (contract === IMPORTED) {
        if (view === 'balance_of') return { result: '0' };
        throw revert();
      }
      return base(method, params);
    });
    const cs = brief(await fetchGalleryCollections('mainnet', W));
    expect(cs.find((c) => c.contractAddress === IMPORTED)).toMatchObject({
      ownedCount: 0,
      imported: true,
    });
    expect(cs.map((c) => c.contractAddress)).toContain(TUNGSTEN);
  });

  it('leaves out a 0-decimals holding whose ABI has no NFT view', async () => {
    holdings.mockResolvedValue([
      { contractAddress: XPECTRA, name: 'Points', symbol: 'PTS', decimals: 0, balance: '40' },
    ]);
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method: string, params: unknown[]) => {
      if (method === 'octra_contractAbi') {
        return { methods: [{ name: 'transfer' }, { name: 'balance_of' }] };
      }
      return base(method, params);
    });
    const cs = await fetchGalleryCollections('mainnet', W);
    expect(cs.map((c) => c.contractAddress)).not.toContain(XPECTRA);
  });

  it('asks again only what went unanswered', async () => {
    holdings.mockResolvedValue([]);
    await fetchGalleryCollections('mainnet', W);
    rpc.mockClear();
    await fetchGalleryCollections('mainnet', W);
    expect(probed()).toEqual(Array(4).fill(BUSY));
  });

  it('keeps the last known collections and probes nothing when the holdings read failed', async () => {
    holdings.mockRejectedValue(new Error('HTTP 503'));
    const prev = new Map([
      [
        TUNGSTEN,
        {
          contractAddress: TUNGSTEN,
          name: 'tungstenoct',
          symbol: 'TUNG',
          totalSupply: null,
          ownedCount: 2,
          ownedTokenIds: [],
          imported: false,
        },
      ],
    ]);
    expect(brief(await fetchGalleryCollections('mainnet', W, prev))).toEqual([
      { contractAddress: TUNGSTEN, name: 'tungstenoct', ownedCount: 2, imported: false },
    ]);
    expect(probed()).toEqual([]);
  });

  it('keeps the registry to mainnet and probes the devnet list on devnet', async () => {
    network.id = 'devnet';
    holdings.mockResolvedValue([]);
    rpc.mockImplementation(async (_m: string, params: unknown[]) => {
      const [contract] = params as [string];
      if (contract === COLONIES) return { result: '2' };
      throw new Error(`unexpected contract ${contract}`);
    });
    expect(brief(await fetchGalleryCollections('devnet', W))).toEqual([
      { contractAddress: COLONIES, name: 'Colonies', ownedCount: 2, imported: false },
    ]);
    const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    expect(urls).not.toContain(NFT_REGISTRY_URL);
  });

  it('caps the probes per refresh at sixty, four at a time', async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      address: `oct${String(i).padStart(44, 'A')}`,
      name: `C${i}`,
      symbol: 'C',
    }));
    let running = 0;
    let peak = 0;
    const read = vi.fn(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running -= 1;
      return 0;
    });
    await probeCollections('mainnet', W, many, new Set(), read);
    expect(read).toHaveBeenCalledTimes(60);
    expect(peak).toBeLessThanOrEqual(4);
    read.mockClear();
    await probeCollections('mainnet', W, many, new Set(), read);
    expect(read).toHaveBeenCalledTimes(10);
  });
});
