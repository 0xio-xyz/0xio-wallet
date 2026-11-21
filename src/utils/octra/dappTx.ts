import { MEMO_MAX_BYTES, memoBytes } from './memo';
import { toUnits } from '../amount';

export function parseBaseUnits(value: unknown): bigint | null {
  if (value == null || value === '') return 0n;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'string' && /^\d{1,30}$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/**
 * A site's call arguments as the exact text it sent, when that text is a JSON array. Signed as
 * is: a parse and re-stringify would round integers above 2^53.
 */
export function rawCallMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  try {
    return Array.isArray(JSON.parse(message)) ? message : null;
  } catch {
    return null;
  }
}

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * JSON.parse for display: an integer too large for a float stays its exact digit text, so a
 * review never shows a rounded value. Throws on text JSON.parse refuses.
 */
export function parseJsonExact(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER_RE.lastIndex = i;
      const token = NUMBER_RE.exec(text)?.[0] ?? c;
      const unsafe = /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token));
      out += unsafe ? `"${token}"` : token;
      i += token.length;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

export const MIN_OU = 1n;
export const MAX_OU = 10_000_000n;

export const FEE_UNAVAILABLE = 'Network fee unavailable. Try again.';
export const FEE_CHANGED = 'The network fee changed. Review again.';

export class FeeUnavailableError extends Error {
  constructor() {
    super(FEE_UNAVAILABLE);
    this.name = 'FeeUnavailableError';
  }
}

export interface FeeQuote {
  minimum: string;
  recommended: string;
}

export function parseOu(value: unknown): bigint | null {
  if (value == null || value === '') return null;
  const ou = parseBaseUnits(value);
  if (ou == null || ou < MIN_OU || ou > MAX_OU) return null;
  return ou;
}

const quoteOu = (value: string): bigint | null => {
  const ou = parseBaseUnits(value);
  return ou != null && ou > 0n ? ou : null;
};

/** The lowest fee the node takes now. A missing minimum makes the recommendation the floor. */
export function feeFloor(quote: FeeQuote): bigint | null {
  const rec = quoteOu(quote.recommended);
  if (rec == null) return null;
  const min = quoteOu(quote.minimum);
  return min != null && min < rec ? min : rec;
}

/**
 * The fee a site request is reviewed and signed at: the site's own fee when it is valid and the
 * node takes it, else the node's recommendation. null when the quote holds no fee.
 */
export function siteFeeOu(requested: unknown, quote: FeeQuote | null): bigint | null {
  if (!quote) return null;
  const floor = feeFloor(quote);
  const rec = quoteOu(quote.recommended);
  if (floor == null || rec == null) return null;
  const own = parseOu(requested);
  return own != null && own >= floor ? own : rec;
}

export function reviewedFeeError(reviewedOu: bigint, live: FeeQuote | null): string | null {
  const floor = live ? feeFloor(live) : null;
  if (floor == null) return FEE_UNAVAILABLE;
  return reviewedOu >= floor ? null : FEE_CHANGED;
}

/** A private transfer: amount_raw in micro-OCT, or a decimal OCT amount. */
export function parsePrivateAmount(params: {
  amount?: unknown;
  amount_raw?: unknown;
}): bigint | null {
  if (params.amount_raw != null && params.amount_raw !== '') {
    const raw = parseBaseUnits(params.amount_raw);
    return raw != null && raw > 0n ? raw : null;
  }
  const a = params.amount;
  if (typeof a !== 'number' && typeof a !== 'string') return null;
  try {
    const units = toUnits(typeof a === 'string' ? a.trim() : a, 6);
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

export type MemoResult = { memo: string } | { error: string };

/** A request may carry `memo` or `message`. Two different texts are refused, never picked from. */
export function resolveTxMemo(params: { memo?: unknown; message?: unknown }): MemoResult {
  const memo = params.memo == null ? '' : params.memo;
  const message = params.message == null ? '' : params.message;
  if (typeof memo !== 'string' || typeof message !== 'string') {
    return { error: 'Memo must be text' };
  }
  if (memo && message && memo !== message) {
    return { error: 'Request has two different memos' };
  }
  const text = memo || message;
  if (memoBytes(text) > MEMO_MAX_BYTES) return { error: 'Memo is too long' };
  return { memo: text };
}
