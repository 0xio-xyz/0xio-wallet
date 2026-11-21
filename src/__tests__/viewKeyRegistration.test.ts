import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const node = vi.hoisted(() => ({
  view: null as string | null,
  pvac: null as string | null,
  balanceRaw: '1000000000' as string,
  failReads: false,
  txStatus: 'pending',
  calls: [] as string[],
}));

vi.mock('../background/services/wallet', () => ({
  getActiveWallet: vi.fn(async () => ({ id: 'id-a', address: A, publicKey: 'pkA', name: 'A' })),
  waitForWalletUnlock: vi.fn(async () => null),
}));
vi.mock('../background/services/approvals', () => ({
  approvalQueue: { add: vi.fn() },
  txApprovalQueue: { add: vi.fn(async () => ({ approved: true })) },
  msgApprovalQueue: { add: vi.fn() },
  hasPendingApproval: vi.fn(() => false),
}));
vi.mock('../services/crypto/PasswordManager', () => ({
  passwordManager: { getSessionKey: vi.fn(async () => 'session-key') },
}));
vi.mock('../services/wallet/WalletStorage', () => ({
  walletStorage: {
    loadVault: vi.fn(async () => [
      { id: 'id-a', address: A, publicKey: 'pkA', privateKey: 'skA', type: 'standard' },
    ]),
    loadAllWallets: vi.fn(async () => [{ id: 'id-a', address: A, publicKey: 'pkA', name: 'A' }]),
    setActiveWallet: vi.fn(async () => null),
  },
}));
vi.mock('../services/network/NetworkService', () => ({
  networkService: {
    jsonRpcCall: vi.fn(async (method: string) => {
      node.calls.push(method);
      if (node.failReads) throw new Error('503');
      if (method === 'octra_viewPubkey') return { view_pubkey: node.view };
      if (method === 'octra_balance') return { balance_raw: node.balanceRaw };
      if (method === 'octra_transaction') return { status: node.txStatus };
      throw new Error(`unexpected ${method}`);
    }),
    getRecommendedFeeStrict: vi.fn(async () => ({ minimum: '5000', recommended: '20000' })),
    releaseNonce: vi.fn(),
  },
  privacyNetworkService: {
    getPvacPubkey: vi.fn(async () => {
      if (node.failReads) throw new Error('503');
      return node.pvac;
    }),
    getKeySwitchFeeQuote: vi.fn(async () => '20000'),
    signKeySwitch: vi.fn(
      async (from: string, _k: string, _s: string, _p: string, _m, _t, ou, scope) => ({
        signedTx: { from, to_: from, amount: '0', nonce: 4, ou, op_type: 'key_switch' },
        nonce: 4,
        scope,
      })
    ),
  },
}));
vi.mock('../services/pvac/PvacManager', () => ({
  pvacManager: {
    ensureOffscreenReady: vi.fn(async () => {}),
    getPublicKeyAsync: vi.fn(async () => 'pvac-local'),
  },
}));
vi.mock('../background/services/txQueue', () => ({
  txQueue: {
    add: vi.fn(async () => ({
      txId: 't1',
      broadcastResult: Promise.resolve({ success: true, txHash: 'k'.repeat(64) }),
    })),
  },
}));
vi.mock('../background/services/balance', () => ({ refreshAndBroadcastBalance: vi.fn() }));

import { txApprovalQueue } from '../background/services/approvals';
import { txQueue } from '../background/services/txQueue';
import { privacyNetworkService } from '../services/network/NetworkService';
import { dappConnections, persistDAppConnection } from '../background/services/dappConnections';
import { getPendingKeySwitch, recordPendingKeySwitch } from '../services/pvac/keySwitchService';
import { handleDAppRequest } from '../background/handlers/dappRequest';

const local = new Map<string, unknown>();

beforeEach(() => {
  local.clear();
  dappConnections.clear();
  Object.assign(node, {
    view: null,
    pvac: null,
    balanceRaw: '1000000000',
    failReads: false,
    txStatus: 'pending',
    calls: [],
  });
  vi.mocked(txApprovalQueue.add).mockClear();
  vi.mocked(txQueue.add).mockClear();
  vi.mocked(privacyNetworkService.signKeySwitch).mockClear();
  local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, A);
  local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'devnet');
  (chrome.runtime as any).getManifest = () => ({ version: '3.0.6' });
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
  (chrome as any).tabs.sendMessage = vi.fn(async () => {});
});

const connect = (permissions: string[] = ['private_transfers']) =>
  persistDAppConnection('https://a.app', {
    origin: 'https://a.app',
    address: A,
    connected: true,
    connectedAt: Date.now(),
    permissions,
  });

const register = (params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) =>
    handleDAppRequest(
      { method: 'register_private_view_key', params },
      { origin: 'https://a.app', tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender,
      resolve
    )
  );

