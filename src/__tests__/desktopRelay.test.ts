import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';
import {
  authProof,
  fromHex,
  toHex,
  type DesktopPairing,
} from 'src/services/desktop/desktopPairing';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DESKTOP_ID = '0123456789abcdef0123456789abcdef';
const CLIENT_ID = 'fedcba9876543210fedcba9876543210';
const SECRET = toHex(new Uint8Array(32).fill(5));
const PAIRING: DesktopPairing = {
  v: 1,
  clientId: CLIENT_ID,
  desktopId: DESKTOP_ID,
  secret: SECRET,
  pairedAt: 1,
};

const holder = vi.hoisted(() => ({ relay: null as any }));

vi.mock('../background/services/desktopRelay', async (importOriginal) => {
  const real = await importOriginal<typeof import('../background/services/desktopRelay')>();
  return {
    ...real,
    desktopRelay: {
      request: (...a: unknown[]) => holder.relay.request(...a),
      ensure: (...a: unknown[]) => holder.relay.ensure(...a),
      disconnectSite: (...a: unknown[]) => holder.relay.disconnectSite(...a),
      closeFrame: (...a: unknown[]) => holder.relay.closeFrame(...a),
      closeTab: (...a: unknown[]) => holder.relay.closeTab(...a),
      protocol: (...a: unknown[]) => holder.relay.protocol(...a),
      wallet: (...a: unknown[]) => holder.relay.wallet(...a),
      status: (...a: unknown[]) => holder.relay.status(...a),
      cancel: (...a: unknown[]) => holder.relay.cancel(...a),
      get knownSites() {
        return holder.relay.knownSites;
      },
    },
  };
});
vi.mock('../background/services/wallet', () => ({
  getActiveWallet: vi.fn(async () => ({ id: A, address: A, publicKey: 'pkA', name: 'Main' })),
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
    loadVault: vi.fn(async () => [
      { id: A, address: A, publicKey: 'pkA', privateKey: 'skA', type: 'standard' },
    ]),
    loadAllWallets: vi.fn(async () => [{ id: A, address: A, publicKey: 'pkA', name: 'Main' }]),
    setActiveWallet: vi.fn(),
  },
}));
vi.mock('../services/network/NetworkService', () => ({
  networkService: { signMessage: vi.fn(async () => 'signed-here') },
  privacyNetworkService: {},
}));
vi.mock('../services/pvac/PvacManager', () => ({ pvacManager: {} }));
vi.mock('../background/services/txQueue', () => ({ txQueue: { addTransaction: vi.fn() } }));
vi.mock('../background/services/balance', () => ({ refreshAndBroadcastBalance: vi.fn() }));

import { approvalQueue, msgApprovalQueue, txApprovalQueue } from '../background/services/approvals';
import { networkService } from '../services/network/NetworkService';
import { walletStorage } from '../services/wallet/WalletStorage';
import { handleDAppRequest } from '../background/handlers/dappRequest';
import {
  DesktopRelay,
  LIFECYCLE_TIMEOUT_MS,
  MAX_IN_FLIGHT,
  REQUEST_TIMEOUT_MS,
  pageEvent,
  relayDeps,
  type RelayDeps,
  type RelaySocket,
} from '../background/services/desktopRelay';
import { relayableOrigin, siteOfSender } from '../background/services/siteOrigin';
import { SITE_SIGNER_KEY } from '../background/services/siteSigner';
import {
  dappConnections,
  persistDAppConnection,
  sendEventToOrigins,
} from '../background/services/dappConnections';

const local = new Map<string, unknown>();

