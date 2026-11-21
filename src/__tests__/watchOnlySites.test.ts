import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const W = 'octWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';
const K = 'octKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK';
const C = 'octCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

const WATCH_ONLY = { code: 'WATCH_ONLY', message: 'This wallet is watch-only and cannot sign.' };

const vault = [
  { id: 'id-a', name: 'A', address: A, publicKey: 'pkA', privateKey: 'skA', type: 'standard' },
  { id: 'id-b', name: 'B', address: B, publicKey: 'pkB', privateKey: 'skB', type: 'standard' },
  { id: 'id-w', name: 'W', address: W, publicKey: null, privateKey: null, type: 'watch' },
  { id: 'id-k', name: 'K', address: K, publicKey: null, privateKey: 'skK', type: 'standard' },
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
    setActiveWallet: vi.fn(),
  },
}));
vi.mock('../services/network/NetworkService', () => ({
  networkService: {
    signMessage: vi.fn(async () => 'sig'),
    getRecommendedFee: vi.fn(async () => ({ recommended: '1000' })),
    getRecommendedFeeStrict: vi.fn(async () => ({ recommended: '1000' })),
  },
  privacyNetworkService: {},
}));
vi.mock('../services/pvac/PvacManager', () => ({
  pvacManager: { ensureOffscreenReady: vi.fn() },
}));
vi.mock('../background/services/txQueue', () => ({ txQueue: {} }));
vi.mock('../background/services/balance', () => ({ refreshAndBroadcastBalance: vi.fn() }));
vi.mock('../services/contracts/contractDeploy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/contracts/contractDeploy')>()),
  liveDeployOu: vi.fn(async () => 201000n),
  previewDeploy: vi.fn(async () => ({ nonce: 5, contractAddress: C })),
  submitDeploy: vi.fn(),
}));

import { approvalQueue, msgApprovalQueue, txApprovalQueue } from '../background/services/approvals';
import { walletStorage } from '../services/wallet/WalletStorage';
import { pvacManager } from '../services/pvac/PvacManager';
import {
  dappConnections,
  moveConnections,
  persistDAppConnection,
} from '../background/services/dappConnections';
import { handleDAppRequest } from '../background/handlers/dappRequest';
import { canSignAddress, walletCanSign } from '../background/services/signingKey';

const local = new Map<string, unknown>();
const sent: any[] = [];
const ALL_PERMISSIONS = ['private_transfers', 'private_claims', 'private_proofs'];

beforeEach(() => {
  local.clear();
  sent.length = 0;
  dappConnections.clear();
  state.active = W;
  local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, W);
  local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'mainnet');
  vi.mocked(approvalQueue.add).mockReset().mockResolvedValue({ approved: true });
  vi.mocked(txApprovalQueue.add).mockReset().mockResolvedValue({ approved: true });
  vi.mocked(msgApprovalQueue.add).mockReset().mockResolvedValue({ approved: true });
  vi.mocked(pvacManager.ensureOffscreenReady).mockClear();
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
  (chrome as any).runtime.getManifest = () => ({ version: '3.0.3' });
  (chrome as any).tabs.query = vi.fn((_q: unknown, cb?: (tabs: any[]) => void) =>
    cb?.([{ id: 7, url: 'https://a.app/page' }])
  );
  (chrome as any).tabs.sendMessage = vi.fn(async (_tabId: number, msg: any) => {
    sent.push(msg);
  });
  (chrome as any).tabs.get = vi.fn(async () => {
    throw new Error('no tab');
  });
});

const connect = (origin: string, address?: string, permissions: string[] = []) =>
  persistDAppConnection(origin, {
    origin,
    address,
    publicKey: vault.find((w) => w.address === address)?.publicKey ?? null,
    connected: true,
    connectedAt: Date.now(),
    permissions,
  });

const request = (method: string, params: unknown = {}, origin = 'https://a.app') =>
  new Promise<any>((resolve) =>
    handleDAppRequest({ method, params }, { origin } as chrome.runtime.MessageSender, resolve)
  );

