import { isOctAddress } from './address';
import {
  parseBaseUnits,
  parseJsonExact,
  parsePrivateAmount,
  rawCallMessage,
  resolveTxMemo,
} from './dappTx';

/**
 * A site write reduced to the fields the wallet signs. The review renders these and the signer
 * signs these, so the two can never read different aliases of one request.
 */
export interface SiteTx {
  op_type: 'standard' | 'call';
  to: string;
  amount: string;
  /** Calls: the method signed as encrypted_data. */
  method?: string;
  /** Calls: the argument text signed as the message, byte for byte. */
  message?: string;
  /** Transfers: the memo signed as the message. */
  memo?: string;
}

export interface SitePrivateTransfer {
  to: string;
  amount_raw: string;
  asset?: string;
}

export type Normalized<T> = { ok: true; tx: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const present = (v: unknown) => v != null && v !== '';

/** The one value several aliases agree on: '' when none is set, null when two set ones differ. */
function agreed(values: unknown[]): unknown | null {
  const set = values.filter(present);
  if (set.length === 0) return '';
  return set.every((v) => v === set[0]) ? set[0] : null;
}

const firstOf = (raw: unknown): Record<string, unknown> | null => {
  const r = Array.isArray(raw) ? raw[0] : raw;
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
};

/** The argument text a call signs: a JSON array text exactly as sent, anything else serialized. */
export function callArgsText(value: unknown): string | null {
  if (value == null || value === '') return '[]';
  if (typeof value === 'string') {
    const raw = rawCallMessage(value);
    if (raw != null) return raw;
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return JSON.stringify(value);
    }
  }
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

export function reviewArgs(message: string): unknown {
  try {
    return parseJsonExact(message);
  } catch {
    return message;
  }
}

function recipient(r: Record<string, unknown>): Normalized<string> {
  const to = agreed([r.to, r.to_, r.contract]);
  if (to === null) return fail('Request has two different recipients');
  if (typeof to !== 'string' || !isOctAddress(to)) return fail('Invalid recipient address.');
  return { ok: true, tx: to };
}

function call(r: Record<string, unknown>, to: string, amount: bigint): Normalized<SiteTx> {
  const method = agreed([r.method, r.encrypted_data]);
  if (method === null) return fail('Request has two different methods');
  if (typeof method !== 'string' || !method) return fail('A contract call needs a method');
  const texts = [r.params, r.message].filter(present).map(callArgsText);
  if (texts.some((t) => t == null)) return fail('Invalid call arguments');
  const message = agreed(texts);
  if (message === null) return fail('Request has two different argument lists');
  return {
    ok: true,
    tx: {
      op_type: 'call',
      to,
      amount: amount.toString(),
      method,
      message: (message as string) || '[]',
    },
  };
}

export function normalizeSiteTx(raw: unknown): Normalized<SiteTx> {
  const r = firstOf(raw);
  if (!r) return fail('Missing transaction');
  const to = recipient(r);
  if (to.ok === false) return to;
  const amount = parseBaseUnits(r.amount);
  if (amount == null) return fail('Invalid amount');
  const isCall = r.op_type === 'call' || present(r.encrypted_data) || present(r.method);
  if (isCall) return call(r, to.tx, amount);
  if (amount <= 0n) return fail('Invalid amount');
  const memo = resolveTxMemo(r);
  if ('error' in memo) return fail(memo.error);
  return {
    ok: true,
    tx: { op_type: 'standard', to: to.tx, amount: amount.toString(), memo: memo.memo },
  };
}

export function normalizeSiteCall(raw: unknown): Normalized<SiteTx> {
  const r = firstOf(raw);
  if (!r) return fail('Missing contract call');
  const to = recipient(r);
  if (to.ok === false) return to;
  const amount = parseBaseUnits(r.amount);
  if (amount == null) return fail('Invalid amount');
  return call(r, to.tx, amount);
}

export function normalizeSitePrivateTransfer(raw: unknown): Normalized<SitePrivateTransfer> {
  const r = firstOf(raw);
  if (!r) return fail('Missing transfer');
  const to = recipient(r);
  if (to.ok === false) return to;
  const units = parsePrivateAmount(r);
  if (units == null || units > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail('Missing or invalid amount (provide amount_raw).');
  }
  const asset = typeof r.asset === 'string' && r.asset ? r.asset : undefined;
  return { ok: true, tx: { to: to.tx, amount_raw: units.toString(), ...(asset ? { asset } : {}) } };
}