function fakeDesktop(
  answer: (args: any) => Promise<any> | 'hang' = () => 'hang',
  other: (method: string, args: any) => any = () => undefined
) {
  const calls: { method: string; args: any; timeout?: number }[] = [];
  const listeners = new Set<(m: any) => void>();
  const closers: (() => void)[] = [];
  const hanging: ((e: Error) => void)[] = [];
  let nonces: { ne: Uint8Array; nd: Uint8Array } | null = null;
  const socket: RelaySocket = {
    link: {
      notify: () => {},
      onEvent: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async call(method, args = {}, timeout?: number) {
        calls.push({ method, args, timeout });
        const own = other(method, args);
        if (own !== undefined) return own;
        if (method === 'auth_hello') {
          const ne = fromHex(args.nonce as string);
          const nd = new Uint8Array(32).fill(9);
          nonces = { ne, nd };
          const proof = toHex(authProof(fromHex(SECRET), 'desktop', CLIENT_ID, DESKTOP_ID, ne, nd));
          return { v: 1, desktop_id: DESKTOP_ID, paired: true, nonce: toHex(nd), proof };
        }
        if (method === 'auth_prove') return { v: 1, ok: !!nonces };
        if (method === 'sites_subscribe') return { v: 1, ok: true };
        if (method === 'site_request') {
          const r = answer(args);
          if (r === 'hang') return new Promise((_res, rej) => hanging.push(rej));
          return r;
        }
        return { v: 1, ok: true };
      },
    },
    close: () => {
      hanging.splice(0).forEach((rej) => rej(new Error('0xio Desktop disconnected')));
      closers.forEach((cb) => cb());
    },
    onClose: (cb) => closers.push(cb),
  };
  return {
    socket,
    calls,
    emit: (msg: any) => listeners.forEach((cb) => cb(msg)),
    sent: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args),
  };
}

const RID = 'ab'.repeat(16);
const unknownStatus = (rid: string) => ({ requestId: rid, status: 'unknown', seq: 0 });
const CAPABILITIES = [
  'request_id',
  'request_status',
  'request_events',
  'idempotent',
  'wait_confirmed',
  'receipt',
  'can_sign',
  'kind',
];
const PROVE_2 = { v: 1, ok: true, protocol: 2, kind: 'desktop', capabilities: CAPABILITIES };
const protocol2 =
  (known: Record<string, unknown> = {}, cancel?: (args: any) => any) =>
  (method: string, args: any) => {
    if (method === 'auth_prove') return PROVE_2;
    if (method === 'site_status')
      return { v: 1, result: known[args.rid] ?? unknownStatus(args.rid) };
    if (method === 'site_cancel' && args.rid && cancel) return cancel(args);
    return undefined;
  };

const makeRelay = (over: Partial<RelayDeps> = {}, desk = fakeDesktop()) => {
  const deps = relayDeps({
    open: async () => desk.socket,
    pairing: async () => PAIRING,
    clientId: async () => CLIENT_ID,
    deliver: vi.fn(async () => {}),
    deliverFrame: vi.fn(async () => {}),
    routed: async () => false,
    signer: async () => undefined,
    setSigner: vi.fn(async () => {}),
    saveSites: vi.fn(async () => {}),
    ...over,
  });
  return { relay: new DesktopRelay(deps), deps, desk };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

const SENDER = {
  id: 'mock-extension-id',
  origin: 'https://a.app',
  url: 'https://a.app/page',
  tab: { id: 7, url: 'https://a.app/page' },
  frameId: 0,
} as unknown as chrome.runtime.MessageSender;

const SITE = siteOfSender(SENDER, false)!;

const request = (method: string, params: unknown = {}, extra: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) => handleDAppRequest({ method, params, ...extra }, SENDER, resolve));

beforeEach(() => {
  local.clear();
  local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, A);
  local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'mainnet');
  vi.mocked(approvalQueue.add).mockReset();
  vi.mocked(msgApprovalQueue.add).mockReset();
  vi.mocked(txApprovalQueue.add).mockReset();
  vi.mocked(networkService.signMessage).mockClear();
  vi.mocked(walletStorage.loadVault).mockClear();
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
  (chrome as any).tabs.get = vi.fn(async () => {
    throw new Error('no tab');
  });
  dappConnections.clear();
});

const routeToDesktop = () => local.set(SITE_SIGNER_KEY, { 'mainnet|https://a.app': 'desktop' });

describe('the site a request names', () => {
  it('comes from the browser sender, never the message body', async () => {
    routeToDesktop();
    const desk = fakeDesktop(async () => ({ v: 1, result: { signature: 'from-desktop' } }));
    holder.relay = makeRelay({}, desk).relay;
    await request(
      'signMessage',
      { message: 'hi', origin: 'https://evil.app' },
      { origin: 'https://evil.app' }
    );
    const [asked] = desk.sent('site_request');
    expect(asked.site.origin).toBe('https://a.app');
    expect(JSON.stringify(asked.site)).not.toContain('evil');
    expect(asked.site.tab_ref).toMatch(/^[0-9a-f]{32}$/);
    expect(asked.site).not.toHaveProperty('tabId');
  });

  it('refuses opaque, file and plain http origins, and http on this machine outside development', () => {
    expect(relayableOrigin('null')).toBeNull();
    expect(relayableOrigin('file:///tmp/x.html')).toBeNull();
    expect(relayableOrigin('http://a.app', true)).toBeNull();
    expect(relayableOrigin('http://localhost:5173', false)).toBeNull();
    expect(relayableOrigin('http://localhost:5173', true)).toBe('http://localhost:5173');
    expect(relayableOrigin('https://a.app')).toBe('https://a.app');
    expect(siteOfSender({ ...SENDER, origin: 'null', url: 'about:blank' } as any)).toBeNull();
    expect(siteOfSender({ ...SENDER, id: 'other-extension' } as any)).toBeNull();
    expect(siteOfSender({ ...SENDER, tab: undefined } as any)).toBeNull();
  });
});

