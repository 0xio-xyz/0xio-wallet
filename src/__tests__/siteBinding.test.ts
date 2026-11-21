import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const W = 'octWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';

const vault = [
  {
    id: 'id-a',
    name: 'Wallet A',
    address: A,
    publicKey: 'pkA',
    privateKey: 'skA',
    type: 'standard',
  },
  {
    id: 'id-b',
    name: 'Wallet B',
    address: B,
    publicKey: 'pkB',
    privateKey: 'skB',
    type: 'standard',
  },
  { id: 'id-w', name: 'Watched', address: W, publicKey: null, privateKey: null, type: 'watch' },
];

const state = vi.hoisted(() => ({ active: '' }));
vi.mock('../background/services/wallet', () => ({
  getActiveWallet: vi.fn(async () => {
    const w = vault.find((v) => v.address === state.active);
    return w ? { id: w.address, address: w.address, publicKey: w.publicKey, name: w.name } : null;
  }),
  waitForWalletUnlock: vi.fn(async () => null),
}));
vi.mock('../background/services/approvals', () => ({
  approvalQueue: { add: vi.fn() },
  txApprovalQueue: { add: vi.fn() },
  msgApprovalQueue: { add: vi.fn() },
  hasPendingApproval: vi.fn(() => false),
}));
vi.mock('../services/crypto/PasswordManager', () => ({
  passwordManager: { getSessionKey: vi.fn(async () => 'session-key') },
}));
vi.mock('../services/wallet/WalletStorage', () => ({
  walletStorage: {
    loadVault: vi.fn(async () => structuredClone(vault)),
    loadAllWallets: vi.fn(async () => structuredClone(vault)),
    setActiveWallet: vi.fn(async (id: string) => {
      const w = vault.find((v) => v.id === id)!;
      state.active = w.address;
      local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, w.address);
      return w;
    }),
  },
}));
vi.mock('../services/network/NetworkService', () => ({
  networkService: { signMessage: vi.fn(async (_m: string, key: string) => `signed-by-${key}`) },
  privacyNetworkService: {},
}));
vi.mock('../services/pvac/PvacManager', () => ({ pvacManager: {} }));
vi.mock('../background/services/txQueue', () => ({ txQueue: {} }));
vi.mock('../background/services/balance', () => ({ refreshAndBroadcastBalance: vi.fn() }));

import { msgApprovalQueue } from '../background/services/approvals';
import { walletStorage } from '../services/wallet/WalletStorage';
import {
  connectionKey,
  dappConnections,
  moveConnections,
  persistDAppConnection,
} from '../background/services/dappConnections';
import {
  choosePrivateWallet,
  prepareSigner,
  privateRequestRoute,
  settleSigner,
  walletForOrigin,
} from '../background/services/siteWallet';
import { txScopeMismatch } from '../services/network/txScope';
import { handleDAppRequest } from '../background/handlers/dappRequest';

const local = new Map<string, unknown>();
const sent: { tabId: number; msg: any }[] = [];

beforeEach(() => {
  local.clear();
  sent.length = 0;
  dappConnections.clear();
  state.active = B;
  local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, B);
  local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'mainnet');
  vi.mocked(msgApprovalQueue.add).mockReset();
  vi.mocked(walletStorage.setActiveWallet).mockClear();
  (chrome.storage as any).local = {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return Object.fromEntries(local);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => local.has(k)).map((k) => [k, local.get(k)]));
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
    },
    remove: async () => {},
  };
  (chrome as any).tabs.query = vi.fn((_q: unknown, cb?: (tabs: any[]) => void) =>
    cb?.([{ id: 7, url: 'https://a.app/page' }])
  );
  (chrome as any).tabs.sendMessage = vi.fn(async (tabId: number, msg: any) => {
    sent.push({ tabId, msg });
  });
  (chrome as any).tabs.get = vi.fn(async () => {
    throw new Error('no tab');
  });
});

const connect = (origin: string, address?: string) =>
  persistDAppConnection(origin, {
    origin,
    address,
    connected: true,
    connectedAt: Date.now(),
    permissions: [],
  });

const request = (method: string, params: unknown = {}, origin = 'https://a.app') =>
  new Promise<any>((resolve) =>
    handleDAppRequest({ method, params }, { origin } as chrome.runtime.MessageSender, resolve)
  );

