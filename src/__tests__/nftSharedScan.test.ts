import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const C = 'octEYrJrypHj2xndM39PokSMM5gGoxEEncKB8k9qGFyhrym';
const ME = 'oct2qyupyPfAof4kJ8LcTdN7fyQkLxiKhfemLCz94NNoxio';
const OTHER = 'octSomeoneElse';
const NET = 'devnet';

const m = vi.hoisted(() => ({ view: vi.fn(), gallery: vi.fn() }));

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
  onsOwnedIds: async () => ({ ids: [] as string[], complete: true }),
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
import { ownedIdsCache } from 'src/features/wallet/nft/nftData';
import { joinOwnedScan } from 'src/features/wallet/nft/ownedScan';
import { useNftGallery } from 'src/features/wallet/nft/useNftGallery';
import { clearAbiCache } from 'src/features/wallet/nft/abi';

const collection = (ownedCount: number) => ({
  contractAddress: C,
  name: 'Colonies',
  symbol: 'COL',
  totalSupply: '4',
  ownedCount,
  ownedTokenIds: [] as string[],
  countKnown: true,
});
const askedIds = () => m.view.mock.calls.filter(([n]) => n === 'owner_of').map(([, a]) => a[0]);
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

let open: () => void;

function slowChain(owners: Record<number, string> = { 0: ME, 1: ME }) {
  const gate = new Promise<void>((resolve) => (open = resolve));
  m.view.mockImplementation(async (name: string, args: unknown[]) => {
    if (name !== 'owner_of') throw new Error('method not found');
    await gate;
    return owners[args[0] as number] ?? OTHER;
  });
}

beforeEach(() => {
  m.view.mockReset();
  m.gallery.mockReset();
  ownedIdsCache.clear();
  clearAbiCache();
  busyRetry.delaysMs = [0, 0, 0];
  vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
});

describe('two users of the gallery on one page', () => {
  beforeEach(() => {
    m.gallery.mockResolvedValue([collection(2)]);
  });

  const mountBoth = async () => {
    slowChain();
    const a = renderHook(() => useNftGallery());
    await waitFor(() => expect(askedIds()).toEqual([0]));
    const b = renderHook(() => useNftGallery());
    await waitFor(() => expect(b.result.current.collections).toHaveLength(1));
    await tick();
    return { a, b };
  };

  it('the second joins the scan already running', async () => {
    const { a, b } = await mountBoth();
    expect(askedIds()).toEqual([0]);
    open();
    await waitFor(() => expect(a.result.current.ids[C]).toEqual(['0', '1']));
    await waitFor(() => expect(b.result.current.ids[C]).toEqual(['0', '1']));
    expect(askedIds()).toEqual([0, 1]);
    expect(a.result.current.failed[C]).toBe(false);
    expect(b.result.current.failed[C]).toBe(false);
    expect(ownedIdsCache.get(`${NET}:${C}:${ME}`)?.ids).toEqual(['0', '1']);
    a.unmount();
    b.unmount();
  });

  it('the scan goes on when one of them leaves', async () => {
    const { a, b } = await mountBoth();
    a.unmount();
    open();
    await waitFor(() => expect(b.result.current.ids[C]).toEqual(['0', '1']));
    expect(askedIds()).toEqual([0, 1]);
    b.unmount();
  });

  it('the scan stops at the next id when both have left', async () => {
    const { a, b } = await mountBoth();
    a.unmount();
    b.unmount();
    open();
    await tick();
    expect(askedIds()).toEqual([0]);
    expect(ownedIdsCache.has(`${NET}:${C}:${ME}`)).toBe(false);
  });

  it('a user that arrives after the scan stopped starts a new one', async () => {
    const { a, b } = await mountBoth();
    a.unmount();
    b.unmount();
    open();
    await tick();
    m.view.mockClear();
    const c = renderHook(() => useNftGallery());
    await waitFor(() => expect(c.result.current.ids[C]).toEqual(['0', '1']));
    expect(askedIds()).toEqual([0, 1]);
    c.unmount();
  });
});

describe('what a scan is shared by', () => {
  const scanOf = (networkId: string, wallet: string, ownedCount = 1) =>
    joinOwnedScan(networkId, wallet, collection(ownedCount));

  it('is one scan for the same network, contract, wallet and owned count', async () => {
    slowChain({ 0: ME });
    const first = scanOf(NET, ME);
    const second = scanOf(NET, ME);
    await tick();
    open();
    expect(await first.result).toEqual({ ids: ['0'], failed: false });
    expect(await second.result).toEqual({ ids: ['0'], failed: false });
    expect(askedIds()).toEqual([0]);
  });

  it('is not shared across wallets, networks or owned counts', async () => {
    slowChain({ 0: ME, 1: OTHER });
    const scans = [scanOf(NET, ME), scanOf(NET, OTHER), scanOf('mainnet', ME), scanOf(NET, ME, 2)];
    await tick();
    expect(askedIds()).toEqual([0, 0, 0, 0]);
    for (const s of scans) s.leave();
    open();
    expect(await Promise.all(scans.map((s) => s.result))).toEqual([null, null, null, null]);
  });
});

describe('the gallery poll and page visibility', () => {
  let hidden = false;
  const show = (visible: boolean) =>
    act(async () => {
      hidden = !visible;
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
  const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    vi.useFakeTimers();
    m.gallery.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    hidden = false;
  });

  it('polls every 60 seconds while visible and not at all while hidden', async () => {
    const { unmount } = renderHook(() => useNftGallery());
    await pass(0);
    expect(m.gallery).toHaveBeenCalledTimes(1);
    await pass(60_000);
    expect(m.gallery).toHaveBeenCalledTimes(2);
    await show(false);
    await pass(300_000);
    expect(m.gallery).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('refreshes once when the page comes back after more than the interval', async () => {
    const { unmount } = renderHook(() => useNftGallery());
    await pass(0);
    await show(false);
    await pass(90_000);
    await show(true);
    expect(m.gallery).toHaveBeenCalledTimes(2);
    await show(true);
    expect(m.gallery).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not refresh when the page comes back sooner', async () => {
    const { unmount } = renderHook(() => useNftGallery());
    await pass(0);
    await pass(5_000);
    await show(false);
    await pass(20_000);
    await show(true);
    expect(m.gallery).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('starts no scan while hidden and starts it when the page shows again', async () => {
    m.gallery.mockResolvedValue([collection(1)]);
    m.view.mockImplementation(async (name: string) => {
      if (name !== 'owner_of') throw new Error('method not found');
      return ME;
    });
    hidden = true;
    const { result, unmount } = renderHook(() => useNftGallery());
    await pass(1_000);
    expect(result.current.collections).toHaveLength(1);
    expect(m.view).not.toHaveBeenCalled();
    await show(true);
    await pass(0);
    expect(result.current.ids[C]).toEqual(['0']);
    unmount();
  });
});
