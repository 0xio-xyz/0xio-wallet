// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { broadcastOutcome, isMethodUnsupported, retryOnce, rpcErrorObject } from '../rpcErrors';

const node = (message: string, code: number | string = -32000) =>
  new Error(`RPC eth_sendRawTransaction: ${message} (${code})`);

describe('rpcErrorObject', () => {
  it('reads the node error and ignores transport failures', () => {
    expect(rpcErrorObject(node('nonce too low'))).toEqual({
      code: -32000,
      message: 'nonce too low',
    });
    expect(rpcErrorObject(node('odd', '?'))).toEqual({ code: null, message: 'odd' });
    expect(rpcErrorObject(new Error('RPC HTTP 502'))).toBeNull();
    expect(rpcErrorObject(new DOMException('timed out', 'TimeoutError'))).toBeNull();
    expect(rpcErrorObject('nope')).toBeNull();
  });
});

describe('broadcastOutcome', () => {
  it('treats a lost reply, an HTTP error or a timeout as maybe sent', () => {
    expect(broadcastOutcome(new Error('RPC HTTP 504'))).toBe('maybe-sent');
    expect(broadcastOutcome(new Error('RPC HTTP 500'))).toBe('maybe-sent');
    expect(broadcastOutcome(new DOMException('signal timed out', 'TimeoutError'))).toBe(
      'maybe-sent'
    );
    expect(broadcastOutcome(new TypeError('Failed to fetch'))).toBe('maybe-sent');
    expect(broadcastOutcome(new Error('Bad transaction hash from the network'))).toBe('maybe-sent');
  });

  it('treats already known and unknown node errors as maybe sent', () => {
    expect(broadcastOutcome(node('already known'))).toBe('maybe-sent');
    expect(broadcastOutcome(node('known transaction: 0xab'))).toBe('maybe-sent');
    expect(broadcastOutcome(node('upstream request timeout', -32603))).toBe('maybe-sent');
  });

  it('treats a definite refusal as rejected', () => {
    for (const m of [
      'nonce too low',
      'insufficient funds for gas * price + value',
      'transaction underpriced',
      'replacement transaction underpriced',
      'max fee per gas less than block base fee',
      'intrinsic gas too low',
      'exceeds block gas limit',
      'invalid sender',
      'only replay-protected (EIP-155) transactions allowed over RPC',
    ]) {
      expect(broadcastOutcome(node(m))).toBe('rejected');
    }
    expect(broadcastOutcome(node('bad params', -32602))).toBe('rejected');
  });
});

describe('isMethodUnsupported', () => {
  it('is true only for a missing method', () => {
    expect(isMethodUnsupported(node('Method not found', -32601))).toBe(true);
    expect(isMethodUnsupported(node('the method eth_feeHistory does not exist'))).toBe(true);
    expect(isMethodUnsupported(new Error('RPC HTTP 429'))).toBe(false);
    expect(isMethodUnsupported(node('rate limited', -32005))).toBe(false);
  });
});

describe('retryOnce', () => {
  it('tries a transport failure once more', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('RPC HTTP 429')).mockResolvedValue(1);
    expect(await retryOnce(fn)).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a node error or an abort', async () => {
    const fn = vi.fn().mockRejectedValue(node('nope'));
    await expect(retryOnce(fn)).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
    const ctrl = new AbortController();
    ctrl.abort();
    const g = vi.fn().mockRejectedValue(new Error('RPC HTTP 503'));
    await expect(retryOnce(g, ctrl.signal)).rejects.toThrow('503');
    expect(g).toHaveBeenCalledTimes(1);
  });
});
