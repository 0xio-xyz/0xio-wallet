// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkService, setSubmitRetrySleepForTests } from 'src/services/network/NetworkService';
import { captureTxScope, type TxScope } from 'src/services/network/txScope';
import {
  RpcHttpError,
  RpcResponseError,
  TxSubmitError,
  submitRefusal,
} from 'src/services/network/txOutcome';
import { errorKey } from 'src/utils/plainError';
import { parseJsonExact, rawCallMessage } from 'src/utils/octra/dappTx';

const A = 'oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB';
const TX = {
  from: A,
  to_: 'oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F',
  amount: '1000000',
  nonce: 7,
  ou: '1000',
  timestamp: 1762300000.123,
  op_type: 'standard',
  public_key: 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=',
  signature:
    'VBORX2a2r6uAlv2W0EPFqTp4sNf2+QL0CzPyAaqTrjYbe8qczkMrpqXMqMLFmEA02yiUIe26DqdmWcs2LQNCCw==',
};
const HASH = 'f802c9eed1384aa62879c871ab3ccba84f536866dfa5373dd09f549a77aed8d9';

const nodeError = (code: number, message = 'node says no') =>
  new RpcResponseError(message, { code, message });

let ns: NetworkService;
let rpc: ReturnType<typeof vi.fn>;
let scope: TxScope;
const sleeps: number[] = [];

