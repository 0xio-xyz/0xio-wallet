import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';
import { parseJsonExact } from 'src/utils/octra/dappTx';
import { normalizeSiteCall, normalizeSiteTx } from 'src/utils/octra/dappTxRequest';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'octCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

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
  },
}));
vi.mock('../services/network/NetworkService', () => ({
  networkService: {
    getRecommendedFeeStrict: vi.fn(async () => ({
      minimum: '1000',
      recommended: '3500',
      fast: '7000',
    })),
    getNextNonce: vi.fn(async () => 1),
    buildAndSignTransaction: vi.fn(async (p: any) => ({ ...p, signature: 'sig' })),
    buildContractCallTransaction: vi.fn(async (p: any) => ({ ...p, signature: 'sig' })),
    jsonRpcCall: vi.fn(async () => ({ tx_hash: 'h' })),
  },
  privacyNetworkService: {
    privateSpendBlocker: vi.fn(async () => null),
    createPrivateTransfer: vi.fn(async () => ({ success: true, txHash: 'h1' })),
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

const local = new Map<string, unknown>();

beforeEach(async () => {
  local.clear();
  dappConnections.clear();
  local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, A);
  local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'mainnet');
  vi.mocked(txApprovalQueue.add).mockReset().mockResolvedValue({ approved: true });
  vi.mocked(networkService.buildAndSignTransaction).mockClear();
  vi.mocked(networkService.buildContractCallTransaction).mockClear();
  vi.mocked(networkService.jsonRpcCall).mockClear();
  vi.mocked(privacyNetworkService.createPrivateTransfer).mockClear();
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
  await persistDAppConnection('https://a.app', {
    origin: 'https://a.app',
    address: A,
    publicKey: 'pkA',
    connected: true,
    connectedAt: Date.now(),
    permissions: ['private_transfers'],
  });
});

const request = (method: string, params: unknown = {}) =>
  new Promise<any>((resolve) =>
    handleDAppRequest(
      { method, params },
      { origin: 'https://a.app' } as chrome.runtime.MessageSender,
      resolve
    )
  );

const reviewed = () => (vi.mocked(txApprovalQueue.add).mock.calls[0][0] as any).params;
const builtCall = (i = 0) =>
  vi.mocked(networkService.buildContractCallTransaction).mock.calls[i][0];
const builtTransfer = () => vi.mocked(networkService.buildAndSignTransaction).mock.calls[0][0];

const expectCallMatches = (shown: any, built: any) => {
  expect(built.contract).toBe(shown.to);
  expect(built.method).toBe(shown.method);
  expect(built.rawMessage).toBe(shown.message);
  expect(built.amount).toBe(shown.amount);
  expect(built.ou).toBe(shown.ou);
  expect(Object.keys(shown).sort()).toEqual(['amount', 'message', 'method', 'op_type', 'ou', 'to']);
};

const BIG_ARGS = '[12345678901234567890, "x", {"k": 1}]';

describe.each(['send_transaction', 'sign_transaction'])('%s', (method) => {
  it('signs the reviewed recipient, amount, memo and fee of a transfer', async () => {
    void request(method, { to_: B, amount: '1500000', memo: 'hi', ou: '5000' });
    await vi.waitFor(() => expect(networkService.buildAndSignTransaction).toHaveBeenCalled());
    const shown = reviewed();
    const built = builtTransfer();
    expect(shown).toEqual({
      op_type: 'standard',
      to: B,
      amount: '1500000',
      memo: 'hi',
      ou: '5000',
    });
    expect([built.to, built.amount, built.message, built.ou]).toEqual([
      shown.to,
      shown.amount,
      shown.memo,
      shown.ou,
    ]);
  });

  it('signs the reviewed contract, method and exact argument text of a call', async () => {
    void request(method, { contract: C, encrypted_data: 'swap', message: BIG_ARGS, amount: '7' });
    await vi.waitFor(() => expect(networkService.buildContractCallTransaction).toHaveBeenCalled());
    const shown = reviewed();
    expectCallMatches(shown, builtCall());
    expect(shown.message).toBe(BIG_ARGS);
    expect(parseJsonExact(shown.message)).toEqual(['12345678901234567890', 'x', { k: 1 }]);
  });

  it.each([
    [{ to: B, contract: C, amount: '1' }, 'recipients'],
    [{ to: B, to_: C, amount: '1' }, 'recipients'],
    [{ to: C, method: 'a', encrypted_data: 'b' }, 'methods'],
    [{ to: C, method: 'a', params: [1], message: '[2]' }, 'argument lists'],
    [{ to: 'oct-not-an-address', amount: '1' }, 'recipient address'],
  ])('refuses %j before any review or signature', async (params, why) => {
    const res = await request(method, params);
    expect(res.error.code).toBe('INVALID_PARAMS');
    expect(res.error.message).toContain(why);
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
    expect(networkService.buildAndSignTransaction).not.toHaveBeenCalled();
    expect(networkService.buildContractCallTransaction).not.toHaveBeenCalled();
  });
});

describe('call_contract', () => {
  it('signs the reviewed params as the message', async () => {
    void request('call_contract', { contract: C, method: 'lock', params: ['9007199254740993', 2] });
    await vi.waitFor(() => expect(networkService.buildContractCallTransaction).toHaveBeenCalled());
    const shown = reviewed();
    expectCallMatches(shown, builtCall());
    expect(shown.message).toBe('["9007199254740993",2]');
  });

  it('takes agreeing aliases and refuses a site sending one recipient to sign and another to show', async () => {
    void request('call_contract', { contract: C, to: C, method: 'm', encrypted_data: 'm' });
    await vi.waitFor(() => expect(networkService.buildContractCallTransaction).toHaveBeenCalled());
    expectCallMatches(reviewed(), builtCall());

    vi.mocked(txApprovalQueue.add).mockClear();
    const res = await request('call_contract', { to: B, contract: C, method: 'm' });
    expect(res.error.code).toBe('INVALID_PARAMS');
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
  });
});

describe('send_contract_transaction_sequence', () => {
  it('reviews every step with the exact args and amount it signs', async () => {
    const res = await request('send_contract_transaction_sequence', {
      transactions: [
        { contract: C, method: 'approve', params: [B, '18446744073709551615'] },
        { contract: B, method: 'swap', message: '[1, 99999999999999999999]', amount: '250' },
      ],
    });
    expect(res.success).toBe(true);
    const steps = reviewed().transactions;
    expect(steps).toHaveLength(2);
    steps.forEach((shown: any, i: number) => expectCallMatches(shown, builtCall(i)));
    expect(steps[1].message).toBe('[1, 99999999999999999999]');
    expect(steps[1].amount).toBe('250');
  });

  it('refuses a step whose contract is not an address before the review', async () => {
    const res = await request('send_contract_transaction_sequence', {
      transactions: [
        { contract: C, method: 'a' },
        { contract: 'nope', method: 'b' },
      ],
    });
    expect(res.error).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(res.error.message).toMatch(/^Step 1: /);
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
  });
});

describe('send_private_transfer', () => {
  it('signs the reviewed recipient and amount', async () => {
    const res = await request('send_private_transfer', { to_: B, amount: '1.25' });
    expect(res.success).toBe(true);
    const shown = reviewed();
    expect(shown).toMatchObject({ to: B, amount_raw: '1250000' });
    const [, to, amount, , ou] = vi.mocked(privacyNetworkService.createPrivateTransfer).mock
      .calls[0];
    expect([to, String(amount), ou]).toEqual([shown.to, shown.amount_raw, shown.ou]);
  });

  it('refuses two different recipients', async () => {
    const res = await request('send_private_transfer', { to: B, contract: C, amount_raw: '1' });
    expect(res.error.code).toBe('INVALID_PARAMS');
    expect(txApprovalQueue.add).not.toHaveBeenCalled();
    expect(privacyNetworkService.createPrivateTransfer).not.toHaveBeenCalled();
  });
});

describe('the request normalizer', () => {
  it('keeps a JSON array argument text byte for byte and serializes the rest once', () => {
    const call = (p: Record<string, unknown>) => {
      const r = normalizeSiteCall({ contract: C, method: 'm', ...p });
      return 'error' in r ? r.error : r.tx.message;
    };
    expect(call({ message: '[ 1,2 ]' })).toBe('[ 1,2 ]');
    expect(call({ params: [1, 2] })).toBe('[1,2]');
    expect(call({ params: [1, 2], message: '[1,2]' })).toBe('[1,2]');
    expect(call({})).toBe('[]');
    expect(call({ params: [1], message: '[1, 2]' })).toMatch(/two different/);
  });

  it('needs a method for a call and a positive amount for a transfer', () => {
    expect(normalizeSiteTx({ to: B, op_type: 'call' })).toMatchObject({ ok: false });
    expect(normalizeSiteTx({ to: B, amount: '0' })).toMatchObject({ ok: false });
    expect(normalizeSiteTx({ to: B, amount: '-1' })).toMatchObject({ ok: false });
    expect(normalizeSiteTx([{ to: B, amount: '1' }])).toMatchObject({ ok: true });
  });
});
