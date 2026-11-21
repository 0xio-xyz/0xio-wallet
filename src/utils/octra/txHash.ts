import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { logger } from '../logger';

export interface SubmittedTx {
  from: string;
  to_: string;
  amount: string | number;
  nonce: number | string;
  ou: string | number;
  timestamp: number;
  signature: string;
  op_type?: string;
  public_key?: string | null;
  message?: string | null;
  encrypted_data?: string | null;
}

const esc = (s: string) => JSON.stringify(s).slice(1, -1).replace(/\x7f/g, '\\u007f');

/** Plain decimal digits with leading zeros stripped, the node's form of amount and ou. */
export const plainDigits = (v: string | number): string => {
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new Error('Transaction amount and fee must be whole units');
  return s.replace(/^0+(?=\d)/, '');
};

const digits = plainDigits;

const precision = (x: number, p: number): string => {
  const s = x.toPrecision(p);
  if (s.includes('e')) return s;
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** The node's timestamp text: shortest of 16 or 17 digits, ".0" on a whole number. */
export function formatTxTimestamp(ts: number): string {
  if (!Number.isFinite(ts)) throw new Error('Transaction time is not finite');
  let text = precision(ts, 16);
  if (Number(text) !== ts) text = precision(ts, 17);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

const optional = (v: string | null | undefined) => (v == null ? 'null' : `"${esc(v)}"`);

export interface UnsignedTx {
  from: string;
  to_: string;
  amount: string | number;
  nonce: number | string;
  ou: string | number;
  timestamp: number;
  op_type?: string;
  message?: string | null;
  encrypted_data?: string | null;
}

const OPTIONAL_FIELDS = ['public_key', 'message', 'encrypted_data'] as const;

/**
 * A record this wallet builds carries no empty optional field: the node signs and hashes "" as a
 * present field, while the signing text leaves it out, as the reference client does.
 */
export function withoutEmptyOptionals<T extends object>(tx: T): T {
  const out = { ...tx } as Record<string, unknown>;
  for (const field of OPTIONAL_FIELDS) if (out[field] === '') delete out[field];
  return out as T;
}

/** The exact bytes the node rebuilds and checks the signature against. */
export function txSigningJson(tx: UnsignedTx): string {
  return (
    `{"from":"${esc(tx.from)}","to_":"${esc(tx.to_)}","amount":"${digits(tx.amount)}"` +
    `,"nonce":${Number(tx.nonce)},"ou":"${digits(tx.ou)}","timestamp":${formatTxTimestamp(tx.timestamp)}` +
    `,"op_type":"${esc(tx.op_type || 'standard')}"` +
    (tx.encrypted_data ? `,"encrypted_data":"${esc(tx.encrypted_data)}"` : '') +
    (tx.message ? `,"message":"${esc(tx.message)}"` : '') +
    '}'
  );
}

/** The record the node hashes into its tx_hash, field for field. */
export function txHashJson(tx: SubmittedTx): string {
  return (
    `{"from":"${esc(tx.from)}","to_":"${esc(tx.to_)}","amount":"${digits(tx.amount)}"` +
    `,"nonce":${Number(tx.nonce)},"ou":"${digits(tx.ou)}","timestamp":${formatTxTimestamp(tx.timestamp)}` +
    `,"signature":"${esc(tx.signature)}","op_type":"${esc(tx.op_type || 'standard')}"` +
    `,"public_key":${optional(tx.public_key)},"message":${optional(tx.message)}` +
    `,"encrypted_data":${optional(tx.encrypted_data)}}`
  );
}

export function computeTxHash(tx: SubmittedTx): string {
  return bytesToHex(sha256(new TextEncoder().encode(txHashJson(tx))));
}

export function localTxHash(tx: unknown): string | null {
  try {
    return computeTxHash(tx as SubmittedTx);
  } catch {
    return null;
  }
}

/** The local exact hash wins: a node cannot steer it. */
export function trackedTxHash(nodeHash: unknown, local: string | null): string | null {
  const node = typeof nodeHash === 'string' && nodeHash ? nodeHash : null;
  if (node && local && node.toLowerCase() !== local) {
    logger.warn('[txHash] node hash differs from the local one', { node, local });
  }
  return local ?? node;
}
