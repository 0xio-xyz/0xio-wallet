// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { networkService } from 'src/services/network/NetworkService';
import { captureTxScope, type TxScope } from 'src/services/network/txScope';
import { RpcResponseError, TxOutcomeUnknownError } from 'src/services/network/txOutcome';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'octCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const SEED = new Uint8Array(32).map((_, i) => i + 1);
const PRIVATE_KEY = btoa(String.fromCharCode(...SEED));

let scope: TxScope;
let removed: string[];
let released: number[];

beforeEach(async () => {
  scope = await captureTxScope(A);
  removed = [];
  released = [];
  vi.spyOn(networkService, 'getNextNonce').mockResolvedValue(5);
  vi.spyOn(networkService, 'storePendingTransaction').mockResolvedValue({ txId: 'p1' } as any);
  vi.spyOn(networkService, 'removePendingTransaction').mockImplementation(async (id: string) => {
    removed.push(id);
  });
  vi.spyOn(networkService, 'releaseNonce').mockImplementation((_a, n) => {
    released.push(n);
  });
  vi.spyOn(networkService as any, 'logTxDiagnostics').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getRecommendedFeeStrict', () => {
  it('returns null when the read fails, never a made-up fee', async () => {
    vi.spyOn(networkService, 'jsonRpcCall').mockRejectedValue(new Error('429'));
    expect(await networkService.getRecommendedFeeStrict('transfer', scope)).toBeNull();
  });

  it('returns null when the node gives no recommendation', async () => {
    vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({ fast: '1000' });
    expect(await networkService.getRecommendedFeeStrict('call', scope)).toBeNull();
  });

  it("returns the node's quote", async () => {
    vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({
      minimum: '5000',
      recommended: '27057',
      fast: '54114',
    });
    expect(await networkService.getRecommendedFeeStrict('stealth', scope)).toEqual({
      minimum: '5000',
      recommended: '27057',
      fast: '54114',
    });
  });
});

describe('buildAndSignTransaction', () => {
  it('refuses to sign without a fee instead of picking one', async () => {
    await expect(
      networkService.buildAndSignTransaction({
        from: A,
        to: B,
        amount: '1',
        nonce: 1,
        privateKey: PRIVATE_KEY,
        ou: '',
      })
    ).rejects.toThrow();
  });

  it('signs the fee it is given', async () => {
    const tx = await networkService.buildAndSignTransaction({
      from: A,
      to: B,
      amount: '1',
      nonce: 1,
      privateKey: PRIVATE_KEY,
      ou: '27057',
    });
    expect(tx.ou).toBe('27057');
  });
});

describe('contractCall after submit', () => {
  const call = (ou?: string) =>
    networkService.contractCall(C, 'transfer', [B, '10'], A, PRIVATE_KEY, ou, scope);

  it('signs the fee the review showed', async () => {
    const rpc = vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({ tx_hash: 'h1' });
    vi.spyOn(networkService as any, 'updatePendingTransaction').mockResolvedValue(undefined);
    expect(await call('1234')).toBe('h1');
    expect((rpc.mock.calls[0][1] as any[])[0].ou).toBe('1234');
  });

  it('a JSON-RPC rejection frees the nonce and drops the pending entry', async () => {
    vi.spyOn(networkService, 'jsonRpcCall').mockRejectedValue(
      new RpcResponseError('nonce too low', { data: { type: 'nonce_too_low' } })
    );
    await expect(call('1000')).rejects.toBeInstanceOf(RpcResponseError);
    expect(released).toEqual([5]);
    expect(removed).toEqual(['p1']);
  });

  it('a lost receipt keeps the pending entry and the nonce', async () => {
    vi.spyOn(networkService, 'jsonRpcCall').mockRejectedValue(new Error('Failed to fetch'));
    await expect(call('1000')).rejects.toBeInstanceOf(TxOutcomeUnknownError);
    expect(released).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('a reply with no hash and no verdict is not a failure', async () => {
    vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({ status: 'weird' });
    await expect(call('1000')).rejects.toBeInstanceOf(TxOutcomeUnknownError);
    expect(removed).toEqual([]);
  });
});

describe('sendTransaction queue replies', () => {
  const send = () =>
    networkService.sendTransaction({
      from: A,
      to: B,
      amount: '1',
      privateKey: PRIVATE_KEY,
      ou: '1000',
      scope,
    });

  it('no verdict from the node keeps it pending', async () => {
    vi.spyOn(networkService, '_sendExtensionMessage').mockResolvedValue({
      success: false,
      error: 'Network timeout - transaction will be retried',
    });
    const res = await send();
    expect(res.success).toBe(false);
    expect(res.outcomeUnknown).toBe(true);
    expect(removed).toEqual([]);
    expect(released).toEqual([]);
  });

  it('a node verdict frees the nonce and drops the pending entry', async () => {
    vi.spyOn(networkService, '_sendExtensionMessage').mockResolvedValue({
      success: false,
      error: 'insufficient balance',
      errorType: 'insufficient_balance',
    });
    const res = await send();
    expect(res.success).toBe(false);
    expect(res.outcomeUnknown).toBeFalsy();
    expect(res.errorType).toBe('insufficient_balance');
    expect(removed).toEqual(['p1']);
    expect(released).toEqual([5]);
  });

  it('an undelivered message sent nothing', async () => {
    vi.spyOn(networkService, '_sendExtensionMessage').mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.')
    );
    const res = await send();
    expect(res.outcomeUnknown).toBeFalsy();
    expect(removed).toEqual(['p1']);
  });
});

describe('broadcastBatchTransaction', () => {
  const tx = { from: A, to_: B, amount: '1', nonce: 5, ou: '1000' } as any;

  it('a node verdict on the batch is a refusal', async () => {
    vi.spyOn(networkService, 'jsonRpcCall').mockRejectedValue(new RpcResponseError('bad', {}));
    const res = await networkService.broadcastBatchTransaction([tx], scope);
    expect(res.success).toBe(false);
    expect(res.outcomeUnknown).toBe(false);
  });

  it('a timeout leaves the batch outcome unknown', async () => {
    vi.spyOn(networkService, 'jsonRpcCall').mockRejectedValue(new Error('aborted after 60000ms'));
    const res = await networkService.broadcastBatchTransaction([tx], scope);
    expect(res.success).toBe(false);
    expect(res.outcomeUnknown).toBe(true);
  });
});
