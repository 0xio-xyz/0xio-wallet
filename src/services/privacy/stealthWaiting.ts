import { privacyNetworkService } from '../network/NetworkService';
import { pvacManager } from '../pvac/PvacManager';
import { scanPrivateOutputs } from '../crypto/PrivateCrypto';
import { base64ToBytes } from 'src/lib/encoding';
import { logger } from 'src/utils/logger';
import type { NetworkPin } from '../network/txScope';
import { claimOutputState } from './claimLedger';
import {
  scanScope,
  scopeKey,
  type MatchedStealthOutput,
  type ScanFindings,
  type StealthOutput,
} from './stealthScan';

/** The amount_hash a v5 claim can take. Any other value is a legacy output the node refuses. */
export const KEY_BOUND_OUTPUT = 'pvac_key_bound_output_v1';

export type StealthClaimStatus =
  | 'ready'
  | 'legacy_stealth_output'
  | 'amount_commitment_missing'
  | 'amount_commitment_mismatch';

type Commit = (amount: number, blinding: Uint8Array) => Promise<Uint8Array>;

/**
 * Whether an output this wallet opened can be claimed (webcli /api/stealth/scan and claim). The
 * tag and the AES-GCM open only say the envelope is addressed here; the claim proof also binds to
 * the stored amount commitment, so the decrypted amount and blinding must reproduce it. `commit`
 * throws when the engine is not ready; the caller then treats the output as not checked yet.
 */
export async function stealthClaimStatus(
  output: Pick<MatchedStealthOutput, 'amount' | 'blinding' | 'amountHash' | 'amountCommitment'>,
  commit: Commit
): Promise<StealthClaimStatus> {
  if (output.amountHash !== KEY_BOUND_OUTPUT) return 'legacy_stealth_output';
  let stored: Uint8Array | null = null;
  try {
    stored = output.amountCommitment ? base64ToBytes(output.amountCommitment) : null;
  } catch {
    stored = null;
  }
  if (!stored || stored.length !== 32) return 'amount_commitment_missing';
  const local = await commit(output.amount, output.blinding);
  if (local.length !== 32) return 'amount_commitment_mismatch';
  for (let i = 0; i < 32; i++) {
    if (local[i] !== stored[i]) return 'amount_commitment_mismatch';
  }
  return 'ready';
}

export async function openOutputs(
  raw: StealthOutput[],
  privateKey: string
): Promise<MatchedStealthOutput[]> {
  const byId = new Map(raw.map((o) => [Number(o.id), o]));
  const mine = await scanPrivateOutputs(raw, privateKey);
  return mine.map((m) => ({
    ...m,
    amountHash: byId.get(m.id)?.amount_hash,
    amountCommitment: byId.get(m.id)?.amount_commitment,
  }));
}

async function checkOwnership(
  matched: MatchedStealthOutput[],
  prepare: () => Promise<void>
): Promise<ScanFindings> {
  const found: ScanFindings = { claimable: [], unchecked: [] };
  if (matched.length === 0) return found;
  let ready = true;
  try {
    await prepare();
  } catch (e) {
    ready = false;
    logger.warn('[ClaimScan] engine not ready, ownership check deferred:', e);
  }
  const commit: Commit = (amount, blinding) => {
    if (!ready) throw new Error('engine not ready');
    return pvacManager.pedersenCommitRawAsync(amount, blinding);
  };
  for (const m of matched) {
    try {
      const status = await stealthClaimStatus(m, commit);
      if (status === 'ready') found.claimable.push(m);
      else logger.debug(`[ClaimScan] output ${m.id} is ours but not claimable: ${status}`);
    } catch {
      found.unchecked.push(m.id);
    }
  }
  return found;
}

export interface WaitingScan {
  address: string;
  privateKey: string;
  pin: NetworkPin;
  stillHere: () => boolean | Promise<boolean>;
  prepare: () => Promise<void>;
}

export function scanWaiting(p: WaitingScan): Promise<MatchedStealthOutput[] | null> {
  const t0 = Date.now();
  return scanScope(scopeKey(p.pin.networkId, p.address), {
    head: () => privacyNetworkService.getHeadEpoch(p.pin),
    fetch: async (fromEpoch, headEpoch) => {
      logger.debug(`[ClaimScan] Scanning ${p.pin.networkId} from epoch ${fromEpoch}`);
      const scan = await privacyNetworkService.getStealthOutputsPaged(fromEpoch, {
        at: p.pin,
        headEpoch,
      });
      logger.debug(
        `[ClaimScan] ${scan.outputs.length} outputs in ${Date.now() - t0}ms${scan.complete ? '' : ' (incomplete, cursor kept)'}`
      );
      return scan;
    },
    byId: (ids, minEpoch) =>
      privacyNetworkService.getStealthOutputsById(ids, {
        at: p.pin,
        minEpoch,
        partial: true,
        lane: 'poll',
      }),
    match: (raw) => openOutputs(raw, p.privateKey),
    check: (matched) => checkOwnership(matched, p.prepare),
    stillHere: async () => p.stillHere(),
  });
}

export type FreshOutput =
  | { kind: 'ready'; output: MatchedStealthOutput }
  | { kind: 'claimed' }
  | { kind: 'notClaimable'; reason: string };

/**
 * The output as the node holds it right now, opened again with this wallet's key and its
 * commitment checked, so a claim never runs on what an older scan saw (webcli reads it by id).
 */
export async function freshStealthOutput(p: {
  id: number;
  epoch?: number;
  privateKey: string;
  pin: NetworkPin;
  prepare: () => Promise<void>;
}): Promise<FreshOutput | null> {
  const outputs = await privacyNetworkService.getStealthOutputsById([p.id], {
    at: p.pin,
    minEpoch: p.epoch,
  });
  const raw = outputs?.find((o) => Number(o.id) === p.id) as StealthOutput | undefined;
  const state = claimOutputState(raw ? { ok: true, claimed: raw.claimed } : { ok: false });
  if (state === 'unknown') return null;
  if (state === 'spent') return { kind: 'claimed' };
  const [mine] = await openOutputs([raw], p.privateKey);
  if (!mine) return { kind: 'notClaimable', reason: 'not_ours' };
  await p.prepare();
  const status = await stealthClaimStatus(mine, (a, b) => pvacManager.pedersenCommitRawAsync(a, b));
  return status === 'ready'
    ? { kind: 'ready', output: mine }
    : { kind: 'notClaimable', reason: status };
}
