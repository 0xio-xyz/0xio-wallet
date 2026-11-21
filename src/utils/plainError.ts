import i18n from 'src/i18n/core';
import { logger } from './logger';

const RULES: ReadonlyArray<[RegExp, string]> = [
  [/proof policy changed/i, 'toast.err.proofPolicyChanged'],
  [/proof (arithmetic|key policy) is unavailable/i, 'toast.err.proofPolicyUnavailable'],
  [/proof rules could not be read/i, 'toast.err.proofPolicyUnreachable'],
  [/wrongpassworderror|incorrect password|wrong password|invalid password/i, 'toast.err.password'],
  [/lockedouterror|too many attempts/i, 'toast.err.lockedOut'],
  [/epoch_cap|operation cap|cap reached/i, 'toast.err.opLimit'],
  [/nonce already used/i, 'toast.err.nonceUsed'],
  [/transaction too large/i, 'toast.err.txTooLarge'],
  [/not accepted by the network/i, 'toast.err.txNotAccepted'],
  [
    /user (rejected|denied|cancel)|notallowederror|aborterror|not allowed|cancell?ed/i,
    'toast.err.cancelled',
  ],
  [
    /failed to fetch|networkerror|network error|load failed|timed? ?out|econn|\b50[234]\b|\b429\b|rate limit|too many requests|(host|network|server) (is )?unreachable|could not reach|rpc capacity|rpc slots busy|state changed during read/i,
    'toast.err.offline',
  ],
  [/nonce/i, 'toast.err.nonce'],
  [
    /(insufficient|not enough|does not cover)[^.]{0,60}\bfee\b|\bfee\b[^.]{0,40}(insufficient|not enough)/i,
    'toast.err.feeShort',
  ],
  [/insufficient|not enough|exceeds (the )?balance/i, 'toast.err.balance'],
  [/\bfee\b/i, 'toast.err.fee'],
  [/wallet is locked|session (expired|locked)|unlock first/i, 'toast.err.locked'],
  [/already exists|already in your wallet/i, 'toast.err.duplicate'],
  [/invalid (mnemonic|phrase|recovery phrase|private key|key)|bad checksum/i, 'toast.err.badKey'],
  [/unexpected token|json|parse/i, 'toast.err.badFile'],
  [/wasm|webassembly|out of memory|worker|hfhe|pvac/i, 'toast.err.engine'],
  [/rejected by the network/i, 'toast.err.txRejected'],
];

export class PlainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlainError';
  }
}

function rawText(err: unknown): string {
  if (err instanceof Error) return `${err.name} ${err.message}`;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return '';
}

export function errorKey(err: unknown): string | null {
  if (err instanceof PlainError) return null;
  const text = rawText(err);
  if (!text) return null;
  for (const [pattern, key] of RULES) if (pattern.test(text)) return key;
  return null;
}

export function plainError(err: unknown, fallback: string): string {
  if (err instanceof PlainError) return err.message;
  const key = errorKey(err);
  if (rawText(err)) logger.warn('[plainError]', err);
  return key ? i18n.t(key) : fallback;
}