beforeEach(async () => {
  ns = new NetworkService();
  rpc = vi.fn();
  (ns as any)._rpc = rpc;
  scope = await captureTxScope(A);
  sleeps.length = 0;
  setSubmitRetrySleepForTests(async (ms) => {
    sleeps.push(ms);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('submit refusal codes', () => {
  it('sorts the node codes the webcli way', () => {
    expect(submitRefusal(112)).toBe('nonce_used');
    for (const c of [107, 110, 117, -32005]) expect(submitRefusal(c)).toBe('resend');
    for (const c of [100, 101, 102, 103, 104, 105, 108, 109, 111, 113, 114, 115, 116, 118])
      expect(submitRefusal(c)).toBe('rejected');
    expect(submitRefusal(-32600)).toBe('rejected');
    expect(submitRefusal(-32602)).toBe('rejected');
    expect(submitRefusal(undefined, 413)).toBe('too_large');
    expect(submitRefusal(106)).toBeNull();
    expect(submitRefusal(undefined)).toBeNull();
  });
});

describe('octra_submit', () => {
  it('tracks the local exact hash, whatever hash the node reports', async () => {
    rpc.mockResolvedValueOnce({ tx_hash: 'abc' });
    expect((await ns.jsonRpcCall('octra_submit', [TX], undefined, scope)).tx_hash).toBe(HASH);
    rpc.mockResolvedValueOnce({ status: 'accepted' });
    expect((await ns.jsonRpcCall('octra_submit', [TX], undefined, scope)).tx_hash).toBe(HASH);
    rpc.mockResolvedValueOnce({ status: 'rejected', error: { reason: 'x' } });
    expect((await ns.jsonRpcCall('octra_submit', [TX], undefined, scope)).tx_hash).toBeUndefined();
  });

  it('sends the same signed bytes again when the node allows it, three tries in all', async () => {
    rpc.mockRejectedValueOnce(nodeError(-32005)).mockResolvedValueOnce({ tx_hash: HASH });
    expect((await ns.jsonRpcCall('octra_submit', [TX], undefined, scope)).tx_hash).toBe(HASH);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).toEqual([TX]);

    rpc.mockReset();
    rpc.mockRejectedValue(nodeError(107));
    const err = await ns.jsonRpcCall('octra_submit', [TX], undefined, scope).catch((e) => e);
    expect(err).toBeInstanceOf(TxSubmitError);
    expect(err.verdict).toBe('not_accepted');
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 1000, 2000]);
  });

  it('never resends a used nonce or a rejected tx, and marks the nonce used', async () => {
    rpc.mockRejectedValue(nodeError(112));
    const used = await ns.jsonRpcCall('octra_submit', [TX], undefined, scope).catch((e) => e);
    expect(used.verdict).toBe('nonce_used');
    expect(used.errorType).toBe('nonce_used');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(chrome.storage.session.set).toHaveBeenCalledWith({
      [`nonce_used_mainnet:${A}`]: { nonce: 7, ts: expect.any(Number) },
    });
    expect(errorKey(used)).toBe('toast.err.nonceUsed');

    rpc.mockReset();
    rpc.mockRejectedValue(nodeError(104, 'bad signature'));
    const rejected = await ns.jsonRpcCall('octra_submit', [TX], undefined, scope).catch((e) => e);
    expect(rejected).toBeInstanceOf(RpcResponseError);
    expect(rejected.verdict).toBe('rejected');
    expect(rejected.code).toBe(104);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(errorKey(rejected)).toBe('toast.err.txRejected');
  });

  it('says a transaction is too large on HTTP 413', async () => {
    rpc.mockRejectedValue(new RpcHttpError('Request Entity Too Large', 413));
    const err = await ns.jsonRpcCall('octra_submit', [TX], undefined, scope).catch((e) => e);
    expect(err.verdict).toBe('too_large');
    expect(errorKey(err)).toBe('toast.err.txTooLarge');
  });

  it('leaves other failures as they were', async () => {
    rpc.mockRejectedValue(new Error('primary RPC timeout'));
    const err = await ns.jsonRpcCall('octra_submit', [TX], undefined, scope).catch((e) => e);
    expect(err).not.toBeInstanceOf(RpcResponseError);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('octra_submitBatch', () => {
  const TX2 = { ...TX, nonce: 8 };

  it('resends a not accepted batch call with the same bytes, then refuses it', async () => {
    rpc.mockRejectedValue(nodeError(110));
    const res = await ns.broadcastBatchTransaction([TX, TX2] as never, scope);
    expect(res.success).toBe(false);
    expect(res.outcomeUnknown).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(3);
    for (const call of rpc.mock.calls) expect(call[1]).toEqual([[TX, TX2]]);
  });

  it('marks a used nonce on a refused batch call without resending', async () => {
    rpc.mockRejectedValue(nodeError(112));
    const res = await ns.broadcastBatchTransaction([TX, TX2] as never, scope);
    expect(res.error).toMatch(/Nonce already used/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('resends only the items the node allows and reads each item code', async () => {
    rpc
      .mockResolvedValueOnce({
        results: [
          { status: 'accepted', nonce: 7, tx_hash: 'node7' },
          { status: 'rejected', nonce: 8, error: { code: 117, reason: 'busy' } },
        ],
      })
      .mockResolvedValueOnce({ results: [{ status: 'accepted', nonce: 8 }] });
    const res = await ns.broadcastBatchTransaction([TX, TX2] as never, scope);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).toEqual([[TX2]]);
    expect(res.accepted).toBe(2);
    expect(res.results[0].tx_hash).not.toBe('node7');
    expect(res.results[0].tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.results[1].tx_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('turns item codes into plain verdicts', async () => {
    rpc.mockResolvedValueOnce({
      results: [
        { status: 'rejected', nonce: 7, error: { code: 112, reason: 'used' } },
        { status: 'rejected', nonce: 8, error: { code: 104, reason: 'bad signature' } },
      ],
    });
    const res = await ns.broadcastBatchTransaction([TX, TX2] as never, scope);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(res.accepted).toBe(0);
    expect(res.results.map((r) => r.error?.type)).toEqual(['nonce_used', 'rejected']);
    expect(chrome.storage.session.set).toHaveBeenCalledWith({
      [`nonce_used_mainnet:${A}`]: { nonce: 7, ts: expect.any(Number) },
    });
  });
});

describe('site call arguments', () => {
  it('signs the text the site sent, big integers intact', () => {
    const text = `["${A}",12345678901234567890123]`;
    expect(rawCallMessage(text)).toBe(text);
    expect(rawCallMessage('{"a":1}')).toBeNull();
    expect(rawCallMessage('nope')).toBeNull();
    expect(rawCallMessage(['x'])).toBeNull();
  });

  it('shows big integers exactly in the review', () => {
    expect(parseJsonExact(`["${A}",12345678901234567890123,-9007199254740993,5,1.5e3]`)).toEqual([
      A,
      '12345678901234567890123',
      '-9007199254740993',
      5,
      1500,
    ]);
    expect(parseJsonExact('{"a":"12345678901234567890 \\" x","b":[1]}')).toEqual({
      a: '12345678901234567890 " x',
      b: [1],
    });
    expect(() => parseJsonExact('[1,')).toThrow();
  });

  it('keeps the exact text in the signed call', async () => {
    const text = `["${A}", 12345678901234567890123]`;
    const tx = await ns.buildContractCallTransaction({
      from: A,
      contract: TX.to_,
      method: 'transfer',
      callParams: [],
      rawMessage: text,
      nonce: 1,
      ou: '1000',
      privateKey: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1))),
    });
    expect(tx.message).toBe(text);
  });
});
