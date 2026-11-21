// The claims this device sent, per network and address (webcli lib/tx_journal.hpp claim rows and
// notes, main.cpp claim_slot and observe_own_tx). A saved claim decides what the next claim of the
// same output may do: an earlier one stands, a conflict waits out the staging lifetime, and an
// open outcome resends exactly the bytes already signed.

import { networkService, privacyNetworkService, rpcNonce } from '../network/NetworkService';
import { rpcCondition } from '../network/rpcExchange';
import { statusOutcome } from '../wallet/historyRows';
import { localTxHash } from 'src/utils/octra/txHash';
import { logger } from 'src/utils/logger';
import type { NetworkPin } from '../network/txScope';
import type { SignedTransaction } from 'src/types/transaction';

export type ClaimOutputState = 'unspent' | 'spent' | 'unknown';

export const CLAIM_STAGING_LIFETIME_MS = 600_000;
export const CLAIM_SPENT_TEXT = 'Claim output is spent; nothing was sent';
export const CLAIM_UNREADABLE_TEXT = 'Claim output state is unavailable; nothing was sent';
export const CLAIM_CONFLICT_TEXT =
  'Confirmed claim conflicts with current output state; nothing was sent';
export const CLAIM_MISSING_TEXT =
  'claim not found on node and output unspent after staging lifetime';

export type ClaimErrorCode =
  | 'CLAIM_OUTPUT_SPENT'
  | 'CLAIM_OUTPUT_UNREADABLE'
  | 'CLAIM_CONFLICT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'NETWORK_ERROR';

export interface ClaimRefusal {
  success: false;
  error: string;
  code: ClaimErrorCode;
}

export const CLAIM_CONFLICT_REFUSAL: ClaimRefusal = {
  success: false,
  error: CLAIM_CONFLICT_TEXT,
  code: 'CLAIM_CONFLICT',
};

export function claimOutputRefusal(state: 'spent' | 'unknown'): ClaimRefusal {
  return state === 'spent'
    ? { success: false, error: CLAIM_SPENT_TEXT, code: 'CLAIM_OUTPUT_SPENT' }
    : { success: false, error: CLAIM_UNREADABLE_TEXT, code: 'CLAIM_OUTPUT_UNREADABLE' };
}

export function claimFaultCode(e: unknown): ClaimErrorCode | null {
  const fault = (e as { fault?: unknown } | null)?.fault;
  if (fault === 'capacity' || fault === 'busy') return 'RATE_LIMIT_EXCEEDED';
  if (fault === 'network' || fault === 'deadline') return 'NETWORK_ERROR';
  const message = e instanceof Error ? e.message : '';
  if (message.startsWith(rpcCondition('capacity'))) return 'RATE_LIMIT_EXCEEDED';
  if (message.startsWith(rpcCondition('busy'))) return 'RATE_LIMIT_EXCEEDED';
  if (message.startsWith(rpcCondition('network'))) return 'NETWORK_ERROR';
  return null;
}

export type ClaimStatus = 'unknown' | 'pending' | 'confirmed' | 'rejected' | 'dropped' | 'missing';

export interface ClaimRow {
  outputId: number;
  hash: string;
  nonce: number;
  status: ClaimStatus;
  at: number;
  tx?: SignedTransaction;
  stagedAt?: number;
  conflictAt?: number;
  released?: boolean;
}

export type ClaimSlot =
  | { kind: 'fresh' }
  | { kind: 'previous' | 'recovery' | 'blocked'; row: ClaimRow };

export type ClaimLookup = 'pending' | 'confirmed' | 'rejected' | 'dropped' | 'notFound' | 'error';

export function claimOutputState(reply: { ok: boolean; claimed?: unknown }): ClaimOutputState {
  if (!reply.ok || !Number.isInteger(reply.claimed)) return 'unknown';
  return reply.claimed === 0 ? 'unspent' : 'spent';
}

export function claimSlot(row: ClaimRow | null): ClaimSlot {
  if (!row) return { kind: 'fresh' };
  if (row.status === 'confirmed' && row.conflictAt !== undefined) return { kind: 'blocked', row };
  if (row.status === 'pending' || row.status === 'confirmed') return { kind: 'previous', row };
  if (row.status === 'unknown' && !row.released) return { kind: 'previous', row };
  if ((row.status === 'unknown' || row.status === 'dropped') && row.tx) {
    return { kind: 'recovery', row };
  }
  return { kind: 'fresh' };
}

export type ClaimResend = 'resend' | 'fresh' | 'spent' | 'unreadable';

