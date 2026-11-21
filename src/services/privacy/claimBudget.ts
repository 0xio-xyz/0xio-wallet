// Claims are broadcast-only: the balance cipher grows when the node EXECUTES them, so any fresh
// octra_encryptedBalance read during a burst sees the same stale layer count.
//
// Rules (webcli-verified math - see pvacPolicy.ts):
// - seed from executed state; the SAME cipher fingerprint never resets in-flight decrements
// - implausible layer readings (not finite/even/>= 2) fail CLOSED
// - a missing cipher (first-time claimer) seeds the true cap for B=0: three claims
// - an unseeded consume allows exactly ONE claim, then pins the budget to zero until a
//   successful re-seed - "transport fail-open" must never mean "unlimited"
// - refunds are clamped to the seeded cap and only issued for DEFINITIVE rejections
//   (an ambiguous timeout may have executed - the slot stays consumed)

import { claimCap } from 'src/services/pvac/pvacPolicy';
import { networkService } from 'src/services/network/NetworkService';
import { logger } from 'src/utils/logger';

interface BudgetEntry {
  remaining: number;
  cap: number;
  cipherFp: string;
}

const STORAGE_PREFIX = 'claim_budget_';

/** Budget for a first-time claimer (no cipher yet): B=0, so floor((6-0)/2) = 3 claims. */
const EMPTY_BALANCE_CAP = 3;
const EMPTY_FP = 'empty';
const UNSEEDED_FP = 'unseeded';
// A bad layer reading over a REAL cipher - unlike the transport pin, empty-seed must never
// lift this one (the cipher exists; only a plausible read may re-seed).
const IMPLAUSIBLE_FP = 'implausible';

const memStore = new Map<string, BudgetEntry>();

const rmwChains = new Map<string, Promise<unknown>>();

let forceMemStore = false;

// SINGLE-WRITER: chrome.storage.local get/set is not atomic, and the popup and background
// service worker each hold their own module instance - interleaved read-modify-writes lose
// decrements (one lost decrement past six layers = unrecoverable balance). All mutations from
// other contexts are therefore delegated to the background via CLAIM_BUDGET_OP; only the
// background touches storage, making its per-address chain globally authoritative.
// The background marks itself EXPLICITLY (background/index.ts calls markSingleWriterContext()
// right after its polyfills) - a `typeof window` sniff is unusable because background/polyfills.ts
// defines window in the SW, and Firefox's event page has a real window anyway.
let isSingleWriter = false;

export function markSingleWriterContext(): void {
  isSingleWriter = true;
}

function canDelegate(): boolean {
  return (
    !isSingleWriter &&
    !forceMemStore &&
    typeof chrome !== 'undefined' &&
    !!chrome.runtime?.sendMessage
  );
}

async function delegate<T>(
  op: string,
  networkId: string | undefined,
  payload: Record<string, unknown>
): Promise<T> {
  // Resolved here, at the call, and sent along: the background must not re-read the network.
  const net = networkId ?? (await networkService.getCurrentNetworkId());
  const res = await chrome.runtime.sendMessage({
    type: 'CLAIM_BUDGET_OP',
    op,
    ...payload,
    networkId: net,
  });
  // A rejected/failed handler responds undefined: normalize to the declared API types so
  // every caller fails CLOSED (consume -> false blocks; remaining -> null = no cap known).
  if (res === undefined) {
    logger.warn(
      `[ClaimBudget] delegated '${op}' got NO response from the background - failing ${op === 'consume' ? 'CLOSED (claim blocked)' : 'open'}; check the service worker console`
    );
    return (op === 'consume' ? false : null) as T;
  }
  return res as T;
}

