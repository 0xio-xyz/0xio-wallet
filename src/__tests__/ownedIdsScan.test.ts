import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const C = 'octEYrJrypHj2xndM39PokSMM5gGoxEEncKB8k9qGFyhrym';
const NAMES = 'octNamesContract';
const ME = 'oct2qyupyPfAof4kJ8LcTdN7fyQkLxiKhfemLCz94NNoxio';
const NET = 'devnet';

const m = vi.hoisted(() => ({ view: vi.fn(), gallery: vi.fn(), names: vi.fn() }));

vi.mock('src/services/network/NetworkService', () => ({
  networkService: {
    getCurrentNetworkId: async () => 'devnet',
    jsonRpcCall: async (method: string, params: unknown[]) => {
      if (method === 'octra_contractAbi') return { methods: [] as unknown[] };
      const [, name, args] = params as [string, string, unknown];
      return { result: await m.view(name, Array.isArray(args) ? args : []) };
    },
    contractCallView: (_c: string, name: string, args: unknown[]) => m.view(name, args ?? []),
  },
}));
vi.mock('src/services/names/ons', () => ({
  onsContractFor: async () => 'octNamesContract',
}));
vi.mock('src/features/wallet/nft/onsNames', () => ({
  onsKnownCollections: async (): Promise<unknown[]> => [],
  onsOwnedIds: () => m.names(),
}));
vi.mock('src/contexts/WalletContext', () => ({
  useWallet: () => ({ activeWallet: { address: ME }, networkId: 'devnet' }),
}));
vi.mock('src/features/wallet/nft/nftData', async (original) => ({
  ...(await original<typeof import('src/features/wallet/nft/nftData')>()),
  fetchGalleryCollections: () => m.gallery(),
  loadNftSnapshot: async (): Promise<null> => null,
  getImportedNftAddresses: async (): Promise<string[]> => [],
  scheduleSnapshotSave: () => {},
}));

import { busyRetry } from 'src/features/wallet/nft/euint/chainState';
import { fetchOwnedTokenIds, ownedIdsCache, stillOwned } from 'src/features/wallet/nft/nftData';
import { useNftGallery } from 'src/features/wallet/nft/useNftGallery';
import { clearAbiCache } from 'src/features/wallet/nft/abi';

const reverted = () => new Error('execution reverted');
const missing = () => new Error('method not found');
const unanswered = () => new Error('committed state changed during read; retry');
const asked = (name: string) => m.view.mock.calls.filter(([n]) => n === name).length;
const askedIds = () => m.view.mock.calls.filter(([n]) => n === 'owner_of').map(([, a]) => a[0]);

function chain(views: Record<string, (args: unknown[]) => unknown>) {
  m.view.mockImplementation(async (name: string, args: unknown[]) => {
    if (!views[name]) throw missing();
    return views[name](args);
  });
}

beforeEach(() => {
  m.view.mockReset();
  m.gallery.mockReset();
  m.names.mockReset();
  ownedIdsCache.clear();
  clearAbiCache();
  busyRetry.delaysMs = [0, 0, 0];
  vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
});

describe('which token ids a wallet holds in a collection', () => {
  it('does not start the one by one scan when the node failed to answer the storage read', async () => {
    chain({
      total_supply: () => {
        throw unanswered();
      },
      owner_of: () => ME,
    });
    expect(await fetchOwnedTokenIds(C, ME, null, 2)).toEqual({ ids: [], complete: false });
    expect(asked('owner_of')).toBe(0);
  });

  it('scans one by one when the collection has no storage view at all', async () => {
    chain({
      owner_of: ([id]) => {
        if (id === 3) return ME;
        throw reverted();
      },
    });
    expect(await fetchOwnedTokenIds(C, ME, null, 1)).toEqual({ ids: ['3'], complete: true });
    expect(asked('owner_of')).toBe(4);
  });

  it('scans one by one when the storage read reverts', async () => {
    chain({
      total_supply: () => {
        throw reverted();
      },
      owner_of: ([id]) => (id === 1 ? ME : 'octSomeoneElse'),
    });
    expect(await fetchOwnedTokenIds(C, ME, null, 1)).toEqual({ ids: ['1'], complete: true });
  });
});