describe('a site routed to 0xio Desktop', () => {
  it('goes to the desktop and never reaches the local signer or review', async () => {
    routeToDesktop();
    const desk = fakeDesktop(async () => ({ v: 1, result: { signature: 'from-desktop' } }));
    holder.relay = makeRelay({}, desk).relay;
    const res = await request('signMessage', { message: 'hello' });
    expect(res).toEqual({ success: true, data: { signature: 'from-desktop' } });
    expect(networkService.signMessage).not.toHaveBeenCalled();
    expect(msgApprovalQueue.add).not.toHaveBeenCalled();
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
    expect(walletStorage.loadVault).not.toHaveBeenCalled();
  });

  it('carries the site request id into the paired frame, and only a well formed one', async () => {
    routeToDesktop();
    const desk = fakeDesktop(
      async () => ({ v: 1, result: { signature: 'from-desktop' } }),
      protocol2()
    );
    holder.relay = makeRelay({}, desk).relay;
    const rid = 'ab'.repeat(16);
    await request('signMessage', { message: 'hi' }, { v: 2, rid });
    await request('signMessage', { message: 'hi' }, { v: 2, rid: 'NOT-HEX' });
    const [withId, bad] = desk.sent('site_request');
    expect(withId.rid).toBe(rid);
    expect(withId.request).toEqual({ method: 'signMessage', params: { message: 'hi' } });
    expect(bad).not.toHaveProperty('rid');
  });

  it('answers NETWORK_ERROR when the desktop leaves mid-request, and signs nothing here', async () => {
    routeToDesktop();
    const { relay, desk } = makeRelay();
    holder.relay = relay;
    const pending = request('signMessage', { message: 'hello' });
    await vi.waitFor(() => expect(desk.sent('site_request')).toHaveLength(1));
    desk.socket.close();
    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error.code).toBe('NETWORK_ERROR');
    expect(networkService.signMessage).not.toHaveBeenCalled();
    expect(msgApprovalQueue.add).not.toHaveBeenCalled();
  });

  it('answers NETWORK_ERROR when the desktop is not reachable, and signs nothing here', async () => {
    routeToDesktop();
    holder.relay = makeRelay({ open: async () => null }).relay;
    const res = await request('send_transaction', { to: A, amount: '1' });
    expect(res.error.code).toBe('NETWORK_ERROR');
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
  });

  it('refuses a method the relay does not carry instead of running it here', async () => {
    routeToDesktop();
    holder.relay = makeRelay().relay;
    const res = await request('encrypt_balance');
    expect(res.error.code).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('requests in flight', () => {
  it(`allows ${MAX_IN_FLIGHT} per origin and refuses the next at once`, async () => {
    const { relay, desk } = makeRelay();
    const waiting = Array.from({ length: MAX_IN_FLIGHT }, () =>
      relay.request(SITE, 'mainnet', { method: 'signMessage' })
    );
    await vi.waitFor(() => expect(desk.sent('site_request')).toHaveLength(MAX_IN_FLIGHT));
    const fourth = await relay.request(SITE, 'mainnet', { method: 'signMessage' });
    expect(fourth).toMatchObject({ ok: false, error: { code: 'RATE_LIMIT_EXCEEDED' } });
    expect(desk.sent('site_request')).toHaveLength(MAX_IN_FLIGHT);

    const other = relay.request({ ...SITE, origin: 'https://b.app' }, 'mainnet', {
      method: 'signMessage',
    });
    await vi.waitFor(() => expect(desk.sent('site_request')).toHaveLength(MAX_IN_FLIGHT + 1));

    desk.socket.close();
    const ends = await Promise.all([...waiting, other]);
    expect(ends.every((a) => 'error' in a && a.error.code === 'NETWORK_ERROR')).toBe(true);
  });

  it('frees the slot and tells the desktop when the tab goes away', async () => {
    const { relay, desk } = makeRelay();
    const pending = relay.request(SITE, 'mainnet', { method: 'signMessage' });
    await vi.waitFor(() => expect(desk.sent('site_request')).toHaveLength(1));
    const ref = desk.sent('site_request')[0].site.tab_ref;
    relay.closeTab(SITE.tabId);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'USER_REJECTED' } });
    expect(desk.sent('site_closed')).toEqual([{ v: 1, tab_ref: ref }]);
  });

  it('cancel answers the site with a rejection and drops the desktop request', async () => {
    const { relay, desk } = makeRelay();
    const abort = new AbortController();
    const pending = relay.request(SITE, 'mainnet', { method: 'connect' }, abort.signal);
    await vi.waitFor(() => expect(desk.sent('site_request')).toHaveLength(1));
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'USER_REJECTED' } });
    expect(desk.sent('site_cancel')[0].id).toBe(desk.sent('site_request')[0].id);
  });
});

