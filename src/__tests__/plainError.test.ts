import { describe, expect, it } from 'vitest';
import 'src/i18n';
import { errorKey, plainError, PlainError } from 'src/utils/plainError';
import { WrongPasswordError, LockedOutError } from 'src/services/crypto/PasswordManager';

describe('errorKey', () => {
  it.each([
    [new TypeError('Failed to fetch'), 'toast.err.offline'],
    ['HTTP 503 Service Unavailable', 'toast.err.offline'],
    ['429 Too Many Requests', 'toast.err.offline'],
    [new WrongPasswordError(), 'toast.err.password'],
    [new LockedOutError(30), 'toast.err.lockedOut'],
    ['fhe_epoch_cap reached', 'toast.err.opLimit'],
    [
      'Insufficient public balance for transaction fee. Need 3,000 OU (~0.003 OCT), have 0.002 OCT.',
      'toast.err.feeShort',
    ],
    ['Insufficient balance', 'toast.err.balance'],
    ['fee too low', 'toast.err.fee'],
    ['nonce already used', 'toast.err.nonceUsed'],
    ['nonce too far ahead', 'toast.err.nonce'],
    ['Transaction too large', 'toast.err.txTooLarge'],
    ['Transaction not accepted by the network', 'toast.err.txNotAccepted'],
    ['Transaction rejected by the network: bad proof', 'toast.err.txRejected'],
    ['Transaction rejected by the network: insufficient balance', 'toast.err.balance'],
    [new Error('Session expired. Please unlock wallet.'), 'toast.err.locked'],
    [new SyntaxError('Unexpected token < in JSON at position 0'), 'toast.err.badFile'],
    [new Error('RuntimeError: unreachable executed in wasm'), 'toast.err.engine'],
    [{ name: 'NotAllowedError', message: 'The operation was not allowed' }, 'toast.err.cancelled'],
  ])('names %s', (err, key) => {
    expect(errorKey(err)).toBe(key);
  });

  it('returns null for unknown or empty errors', () => {
    expect(errorKey(new Error('something odd'))).toBeNull();
    expect(errorKey(undefined)).toBeNull();
    expect(errorKey('')).toBeNull();
  });
});

describe('plainError', () => {
  it('keeps raw text out of the message', () => {
    const msg = plainError(
      new Error('RPC -32000: stack at foo.ts:12'),
      'Could not send. Try again.'
    );
    expect(msg).toBe('Could not send. Try again.');
  });

  it('uses plain words for known failures', () => {
    expect(plainError(new TypeError('Failed to fetch'), 'x')).toBe('Network error. Try again.');
  });

  it('passes a PlainError message through unchanged', () => {
    expect(plainError(new PlainError('Insufficient private balance.'), 'x')).toBe(
      'Insufficient private balance.'
    );
  });
});
