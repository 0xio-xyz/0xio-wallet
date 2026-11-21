import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';
import { captureTxScope } from 'src/services/network/txScope';
import { CANCELLED, TransactionQueue } from 'src/background/services/txQueue';
import { checkPendingTransactionsConfirmation } from 'src/background/services/pendingReconciler';

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
  vi.stubGlobal('fetch', fetchMock);
});

const signed = () => ({ from: A, to_: B, amount: '1', nonce: 7, signature: 'sig' });

const held = async (q: TransactionQueue, txId: string) => {
  q.processing = true;
  return q.add({
    txId,
    type: 'broadcast_only',
    opType: 'transfer',
    signedTransaction: signed(),
    from: A,
  });
};

describe('cancelling a queued tx', () => {
  it('removes a tx that never reached a node and answers its sender', async () => {
    const q = new TransactionQueue();
    local.set('pending_tx_t1', { from: A, txId: 't1' });
    const { broadcastResult } = await held(q, 't1');
    expect(await q.cancel('t1')).toBe(true);
    expect(q.queue).toHaveLength(0);
    expect((local.get('tx_queue_state') as any).queue).toHaveLength(0);
    expect(local.has('pending_tx_t1')).toBe(false);
    await expect(broadcastResult).resolves.toMatchObject({ success: false, errorType: CANCELLED });
  });

  it('refuses once an attempt may have reached a node, and keeps the tx', async () => {
    const q = new TransactionQueue();
    await held(q, 't2');
    q.queue[0].sent = true;
    expect(await q.cancel('t2')).toBe(false);
    q.queue[0].sent = false;
    q.queue[0].status = 'processing';
    expect(await q.cancel('t2')).toBe(false);
    expect(q.queue).toHaveLength(1);
  });

  it('refuses a tx the queue does not hold', async () => {
    expect(await new TransactionQueue().cancel('nope')).toBe(false);
  });

  it('marks a tx sent once its submit times out, so it can no longer be cancelled', async () => {
    const q = new TransactionQueue();
    fetchMock.mockRejectedValue(new Error('network down'));
    const tx = {
      id: 't3',
      signedTransaction: signed(),
      scope: await captureTxScope(A),
      status: 'retrying',
      addedAt: 0,
      attempts: 1,
      maxAttempts: 3,
    } as any;
    q.queue.push(tx);
    await q.sendTransaction(tx);
    expect(tx.sent).toBe(true);
    expect(await q.cancel('t3')).toBe(false);
  });

  it('a definite refusal leaves it unsent, typed and fatal', async () => {
    const q = new TransactionQueue();
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () =>
        JSON.stringify({
          result: { status: 'rejected', error: { reason: 'nonce too low', type: 'bad_nonce' } },
        }),
    });
    const tx = {
      id: 't4',
      signedTransaction: signed(),
      scope: await captureTxScope(A),
      status: 'processing',
      addedAt: 0,
      attempts: 1,
      maxAttempts: 3,
    } as any;
    const res = await q.sendTransaction(tx);
    expect(res).toEqual({ success: false, error: 'nonce too low', errorType: 'bad_nonce' });
    expect(tx.sent).toBe(false);
  });
});

describe('background reconciler', () => {
  const rpcAnswer = (status: string) => new Response(JSON.stringify({ result: { status } }));

  it('asks the node of the record network, not the active one', async () => {
    local.set('pending_tx_d', {
      from: A,
      hash: 'H',
      nonce: 1,
      network: 'devnet',
      timestamp: Date.now(),
    });
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith(DEVNET_RPC) ? rpcAnswer('confirmed') : rpcAnswer('pending')
    );
    await checkPendingTransactionsConfirmation();
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith(DEVNET_RPC))).toBe(true);
    expect(local.get('pending_tx_d')).toMatchObject({
      status: 'success',
      confirmed: true,
      pending: false,
      hash: 'H',
    });
  });

  it('checks both built-ins for a record without a network and skips the nonce rule', async () => {
    local.set('pending_tx_old', { from: A, hash: 'H', nonce: 1, timestamp: Date.now() });
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith(MAINNET_RPC)
        ? new Response(JSON.stringify({ result: null }))
        : rpcAnswer('dropped')
    );
    await checkPendingTransactionsConfirmation();
    expect(fetchMock.mock.calls.map(([url]) => String(url).slice(0, 20))).toEqual([
      `${MAINNET_RPC}/rpc`.slice(0, 20),
      `${DEVNET_RPC}/rpc`.slice(0, 20),
    ]);
    expect(local.get('pending_tx_old')).toMatchObject({ status: 'failed', pending: false });
  });

  it('leaves a confirmed marker alone until it is a day old', async () => {
    local.set('pending_tx_m', {
      from: A,
      hash: 'H',
      network: 'mainnet',
      status: 'success',
      confirmed: true,
      timestamp: Date.now(),
    });
    await checkPendingTransactionsConfirmation();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.has('pending_tx_m')).toBe(true);
  });
});
