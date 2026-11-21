import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';
import { computeTxHash } from 'src/utils/octra/txHash';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const q = vi.hoisted(() => ({
  outcome: { success: false } as Record<string, unknown>,
  submit: [] as unknown[],
  privateResult: {} as Record<string, unknown>,
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
vi.mock('../services/network/NetworkService', () => {
  const signed = (tx: Record<string, unknown>) => ({
    ...tx,
    timestamp: 1762300000.5,
    signature: 'c2lnbmF0dXJl',
    public_key: 'pkA',
  });
  return {
    networkService: {
      buildAndSignTransaction: vi.fn(async (p: any) =>
        signed({
          from: p.from,
          to_: p.to,
          amount: String(p.amount),
          nonce: p.nonce,
          ou: p.ou,
          op_type: 'standard',
        })
      ),
      buildContractCallTransaction: vi.fn(async (p: any) =>
        signed({
          from: p.from,
          to_: p.contract,
          amount: String(p.amount),
          nonce: p.nonce,
          ou: p.ou,
          op_type: 'call',
          encrypted_data: p.method,
          message: p.rawMessage,
        })
      ),
      getNextNonce: vi.fn(async () => 3),
      getRecommendedFeeStrict: vi.fn(async () => ({ minimum: '1000', recommended: '10000' })),
      jsonRpcCall: vi.fn(async (_m: string, params: unknown[]) => {
        const next = q.submit.shift();
        if (next instanceof Error) throw next;
        return next ?? { tx_hash: computeTxHashOf(params[0]) };
      }),
    },
    privacyNetworkService: {
      privateSpendBlocker: vi.fn(async () => null),
      createPrivateTransfer: vi.fn(async () => q.privateResult),
    },
  };
});
vi.mock('../background/services/txQueue', () => ({
  txQueue: {
    add: vi.fn(async () => ({ txId: 't1', broadcastResult: Promise.resolve(q.outcome) })),
  },
}));
vi.mock('../services/pvac/PvacManager', () => ({ pvacManager: {} }));
vi.mock('../background/services/balance', () => ({ refreshAndBroadcastBalance: vi.fn() }));
vi.mock('../background/services/networkPrivacy', () => ({
  activeNetworkHasPrivacy: vi.fn(async () => true),
}));

function computeTxHashOf(tx: unknown) {
  return computeTxHash(tx as any);
}

import { networkService } from '../services/network/NetworkService';
import { RpcResponseError } from '../services/network/txOutcome';
import { persistDAppConnection, dappConnections } from '../background/services/dappConnections';
import { handleDAppRequest } from '../background/handlers/dappRequest';

const local = new Map<string, unknown>();

beforeEach(() => {
  local.clear();
  dappConnections.clear();
  q.submit = [];
  q.privateResult = {};
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
  return persistDAppConnection('https://a.app', {
    origin: 'https://a.app',
    address: A,
    connected: true,
    connectedAt: Date.now(),
    permissions: ['private_transfers'],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const call = (method: string, params: unknown) =>
  new Promise<any>((resolve) =>
    handleDAppRequest(
      { method, params },
      { origin: 'https://a.app', tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender,
      resolve
    )
  );

const builtHash = async (mock: any) => computeTxHash(await mock.mock.results[0].value);

describe('a site write whose outcome is unclear', () => {
  it('send: answers submitted with the local exact hash, never an error', async () => {
    q.outcome = { success: false, error: 'Network timeout', outcomeUnknown: true };
    const res = await call('send_transaction', { to: B, amount: '1000' });
    expect(res).toEqual({
      success: true,
      data: expect.objectContaining({ status: 'submitted', outcome: 'unknown' }),
    });
    expect(res.data.txHash).toBe(await builtHash(networkService.buildAndSignTransaction));
  });

  it('send: a node refusal is still an error', async () => {
    q.outcome = { success: false, error: 'Transaction rejected', errorType: 'rejected' };
    expect(await call('send_transaction', { to: B, amount: '1000' })).toMatchObject({
      success: false,
      error: { code: 'TRANSACTION_FAILED' },
    });
  });

  it('contract call: answers submitted with the local exact hash', async () => {
    q.outcome = { success: false, error: 'fetch failed', outcomeUnknown: true };
    const res = await call('call_contract', { contract: B, method: 'm', params: [], amount: '0' });
    expect(res).toMatchObject({ success: true, data: { status: 'submitted', outcome: 'unknown' } });
    expect(res.data.txHash).toBe(await builtHash(networkService.buildContractCallTransaction));
  });

  it('sequence: stops at an unclear step and answers what went out', async () => {
    q.submit = [undefined, new TypeError('Failed to fetch')];
    const res = await call('send_contract_transaction_sequence', {
      sequence_id: 's1',
      transactions: [
        { contract: B, method: 'a', params: [], amount: '0' },
        { contract: B, method: 'b', params: [], amount: '0' },
        { contract: B, method: 'c', params: [], amount: '0' },
      ],
    });
    expect(res).toMatchObject({
      success: true,
      data: {
        status: 'submitted',
        completed: 2,
        total: 3,
        stopped: { index: 1, reason: 'outcome_unknown' },
      },
    });
    expect(res.data.results[1]).toMatchObject({ index: 1, outcome: 'unknown' });
  });

  it('sequence: a refused first step is an error', async () => {
    q.submit = [new RpcResponseError('bad', { code: 105 })];
    const res = await call('send_contract_transaction_sequence', {
      sequence_id: 's2',
      transactions: [{ contract: B, method: 'a', params: [], amount: '0' }],
    });
    expect(res).toMatchObject({ success: false, error: { code: 'CONTRACT_CALL_FAILED' } });
  });

  it('private transfer: answers submitted with the local hash', async () => {
    q.privateResult = { success: false, outcomeUnknown: true, txHash: 'f'.repeat(64), error: 'x' };
    const res = await call('send_private_transfer', { to: B, amount_raw: '5' });
    expect(res).toMatchObject({
      success: true,
      data: { txHash: 'f'.repeat(64), status: 'submitted', outcome: 'unknown', to: B },
    });
  });
});
