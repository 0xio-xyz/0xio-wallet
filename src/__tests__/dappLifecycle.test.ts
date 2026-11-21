import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const vault = [
  { id: 'id-a', name: 'A', address: A, publicKey: 'pkA', privateKey: 'skA', type: 'standard' },
];

vi.mock('../background/services/wallet', () => ({
  getActiveWallet: vi.fn(async () => ({ id: 'id-a', address: A, publicKey: 'pkA', name: 'A' })),
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
    setActiveWallet: vi.fn(async () => null),
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
import { dappConnections, persistDAppConnection } from '../background/services/dappConnections';
import { handleDAppRequest } from '../background/handlers/dappRequest';
import { isEvmMethod } from '../background/handlers/evmRequest';

const local = new Map<string, unknown>();
const events: { tabId: number; frameId?: number; msg: any }[] = [];
let n = 0;
const newRid = () => (++n).toString(16).padStart(32, '0');

beforeEach(() => {
  local.clear();
  events.length = 0;
  dappConnections.clear();
  local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, A);
  local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'devnet');
  vi.mocked(msgApprovalQueue.add).mockReset();
  (chrome.runtime as any).getManifest = () => ({ version: '3.0.4' });
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
  (chrome as any).tabs.query = vi.fn((_q: unknown, cb?: (tabs: any[]) => void) => cb?.([]));
  (chrome as any).tabs.sendMessage = vi.fn(async (tabId: number, msg: any, opts?: any) => {
    events.push({ tabId, frameId: opts?.frameId, msg });
  });
  (chrome as any).tabs.get = vi.fn(async () => {
    throw new Error('no tab');
  });
});

const connect = (origin: string) =>
  persistDAppConnection(origin, {
    origin,
    address: A,
    connected: true,
    connectedAt: Date.now(),
    permissions: [],
  });

const call = (
  method: string,
  params: unknown,
  extra: Record<string, unknown> = {},
  origin = 'https://a.app',
  tabId = 7,
  frameId = 0
) =>
  new Promise<any>((resolve) =>
    handleDAppRequest(
      { method, params, ...extra },
      { origin, tab: { id: tabId }, frameId } as chrome.runtime.MessageSender,
      resolve
    )
  );

function heldApproval() {
  let answer: (a: unknown) => void = () => {};
  vi.mocked(msgApprovalQueue.add).mockImplementation(async (req: any) => {
    await req.review?.shown();
    const result = await new Promise((r) => (answer = r));
    await req.review?.answered((result as any).approved === true);
    return result as any;
  });
  return { answer: (approved: boolean) => answer({ approved }) };
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const updates = () =>
  events.filter((e) => e.msg?.eventData?.type === 'requestUpdate').map((e) => e.msg.eventData.data);

describe('wallet protocol 2 in the dApp handler', () => {
  it('routes wallet_hello to the Octra handler, not the EVM one', () => {
    expect(isEvmMethod('wallet_hello')).toBe(false);
    expect(isEvmMethod('wallet_switchEthereumChain')).toBe(true);
  });

  it('answers wallet_hello for any page, with the build and nothing about the user', async () => {
    const res = await call(
      'wallet_hello',
      { sdk: '2.12.0', protocols: [1, 2] },
      {},
      'https://x.app'
    );
    expect(res).toEqual({
      success: true,
      data: {
        protocol: 2,
        kind: 'extension',
        version: '3.0.4',
        capabilities: [
          'announce',
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
  });

  it('signs once for a repeated id, tells only the requesting frame, and keeps the outcome', async () => {
    await connect('https://a.app');
    const rid = newRid();
    const held = heldApproval();
    const first = call('signMessage', { message: 'hi' }, { v: 2, rid }, 'https://a.app', 7, 2);
    await flush();
    const status = await call('request_status', { rid });
    expect(status.data).toMatchObject({ requestId: rid, status: 'review_open', network: 'devnet' });

    const again = call('signMessage', { message: 'hi' }, { v: 2, rid }, 'https://a.app', 7, 2);
    await flush();
    expect(msgApprovalQueue.add).toHaveBeenCalledTimes(1);
    held.answer(true);
    const [a, b] = await Promise.all([first, again]);
    expect(a).toMatchObject({ success: true, data: { signature: 'signed-by-skA' }, rid });
    expect(b).toEqual(a);
    expect(a.status).toBe('completed');

    await flush();
    expect(updates().map((u) => u.status)).toEqual(['pending', 'review_open', 'completed']);
    for (const e of events) {
      expect(e).toMatchObject({ tabId: 7, frameId: 2, msg: { origin: 'https://a.app' } });
    }
    const later = await call('signMessage', { message: 'hi' }, { v: 2, rid });
    expect(later).toMatchObject({ success: true, data: { signature: 'signed-by-skA' } });
    expect(msgApprovalQueue.add).toHaveBeenCalledTimes(1);
  });

  it('refuses another request under a used id before any review', async () => {
    await connect('https://a.app');
    const rid = newRid();
    vi.mocked(msgApprovalQueue.add).mockResolvedValue({ approved: false });
    const rejected = await call('signMessage', { message: 'one' }, { v: 2, rid });
    expect(rejected).toMatchObject({ error: { code: 'USER_REJECTED' }, status: 'rejected' });
    const reused = await call('signMessage', { message: 'two' }, { v: 2, rid });
    expect(reused).toMatchObject({ error: { code: 'REQUEST_ID_REUSED' } });
    const repeat = await call('signMessage', { message: 'one' }, { v: 2, rid });
    expect(repeat).toMatchObject({ error: { code: 'USER_REJECTED' }, status: 'rejected' });
    expect(msgApprovalQueue.add).toHaveBeenCalledTimes(1);
  });

  it('keeps one site out of another site request', async () => {
    await connect('https://a.app');
    await connect('https://b.app');
    const rid = newRid();
    vi.mocked(msgApprovalQueue.add).mockResolvedValue({ approved: true });
    await call('signMessage', { message: 'a' }, { v: 2, rid });
    const peek = await call('request_status', { rid }, {}, 'https://b.app', 9);
    expect(peek.data).toMatchObject({ requestId: rid, status: 'unknown' });
    const own = await call('signMessage', { message: 'b' }, { v: 2, rid }, 'https://b.app', 9);
    expect(own).toMatchObject({ success: true });
    expect(msgApprovalQueue.add).toHaveBeenCalledTimes(2);
  });

  it('leaves an old site exactly as before', async () => {
    await connect('https://a.app');
    vi.mocked(msgApprovalQueue.add).mockResolvedValue({ approved: true });
    const res = await call('signMessage', { message: 'hi' });
    expect(res).toEqual({ success: true, data: { signature: 'signed-by-skA' } });
    await flush();
    expect(updates()).toEqual([]);
  });

  it('refuses a malformed request id', async () => {
    await connect('https://a.app');
    const res = await call('signMessage', { message: 'hi' }, { v: 2, rid: 'nope' });
    expect(res).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } });
    expect(msgApprovalQueue.add).not.toHaveBeenCalled();
  });

  it('lets a site cancel its own review before an answer', async () => {
    await connect('https://a.app');
    const rid = newRid();
    vi.mocked(msgApprovalQueue.add).mockImplementation(async (req: any) => {
      await req.review?.shown();
      return new Promise((resolve) =>
        req.review.onPageGone(() => resolve({ approved: false, error: 'closed' }))
      ) as any;
    });
    const pending = call('signMessage', { message: 'hi' }, { v: 2, rid });
    await flush();
    const cancelled = await call('cancel_request', { rid });
    expect(cancelled.data).toMatchObject({ requestId: rid, status: 'rejected' });
    expect(await pending).toMatchObject({ error: { code: 'USER_REJECTED' } });
  });
});
