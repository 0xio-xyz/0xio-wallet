import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const vault = [
  { id: 'id-a', name: 'A', address: A, publicKey: 'pkA', privateKey: 'skA', type: 'standard' },
];

const h = vi.hoisted(() => ({ sessionKey: 'session-key' as string | null }));
vi.mock('../background/services/wallet', () => ({
  getActiveWallet: vi.fn(async () => ({ id: A, address: A, publicKey: 'pkA', name: 'A' })),
  waitForWalletUnlock: vi.fn(async () => null),
}));
vi.mock('../background/services/approvals', () => ({
  approvalQueue: { add: vi.fn() },
  txApprovalQueue: { add: vi.fn() },
  msgApprovalQueue: { add: vi.fn() },
  hasPendingApproval: vi.fn(() => false),
}));
vi.mock('../services/crypto/PasswordManager', () => ({
  passwordManager: { getSessionKey: vi.fn(async () => h.sessionKey) },
}));
vi.mock('../services/wallet/WalletStorage', () => ({
  walletStorage: {
    loadVault: vi.fn(async () => structuredClone(vault)),
    loadAllWallets: vi.fn(async () => structuredClone(vault)),
  },
}));
vi.mock('../services/network/NetworkService', () => ({
  networkService: {},
  privacyNetworkService: {},
}));
vi.mock('../services/pvac/PvacManager', () => ({ pvacManager: {} }));
vi.mock('../background/services/txQueue', () => ({
  txQueue: { getNetworkUrl: vi.fn(async () => 'http://node') },
}));
vi.mock('../background/services/balance', () => ({ refreshAndBroadcastBalance: vi.fn() }));
vi.mock('../background/services/networkPrivacy', () => ({
  activeNetworkHasPrivacy: vi.fn(async () => true),
}));

import { dappConnections, persistDAppConnection } from '../background/services/dappConnections';
import { handleDAppRequest } from '../background/handlers/dappRequest';
import {
  balanceCacheKey,
  clearPrivateBalanceCache,
  readBalanceCache,
  stripPrivateFromLocalBalanceCache,
  writeBalanceCache,
} from '../services/wallet/balanceCache';

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();

const area = (store: Map<string, unknown>) => ({
  get: async (keys?: string | string[] | null) => {
    if (keys == null) return Object.fromEntries(store);
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
  },
  set: async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
  },
  remove: async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
  },
});

const KEY = balanceCacheKey('mainnet', A);
const fetchMock = vi.fn(
  async () => new Response(JSON.stringify({ result: { balance: '10', nonce: 1 } }))
);

beforeEach(() => {
  local.clear();
  session.clear();
  dappConnections.clear();
  h.sessionKey = 'session-key';
  local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, A);
  local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'mainnet');
  session.set('wallet_unlocked', true);
  (chrome.storage as any).local = area(local);
  (chrome.storage as any).session = area(session);
  (chrome as any).tabs.get = vi.fn(async () => {
    throw new Error('no tab');
  });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

const request = (method: string, params: unknown = {}, origin = 'https://a.app') =>
  new Promise<any>((resolve) =>
    handleDAppRequest({ method, params }, { origin } as chrome.runtime.MessageSender, resolve)
  );

const connect = () =>
  persistDAppConnection('https://a.app', {
    origin: 'https://a.app',
    address: A,
    connected: true,
    connectedAt: Date.now(),
    permissions: [],
  });

describe('balance cache storage', () => {
  it('keeps the private half and the total out of local storage', async () => {
    await writeBalanceCache('mainnet', A, '10', '5', '15');
    expect(local.get(KEY)).toEqual({ balance: '10' });
    expect(session.get(KEY)).toEqual({ privateBalance: '5', totalBalance: '15' });
    expect(await readBalanceCache('mainnet', A)).toEqual({
      balance: '10',
      privateBalance: '5',
      totalBalance: '15',
    });
  });

  it('a public read alone leaves the private half in place', async () => {
    await writeBalanceCache('mainnet', A, '10', '5', '15');
    await writeBalanceCache('mainnet', A, '12', null, null);
    expect(await readBalanceCache('mainnet', A)).toEqual({
      balance: '12',
      privateBalance: '5',
      totalBalance: '15',
    });
  });

  it('writes no private half while locked, and a lock clears it', async () => {
    await writeBalanceCache('mainnet', A, '10', '5', '15');
    session.delete('wallet_unlocked');
    await clearPrivateBalanceCache();
    expect(session.has(KEY)).toBe(false);
    await writeBalanceCache('mainnet', A, '10', '6', '16');
    expect(session.has(KEY)).toBe(false);
    expect(await readBalanceCache('mainnet', A)).toEqual({ balance: '10' });
  });

  it('strips the private half older versions left in local storage', async () => {
    local.set(KEY, { balance: '10', privateBalance: '5', totalBalance: '15' });
    local.set(balanceCacheKey('devnet', A), { privateBalance: '1' });
    local.set('other', { privateBalance: '9' });
    await stripPrivateFromLocalBalanceCache();
    expect(local.get(KEY)).toEqual({ balance: '10' });
    expect(local.has(balanceCacheKey('devnet', A))).toBe(false);
    expect(local.get('other')).toEqual({ privateBalance: '9' });
  });
});

describe('dApp balance reads while locked', () => {
  it('refuses getBalance and get_private_balance_info with WALLET_LOCKED', async () => {
    await connect();
    session.set(KEY, { privateBalance: '5', totalBalance: '15' });
    h.sessionKey = null;

    const bal = await request('getBalance');
    expect(bal).toEqual({
      success: false,
      error: { code: 'WALLET_LOCKED', message: expect.any(String) },
    });
    const info = await request('get_private_balance_info');
    expect(info.success).toBe(false);
    expect(info.error.code).toBe('WALLET_LOCKED');
    expect(JSON.stringify([bal, info])).not.toContain('5');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the private balance from the session cache once unlocked', async () => {
    await connect();
    local.set(KEY, { balance: '10', privateBalance: '99', totalBalance: '109' });
    session.set(KEY, { privateBalance: '5', totalBalance: '15' });

    const info = await request('get_private_balance_info');
    expect(info).toEqual({
      success: true,
      data: { hasPrivateBalance: true, encryptedAmount: '5', canDecrypt: true },
    });
    const bal = await request('getBalance');
    expect(bal.success).toBe(true);
    expect(bal.data.privateBalance).toBe(5);
  });
});