describe('desktop events', () => {
  it('reach only the tabs of the origin they name, and only for a site routed here', async () => {
    const sent: { tabId: number; msg: any }[] = [];
    (chrome as any).tabs.sendMessage = vi.fn(async (tabId: number, msg: any) => {
      sent.push({ tabId, msg });
    });
    (chrome as any).tabs.query = vi.fn((_q: unknown, cb?: (tabs: any[]) => void) =>
      cb?.([
        { id: 1, url: 'https://a.app/x' },
        { id: 2, url: 'https://b.app/y' },
        { id: 3, url: 'https://a.app.evil.io/' },
      ])
    );
    const { relay, desk } = makeRelay({
      deliver: (origin, ev) => sendEventToOrigins([origin], ev),
      routed: async (origin) => origin === 'https://a.app',
    });
    expect(await relay.ensure(true)).toBe(true);

    desk.emit({
      event: 'site_event',
      v: 1,
      origin: 'https://a.app',
      kind: 'accountsChanged',
      data: { accounts: [A] },
    });
    desk.emit({
      event: 'site_event',
      v: 1,
      origin: 'https://b.app',
      kind: 'accountsChanged',
      data: { accounts: [A] },
    });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    await tick();
    expect(sent.map((s) => s.tabId)).toEqual([1]);
    expect(sent[0].msg).toEqual({
      type: 'WALLET_EVENT',
      origin: 'https://a.app',
      eventData: { type: 'accountChanged', data: { address: A } },
    });
  });

  it('maps desktop kinds to the events pages already hear', () => {
    expect(pageEvent('accountsChanged', { accounts: [] })).toEqual({
      type: 'disconnect',
      data: {},
    });
    expect(pageEvent('tx', { hash: 'h' })).toEqual({
      type: 'transactionConfirmed',
      data: { hash: 'h' },
    });
    expect(pageEvent('somethingElse', {})).toBeNull();
  });

  it('mirrors only the sites this install relayed and disconnects the ones moved here', async () => {
    const { relay, desk, deps } = makeRelay({
      signer: async (origin) => (origin === 'https://moved.app' ? 'browser' : undefined),
    });
    await relay.ensure(true);
    desk.emit({
      event: 'sites_snapshot',
      v: 1,
      sites: [
        {
          origin: 'https://a.app',
          network: 'mainnet',
          address: A,
          wallet: { name: 'Spending' },
          relayed_by: CLIENT_ID,
        },
        {
          origin: 'https://moved.app',
          network: 'mainnet',
          address: A,
          wallet: { name: 'Spending' },
          relayed_by: CLIENT_ID,
        },
        {
          origin: 'https://other.app',
          network: 'mainnet',
          address: A,
          wallet: { name: 'X' },
          relayed_by: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
    });
    await vi.waitFor(() => expect(desk.sent('site_disconnect')).toHaveLength(1));
    expect(relay.knownSites.map((s) => s.origin)).toEqual(['https://a.app', 'https://moved.app']);
    expect(desk.sent('site_disconnect')[0]).toEqual({
      v: 1,
      origin: 'https://moved.app',
      network: 'mainnet',
    });
    expect(deps.setSigner).toHaveBeenCalledWith('https://a.app', 'mainnet', 'desktop');
  });
});

describe('Sign with on the connect review', () => {
  it('is not offered while 0xio Desktop is not paired', async () => {
    const opened = vi.fn(async () => null);
    holder.relay = makeRelay({ pairing: async () => null, open: opened }).relay;
    vi.mocked(approvalQueue.add).mockResolvedValue({ approved: false });
    await request('connect');
    const shown = vi.mocked(approvalQueue.add).mock.calls[0][0] as Record<string, unknown>;
    expect(shown.signWith).toBeUndefined();
    expect(shown.routeDesktop).toBeUndefined();
    expect(opened).not.toHaveBeenCalled();
  });

  it('is offered while paired and proven, and Continue only routes the request', async () => {
    const desk = fakeDesktop(async () => ({ v: 1, result: { address: A } }));
    holder.relay = makeRelay({}, desk).relay;
    vi.mocked(approvalQueue.add).mockImplementation(async (info: any) => ({
      approved: true,
      desktop: await info.routeDesktop(new AbortController().signal),
    }));
    const res = await request('connect', { origin: 'https://evil.app' });
    const shown = vi.mocked(approvalQueue.add).mock.calls[0][0] as Record<string, any>;
    expect(shown.signWith).toEqual({ available: true, pick: 'browser', network: 'mainnet' });
    expect(res).toEqual({ success: true, data: { address: A } });
    expect(desk.sent('site_request')[0].site.origin).toBe('https://a.app');
    expect(local.get(SITE_SIGNER_KEY)).toEqual({ 'mainnet|https://a.app': 'desktop' });
  });
});

describe('a desktop site while 0xio Desktop is closed or locked', () => {
  const closed = () => {
    const opened = vi.fn(async () => null);
    holder.relay = makeRelay({ open: opened }).relay;
    return opened;
  };

  it('answers register_dapp here, so the SDK starts, and never asks the desktop', async () => {
    routeToDesktop();
    const desk = fakeDesktop(async () => ({ v: 1, result: { registered: true } }));
    holder.relay = makeRelay({}, desk).relay;
    const res = await request('register_dapp', { appName: 'Bridge' });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ registered: true, appName: 'Bridge' });
    expect(desk.sent('site_request')).toHaveLength(0);

    closed();
    expect((await request('register_dapp', { appName: 'Bridge' })).success).toBe(true);
  });

  it('answers the pre-connect reads here as not connected while the desktop is down', async () => {
    routeToDesktop();
    closed();
    await persistDAppConnection('https://a.app', {
      address: A,
      publicKey: 'pkA',
      connected: true,
      connectedAt: Date.now(),
      origin: 'https://a.app',
      permissions: [],
    });
    const status = await request('getConnectionStatus');
    expect(status.success).toBe(true);
    expect(status.data).toMatchObject({
      connected: false,
      isConnected: false,
      networkId: 'mainnet',
    });
    expect(status.data).not.toHaveProperty('address');
    expect(status.data.networkInfo.id).toBe('mainnet');
    for (const method of ['get_network_info', 'getNetworkInfo']) {
      const info = await request(method);
      expect(info.success).toBe(true);
      expect(info.data.id).toBe('mainnet');
    }
  });

  it('forwards the pre-connect reads while the session is up', async () => {
    routeToDesktop();
    const desk = fakeDesktop(async (args) => ({
      v: 1,
      result:
        args.request.method === 'getConnectionStatus'
          ? { connected: true, isConnected: true, address: A }
          : { id: 'mainnet', name: 'Mainnet' },
    }));
    holder.relay = makeRelay({}, desk).relay;
    const status = await request('getConnectionStatus');
    expect(status).toEqual({
      success: true,
      data: { connected: true, isConnected: true, address: A },
    });
    expect((await request('get_network_info')).data).toEqual({ id: 'mainnet', name: 'Mainnet' });
    expect(desk.sent('site_request').map((r) => r.request.method)).toEqual([
      'getConnectionStatus',
      'get_network_info',
    ]);
  });

  it('opens the connect review on its not reachable state, never a plain failure', async () => {
    routeToDesktop();
    closed();
    vi.mocked(approvalQueue.add).mockResolvedValue({ approved: false });
    const res = await request('connect');
    const shown = vi.mocked(approvalQueue.add).mock.calls[0][0] as Record<string, any>;
    expect(shown.signWith).toEqual({ available: false, pick: 'desktop', network: 'mainnet' });
    expect(typeof shown.routeDesktop).toBe('function');
    expect(res.error.code).toBe('USER_REJECTED');
  });

  it('opens the not reachable review when the desktop leaves during connect', async () => {
    routeToDesktop();
    const { relay, desk } = makeRelay();
    holder.relay = relay;
    vi.mocked(approvalQueue.add).mockResolvedValue({ approved: false });
    const pending = request('connect');
    await vi.waitFor(() => expect(desk.sent('site_request')).toHaveLength(1));
    desk.socket.close();
    await pending;
    const shown = vi.mocked(approvalQueue.add).mock.calls[0][0] as Record<string, any>;
    expect(shown.signWith).toMatchObject({ available: false, pick: 'desktop' });
  });

  it('never signs here for a desktop site, the desktop down', async () => {
    routeToDesktop();
    closed();
    for (const method of ['signMessage', 'send_transaction', 'getAddress', 'getBalance']) {
      const res = await request(method, { message: 'hi', to: A, amount: '1' });
      expect(res.error.code).toBe('NETWORK_ERROR');
    }
    expect(networkService.signMessage).not.toHaveBeenCalled();
    expect(msgApprovalQueue.add).not.toHaveBeenCalled();
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
    expect(walletStorage.loadVault).not.toHaveBeenCalled();
  });
});

