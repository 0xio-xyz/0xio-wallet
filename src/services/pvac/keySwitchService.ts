import { logger } from 'src/utils/logger';
import { base64ToBytes, bytesToHex } from 'src/lib/encoding';
import type { TransactionHistoryItem } from 'src/types/transaction';
import { resolveNetworkPin, storedNetworkId, type NetworkPin } from '../network/txScope';

const STORAGE_KEY = 'pvac_pending_key_switch';

export interface KeySwitchScope {
  networkId: string;
  address: string;
}

const slot = (s: KeySwitchScope) => `${s.networkId}:${s.address}`;

export interface PendingKeySwitch {
  address: string;
  networkId?: string;
  txId: string;
  submittedAt: number;
  /** What the key_switch does. 'rotation' changes the registered pubkey - "keys match" proves
   *  it completed. 'migration' is a SAME-KEY switch (compact refresh / bound migration): keys
   *  match the whole time it is in staging, so only its tx status may settle it. Records
   *  written before this field exists are treated as rotations. */
  kind?: 'rotation' | 'migration';
}

type PendingMap = Record<string, PendingKeySwitch>;

async function load(): Promise<PendingMap> {
  let map: PendingMap;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const parsed = stored[STORAGE_KEY];
    map = parsed && typeof parsed === 'object' ? (parsed as PendingMap) : {};
  } catch {
    return {};
  }
  // Records from before the network scope were keyed by address alone. They were almost always
  // made on the network still selected, so they move there once and settle by their tx status.
  const legacy = Object.keys(map).filter((k) => !k.includes(':'));
  if (legacy.length > 0) {
    const net = await storedNetworkId();
    for (const k of legacy) {
      const rec = map[k];
      delete map[k];
      const key = slot({ networkId: net, address: rec.address || k });
      if (!map[key]) map[key] = { ...rec, address: rec.address || k, networkId: net };
    }
    await save(map);
  }
  return map;
}

async function save(map: PendingMap): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: map });
  } catch (e) {
    logger.warn(`[keySwitch] could not persist pending rotation: ${e}`);
  }
}

export async function recordPendingKeySwitch(
  scope: KeySwitchScope,
  txId: string,
  kind: 'rotation' | 'migration' = 'rotation'
): Promise<void> {
  const { networkId, address } = scope;
  const map = await load();
  map[slot(scope)] = { address, networkId, txId, submittedAt: Date.now(), kind };
  await save(map);
  logger.debug(
    `[keySwitch] recorded pending ${kind} for ${address.slice(0, 8)}... on ${networkId} -> ${txId}`
  );
}

export async function getPendingKeySwitch(scope: KeySwitchScope): Promise<PendingKeySwitch | null> {
  const map = await load();
  return map[slot(scope)] ?? null;
}

export async function clearPendingKeySwitch(
  scope: KeySwitchScope,
  onlyTxId?: string
): Promise<void> {
  const key = slot(scope);
  const address = scope.address;
  const map = await load();
  if (!map[key]) return;
  // Guarded clear: only remove the record the caller actually resolved. A settled-status check
  // races with a resubmit writing a NEW record into the same slot - an unguarded delete here
  // dropped the live tx's record and re-offered Migrate while it sat in staging.
  if (onlyTxId && map[key].txId !== onlyTxId) {
    logger.debug(
      `[keySwitch] not clearing pending rotation for ${address.slice(0, 8)}... - record now tracks ${map[key].txId.slice(0, 8)}..., caller resolved ${onlyTxId.slice(0, 8)}...`
    );
    return;
  }
  delete map[key];
  await save(map);
  logger.debug(`[keySwitch] cleared pending rotation for ${address.slice(0, 8)}...`);
}

export const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RotationState =
  | { kind: 'none' }
  | { kind: 'pending'; txHash: string; submittedAt: number }
  | { kind: 'stuck'; txHash: string; submittedAt: number };

/**
 * SHA-256 over the base64-decoded pubkey, first 8 bytes as hex - the `new_key:`
 * value webcli writes into the key_switch memo.
 */
export async function pubkeyHashPrefix(pubkeyB64: string): Promise<string> {
  const bytes = base64ToBytes(pubkeyB64);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return bytesToHex(new Uint8Array(digest).slice(0, 8));
}

const MAX_ROTATION_DETAIL_LOOKUPS = 4;

export function findKeySwitchCandidates(
  txs: TransactionHistoryItem[],
  address: string
): TransactionHistoryItem[] {
  return txs
    .filter((tx) => tx.from === address && tx.opType === 'key_switch')
    .sort((a, b) => b.timestamp - a.timestamp);
}

function classify(txHash: string, rawTimestamp: number, now: number): RotationState {
  const submittedAt = rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp;
  return {
    kind: now - submittedAt < PENDING_WINDOW_MS ? 'pending' : 'stuck',
    txHash,
    submittedAt,
  };
}

/**
 * octra_transactionsByAddress omits `message`, so candidates come from opType in
 * the list and are confirmed against the memo via octra_transaction.
 */