describe('canSign on connection payloads', () => {
  it('is false for a watch-only wallet and true for one with a key on a new connect', async () => {
    const watch = await request('connect');
    expect(watch.success).toBe(true);
    expect(watch.data.canSign).toBe(false);
    expect(watch.data.publicKey).toBeNull();

    state.active = A;
    local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, A);
    const own = await request('connect', {}, 'https://b.app');
    expect(own.data.canSign).toBe(true);
  });

  it('follows the wallet picked on the connect review', async () => {
    vi.mocked(approvalQueue.add).mockResolvedValue({ approved: true, selectedAddress: A });
    const res = await request('connect');
    expect(res.data.address).toBe(A);
    expect(res.data.canSign).toBe(true);
  });

  it('is on the reconnect answer of a site already connected', async () => {
    await connect('https://a.app', W);
    const res = await request('connect');
    expect(approvalQueue.add).not.toHaveBeenCalled();
    expect(res.data.address).toBe(W);
    expect(res.data.canSign).toBe(false);

    await connect('https://b.app', A);
    expect((await request('connect', {}, 'https://b.app')).data.canSign).toBe(true);
  });

  it('is on getConnectionStatus and getWalletInfo, and absent when not connected', async () => {
    await connect('https://a.app', W);
    const status = await request('getConnectionStatus');
    expect(status.data.isConnected).toBe(true);
    expect(status.data.canSign).toBe(false);
    expect((await request('getWalletInfo')).data.canSign).toBe(false);

    await connect('https://b.app', A);
    expect((await request('getConnectionStatus', {}, 'https://b.app')).data.canSign).toBe(true);

    const none = await request('getConnectionStatus', {}, 'https://never.app');
    expect(none.data.isConnected).toBe(false);
    expect(none.data.canSign).toBeUndefined();
  });

  it('falls back to the public key when the vault cannot be read', async () => {
    vi.mocked(walletStorage.loadAllWallets).mockResolvedValueOnce([]);
    expect(await canSignAddress(W, null)).toBe(false);
    vi.mocked(walletStorage.loadAllWallets).mockRejectedValueOnce(new Error('locked'));
    expect(await canSignAddress(A, 'pkA')).toBe(true);
  });

  it('treats a missing key as watch-only too', () => {
    expect(walletCanSign(vault[0])).toBe(true);
    expect(walletCanSign(vault[2])).toBe(false);
    expect(walletCanSign({ type: 'standard', privateKey: null })).toBe(false);
    expect(walletCanSign({ type: 'watch', privateKey: 'stray' })).toBe(false);
    expect(walletCanSign(undefined)).toBe(false);
  });
});

describe('the accountChanged event', () => {
  it('carries canSign for the wallet the site moved to', async () => {
    await connect('https://a.app', A);
    await moveConnections(['https://a.app'], { address: W, publicKey: null });
    await moveConnections(['https://a.app'], { address: B, publicKey: 'pkB' });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0].eventData).toEqual({
      type: 'accountChanged',
      data: { address: W, publicKey: null, canSign: false },
    });
    expect(sent[1].eventData.data).toEqual({ address: B, publicKey: 'pkB', canSign: true });
  });
});

describe('every refusal of a watch-only wallet', () => {
  const site = 'https://w.app';
  beforeEach(() => connect(site, W, ALL_PERMISSIONS));

  const cases: [string, unknown][] = [
    ['send_transaction', { to: A, amount: '1' }],
    ['sendTransaction', { to: A, amount: '1' }],
    ['call_contract', { contract: C, method: 'swap', params: [] }],
    ['deploy_contract', { bytecode: btoa('contract code bytes') }],
    ['signMessage', { message: 'hello' }],
    ['sign_transaction', { to: A, amount: '1' }],
    ['send_contract_transaction_sequence', { transactions: [{ contract: C, method: 'swap' }] }],
    ['register_private_view_key', {}],
    ['send_private_transfer', { to: A, amount_raw: '1', ou: '1000' }],
    ['claim_private_transfer', { transferId: 't1' }],
    ['encrypt_value', { value: 1 }],
    ['make_zero_proof', { value: 0 }],
  ];

  it.each(cases)('%s answers WATCH_ONLY', async (method, params) => {
    const res = await request(method, params, site);
    expect(res.success).toBe(false);
    expect(res.error).toEqual(WATCH_ONLY);
    expect(pvacManager.ensureOffscreenReady).not.toHaveBeenCalled();
  });

  it('a watch-only pick on a review answers WATCH_ONLY', async () => {
    await connect('https://a.app', A);
    state.active = A;
    vi.mocked(msgApprovalQueue.add).mockResolvedValue({ approved: true, selectedAddress: W });
    const res = await request('signMessage', { message: 'hello' });
    expect(res.error).toEqual(WATCH_ONLY);
  });

  it('a site whose wallet left the vault while it signed is told to connect again', async () => {
    await connect('https://a.app', A);
    state.active = A;
    vi.mocked(walletStorage.loadVault).mockResolvedValueOnce(
      structuredClone(vault.filter((w) => w.address !== A)) as any
    );
    const res = await request('signMessage', { message: 'hello' });
    expect(res.error.code).toBe('NOT_CONNECTED');
  });
});

describe('getPublicKey', () => {
  it('answers WATCH_ONLY for a watch-only wallet', async () => {
    await connect('https://a.app', W);
    const res = await request('getPublicKey');
    expect(res.error).toEqual(WATCH_ONLY);
  });

  it('answers NOT_AVAILABLE when a wallet with a key has no public key yet', async () => {
    await connect('https://a.app', K);
    state.active = K;
    const res = await request('getPublicKey');
    expect(res.error.code).toBe('NOT_AVAILABLE');
  });

  it('returns the key of a wallet that has one', async () => {
    await connect('https://a.app', A);
    state.active = A;
    expect((await request('getPublicKey')).data.publicKey).toBe('pkA');
  });
});