/**
 * Whether a dropped or released claim goes again as its saved bytes: only while the output reads
 * unspent, its nonce is still the next one and its fee is the one just reviewed.
 */
export function claimResend(
  row: ClaimRow,
  output: ClaimOutputState,
  nextNonce: number | null,
  ou: string
): ClaimResend {
  if (output === 'spent') return 'spent';
  if (output === 'unknown') return 'unreadable';
  if (!row.tx || nextNonce !== row.nonce || String(row.tx.ou) !== String(ou)) return 'fresh';
  return 'resend';
}

const openUnknown = (row: ClaimRow) => row.status === 'unknown' && !row.released;

const pendingLike = (s: ClaimStatus) => s === 'pending' || s === 'unknown' || s === 'dropped';

export function claimNeedsOutput(row: ClaimRow, lookup: ClaimLookup): boolean {
  const missing =
    (row.status === 'pending' || row.status === 'confirmed' || openUnknown(row)) &&
    lookup === 'notFound';
  const found =
    row.status === 'confirmed' && row.conflictAt !== undefined && lookup === 'confirmed';
  return missing || found;
}

export function observeClaim(
  row: ClaimRow,
  lookup: ClaimLookup,
  output: ClaimOutputState,
  nonce: { confirmed: number | null; pending: number | null },
  now: number
): ClaimRow {
  if (row.status === 'missing') return row;
  const missingOnNode =
    (row.status === 'pending' || row.status === 'confirmed') && lookup === 'notFound';
  const foundAgain =
    row.status === 'confirmed' && row.conflictAt !== undefined && lookup === 'confirmed';
  if (output === 'unspent' && row.status === 'confirmed' && missingOnNode) {
    if (row.conflictAt === undefined) return { ...row, conflictAt: now };
    if (now - row.conflictAt <= CLAIM_STAGING_LIFETIME_MS) return row;
    const { conflictAt: _c, tx: _t, ...rest } = row;
    return { ...rest, status: 'missing' };
  }
  if (!pendingLike(row.status) && !(output === 'spent' && foundAgain)) return row;
  if (lookup === 'pending' || lookup === 'dropped') {
    const next: ClaimRow = { ...row, status: lookup };
    if (lookup === 'pending') {
      next.stagedAt ??= now;
      delete next.tx;
    }
    return next;
  }
  if (lookup === 'confirmed' || lookup === 'rejected') {
    const { conflictAt: _c, tx: _t, ...rest } = row;
    return { ...rest, status: lookup };
  }
  if (output === 'unspent' && (missingOnNode || (openUnknown(row) && lookup === 'notFound'))) {
    const confirmed = nonce.confirmed ?? -1;
    const pending = nonce.pending ?? -1;
    const since = row.stagedAt ?? (row.status === 'unknown' ? row.at : undefined);
    const staged = since !== undefined && now - since > CLAIM_STAGING_LIFETIME_MS;
    if (confirmed >= row.nonce || (pending < row.nonce && staged)) {
      return { ...row, status: 'unknown', released: true };
    }
    if (row.stagedAt === undefined) return { ...row, stagedAt: now };
  }
  return row;
}

const ledgerKey = (pin: Pick<NetworkPin, 'networkId'>, address: string) =>
  `claim_ledger_${pin.networkId}_${address}`;

type Ledger = Record<string, ClaimRow>;

const MAX_ROWS = 100;
const chains = new Map<string, Promise<unknown>>();

async function readLedger(key: string): Promise<Ledger> {
  const stored = (await chrome.storage.local.get(key))[key];
  return stored && typeof stored === 'object' ? (stored as Ledger) : {};
}

function withLedger<T>(key: string, fn: (ledger: Ledger) => T | Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(async () => {
    const ledger = await readLedger(key);
    const out = await fn(ledger);
    const rows = Object.entries(ledger).sort(([, a], [, b]) => b.at - a.at);
    await chrome.storage.local.set({ [key]: Object.fromEntries(rows.slice(0, MAX_ROWS)) });
    return out;
  });
  chains.set(
    key,
    run.catch((): void => undefined)
  );
  return run;
}

export async function savedClaim(
  pin: Pick<NetworkPin, 'networkId'>,
  address: string,
  outputId: number
): Promise<ClaimRow | null> {
  const key = ledgerKey(pin, address);
  await chains.get(key);
  return (await readLedger(key))[String(outputId)] ?? null;
}

