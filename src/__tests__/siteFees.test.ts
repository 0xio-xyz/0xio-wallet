import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';
import {
  FEE_CHANGED,
  FEE_UNAVAILABLE,
  FeeUnavailableError,
  parseOu,
  reviewedFeeError,
  siteFeeOu,
} from 'src/utils/octra/dappTx';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const vault = [
  { id: 'id-a', name: 'A', address: A, publicKey: 'pkA', privateKey: 'skA', type: 'standard' },
];

const fees = vi.hoisted(() => ({
  quote: null as null | { minimum: string; recommended: string; fast: string },
  after: undefined as undefined | null | { minimum: string; recommended: string; fast: string },
}));

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
  },
}));
vi.mock('../services/network/NetworkService', () => ({
  networkService: {
    getRecommendedFeeStrict: vi.fn(),
    getNextNonce: vi.fn(async () => 1),
    buildAndSignTransaction: vi.fn(async (p: any) => ({ ...p, signature: 'sig' })),
    buildContractCallTransaction: vi.fn(async (p: any) => ({ ...p, signature: 'sig' })),
  },
  privacyNetworkService: {
    privateSpendBlocker: vi.fn(async () => null),
    createPrivateTransfer: vi.fn(async () => ({ success: true, txHash: 'h1' })),
    earlierClaim: vi.fn(async () => null),
    claimableAmount: vi.fn(async () => ({ ok: true, amount: 2_500_000 })),
    claimPrivateTransfer: vi.fn(async () => ({ success: true, txHash: 'h2' })),
  },
}));
vi.mock('../services/pvac/PvacManager', () => ({ pvacManager: { ensureOffscreenReady: vi.fn() } }));
vi.mock('../background/services/txQueue', () => ({
  txQueue: { add: vi.fn(() => new Promise(() => {})) },
}));
vi.mock('../background/services/balance', () => ({ refreshAndBroadcastBalance: vi.fn() }));

import { txApprovalQueue } from '../background/services/approvals';
import { networkService, privacyNetworkService } from '../services/network/NetworkService';
import { dappConnections, persistDAppConnection } from '../background/services/dappConnections';
import { handleDAppRequest } from '../background/handlers/dappRequest';
import { PrivacyNetworkService } from '../services/network/PrivacyNetworkService';

const local = new Map<string, unknown>();
const MAINNET_STEALTH = { minimum: '1000000', recommended: '1000000', fast: '1500000' };

beforeEach(() => {
  local.clear();
  dappConnections.clear();
  local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, A);
  local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'mainnet');
  fees.quote = MAINNET_STEALTH;
  fees.after = undefined;
  let reads = 0;
  vi.mocked(networkService.getRecommendedFeeStrict).mockImplementation(async () => {
    reads++;
    return reads > 1 && fees.after !== undefined ? fees.after : fees.quote;
  });
  vi.mocked(txApprovalQueue.add).mockReset().mockResolvedValue({ approved: true });
  vi.mocked(privacyNetworkService.createPrivateTransfer).mockClear();
  vi.mocked(privacyNetworkService.claimPrivateTransfer).mockClear();
  vi.mocked(networkService.buildAndSignTransaction).mockClear();
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

const connect = () =>
  persistDAppConnection('https://a.app', {
    origin: 'https://a.app',
    address: A,
    publicKey: 'pkA',
    connected: true,
    connectedAt: Date.now(),
    permissions: ['private_transfers', 'private_claims'],
  });

const request = (method: string, params: unknown = {}) =>
  new Promise<any>((resolve) =>
    handleDAppRequest(
      { method, params },
      { origin: 'https://a.app' } as chrome.runtime.MessageSender,
      resolve
    )
  );

const shownParams = () => (vi.mocked(txApprovalQueue.add).mock.calls[0][0] as any).params;