describe('a desktop site after the extension switches network', () => {
  it('stays on 0xio Desktop on its own network', async () => {
    routeToDesktop();
    local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'devnet');
    const desk = fakeDesktop(async () => ({ v: 1, result: { signature: 'from-desktop' } }));
    holder.relay = makeRelay({}, desk).relay;
    const res = await request('signMessage', { message: 'hello' });
    expect(res).toEqual({ success: true, data: { signature: 'from-desktop' } });
    expect(desk.sent('site_request')[0].network).toBe('mainnet');
    expect(networkService.signMessage).not.toHaveBeenCalled();
  });

  it('follows the network the desktop last reported when it is on both', async () => {
    local.set(SITE_SIGNER_KEY, {
      'mainnet|https://a.app': 'desktop',
      'devnet|https://a.app': 'desktop',
    });
    local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'custom-node');
    const desk = fakeDesktop(async () => ({ v: 1, result: { address: A } }));
    holder.relay = makeRelay({}, desk).relay;
    await holder.relay.ensure(true);
    desk.emit({
      event: 'sites_snapshot',
      v: 1,
      sites: [
        {
          origin: 'https://a.app',
          network: 'mainnet',
          address: A,
          relayed_by: CLIENT_ID,
          connected_at: 1,
        },
        {
          origin: 'https://a.app',
          network: 'devnet',
          address: A,
          relayed_by: CLIENT_ID,
          connected_at: 2,
        },
      ],
    });
    await vi.waitFor(() => expect(holder.relay.knownSites).toHaveLength(2));
    await request('getAddress');
    expect(desk.sent('site_request')[0].network).toBe('devnet');
  });

  it('signs here when this browser has the choice or the connection on that network', async () => {
    holder.relay = makeRelay().relay;
    local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'devnet');
    local.set(SITE_SIGNER_KEY, {
      'mainnet|https://a.app': 'desktop',
      'devnet|https://a.app': 'browser',
    });
    expect((await request('getAddress')).error).toMatchObject({ code: 'NOT_CONNECTED' });

    local.set(SITE_SIGNER_KEY, { 'mainnet|https://a.app': 'desktop' });
    await persistDAppConnection('https://a.app', {
      address: A,
      publicKey: 'pkA',
      connected: true,
      connectedAt: Date.now(),
      origin: 'https://a.app',
      permissions: [],
    });
    expect(await request('getAddress')).toEqual({ success: true, data: { address: A } });
  });
});

