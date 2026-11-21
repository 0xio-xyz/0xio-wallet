import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const vault = [
  { id: 'id-a', name: 'A', address: A, publicKey: 'pkA', privateKey: 'skA', type: 'standard' },
  { id: 'id-b', name: 'B', address: B, publicKey: 'pkB', privateKey: 'skB', type: 'standard' },
];

const state = vi.hoisted(() => ({ active: '' }));
vi.mock('../background/services/wallet', () => ({
  getActiveWallet: vi.fn(async () => {
    const w = vault.find((v) => v.address === state.active);
    return w ? { id: w.id, address: w.address, publicKey: w.publicKey, name: w.name } : null;
  }),
  waitForWalletUnlock: vi.fn(async () => null),
}));
vi.mock('../background/services/approvals', () => ({
  approvalQueue: { add: vi.fn() },
  txApprovalQueue: { add: vi.fn() },
  msgApprovalQueue: { add: vi.fn(async () => ({ approved: true })) },
  hasPendingApproval: vi.fn(() => false),
}));
vi.mock('../services/crypto/PasswordManager', () => ({
  passwordManager: { getSessionKey: vi.fn(async () => 'session-key') },
}));
vi.mock('../services/wallet/WalletStorage', () => ({
  walletStorage: {
    loadVault: vi.fn(async () => structuredClone(vault)),
    loadAllWallets: vi.fn(async () => structuredClone(vault)),
    setActiveWallet: vi.fn(async () => null),
  },
}));
vi.mock('../services/network/NetworkService', () => ({
  networkService: {},
  privacyNetworkService: {},
}));
vi.mock('../services/pvac/PvacManager', () => ({ pvacManager: {} }));

import { TransactionQueue } from '../background/services/txQueue';
import {
  dappConnections,
  moveConnections,
  persistDAppConnection,
  sendEventToConnected,
} from '../background/services/dappConnections';
import { refreshAndBroadcastBalance } from '../background/services/balance';
import { handleDAppRequest } from '../background/handlers/dappRequest';

const NET = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;
const ACTIVE = ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET;

const local = new Map<string, unknown>();
const sent: { tabId: number; msg: any; frameId?: number }[] = [];
const fetchMock = vi.fn();

const TABS = [
  { id: 7, url: undefined },
  { id: 8, url: 'https://evil.app/', active: true },
  { id: 9, url: 'https://a.app/x' },
  { id: 10, url: 'https://c.app/' },
];

