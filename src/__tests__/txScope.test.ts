import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';
import {
  SCOPE_CHANGED,
  TxScopeError,
  assertTxScope,
  captureTxScope,
  type TxScope,
} from 'src/services/network/txScope';
import { TransactionQueue } from 'src/background/services/txQueue';
import { NetworkService, pendingTxInScope } from 'src/services/network/NetworkService';
import { PvacManager } from 'src/services/pvac/PvacManager';
import {
  clearPendingKeySwitch,
  getPendingKeySwitch,
  recordPendingKeySwitch,
} from 'src/services/pvac/keySwitchService';

const NET = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;
const ACTIVE = ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET;
const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MAINNET_RPC = ZeroXIOConfig.NETWORKS.mainnet.rpc_url;
const DEVNET_RPC = ZeroXIOConfig.NETWORKS.devnet.rpc_url;

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
  fetchMock.mockResolvedValue({
    status: 200,
    text: async () => JSON.stringify({ result: { tx_hash: 'abc' } }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

const signed = (from = A) => ({ from, to_: B, amount: '1', nonce: 7, signature: 'sig' });

describe('tx scope', () => {
  it('pins the network id and the RPC of that id', async () => {
    expect(await captureTxScope(A)).toEqual({
      networkId: 'mainnet',
      rpcUrl: MAINNET_RPC,
      address: A,
    });
    expect((await captureTxScope(A, 'devnet')).rpcUrl).toBe(DEVNET_RPC);
  });

  it('refuses once the network or the wallet moved', async () => {
    const scope = await captureTxScope(A);
    await expect(assertTxScope(scope)).resolves.toBeUndefined();
    local.set(NET, 'devnet');
    await expect(assertTxScope(scope)).rejects.toBeInstanceOf(TxScopeError);
    local.set(NET, 'mainnet');
    local.set(ACTIVE, B);
    await expect(assertTxScope(scope)).rejects.toThrow(/active wallet changed/);
  });
});

describe('background queue', () => {
  const queued = (scope: TxScope | undefined) =>
    ({
      id: 't1',
      type: 'broadcast_only',
      opType: 'transfer',
      signedTransaction: signed(),
      from: A,
      scope,
      status: 'pending',
      addedAt: 0,
      attempts: 1,
      maxAttempts: 3,
    }) as any;

  it('submits to the RPC the tx was signed for', async () => {
    const q = new TransactionQueue();
    const res = await q.sendTransaction(queued(await captureTxScope(A)));
    expect(res.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`${MAINNET_RPC}/rpc`);
  });

  it('refuses a queued tx after a network switch and never contacts a node', async () => {
    const q = new TransactionQueue();
    const scope = await captureTxScope(A);
    local.set(NET, 'devnet');
    const res = await q.sendTransaction(queued(scope));
    expect(res).toMatchObject({ success: false, errorType: SCOPE_CHANGED });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a tx with no scope (an unscoped persisted entry is never re-targeted)', async () => {
    const q = new TransactionQueue();
    const res = await q.sendTransaction(queued(undefined));
    expect(res.errorType).toBe(SCOPE_CHANGED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stamps the enqueue-time network, persists it, and refuses the retry after a switch', async () => {
    const q = new TransactionQueue();
    q.processing = true;
    const { broadcastResult } = await q.add({
      txId: 't2',
      type: 'broadcast_only',
      opType: 'transfer',
      signedTransaction: signed(),
      from: A,
    });
    const persisted = (local.get('tx_queue_state') as any).queue[0];
    expect(persisted.scope).toEqual({ networkId: 'mainnet', rpcUrl: MAINNET_RPC, address: A });

    local.set(NET, 'devnet');
    q.processing = false;
    await q.process();
    await expect(broadcastResult).resolves.toMatchObject({
      success: false,
      errorType: SCOPE_CHANGED,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(q.queue).toHaveLength(0);
  });

  it('refuses after the active wallet changed', async () => {
    const q = new TransactionQueue();
    const scope = await captureTxScope(A);
    local.set(ACTIVE, B);
    const res = await q.sendTransaction(queued(scope));
    expect(res.errorType).toBe(SCOPE_CHANGED);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('network-scoped lookups', () => {
  it('getCachedNonce reads only the RPC it is asked about', () => {
    const ns = new NetworkService();
    ns.balanceCache.set(`${MAINNET_RPC}|${A}`, { balance: 1, nonce: 40, timestamp: 0 });
    expect(ns.getCachedNonce(A, MAINNET_RPC)).toBe(40);
    expect(ns.getCachedNonce(A, DEVNET_RPC)).toBeNull();
  });

  it('a pending tx shows only for its party and its networks', () => {
    const tx = { from: A, to: B, network: 'devnet' };
    expect(pendingTxInScope(tx, A, ['mainnet', 'devnet'])).toBe(true);
    expect(pendingTxInScope(tx, B, ['mainnet', 'devnet'])).toBe(false);
    expect(pendingTxInScope(tx, 'octC', ['mainnet', 'devnet'])).toBe(false);
    expect(pendingTxInScope(tx, A, ['custom_1'])).toBe(false);
    expect(pendingTxInScope({ ...tx, network: 'custom_1' }, A, ['mainnet', 'devnet'])).toBe(false);
    expect(pendingTxInScope({ from: A, to: B }, A, ['custom_1'])).toBe(false);
  });
});

describe('PVAC registration cache', () => {
  const remote = (byNetwork: Record<string, string | null>) => ({
    getPvacPubkey: vi.fn(
      async (_addr: string, at: { networkId: string }) => byNetwork[at.networkId]
    ),
  });

  it('a verdict on one network is never reused on another', async () => {
    const pm = new PvacManager();
    vi.spyOn(pm, 'getPublicKeyAsync').mockResolvedValue('LOCAL');
    const svc = remote({ mainnet: 'LOCAL', devnet: null });

    expect(await pm.verifyRegistration(A, 'pk', 'pub', svc)).toBe(true);
    local.set(NET, 'devnet');
    expect(await pm.verifyRegistration(A, 'pk', 'pub', svc)).toBe(false);
    expect(svc.getPvacPubkey).toHaveBeenCalledTimes(2);

    local.set(NET, 'mainnet');
    expect(await pm.verifyRegistration(A, 'pk', 'pub', svc)).toBe(true);
    expect(svc.getPvacPubkey).toHaveBeenCalledTimes(2);
  });

  it('drops a verdict that lands after a switch and refuses a stale caller', async () => {
    const pm = new PvacManager();
    vi.spyOn(pm, 'getPublicKeyAsync').mockResolvedValue('LOCAL');
    const svc = {
      getPvacPubkey: vi.fn(async () => {
        local.set(NET, 'devnet');
        return 'OTHER';
      }),
    };
    await expect(pm.verifyRegistration(A, 'pk', 'pub', svc)).rejects.toBeInstanceOf(TxScopeError);
    expect(pm.pvacForeign).toBe(false);
    await expect(
      pm.verifyRegistration(A, 'pk', 'pub', svc, false, 'mainnet')
    ).rejects.toBeInstanceOf(TxScopeError);
  });
});

describe('pending key switch', () => {
  it('is kept per network, and a record from before the scope moves to the selected one', async () => {
    local.set('pvac_pending_key_switch', { [A]: { address: A, txId: 'old', submittedAt: 1 } });
    expect(await getPendingKeySwitch({ networkId: 'mainnet', address: A })).toMatchObject({
      txId: 'old',
      networkId: 'mainnet',
    });
    expect(await getPendingKeySwitch({ networkId: 'devnet', address: A })).toBeNull();

    await recordPendingKeySwitch({ networkId: 'devnet', address: A }, 'dev', 'migration');
    await clearPendingKeySwitch({ networkId: 'mainnet', address: A });
    expect(await getPendingKeySwitch({ networkId: 'mainnet', address: A })).toBeNull();
    expect(await getPendingKeySwitch({ networkId: 'devnet', address: A })).toMatchObject({
      txId: 'dev',
    });
  });
});