describe('asking for the ids known before', () => {
  it('answers yes with one read per id when every one is still held', async () => {
    chain({ owner_of: () => ME });
    expect(await stillOwned(NET, C, ME, ['30', '40'])).toBe(true);
    expect(m.view.mock.calls).toEqual([
      ['owner_of', [30]],
      ['owner_of', [40]],
    ]);
  });

  it('answers no when an id went to someone else or no longer exists', async () => {
    chain({ owner_of: ([id]) => (id === 30 ? ME : 'octSomeoneElse') });
    expect(await stillOwned(NET, C, ME, ['30', '40'])).toBe(false);
    chain({
      owner_of: () => {
        throw reverted();
      },
    });
    expect(await stillOwned(NET, C, ME, ['30'])).toBe(false);
  });

  it('answers no without asking for nothing known or a long list', async () => {
    chain({ owner_of: () => ME });
    expect(await stillOwned(NET, C, ME, [])).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => String(i));
    expect(await stillOwned(NET, C, ME, eleven)).toBe(false);
    expect(asked('owner_of')).toBe(0);
  });

  it('never asks the name contract this way', async () => {
    chain({ owner_of: () => ME });
    expect(await stillOwned(NET, NAMES, ME, ['7'])).toBe(false);
    expect(asked('owner_of')).toBe(0);
  });

  it('answers null when the node does not answer', async () => {
    chain({
      owner_of: () => {
        throw unanswered();
      },
    });
    expect(await stillOwned(NET, C, ME, ['30', '40'])).toBeNull();
    expect(asked('owner_of')).toBe(1);
  });
});

describe('the gallery with ids known at the same owned count', () => {
  const key = `${NET}:${C}:${ME}`;
  const collection = (contractAddress: string, ownedCount: number) => ({
    contractAddress,
    name: 'Colonies',
    symbol: 'COL',
    totalSupply: '4',
    ownedCount,
    ownedTokenIds: [] as string[],
    countKnown: true,
  });
  const known = (ids: string[], count = ids.length) =>
    ownedIdsCache.set(key, { ids, ts: 1, count });
  const settled = async (view: { current: ReturnType<typeof useNftGallery> }, ids: string[]) => {
    await waitFor(() => expect(view.current.failed[C]).toBe(false));
    expect(view.current.ids[C]).toEqual(ids);
  };

  beforeEach(() => {
    m.gallery.mockResolvedValue([collection(C, 2)]);
  });

  it('keeps them for one read per id and no scan when all are still held', async () => {
    known(['30', '40']);
    chain({ owner_of: () => ME });
    const { result } = renderHook(() => useNftGallery());
    await settled(result, ['30', '40']);
    expect(askedIds()).toEqual([30, 40]);
    expect(asked('total_supply')).toBe(0);
    expect(Date.now() - ownedIdsCache.get(key)!.ts).toBeLessThan(60_000);
  });

  it('scans the collection again when a known id is gone', async () => {
    known(['30', '40']);
    chain({
      owner_of: ([id]) => {
        if (id === 30 || id === 41) return ME;
        if (id === 40) return 'octSomeoneElse';
        throw reverted();
      },
    });
    const { result } = renderHook(() => useNftGallery());
    await settled(result, ['30', '41']);
    expect(askedIds().slice(0, 3)).toEqual([30, 40, 0]);
    expect(asked('total_supply')).toBe(1);
  });

  it('keeps what was known, marked stale, when the node does not answer', async () => {
    known(['30', '40']);
    chain({
      owner_of: () => {
        throw unanswered();
      },
    });
    const { result } = renderHook(() => useNftGallery());
    await settled(result, ['30', '40']);
    expect(askedIds()).toEqual([30]);
    expect(asked('total_supply')).toBe(0);
    expect(ownedIdsCache.get(key)).toEqual({ ids: ['30', '40'], ts: 0, count: 2 });
    expect(result.current.failed[C]).toBe(false);
  });

  it('goes straight to the scan with no ids known, too few or a changed count', async () => {
    chain({ owner_of: ([id]) => (id === 0 || id === 1 ? ME : 'octSomeoneElse') });
    const first = renderHook(() => useNftGallery());
    await settled(first.result, ['0', '1']);
    expect(askedIds()).toEqual([0, 1]);
    first.unmount();

    m.view.mockClear();
    known(['1']);
    const second = renderHook(() => useNftGallery());
    await settled(second.result, ['0', '1']);
    expect(askedIds()).toEqual([0, 1]);
    second.unmount();

    m.view.mockClear();
    known(['0', '1', '2'], 3);
    const third = renderHook(() => useNftGallery());
    await settled(third.result, ['0', '1']);
    expect(askedIds()).toEqual([0, 1]);
  });

  it('goes straight to the scan with more than 10 ids known', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => String(i));
    m.gallery.mockResolvedValue([collection(C, 12)]);
    known(twelve);
    chain({ owner_of: () => ME });
    const { result } = renderHook(() => useNftGallery());
    await settled(result, twelve);
    expect(asked('total_supply')).toBe(1);
    expect(askedIds()).toEqual(twelve.map(Number));
  });

  it('reads the name contract through its own path', async () => {
    m.gallery.mockResolvedValue([collection(NAMES, 1)]);
    ownedIdsCache.set(`${NET}:${NAMES}:${ME}`, { ids: ['7'], ts: 1, count: 1 });
    m.names.mockResolvedValue({ ids: ['7'], complete: true });
    chain({ owner_of: () => ME });
    const { result } = renderHook(() => useNftGallery());
    await waitFor(() => expect(m.names).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.ids[NAMES]).toEqual(['7']));
    expect(m.view).not.toHaveBeenCalled();
  });
});