describe('wallet protocol 2 through 0xio Desktop', () => {
  it('reads protocol, kind and capabilities from the auth_prove reply, with no probe', async () => {
    const two = makeRelay({}, fakeDesktop(undefined, protocol2()));
    expect(await two.relay.wallet()).toEqual({
      protocol: 2,
      kind: 'desktop',
      capabilities: CAPABILITIES,
    });
    expect(await two.relay.protocol()).toBe(2);
    expect(two.desk.sent('site_status')).toEqual([]);

    const legacy = makeRelay();
    expect(await legacy.relay.wallet()).toEqual({ protocol: 1, kind: 'desktop', capabilities: [] });
    expect(legacy.desk.sent('site_status')).toEqual([]);

    const closed = makeRelay({ open: async () => null });
    expect(await closed.relay.protocol()).toBe(1);
  });

  it('forgets the protocol on reconnect and reads it again from the new proof', async () => {
    const reply = { current: PROVE_2 as Record<string, unknown> };
    const sockets: ReturnType<typeof fakeDesktop>[] = [];
    const { relay } = makeRelay({
      open: async () => {
        const desk = fakeDesktop(undefined, (m) =>
          m === 'auth_prove' ? reply.current : undefined
        );
        sockets.push(desk);
        return desk.socket;
      },
    });
    expect(await relay.protocol()).toBe(2);
    reply.current = { v: 1, ok: true };
    sockets[0].socket.close();
    expect(relay.live).toBe(false);
    expect(await relay.protocol()).toBe(1);
    expect(sockets).toHaveLength(2);
  });

  it("answers a routed site's wallet_hello with the desktop's protocol, kind and capabilities", async () => {
    routeToDesktop();
    holder.relay = makeRelay({}, fakeDesktop(undefined, protocol2())).relay;
    expect(await request('wallet_hello', { protocols: [1, 2] })).toEqual({
      success: true,
      data: {
        protocol: 2,
        kind: 'desktop',
        capabilities: [
          'request_id',
          'request_status',
          'request_events',
          'idempotent',
          'wait_confirmed',
          'receipt',
          'can_sign',
          'kind',
        ],
      },
    });
    holder.relay = makeRelay().relay;
    expect(await request('wallet_hello', {})).toMatchObject({
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED' },
    });
    holder.relay = makeRelay({ open: async () => null }).relay;
    expect(await request('wallet_hello', {})).toMatchObject({
      error: { code: 'METHOD_NOT_ALLOWED' },
    });
  });

  it('forwards request_status and cancel_request for a routed site, origin from the sender', async () => {
    routeToDesktop();
    const held = { requestId: RID, status: 'review_open', seq: 3 };
    const desk = fakeDesktop(
      undefined,
      protocol2({ [RID]: held }, () => ({
        v: 1,
        ok: true,
        result: { ...held, status: 'rejected' },
      }))
    );
    holder.relay = makeRelay({}, desk).relay;
    const status = await request('request_status', { rid: RID, origin: 'https://evil.app' });
    expect(status).toEqual({ success: true, data: held });
    expect(desk.sent('site_status').slice(-1)[0]).toEqual({
      v: 1,
      rid: RID,
      origin: 'https://a.app',
    });
    const cancelled = await request('cancel_request', { rid: RID });
    expect(cancelled.data).toMatchObject({ requestId: RID, status: 'rejected' });
    expect(desk.sent('site_cancel')).toEqual([{ v: 1, rid: RID, origin: 'https://a.app' }]);
    expect(await request('request_status', { rid: 'nope' })).toMatchObject({
      error: { code: 'INVALID_PARAMS' },
    });
  });

  it('a cancel the desktop refuses (approved) answers the status after it', async () => {
    routeToDesktop();
    const desk = fakeDesktop(
      undefined,
      protocol2({ [RID]: { requestId: RID, status: 'signing', seq: 4 } }, () => ({
        v: 1,
        ok: false,
      }))
    );
    holder.relay = makeRelay({}, desk).relay;
    expect((await request('cancel_request', { rid: RID })).data).toMatchObject({
      status: 'signing',
    });
  });

  it('answers status here while the desktop is down or on protocol 1', async () => {
    routeToDesktop();
    holder.relay = makeRelay({ open: async () => null }).relay;
    expect((await request('request_status', { rid: RID })).data).toMatchObject({
      requestId: RID,
      status: 'unknown',
    });
    const old = fakeDesktop();
    holder.relay = makeRelay({}, old).relay;
    expect((await request('cancel_request', { rid: RID })).data).toMatchObject({
      status: 'unknown',
    });
    expect(old.sent('site_cancel')).toEqual([]);
  });

  it('passes the request id and status of a desktop answer to the site', async () => {
    routeToDesktop();
    const desk = fakeDesktop(
      async () => ({
        v: 1,
        rid: RID,
        status: 'expired',
        error: {
          code: 'USER_REJECTED',
          message: 'expired',
          details: { requestId: RID, status: 'expired', secret: 'x' },
        },
      }),
      protocol2()
    );
    holder.relay = makeRelay({}, desk).relay;
    expect(await request('signMessage', { message: 'hi' }, { v: 2, rid: RID })).toEqual({
      success: false,
      error: {
        code: 'USER_REJECTED',
        message: 'expired',
        details: { requestId: RID, status: 'expired' },
      },
      rid: RID,
      status: 'expired',
    });
  });

  it('a v2 request outlasts the review window and never cancels it; a v1 request still does', async () => {
    const timedOut = () => Promise.reject(new Error('site_request timed out'));
    const two = makeRelay({}, fakeDesktop(timedOut, protocol2()));
    const v2 = await two.relay.request(SITE, 'mainnet', { method: 'signMessage', rid: RID });
    expect(v2).toMatchObject({
      ok: false,
      error: { code: 'STATUS_UNKNOWN', details: { requestId: RID, status: 'unknown' } },
    });
    expect(two.desk.sent('site_cancel')).toEqual([]);
    const asked = two.desk.calls.find((c) => c.method === 'site_request')!;
    expect(asked.timeout).toBe(LIFECYCLE_TIMEOUT_MS);
    expect(LIFECYCLE_TIMEOUT_MS).toBeGreaterThan(5 * 60_000);

    const one = makeRelay({}, fakeDesktop(timedOut, protocol2()));
    const v1 = await one.relay.request(SITE, 'mainnet', { method: 'signMessage' });
    expect(v1).toMatchObject({ ok: false, error: { code: 'USER_REJECTED' } });
    expect(one.desk.sent('site_cancel')).toHaveLength(1);
    expect(one.desk.calls.find((c) => c.method === 'site_request')!.timeout).toBe(
      REQUEST_TIMEOUT_MS
    );

    const old = makeRelay({}, fakeDesktop(timedOut));
    await old.relay.request(SITE, 'mainnet', { method: 'signMessage', rid: RID });
    expect(old.desk.sent('site_cancel')).toHaveLength(1);
    expect(old.desk.sent('site_request')[0]).not.toHaveProperty('rid');
  });

  it('delivers request updates only to the tab and frame behind the tab_ref', async () => {
    const desk = fakeDesktop(undefined, protocol2());
    const { relay, deps } = makeRelay({}, desk);
    const pending = relay.request({ ...SITE, frameId: 3 }, 'mainnet', {
      method: 'signMessage',
      rid: RID,
    });
    await vi.waitFor(() => expect(desk.sent('site_request')).toHaveLength(1));
    const ref = desk.sent('site_request')[0].site.tab_ref;
    const update = { requestId: RID, status: 'review_open', seq: 2 };
    const event = (over: Record<string, unknown>) =>
      desk.emit({
        event: 'site_event',
        v: 1,
        origin: 'https://a.app',
        kind: 'request',
        data: update,
        ...over,
      });
    event({ tab_ref: ref });
    event({ tab_ref: 'cd'.repeat(16) });
    event({});
    event({ tab_ref: ref, origin: 'https://b.app' });
    event({ tab_ref: ref, data: { requestId: 'bad', status: 'review_open' } });
    await tick();
    expect(deps.deliverFrame).toHaveBeenCalledTimes(1);
    expect(deps.deliverFrame).toHaveBeenCalledWith(7, 3, 'https://a.app', {
      type: 'requestUpdate',
      data: update,
    });
    expect(deps.deliver).not.toHaveBeenCalled();
    relay.closeFrame(7, 3);
    event({ tab_ref: ref });
    await tick();
    expect(deps.deliverFrame).toHaveBeenCalledTimes(1);
    await pending;
  });

  it('maps the desktop request kind to requestUpdate and nothing malformed', () => {
    const data = { requestId: RID, status: 'confirmed', seq: 9 };
    expect(pageEvent('request', data)).toEqual({ type: 'requestUpdate', data });
    expect(pageEvent('request', { requestId: RID })).toBeNull();
    expect(pageEvent('request', null)).toBeNull();
  });
});

describe('a protocol 1 desktop', () => {
  it('gets no request id and its pages hear no request updates', async () => {
    const desk = fakeDesktop(async () => ({ v: 1, result: { signature: 's' } }));
    const { relay, deps } = makeRelay({}, desk);
    await relay.request(SITE, 'mainnet', { method: 'signMessage', rid: RID });
    expect(desk.sent('site_request')[0]).not.toHaveProperty('rid');
    const ref = desk.sent('site_request')[0].site.tab_ref;
    desk.emit({
      event: 'site_event',
      v: 1,
      origin: 'https://a.app',
      kind: 'request',
      tab_ref: ref,
      data: { requestId: RID, status: 'review_open', seq: 2 },
    });
    await tick();
    expect(deps.deliverFrame).not.toHaveBeenCalled();
  });
});