async function putClaim(pin: Pick<NetworkPin, 'networkId'>, address: string, row: ClaimRow) {
  await withLedger(ledgerKey(pin, address), (ledger) => {
    ledger[String(row.outputId)] = row;
  });
}

export async function readClaimOutput(
  pin: NetworkPin,
  outputId: number,
  epoch?: number
): Promise<ClaimOutputState> {
  const outputs = await privacyNetworkService.getStealthOutputsById([outputId], {
    at: pin,
    minEpoch: epoch,
    timeoutMs: 5_000,
  });
  const raw = outputs?.find((o: { id?: unknown }) => Number(o?.id) === outputId);
  return claimOutputState(raw ? { ok: true, claimed: raw.claimed } : { ok: false });
}

async function lookupClaim(pin: NetworkPin, hash: string): Promise<ClaimLookup> {
  const res = await networkService.getTransactionStatus(hash, pin);
  if (String(res.status).toLowerCase() === 'dropped') return 'dropped';
  return statusOutcome(res);
}

async function nodeNonce(pin: NetworkPin, address: string) {
  try {
    const r = await networkService.jsonRpcCall('octra_balance', [address], true, pin);
    return { confirmed: rpcNonce(r?.nonce), pending: rpcNonce(r?.pending_nonce) };
  } catch {
    return { confirmed: null, pending: null };
  }
}

export async function claimSlotFor(
  pin: NetworkPin,
  address: string,
  outputId: number,
  epoch?: number
): Promise<ClaimSlot> {
  let row = await savedClaim(pin, address, outputId);
  if (row && row.status !== 'rejected' && row.status !== 'missing') {
    const lookup = await lookupClaim(pin, row.hash);
    const output = claimNeedsOutput(row, lookup)
      ? await readClaimOutput(pin, outputId, epoch)
      : 'unknown';
    const nonce =
      (row.status === 'pending' || openUnknown(row)) &&
      lookup === 'notFound' &&
      output === 'unspent'
        ? await nodeNonce(pin, address)
        : { confirmed: null, pending: null };
    const next = observeClaim(row, lookup, output, nonce, Date.now());
    if (next !== row) {
      if (next.status === 'missing') {
        logger.warn(`[ClaimLedger] output ${outputId}: ${CLAIM_MISSING_TEXT}`);
      }
      await putClaim(pin, address, next);
      row = next;
    }
  }
  return claimSlot(row);
}

export async function claimResendFor(
  pin: NetworkPin,
  address: string,
  row: ClaimRow,
  ou: string,
  epoch?: number
): Promise<ClaimResend> {
  const output = await readClaimOutput(pin, row.outputId, epoch);
  if (output !== 'unspent') return claimResend(row, output, null, ou);
  const n = await nodeNonce(pin, address);
  const next =
    n.confirmed === null && n.pending === null
      ? null
      : Math.max(n.confirmed ?? -1, n.pending ?? -1) + 1;
  return claimResend(row, output, next, ou);
}

/** Saves the claim row before its bytes leave; the hash is null when it cannot be tracked. */
export async function noteClaimSent(
  pin: NetworkPin,
  address: string,
  outputId: number,
  signedTx: SignedTransaction
): Promise<string | null> {
  const hash = localTxHash(signedTx);
  if (!hash) return null;
  const row: ClaimRow = {
    outputId,
    hash,
    nonce: Number(signedTx.nonce),
    status: 'unknown',
    at: Date.now(),
    tx: signedTx,
  };
  await putClaim(pin, address, row);
  return hash;
}

export async function noteClaimOutcome(
  pin: NetworkPin,
  address: string,
  outputId: number,
  hash: string,
  status: 'pending' | 'rejected'
): Promise<void> {
  await withLedger(ledgerKey(pin, address), (ledger) => {
    const row = ledger[String(outputId)];
    if (!row || row.hash !== hash) return;
    const { tx: _t, ...rest } = row;
    ledger[String(outputId)] =
      status === 'pending'
        ? { ...rest, status, stagedAt: row.stagedAt ?? Date.now() }
        : { ...rest, status };
  });
}

export async function sendClaim<R extends { success?: boolean; errorType?: unknown }>(
  pin: NetworkPin,
  address: string,
  outputId: number,
  signedTx: SignedTransaction,
  send: (tx: SignedTransaction) => Promise<R>
): Promise<R> {
  const hash = await noteClaimSent(pin, address, outputId, signedTx);
  const result = await send(signedTx);
  if (hash && (result?.success || result?.errorType)) {
    await noteClaimOutcome(pin, address, outputId, hash, result.success ? 'pending' : 'rejected');
  }
  return result;
}
