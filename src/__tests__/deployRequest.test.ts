import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const W = 'octWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';
const C1 = 'octCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const CODE = btoa('contract code bytes');

const vault = [
  { id: 'id-a', name: 'A', address: A, publicKey: 'pkA', privateKey: 'skA', type: 'standard' },
  { id: 'id-b', name: 'B', address: B, publicKey: 'pkB', privateKey: 'skB', type: 'standard' },
  { id: 'id-w', name: 'W', address: W, publicKey: null, privateKey: null, type: 'watch' },
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
  },
}));
vi.mock('../services/network/NetworkService', () => ({
  networkService: {},
  privacyNetworkService: {},
}));
vi.mock('../services/pvac/PvacManager', () => ({ pvacManager: {} }));
vi.mock('../background/services/txQueue', () => ({ txQueue: {} }));
vi.mock('../background/services/balance', () => ({ refreshAndBroadcastBalance: vi.fn() }));
vi.mock('../services/contracts/contractDeploy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/contracts/contractDeploy')>()),
  liveDeployOu: vi.fn(async (_b: string, _at: unknown, requested?: bigint | null) =>
    requested != null && requested >= 201000n ? requested : 201000n
  ),
  deployFeeError: vi.fn(async (): Promise<string | null> => null),
  previewDeploy: vi.fn(async () => ({ nonce: 5, contractAddress: C1 })),
  submitDeploy: vi.fn(async () => ({ txHash: 'h1', contractAddress: C1 })),
}));

import { txApprovalQueue } from '../background/services/approvals';
import {
  deployFeeError,
  liveDeployOu,
  previewDeploy,
  submitDeploy,
} from '../services/contracts/contractDeploy';
import { dappConnections, persistDAppConnection } from '../background/services/dappConnections';
import { handleDAppRequest } from '../background/handlers/dappRequest';

const local = new Map<string, unknown>();

beforeEach(() => {
  local.clear();
  dappConnections.clear();
  state.active = A;
  local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, A);
  local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'mainnet');
  vi.mocked(txApprovalQueue.add).mockReset();
  vi.mocked(submitDeploy).mockClear();
  vi.mocked(previewDeploy).mockClear();
  vi.mocked(liveDeployOu).mockClear();
  vi.mocked(deployFeeError).mockClear();
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

describe('deploy_contract from a site', () => {
  it('needs a connected site and shows nothing before that', async () => {
    const res = await request('deploy_contract', { bytecode: CODE });
    expect(res.error.code).toBe('NOT_CONNECTED');
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
    expect(submitDeploy).not.toHaveBeenCalled();
  });

  it('refuses bad params before any review', async () => {
    await connect('https://a.app', A);
    const res = await request('deploy_contract', { bytecode: 'not base64!' });
    expect(res.error.code).toBe('INVALID_PARAMS');
    const fee = await request('deployContract', { bytecode: CODE, ou: '50000001' });
    expect(fee.error.code).toBe('INVALID_PARAMS');
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
  });

  it('sends nothing when the review is rejected', async () => {
    await connect('https://a.app', A);
    vi.mocked(txApprovalQueue.add).mockResolvedValue({ approved: false });
    const res = await request('deploy_contract', { bytecode: CODE });
    expect(res.error.code).toBe('USER_REJECTED');
    expect(submitDeploy).not.toHaveBeenCalled();
  });

  it('reviews the predicted address and live fee, then deploys what was reviewed', async () => {
    await connect('https://a.app', A);
    vi.mocked(txApprovalQueue.add).mockResolvedValue({ approved: true });
    const res = await request('deploy_contract', [{ bytecode: CODE, params: '["x"]' }]);

    const shown = vi.mocked(txApprovalQueue.add).mock.calls[0][0] as any;
    expect(shown).toMatchObject({
      methods: 'deploy_contract',
      origin: 'https://a.app',
      walletAddress: A,
      networkId: 'mainnet',
      params: {
        codeBytes: 'contract code bytes'.length,
        contractAddress: C1,
        constructorParams: '["x"]',
        ou: '201000',
      },
    });
    expect(JSON.stringify(shown)).not.toContain(CODE);

    const sent = vi.mocked(submitDeploy).mock.calls[0][0];
    expect(sent).toMatchObject({
      privateKey: 'skA',
      bytecodeB64: CODE,
      constructorParams: '["x"]',
      ou: 201000n,
      reviewed: { nonce: 5, contractAddress: C1 },
    });
    expect(sent.scope.address).toBe(A);
    expect(res).toEqual({
      success: true,
      data: { txHash: 'h1', contractAddress: C1, success: true },
    });
  });

  it('uses the fee the site set when the node takes it, else the live one', async () => {
    await connect('https://a.app', A);
    vi.mocked(txApprovalQueue.add).mockResolvedValue({ approved: true });
    await request('deploy_contract', { bytecode: CODE, ou: 300000 });
    expect(vi.mocked(liveDeployOu).mock.calls[0][2]).toBe(300000n);
    expect(vi.mocked(submitDeploy).mock.calls[0][0].ou).toBe(300000n);
    await request('deploy_contract', { bytecode: CODE, ou: 1000 });
    expect(vi.mocked(submitDeploy).mock.calls[1][0].ou).toBe(201000n);
  });

  it('refuses before any review when the fee cannot be read', async () => {
    await connect('https://a.app', A);
    vi.mocked(liveDeployOu).mockResolvedValueOnce(null);
    const res = await request('deploy_contract', { bytecode: CODE });
    expect(res.error).toEqual({
      code: 'NETWORK_ERROR',
      message: 'Network fee unavailable. Try again.',
    });
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
    expect(submitDeploy).not.toHaveBeenCalled();
  });

  it('signs nothing when the live minimum rose above the reviewed fee', async () => {
    await connect('https://a.app', A);
    vi.mocked(txApprovalQueue.add).mockResolvedValue({ approved: true });
    vi.mocked(deployFeeError).mockResolvedValueOnce('The network fee changed. Review again.');
    const res = await request('deploy_contract', { bytecode: CODE });
    expect(res.error).toEqual({
      code: 'FEE_CHANGED',
      message: 'The network fee changed. Review again.',
    });
    expect(submitDeploy).not.toHaveBeenCalled();
  });

  it('refuses a different wallet picked on the review', async () => {
    await connect('https://a.app', A);
    vi.mocked(txApprovalQueue.add).mockResolvedValue({ approved: true, selectedAddress: B });
    const res = await request('deploy_contract', { bytecode: CODE });
    expect(res.success).toBe(false);
    expect(submitDeploy).not.toHaveBeenCalled();
  });

  it('refuses when the network moved during the review', async () => {
    await connect('https://a.app', A);
    vi.mocked(txApprovalQueue.add).mockImplementation(async () => {
      local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'devnet');
      return { approved: true };
    });
    const res = await request('deploy_contract', { bytecode: CODE });
    expect(res.error.code).toBe('NETWORK_CHANGED');
    expect(submitDeploy).not.toHaveBeenCalled();
  });

  it('refuses a watch-only wallet', async () => {
    await connect('https://w.app', W);
    vi.mocked(txApprovalQueue.add).mockResolvedValue({ approved: true });
    const res = await request('deploy_contract', { bytecode: CODE }, 'https://w.app');
    expect(res.error).toEqual({
      code: 'WATCH_ONLY',
      message: 'This wallet is watch-only and cannot sign.',
    });
    expect(submitDeploy).not.toHaveBeenCalled();
  });
});