describe('the wallet a site acts through', () => {
  it('is the wallet the site was connected with, even when another one is open', async () => {
    await connect('https://a.app', A);
    const site = await walletForOrigin('https://a.app');
    expect(site.status).toBe('ok');
    expect(site.status === 'ok' && site.wallet.address).toBe(A);
    expect(site.status === 'ok' && site.bound).toBe(true);
  });

  it('is the open wallet for a site that never picked one', async () => {
    await connect('https://b.app');
    const site = await walletForOrigin('https://b.app');
    expect(site.status === 'ok' && site.wallet.address).toBe(B);
    expect(site.status === 'ok' && site.bound).toBe(false);
    const fresh = await walletForOrigin('https://never.app');
    expect(fresh.status === 'ok' && fresh.wallet.address).toBe(B);
  });

  it('is gone when the bound wallet was removed, and the site is refused', async () => {
    await connect('https://a.app', 'octGONEGONEGONEGONEGONEGONEGONEGONEGONEGONEGONE');
    expect((await walletForOrigin('https://a.app')).status).toBe('gone');
    const res = await request('getWalletInfo');
    expect(res.success).toBe(false);
    expect(res.error.code).toBe('NOT_CONNECTED');
  });

  it('answers reads with the site wallet', async () => {
    await connect('https://a.app', A);
    const res = await request('getWalletInfo');
    expect(res.data.address).toBe(A);
  });

  it('signs a message with the site wallet, not the open one', async () => {
    await connect('https://a.app', A);
    vi.mocked(msgApprovalQueue.add).mockResolvedValue({ approved: true });
    const res = await request('signMessage', { message: 'hello' });
    expect(vi.mocked(msgApprovalQueue.add).mock.calls[0][0].walletAddress).toBe(A);
    expect(res.data.signature).toBe('signed-by-skA');
  });

  it('signs with the open wallet for an unbound site', async () => {
    await connect('https://b.app');
    vi.mocked(msgApprovalQueue.add).mockResolvedValue({ approved: true });
    const res = await request('signMessage', { message: 'hello' }, 'https://b.app');
    expect(res.data.signature).toBe('signed-by-skB');
  });

  it('switching the open wallet tells no site anything', async () => {
    await connect('https://a.app', A);
    await walletStorage.setActiveWallet('id-a');
    await walletStorage.setActiveWallet('id-b');
    expect(sent).toEqual([]);
  });
});

describe('signer scope', () => {
  it('pins a bound site to its binding, not to the open wallet', async () => {
    await connect('https://a.app', A);
    const prep = await prepareSigner('https://a.app', await walletForOrigin('https://a.app'));
    if (prep.ok === false) throw new Error('no signer');
    expect(prep.signer.address).toBe(A);
    expect(prep.signer.scope.siteKey).toBe(connectionKey('https://a.app'));
    expect(await txScopeMismatch(prep.signer.scope)).toBeNull();

    await moveConnections(['https://a.app'], { address: B, publicKey: 'pkB' });
    expect(await txScopeMismatch(prep.signer.scope)).toMatch(/moved to another wallet/);
  });
});

describe('picking another wallet on the approval', () => {
  const prepared = async () => {
    await connect('https://a.app', A);
    const prep = await prepareSigner('https://a.app', await walletForOrigin('https://a.app'));
    if (prep.ok === false) throw new Error('no signer');
    return prep.signer;
  };

  it('keeps the shown wallet when nothing was picked', async () => {
    const signer = await prepared();
    const res = await settleSigner('https://a.app', signer, undefined);
    expect(res.ok && res.address).toBe(A);
  });

  it('re-checks the pick, moves the site to it and tells the site', async () => {
    const signer = await prepared();
    const res = await settleSigner('https://a.app', signer, B);
    expect(res.ok && res.address).toBe(B);
    expect((local.get(connectionKey('https://a.app')) as any).address).toBe(B);
    expect(sent[0].msg.eventData).toEqual({
      type: 'accountChanged',
      data: { address: B, publicKey: 'pkB', canSign: true },
    });
    if (res.ok) expect(await txScopeMismatch(res.scope)).toBeNull();
  });

  it('refuses a watch-only or unknown pick and leaves the site alone', async () => {
    const signer = await prepared();
    const watch = await settleSigner('https://a.app', signer, W);
    expect(watch.ok === false && watch.error.code).toBe('WATCH_ONLY');
    const unknown = await settleSigner(
      'https://a.app',
      signer,
      'octZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'
    );
    expect(unknown.ok).toBe(false);
    expect((local.get(connectionKey('https://a.app')) as any).address).toBe(A);
    expect(sent).toEqual([]);
  });

  it('refuses when the site moved while the approval was open', async () => {
    const signer = await prepared();
    await moveConnections(['https://a.app'], { address: B, publicKey: 'pkB' });
    const res = await settleSigner('https://a.app', signer, undefined);
    expect(res.ok === false && res.error.code).toBe('NETWORK_CHANGED');
  });
});