export async function resolveRotationState(
  scope: KeySwitchScope & NetworkPin,
  localPubkeyB64: string,
  now = Date.now()
): Promise<RotationState> {
  const { address } = scope;
  const record = await getPendingKeySwitch(scope);
  if (record && now - record.submittedAt < PENDING_WINDOW_MS) {
    return { kind: 'pending', txHash: record.txId, submittedAt: record.submittedAt };
  }
  try {
    const prefix = await pubkeyHashPrefix(localPubkeyB64);
    const { networkService } = await import('../network/NetworkService');
    // History reads both built-ins: only this network's key_switch txs speak for its key.
    const txs = (await networkService.getTransactionHistory(address)).filter(
      (tx) => !tx.network || tx.network === scope.networkId
    );
    const candidates = findKeySwitchCandidates(txs, address);
    const marker = `new_key:${prefix}`.toLowerCase();

    for (const candidate of candidates.slice(0, MAX_ROTATION_DETAIL_LOOKUPS)) {
      const detail = await networkService.jsonRpcCall(
        'octra_transaction',
        [candidate.hash],
        undefined,
        scope
      );
      const message: unknown = detail?.message;
      if (typeof message === 'string' && message.toLowerCase().includes(marker)) {
        return classify(candidate.hash, detail?.timestamp || candidate.timestamp, now);
      }
    }
    return { kind: 'none' };
  } catch (e) {
    logger.warn(`[keySwitch] rotation history lookup failed: ${e}`);
    return record
      ? { kind: 'stuck', txHash: record.txId, submittedAt: record.submittedAt }
      : { kind: 'none' };
  }
}

export const blockedAckKey = (networkId: string, address: string) =>
  `pvac_blocked_ack_${networkId}_${address}`;

// --- Key switch mode resolution (webcli main.cpp:2280-2470, mirrored from desktop) ---
// A locked balance must migrate INSIDE the key_switch tx; the node refuses a bare rotation
// while one exists.

import {
  networkService as netSvc,
  privacyNetworkService as privNetSvc,
} from '../network/NetworkService';

export type KeySwitchMode =
  | { mode: 'empty_key_switch' }
  | { mode: 'legacy_public_migration'; amount: number }
  | { mode: 'legacy_zero_reset' }
  /** A key-bound balance cannot take a bare rotation - it needs the equality-proof bound
   *  migration, which lives on the "Migrate balance" path (useMigrateBalance),
   *  not here. keyCurrent = the node reports key_class "current": the KEY is fine, only the
   *  balance awaits migration - show the calmer balance-hold copy, not a key scare. */
  | { mode: 'key_bound_unavailable'; keyCurrent: boolean }
  | { mode: 'blocked'; reason: string };

export const ACCOUNT_STATE_UNREAD = 'Account state unavailable. Try again.';

/**
 * What a key update would do for this account on the pinned network. webcli refuses to submit
 * when the upgrade status cannot be read, and allows a bare rotation only when the node shows no
 * cipher at all: a decrypted 0 is not proof (the read can fail, be skipped or be corrupt).
 */
export async function resolveKeySwitchMode(
  address: string,
  privateKey: string,
  publicKey?: string,
  at?: NetworkPin
): Promise<KeySwitchMode> {
  const pin = at ?? (await resolveNetworkPin());
  const read = await netSvc.readPvacMigrationStatus(address, pin);

  if (read.kind === 'failed') return { mode: 'blocked', reason: ACCOUNT_STATE_UNREAD };
  if (read.kind === 'unsupported') {
    const bal = await privNetSvc.getEncryptedBalanceDevnet(
      address,
      privateKey,
      publicKey as string,
      pin
    );
    if (!bal?.success) return { mode: 'blocked', reason: ACCOUNT_STATE_UNREAD };
    if (!bal.cipher || bal.cipher === '0') return { mode: 'empty_key_switch' };
    return {
      mode: 'blocked',
      reason:
        "This network node doesn't support migrating encrypted balances during a key update yet.",
    };
  }
  const status = read.status;
  const cls = status.cipher_class ?? '';

  if (cls === 'empty') return { mode: 'empty_key_switch' };

  if (cls === 'v3' || cls === 'key_bound') {
    return { mode: 'key_bound_unavailable', keyCurrent: status.key_class === 'current' };
  }

  const replay = status.legacy_public_replay;
  const replayNet = replay?.public_net_raw ?? replay?.public_net;
  if (replay?.can_public_migrate && replayNet != null) {
    const replayAmount = parseInt(String(replayNet), 10);
    if (!Number.isFinite(replayAmount) || replayAmount < 0) {
      return { mode: 'blocked', reason: 'legacy public migration replay amount is invalid' };
    }
    // webcli pvac_upgrade_policy::replay_matches - the local decode must equal the replay.
    const bal = await privNetSvc.getEncryptedBalanceDevnet(
      address,
      privateKey,
      publicKey as string,
      pin
    );
    if (
      !bal?.success ||
      bal.cipherCorrupted ||
      bal.decryptSkipped ||
      (bal.encryptedRaw ?? -1) !== replayAmount
    ) {
      return {
        mode: 'blocked',
        reason: 'legacy public replay does not match the locally decoded balance',
      };
    }
    if (replayAmount === 0) return { mode: 'legacy_zero_reset' };
    return { mode: 'legacy_public_migration', amount: replayAmount };
  }
  if (replay?.audit_class === 'hidden_witness') {
    return {
      mode: 'blocked',
      reason: 'legacy hidden balance needs commitment migration (not supported yet)',
    };
  }
  return {
    mode: 'blocked',
    reason:
      replay?.reason || status.reason || 'the node does not allow a key switch for this account',
  };
}
