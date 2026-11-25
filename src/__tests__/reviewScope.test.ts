import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ZeroXIOConfig } from 'src/utils/config';
import { TxScopeError, captureTxScope } from 'src/services/network/txScope';
import { networkService, NetworkService } from 'src/services/network/NetworkService';
import { ContractTasksService } from 'src/services/contracts/ContractTasksService';
import { TransactionQueue } from 'src/background/services/txQueue';
import { enrichTokenTransfers, type TransferDeps } from 'src/services/tokens/tokenTransfers';
import { listNft, cancelListing } from 'src/features/wallet/nft/xpectrum/tx';
import { waitForReceipt } from 'src/features/wallet/nft/xpectrum/confirm';
import { useReviewScope } from 'src/hooks/transactions/useReviewScope';
import type { TransactionHistoryItem } from 'src/types/transaction';

const NET = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;
const ACTIVE = ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET;
const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MARKET = 'octMarket000000000000000000000000000000000000';
const NFT = 'octNft000000000000000000000000000000000000000';
const MAINNET_RPC = ZeroXIOConfig.NETWORKS.mainnet.rpc_url;

const local = new Map<string, unknown>();
const fetchMock = vi.fn();

beforeEach(() => {
  local.clear();
  local.set(NET, 'mainnet');
  local.set(ACTIVE, A);
  (chrome.storage as any).local = {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return Object.fromEntries(local);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => local.has(k)).map((k) => [k, local.get(k)]));
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) local.delete(k);
    },
  };
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const watchSubmit = (ns: NetworkService) => ({
  nonce: vi.spyOn(ns, 'getNextNonce').mockResolvedValue(5),
  build: vi.spyOn(ns, 'buildContractCallTransaction').mockResolvedValue({ from: A } as any),
  rpc: vi.spyOn(ns, 'jsonRpcCall').mockResolvedValue({ tx_hash: 'h1' }),
});

describe('Xpectrum market txs are bound to the reviewed scope', () => {
  it('submits on the network and RPC the review showed', async () => {
    const spies = watchSubmit(networkService);
    vi.spyOn(networkService, 'storePendingTransaction').mockResolvedValue(null);
    const scope = await captureTxScope(A, 'mainnet');
    await expect(
      listNft({ from: A, privateKey: 'k', scope, ou: '1000' }, MARKET, NFT, 1, 100)
    ).resolves.toBe('h1');
    expect(spies.nonce).toHaveBeenCalledWith(A, scope);
    expect(spies.rpc).toHaveBeenCalledWith('octra_submit', expect.any(Array), undefined, scope);
  });

  it('refuses after the network changed since the review, before a nonce or a signature', async () => {
    const spies = watchSubmit(networkService);
    const scope = await captureTxScope(A, 'mainnet');
    local.set(NET, 'devnet');
    await expect(
      listNft({ from: A, privateKey: 'k', scope, ou: '1000' }, MARKET, NFT, 1, 100)
    ).rejects.toBeInstanceOf(TxScopeError);
    expect(spies.nonce).not.toHaveBeenCalled();
    expect(spies.build).not.toHaveBeenCalled();
    expect(spies.rpc).not.toHaveBeenCalled();
  });

  it('refuses after the active wallet changed since the review', async () => {
    const spies = watchSubmit(networkService);
    const scope = await captureTxScope(A, 'mainnet');
    local.set(ACTIVE, B);
    await expect(
      cancelListing({ from: A, privateKey: 'k', scope, ou: '1000' }, MARKET, 3)
    ).rejects.toThrow(/active wallet changed/);
    expect(spies.rpc).not.toHaveBeenCalled();
  });

  it('the review hook keeps the scope from when the review opened, for one send', async () => {
    const spies = watchSubmit(networkService);
    const { result } = renderHook(() => useReviewScope());
    result.current.bind(A, 'mainnet');
    local.set(NET, 'devnet');
    const scope = await result.current.take();
    expect(scope).toEqual({ networkId: 'mainnet', rpcUrl: MAINNET_RPC, address: A });
    await expect(
      listNft({ from: A, privateKey: 'k', scope, ou: '1000' }, MARKET, NFT, 1, 100)
    ).rejects.toBeInstanceOf(TxScopeError);
    expect(spies.nonce).not.toHaveBeenCalled();
    await expect(result.current.take()).rejects.toBeInstanceOf(TxScopeError);
  });
});

describe('ContractTasks calls are bound to the reviewed scope', () => {
  it('refuses after the network changed since the confirmation opened', async () => {
    const ns = new NetworkService();
    const spies = watchSubmit(ns);
    const tasks = new ContractTasksService(ns);
    const scope = await captureTxScope(A, 'mainnet');
    local.set(NET, 'devnet');
    const res = await tasks.executeCallMethod('claimToken', [], A, 'k', scope);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/network changed/);
    expect(spies.nonce).not.toHaveBeenCalled();
    expect(spies.build).not.toHaveBeenCalled();
    expect(spies.rpc).not.toHaveBeenCalled();
  });

  it('refuses after the active wallet changed since the confirmation opened', async () => {
    const ns = new NetworkService();
    const spies = watchSubmit(ns);
    const tasks = new ContractTasksService(ns);
    const scope = await captureTxScope(A, 'mainnet');
    local.set(ACTIVE, B);
    const res = await tasks.executeCallMethod('claimToken', [], A, 'k', scope);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/active wallet changed/);
    expect(spies.rpc).not.toHaveBeenCalled();
  });

  it('targets the contract of the reviewed network and submits under its scope', async () => {
    const ns = new NetworkService();
    const spies = watchSubmit(ns);
    vi.spyOn(ns, 'storePendingTransaction').mockResolvedValue(null);
    vi.spyOn(ns, 'getRecommendedFeeStrict').mockResolvedValue({
      minimum: '900',
      recommended: '1200',
      fast: '2000',
    });
    const tasks = new ContractTasksService(ns);
    const scope = await captureTxScope(A, 'mainnet');
    const res = await tasks.executeCallMethod('claimToken', [], A, 'k', scope);
    expect(res).toMatchObject({ success: true, txHash: 'h1' });
    expect(spies.build.mock.calls[0][0].contract).toBe(ZeroXIOConfig.CONTRACTS.DEMO_CONTRACT);
    expect(spies.build.mock.calls[0][0].ou).toBe('1200');
    expect(spies.rpc).toHaveBeenCalledWith('octra_submit', expect.any(Array), undefined, scope);
  });
});