describe('the site fee rule', () => {
  const quote = { minimum: '1000', recommended: '3500' };

  it('keeps a valid site fee the node takes, else the live recommendation', () => {
    expect(siteFeeOu('5000', quote)).toBe(5000n);
    expect(siteFeeOu('1000', quote)).toBe(1000n);
    expect(siteFeeOu('999', quote)).toBe(3500n);
    expect(siteFeeOu(undefined, quote)).toBe(3500n);
    expect(siteFeeOu('abc', quote)).toBe(3500n);
    expect(siteFeeOu('99999999', quote)).toBe(3500n);
  });

  it('has no fee without a live quote and no constant default', () => {
    expect(siteFeeOu('5000', null)).toBeNull();
    expect(parseOu(undefined)).toBeNull();
    expect(parseOu('')).toBeNull();
  });

  it('signs the reviewed fee unless the live minimum rose above it', () => {
    expect(reviewedFeeError(3500n, quote)).toBeNull();
    expect(reviewedFeeError(3500n, { minimum: '4000', recommended: '5000' })).toBe(FEE_CHANGED);
    expect(reviewedFeeError(3500n, null)).toBe(FEE_UNAVAILABLE);
  });

  it('builds no private transaction without a fee', async () => {
    const svc = new PrivacyNetworkService({} as any);
    await expect(
      svc.buildHfheTransaction({
        from: A,
        to: A,
        amount: '0',
        nonce: 1,
        privateKey: 'sk',
        opType: 'stealth',
        encryptedData: '{}',
        ou: '',
      })
    ).rejects.toBeInstanceOf(FeeUnavailableError);
  });
});

describe('send_private_transfer from a site', () => {
  beforeEach(connect);

  it('refuses before any review when the live fee cannot be read, and signs nothing', async () => {
    fees.quote = null;
    const res = await request('send_private_transfer', { to: B, amount_raw: '1000000' });
    expect(res.error).toEqual({ code: 'NETWORK_ERROR', message: FEE_UNAVAILABLE });
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
    expect(privacyNetworkService.createPrivateTransfer).not.toHaveBeenCalled();
  });

  it('shows and signs the live stealth fee, never a constant', async () => {
    const res = await request('send_private_transfer', { to: B, amount_raw: '1000000' });
    expect(res.success).toBe(true);
    expect(shownParams().ou).toBe('1000000');
    expect(vi.mocked(privacyNetworkService.createPrivateTransfer).mock.calls[0][4]).toBe('1000000');
  });

  it('replaces a site fee below the live minimum with the live one', async () => {
    await request('send_private_transfer', { to: B, amount_raw: '1000000', ou: '3000' });
    expect(shownParams().ou).toBe('1000000');
    expect(vi.mocked(privacyNetworkService.createPrivateTransfer).mock.calls[0][4]).toBe('1000000');
  });

  it('signs nothing when the minimum rose during the review', async () => {
    fees.after = { minimum: '2000000', recommended: '2000000', fast: '3000000' };
    const res = await request('send_private_transfer', { to: B, amount_raw: '1000000' });
    expect(res.error).toEqual({ code: 'FEE_CHANGED', message: FEE_CHANGED });
    expect(privacyNetworkService.createPrivateTransfer).not.toHaveBeenCalled();
  });
});

describe('site writes', () => {
  beforeEach(connect);
  const CALL = { minimum: '1000', recommended: '3500', fast: '7000' };

  const signedOu = async (params: Record<string, unknown>) => {
    vi.mocked(txApprovalQueue.add).mockClear();
    vi.mocked(networkService.buildAndSignTransaction).mockClear();
    void request('send_transaction', params);
    await vi.waitFor(() => expect(networkService.buildAndSignTransaction).toHaveBeenCalled());
    return {
      shown: shownParams().ou,
      signed: vi.mocked(networkService.buildAndSignTransaction).mock.calls[0][0].ou,
    };
  };

  it('use the site fee only when valid and at or above the live minimum', async () => {
    fees.quote = CALL;
    expect(await signedOu({ to: B, amount: '1000000', ou: '5000' })).toEqual({
      shown: '5000',
      signed: '5000',
    });
    expect(await signedOu({ to: B, amount: '1000000', ou: '500' })).toEqual({
      shown: '3500',
      signed: '3500',
    });
    expect(await signedOu({ to: B, amount: '1000000' })).toEqual({
      shown: '3500',
      signed: '3500',
    });
  });

  it('are refused before the review without a live fee', async () => {
    fees.quote = null;
    const res = await request('send_transaction', { to: B, amount: '1000000', ou: '5000' });
    expect(res.error.message).toBe(FEE_UNAVAILABLE);
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
    expect(networkService.buildAndSignTransaction).not.toHaveBeenCalled();
  });
});