describe('private request from a site on another wallet', () => {
  it('asks first when the wallets differ, and runs straight otherwise', async () => {
    await connect('https://a.app', A);
    await connect('https://b.app', B);
    expect(privateRequestRoute(await walletForOrigin('https://a.app'))).toBe('choose');
    expect(privateRequestRoute(await walletForOrigin('https://b.app'))).toBe('run');
    expect(privateRequestRoute({ status: 'locked' })).toBe('run');
  });

  const choose = async (answer: unknown) => {
    await connect('https://a.app', A);
    const site = await walletForOrigin('https://a.app');
    if (site.status !== 'ok') throw new Error('no site');
    vi.mocked(msgApprovalQueue.add).mockResolvedValue(answer as any);
    return choosePrivateWallet('https://a.app', 'send_private_transfer', site);
  };

  it('shows both wallets on the choice', async () => {
    await choose({ approved: false });
    expect(vi.mocked(msgApprovalQueue.add).mock.calls[0][0]).toMatchObject({
      kind: 'site_wallet_choice',
      siteAddress: A,
      siteName: 'Wallet A',
      activeAddress: B,
      activeName: 'Wallet B',
    });
  });

  it('switch opens the site wallet and leaves the site where it is', async () => {
    const res = await choose({ approved: true, choice: 'switch' });
    expect(res.ok).toBe(true);
    expect(walletStorage.setActiveWallet).toHaveBeenCalledWith('id-a');
    expect(state.active).toBe(A);
    expect((local.get(connectionKey('https://a.app')) as any).address).toBe(A);
  });

  it('move hands the site the open wallet', async () => {
    const res = await choose({ approved: true, choice: 'move' });
    expect(res.ok).toBe(true);
    expect(walletStorage.setActiveWallet).not.toHaveBeenCalled();
    expect((local.get(connectionKey('https://a.app')) as any).address).toBe(B);
  });

  it('cancel rejects the request and changes nothing', async () => {
    const res = await choose(false);
    expect(res.ok === false && res.error.code).toBe('USER_REJECTED');
    expect(state.active).toBe(B);
    expect((local.get(connectionKey('https://a.app')) as any).address).toBe(A);
  });

  it('the request gate goes through the choice before any private work', async () => {
    await connect('https://a.app', A);
    vi.mocked(msgApprovalQueue.add).mockResolvedValue({ approved: false });
    const res = await request('send_private_transfer', { to: B, amount_raw: '1' });
    expect(vi.mocked(msgApprovalQueue.add).mock.calls[0][0].kind).toBe('site_wallet_choice');
    expect(res.error.code).toBe('USER_REJECTED');
  });
});

describe('wallet switch', () => {
  it('no longer queues a "move sites" prompt', async () => {
    const listeners: ((changes: any, area: string) => unknown)[] = [];
    const sessionSet = vi.fn(async () => {});
    (chrome as any).runtime.onInstalled = { addListener: vi.fn() };
    (chrome as any).runtime.onStartup = { addListener: vi.fn() };
    (chrome as any).storage.onChanged = {
      addListener: (fn: any) => listeners.push(fn),
      removeListener: vi.fn(),
    };
    (chrome as any).storage.session = {
      get: vi.fn(async () => ({})),
      set: sessionSet,
      remove: vi.fn(async () => {}),
    };
    (chrome as any).alarms = {
      get: vi.fn(async () => undefined),
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    };
    await connect('https://a.app', A);
    await import('../background/index');
    expect(listeners.length).toBeGreaterThan(0);

    const key = ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET;
    for (const fn of listeners) await fn({ [key]: { oldValue: A, newValue: B } }, 'local');
    expect(sessionSet).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