const noNodeWrites = () => {
  for (const m of node.calls) expect(m).not.toMatch(/register/i);
};

describe('register_private_view_key', () => {
  it('refuses another address with INVALID_PARAMS before any review or permission check', async () => {
    await connect([]);
    expect(await register({ address: B })).toMatchObject({
      success: false,
      error: { code: 'INVALID_PARAMS' },
    });
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
  });

  it('keeps the private_transfers permission for the own address', async () => {
    await connect(['accounts']);
    expect(await register({ address: A })).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
  });

  it('completes at once for a registered account: no review, nothing signed', async () => {
    await connect();
    Object.assign(node, { view: 'view-pk', pvac: 'pvac-local' });
    expect(await register({ address: A })).toEqual({
      success: true,
      data: { status: 'registered', view_pubkey: 'view-pk', pvac: true },
    });
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
    expect(privacyNetworkService.signKeySwitch).not.toHaveBeenCalled();
    noNodeWrites();
  });

  it('reviews the live key_switch fee, then submits the empty key_switch', async () => {
    await connect();
    Object.assign(node, { view: null, pvac: null });
    const res = await register({ address: A });
    expect(vi.mocked(txApprovalQueue.add).mock.calls[0][0]).toMatchObject({
      methods: 'register_private_view_key',
      params: { address: A, ou: '20000' },
    });
    expect(privacyNetworkService.signKeySwitch).toHaveBeenCalledWith(
      A,
      'pvac-local',
      'skA',
      'pkA',
      undefined,
      'recommended',
      '20000',
      expect.objectContaining({ address: A, networkId: 'devnet' })
    );
    expect(vi.mocked(txQueue.add).mock.calls[0][0]).toMatchObject({
      opType: 'key_switch',
      type: 'broadcast_only',
    });
    expect(res).toMatchObject({
      success: true,
      data: { status: 'submitted', txHash: 'k'.repeat(64) },
    });
    expect(await getPendingKeySwitch({ networkId: 'devnet', address: A })).toBeTruthy();
    noNodeWrites();
  });

  it('completes for a registered account even with a registration flagged pending', async () => {
    await connect();
    await recordPendingKeySwitch({ networkId: 'devnet', address: A }, 'old');
    Object.assign(node, { view: 'view-pk', pvac: 'pvac-local' });
    expect(await register({ address: A })).toMatchObject({ data: { status: 'registered' } });
  });

  it('refuses a second registration before the first confirms, then clears it once the chain settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await connect();
      expect(await register({ address: A })).toMatchObject({ data: { status: 'submitted' } });
      node.balanceRaw = '0';
      expect(await register({ address: A })).toMatchObject({
        error: { code: 'REGISTRATION_PENDING' },
      });
      expect(txApprovalQueue.add).toHaveBeenCalledTimes(1);
      node.txStatus = 'confirmed';
      await vi.advanceTimersByTimeAsync(5000);
      expect(await getPendingKeySwitch({ networkId: 'devnet', address: A })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a balance below the fee before any review', async () => {
    await connect();
    node.balanceRaw = '19999';
    expect(await register({ address: A })).toMatchObject({
      error: { code: 'INSUFFICIENT_BALANCE' },
    });
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
  });

  it('never registers over another PVAC key, and never reads a node error as no key', async () => {
    await connect();
    Object.assign(node, { view: 'view-pk', pvac: 'pvac-other' });
    expect(await register({ address: A })).toMatchObject({ error: { code: 'PVAC_KEY_MISMATCH' } });
    node.failReads = true;
    expect(await register({ address: A })).toMatchObject({ error: { code: 'NETWORK_ERROR' } });
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
  });
});

describe('another review of the site is open', () => {
  it('reads RATE_LIMIT_EXCEEDED with review_pending for a protocol 2 site, REQUEST_PENDING for an older one', async () => {
    await connect();
    const { hasPendingApproval } = await import('../background/services/approvals');
    vi.mocked(hasPendingApproval).mockReturnValue(true);
    const ask = (extra: Record<string, unknown>) =>
      new Promise<any>((resolve) =>
        handleDAppRequest(
          { method: 'switch_network', params: { networkId: 'mainnet' }, ...extra },
          { origin: 'https://a.app', tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender,
          resolve
        )
      );
    try {
      const v2 = await ask({ v: 2, rid: 'c'.repeat(32) });
      expect(v2).toMatchObject({
        success: false,
        rid: 'c'.repeat(32),
        error: { code: 'RATE_LIMIT_EXCEEDED', details: { reason: 'review_pending' } },
      });
      expect(v2.error.details.requestId).not.toBe('c'.repeat(32));
      expect((await ask({})).error.code).toBe('REQUEST_PENDING');
    } finally {
      vi.mocked(hasPendingApproval).mockReturnValue(false);
    }
  });
});