function hasChromeStorage(): boolean {
  if (forceMemStore) return false;
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

// Budgets are chain state: the same address exists on devnet AND mainnet with different
// ciphers/layers, so every key is scoped by a network id - the caller's when it gave one.
async function budgetKey(address: string, networkId?: string): Promise<string> {
  const network = networkId ?? (await networkService.getCurrentNetworkId());
  return `${STORAGE_PREFIX}${network}_${address}`;
}

async function readEntryByKey(key: string): Promise<BudgetEntry | null> {
  if (!hasChromeStorage()) return memStore.get(key) ?? null;
  const got = await chrome.storage.local.get(key);
  return (got[key] as BudgetEntry | undefined) ?? null;
}

async function writeEntryByKey(key: string, entry: BudgetEntry | null): Promise<void> {
  if (!hasChromeStorage()) {
    if (entry === null) memStore.delete(key);
    else memStore.set(key, entry);
    return;
  }
  if (entry === null) await chrome.storage.local.remove(key);
  else await chrome.storage.local.set({ [key]: entry });
}

function chained<T>(address: string, fn: () => Promise<T>): Promise<T> {
  const prev = rmwChains.get(address) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  rmwChains.set(address, next);
  return next;
}

export function fingerprint(cipher: string): string {
  return `${cipher.length}:${cipher.slice(0, 48)}`;
}

export function plausibleLayers(layers: unknown): layers is number {
  return typeof layers === 'number' && Number.isFinite(layers) && layers >= 2 && layers % 2 === 0;
}

export function seedClaimBudget(
  address: string,
  cipher: string,
  layers: number,
  networkId?: string
): Promise<void> {
  if (canDelegate()) return delegate('seed', networkId, { address, cipher, layers });
  return chained(address, async () => {
    // Resolve the network-scoped key ONCE per op - a network switch mid-op must not split
    // the read and write across two networks (lost decrement + cross-chain corruption).
    const key = await budgetKey(address, networkId);
    const fp = fingerprint(cipher);
    const existing = await readEntryByKey(key);
    if (existing && existing.cipherFp === fp) return;
    if (!plausibleLayers(layers)) {
      // Pin (not clear): a cleared entry would hand the next consume the one-claim
      // unseeded allowance - fail closed means ZERO claims until a plausible read.
      await writeEntryByKey(key, { remaining: 0, cap: 0, cipherFp: IMPLAUSIBLE_FP });
      logger.warn(`[ClaimBudget] implausible layer reading (${layers}) - failing closed`);
      return;
    }
    const cap = claimCap(layers);
    await writeEntryByKey(key, { remaining: cap, cap, cipherFp: fp });
    logger.debug(`[ClaimBudget] seeded ${address.slice(0, 10)}: layers=${layers} budget=${cap}`);
  });
}

export function seedClaimBudgetEmpty(address: string, networkId?: string): Promise<void> {
  if (canDelegate()) return delegate('seedEmpty', networkId, { address });
  return chained(address, async () => {
    const key = await budgetKey(address, networkId);
    const existing = await readEntryByKey(key);
    // A cipher that once existed cannot un-exist: a false "no cipher" (node quirk '0') must
    // never reset a real budget. Empty-seed only from no-entry or the unseeded pin.
    if (existing && existing.cipherFp !== UNSEEDED_FP) return;
    await writeEntryByKey(key, {
      remaining: EMPTY_BALANCE_CAP,
      cap: EMPTY_BALANCE_CAP,
      cipherFp: EMPTY_FP,
    });
    logger.debug(
      `[ClaimBudget] seeded ${address.slice(0, 10)} (no cipher yet): budget=${EMPTY_BALANCE_CAP}`
    );
  });
}

export function consumeClaimSlot(address: string, networkId?: string): Promise<boolean> {
  if (canDelegate()) return delegate('consume', networkId, { address });
  return chained(address, async () => {
    const key = await budgetKey(address, networkId);
    const e = await readEntryByKey(key);
    if (!e) {
      await writeEntryByKey(key, { remaining: 0, cap: 0, cipherFp: UNSEEDED_FP });
      logger.warn(
        `[ClaimBudget] unseeded consume for ${address.slice(0, 10)} - allowing ONE claim`
      );
      return true;
    }
    if (e.remaining <= 0) return false;
    e.remaining -= 1;
    await writeEntryByKey(key, e);
    logger.debug(`[ClaimBudget] consumed slot for ${address.slice(0, 10)} - ${e.remaining} left`);
    return true;
  });
}

export function refundClaimSlot(address: string, networkId?: string): Promise<void> {
  if (canDelegate()) return delegate('refund', networkId, { address });
  return chained(address, async () => {
    const key = await budgetKey(address, networkId);
    const e = await readEntryByKey(key);
    if (!e) return;
    e.remaining = Math.min(e.cap, e.remaining + 1);
    await writeEntryByKey(key, e);
  });
}

export function remainingClaims(address: string, networkId?: string): Promise<number | null> {
  if (canDelegate()) return delegate('remaining', networkId, { address });
  return chained(address, async () => {
    const e = await readEntryByKey(await budgetKey(address, networkId));
    return e ? e.remaining : null;
  });
}

export function resetClaimBudget(address: string, networkId?: string): Promise<void> {
  if (canDelegate()) return delegate('reset', networkId, { address });
  return chained(address, async () => {
    await writeEntryByKey(await budgetKey(address, networkId), null);
  });
}

export function _clearMemStoreForTests(): void {
  forceMemStore = true;
  memStore.clear();
}

export function _setForceMemStoreForTests(v: boolean): void {
  forceMemStore = v;
}