beforeEach(() => {
  local.clear();
  sent.length = 0;
  dappConnections.clear();
  state.active = A;
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
  (chrome as any).tabs.query = vi.fn((q: any, cb?: (tabs: any[]) => void) => {
    const tabs = q?.active ? TABS.filter((t) => t.active) : TABS;
    if (cb) cb(tabs);
    return Promise.resolve(tabs);
  });
  (chrome as any).tabs.sendMessage = vi.fn(async (tabId: number, msg: any, opts?: any) => {
    sent.push({ tabId, msg, frameId: opts?.frameId });
  });
  (chrome as any).tabs.get = vi.fn(async () => {
    throw new Error('no tab');
  });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ result: { tx_hash: 'h1', balance: '5' } }),
    json: async () => ({ result: { tx_hash: 'h1', balance: '5' } }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

const connect = (origin: string, address: string) =>
  persistDAppConnection(origin, {
    origin,
    address,
    connected: true,
    connectedAt: Date.now(),
    permissions: [],
  });

const settle = () => new Promise((r) => setTimeout(r, 30));
const walletEvents = () => sent.filter((s) => s.msg?.type === 'WALLET_EVENT');
const tabsOf = (type: string) =>
  walletEvents()
    .filter((s) => s.msg.eventData?.type === type)
    .map((s) => s.tabId)
    .sort((a, b) => a - b);

const signed = () => ({ from: A, to_: B, amount: '1000000', nonce: 7, signature: 'sig' });

const queueTx = async (site?: { origin: string; tabId?: number; frameId?: number }) => {
  const q = new TransactionQueue();
  const { broadcastResult } = await q.add(
    {
      type: 'broadcast_only',
      opType: 'transfer',
      signedTransaction: signed(),
      from: A,
      to: B,
      amount: 1,
    },
    site
  );
  return broadcastResult;
};

describe('transaction events', () => {
  it('a send made in the popup tells no page anything', async () => {
    await connect('https://a.app', A);
    await expect(await queueTx()).toMatchObject({ success: true });
    await settle();
    expect(walletEvents()).toHaveLength(0);
  });

  it('ignores an origin the popup slips into the transaction itself', async () => {
    await connect('https://a.app', A);
    const q = new TransactionQueue();
    const { broadcastResult } = await q.add({
      type: 'broadcast_only',
      signedTransaction: signed(),
      from: A,
      origin: 'https://a.app',
      tabId: 7,
    } as any);
    await broadcastResult;
    await settle();
    expect(walletEvents()).toHaveLength(0);
  });

  it('a site send reaches only the tabs of that site, never the active tab', async () => {
    await connect('https://a.app', A);
    await queueTx({ origin: 'https://a.app', tabId: 7, frameId: 0 });
    await vi.waitFor(() => expect(tabsOf('transactionConfirmed')).toEqual([7, 9]));
    await settle();
    expect(tabsOf('transactionConfirmed')).toEqual([7, 9]);
    for (const s of walletEvents()) expect(s.msg.origin).toBe('https://a.app');
    expect(walletEvents()[0].msg.eventData.data).toMatchObject({ txHash: 'h1', from: A, to: B });
  });

  it('a failure reaches only that site too', async () => {
    await connect('https://a.app', A);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ error: { message: 'bad nonce', data: { type: 'nonce' } } }),
    });
    await queueTx({ origin: 'https://a.app', tabId: 7 });
    await vi.waitFor(() => expect(tabsOf('transactionFailed')).toEqual([7, 9]));
  });

  it('a site that disconnected meanwhile gets nothing', async () => {
    await queueTx({ origin: 'https://a.app', tabId: 7 });
    await settle();
    expect(walletEvents()).toHaveLength(0);
  });

  it('a site moved to another wallet meanwhile gets nothing', async () => {
    await connect('https://a.app', B);
    await queueTx({ origin: 'https://a.app', tabId: 7 });
    await settle();
    expect(walletEvents()).toHaveLength(0);
  });
});

describe('wallet events', () => {
  beforeEach(async () => {
    await connect('https://a.app', A);
    await connect('https://c.app', B);
  });

  it('lock reaches every connected site and no other tab', async () => {
    await sendEventToConnected({ type: 'extensionLocked' });
    await settle();
    expect(tabsOf('extensionLocked')).toEqual([9, 10]);
  });

  it('networkChanged after a site switch reaches the connected sites only', async () => {
    const res = await new Promise<any>((resolve) =>
      handleDAppRequest(
        { method: 'switch_network', params: { networkId: 'devnet' } },
        { origin: 'https://a.app', tab: { id: 7 } } as chrome.runtime.MessageSender,
        resolve
      )
    );
    expect(res).toMatchObject({ success: true, data: { switched: true } });
    await settle();
    expect(tabsOf('networkChanged')).toEqual([9, 10]);
    const data = walletEvents().find((s) => s.tabId === 10)!.msg.eventData.data;
    expect(JSON.stringify(data)).not.toContain(A);
  });

  it('balanceChanged reaches only the sites on that wallet', async () => {
    await refreshAndBroadcastBalance(A);
    await settle();
    expect(tabsOf('balanceChanged')).toEqual([9]);
  });

  it('accountChanged reaches only the site that moved', async () => {
    await moveConnections(['https://c.app'], { address: A, publicKey: 'pkA' });
    await settle();
    expect(tabsOf('accountChanged')).toEqual([10]);
    expect(walletEvents()[0].msg.eventData.data).toMatchObject({ address: A });
  });

  it('a connection kept only in storage still counts after a worker restart', async () => {
    dappConnections.clear();
    await sendEventToConnected({ type: 'extensionUnlocked' }, B);
    await settle();
    expect(tabsOf('extensionUnlocked')).toEqual([10]);
  });
});