describe('claim_private_transfer from a site', () => {
  beforeEach(connect);

  it('shows the amount, the count and the live fee, and signs that fee', async () => {
    fees.quote = { minimum: '900000', recommended: '1000000', fast: '1500000' };
    const res = await request('claim_private_transfer', { transferId: '42' });
    expect(res.success).toBe(true);
    expect(shownParams()).toMatchObject({
      transferId: '42',
      amount_raw: '2500000',
      count: 1,
      ou: '1000000',
    });
    expect(vi.mocked(privacyNetworkService.claimPrivateTransfer).mock.calls[0][3]).toBe('1000000');
  });

  it('refuses before any review when the transfer amount cannot be read', async () => {
    vi.mocked(privacyNetworkService.claimableAmount).mockResolvedValueOnce({
      ok: false,
      error: 'Already claimed',
    });
    const res = await request('claim_private_transfer', { transferId: '42' });
    expect(res.error.message).toBe('Already claimed');
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
  });

  it('answers a spent or unreadable output with its code before any review', async () => {
    vi.mocked(privacyNetworkService.claimableAmount).mockResolvedValueOnce({
      ok: false,
      error: 'Claim output is spent; nothing was sent',
      code: 'CLAIM_OUTPUT_SPENT',
    });
    expect((await request('claim_private_transfer', { transferId: '42' })).error.code).toBe(
      'CLAIM_OUTPUT_SPENT'
    );
    vi.mocked(privacyNetworkService.claimableAmount).mockResolvedValueOnce({
      ok: false,
      error: 'Claim output state is unavailable; nothing was sent',
      code: 'CLAIM_OUTPUT_UNREADABLE',
    });
    expect((await request('claim_private_transfer', { transferId: '42' })).error.code).toBe(
      'CLAIM_OUTPUT_UNREADABLE'
    );
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
  });

  it('returns the earlier hash for a claim already pending or confirmed, without a review', async () => {
    vi.mocked(privacyNetworkService.earlierClaim).mockResolvedValueOnce({ txHash: 'h0' });
    const res = await request('claim_private_transfer', { transferId: '42' });
    expect(res).toEqual({
      success: true,
      data: { claimed_count: 1, tx_hashes: ['h0'], status: 'submitted' },
    });
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
    expect(privacyNetworkService.claimPrivateTransfer).not.toHaveBeenCalled();
  });

  it('answers a claim in conflict with CLAIM_CONFLICT before any review', async () => {
    vi.mocked(privacyNetworkService.earlierClaim).mockResolvedValueOnce({
      success: false,
      error: 'Confirmed claim conflicts with current output state; nothing was sent',
      code: 'CLAIM_CONFLICT',
    });
    const res = await request('claim_private_transfer', { transferId: '42' });
    expect(res.error.code).toBe('CLAIM_CONFLICT');
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
  });

  it.each([
    'CLAIM_OUTPUT_SPENT',
    'CLAIM_CONFLICT',
    'RATE_LIMIT_EXCEEDED',
    'NETWORK_ERROR',
  ] as const)('passes %s from the claim after the review', async (code) => {
    vi.mocked(privacyNetworkService.claimPrivateTransfer).mockResolvedValueOnce({
      success: false,
      error: 'refused',
      code,
    });
    const res = await request('claim_private_transfer', { transferId: '42' });
    expect(res.error).toEqual({ code, message: 'refused' });
  });

  it('keeps PRIVATE_TRANSFER_FAILED for a failure without a code', async () => {
    vi.mocked(privacyNetworkService.claimPrivateTransfer).mockResolvedValueOnce({
      success: false,
      error: 'proof failed',
    });
    const res = await request('claim_private_transfer', { transferId: '42' });
    expect(res.error.code).toBe('PRIVATE_TRANSFER_FAILED');
  });
});