describe('NFT receipt polling', () => {
  it('reads the receipt from the reviewed RPC', async () => {
    const rpc = vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({ status: 'confirmed' });
    const scope = await captureTxScope(A, 'mainnet');
    await expect(waitForReceipt('h1', scope, { intervalMs: 1 })).resolves.toEqual({
      status: 'confirmed',
      reason: null,
    });
    expect(rpc).toHaveBeenCalledWith('octra_transaction', ['h1'], true, scope);
  });

  it('ignores a result that lands after a network switch', async () => {
    const scope = await captureTxScope(A, 'mainnet');
    const rpc = vi.spyOn(networkService, 'jsonRpcCall').mockImplementation(async () => {
      local.set(NET, 'devnet');
      return { status: 'confirmed' };
    });
    const rec = await waitForReceipt('h1', scope, { intervalMs: 1, timeoutMs: 1000 });
    expect(rec.status).toBe('switched');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the wallet changed, without another read', async () => {
    const scope = await captureTxScope(A, 'mainnet');
    let calls = 0;
    const rpc = vi.spyOn(networkService, 'jsonRpcCall').mockImplementation(async () => {
      if (++calls > 1) return { status: 'confirmed' };
      setTimeout(() => local.set(ACTIVE, B), 0);
      return { status: 'pending' };
    });
    const rec = await waitForReceipt('h1', scope, { intervalMs: 50, timeoutMs: 1000 });
    expect(rec.status).toBe('switched');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('token enrichment', () => {
  const row: TransactionHistoryItem = {
    hash: 'nftIn',
    timestamp: 1,
    type: 'outgoing',
    amount: 0,
    from: B,
    to: NFT,
    address: NFT,
    nonce: 1,
    confirmed: true,
    status: 'success',
    network: 'mainnet',
  };
  const deps = (stillOn: boolean, store: Record<string, unknown>): TransferDeps => ({
    networkId: 'mainnet',
    rpc: async () => ({
      method: 'transfer',
      events: [{ event: 'Transferred', values: [B, A, '5'] }],
    }),
    abiMethods: async () => ['transfer', 'owner_of'],
    held: async () => [],
    nftInfo: async () => ({ name: 'Geodesics', symbol: 'GDSC' }),
    tokenInfo: async () => ({}),
    store: {
      get: async (k) => store[k],
      set: async (k, v) => {
        store[k] = v;
      },
    },
    stillOn: async () => stillOn,
  });

  it('drops what it read once the wallet left the network, and keeps nothing', async () => {
    const store: Record<string, unknown> = {};
    const out = await enrichTokenTransfers([row], A, deps(false, store));
    expect(out).toEqual([row]);
    expect(store).toEqual({});
  });

  it('keeps it while the wallet stays on the network', async () => {
    const store: Record<string, unknown> = {};
    const out = await enrichTokenTransfers([row], A, deps(true, store));
    expect(out[0].token_transfer).toMatchObject({ kind: 'nft', raw_amount: '5' });
    expect(Object.keys(store)).toHaveLength(2);
  });

  it('pins the contract, storage and token-list reads to the history network', async () => {
    const ns = new NetworkService();
    const rpc = vi.spyOn(ns, 'jsonRpcCall').mockResolvedValue({ result: 'X', tokens: [] });
    const pin = { networkId: 'mainnet', rpcUrl: MAINNET_RPC };
    const d: TransferDeps = (ns as any).transferDeps(pin, A);
    local.set(NET, 'devnet');
    await d.nftInfo(NFT);
    await d.tokenInfo(NFT);
    await d.held();
    expect(rpc.mock.calls.length).toBeGreaterThan(0);
    for (const call of rpc.mock.calls) expect(call[3]).toEqual(pin);
    expect(await d.stillOn!()).toBe(false);
  });
});

describe('background queue takes signed txs only', () => {
  it('refuses an entry that carries a private key', async () => {
    const q = new TransactionQueue();
    await expect(
      q.add({ opType: 'transfer', from: A, privateKey: 'secret' } as any)
    ).rejects.toThrow(/Only signed transactions/);
    expect(q.queue).toHaveLength(0);
    expect(local.has('tx_queue_state')).toBe(false);
  });

  it('never posts an unsigned entry to a node', async () => {
    const q = new TransactionQueue();
    const res = await q.sendTransaction({
      id: 't1',
      opType: 'transfer',
      from: A,
      scope: await captureTxScope(A),
      status: 'pending',
      addedAt: 0,
      attempts: 1,
      maxAttempts: 3,
    });
    expect(res.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
