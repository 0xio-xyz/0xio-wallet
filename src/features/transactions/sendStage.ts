import type { TransactionStatusResult } from 'src/types/network';
import { isCustomNetworkId, type NetworkId } from 'src/utils/config';
import { getExplorerTxUrl } from 'src/utils/network';
import { cleanAmountInput, formatUnits, fromUnits, toUnits } from 'src/utils/amount';
import { normalizeAddress } from 'src/utils/octra/address';

export type SendStage = 'form' | 'review' | 'sending' | 'pending' | 'done' | 'failed';
export type PollOutcome = 'pending' | 'done' | 'failed';

export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 300_000;

export const isResultStage = (stage: SendStage) =>
  stage === 'pending' || stage === 'done' || stage === 'failed';

/** Submit only reaches the mempool: a send reads Sent once the node confirms it, never before. */
export const stageFromStatus = (
  res: Pick<TransactionStatusResult, 'status' | 'confirmed' | 'finality'>
): PollOutcome => {
  if (
    res.status === 'rejected' ||
    res.status === 'dropped' ||
    res.status === 'expired' ||
    res.finality === 'rejected'
  ) {
    return 'failed';
  }
  if (res.confirmed || res.finality === 'confirmed' || res.status === 'confirmed') return 'done';
  return 'pending';
};

export const stageAfterError = (broadcast: boolean, stage: SendStage): SendStage => {
  if (!broadcast) return 'form';
  return isResultStage(stage) ? stage : 'pending';
};

export const bulkStage = (accepted: number, total: number): 'done' | 'failed' | null =>
  accepted <= 0 ? null : accepted >= total ? 'done' : 'failed';

export interface PollResult {
  outcome: PollOutcome;
  reason?: string;
  timedOut: boolean;
}

export async function pollTxOutcome(
  hash: string,
  getStatus: (hash: string) => Promise<TransactionStatusResult>,
  {
    cancelled,
    intervalMs = POLL_INTERVAL_MS,
    timeoutMs = POLL_TIMEOUT_MS,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now = Date.now,
  }: {
    cancelled: () => boolean;
    intervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  }
): Promise<PollResult> {
  const deadline = now() + timeoutMs;
  while (!cancelled()) {
    await sleep(intervalMs);
    if (cancelled()) break;
    let res: TransactionStatusResult;
    try {
      res = await getStatus(hash);
    } catch {
      res = { status: 'unknown', confirmed: false };
    }
    const outcome = stageFromStatus(res);
    if (outcome !== 'pending') {
      return { outcome, reason: res.errorReason || undefined, timedOut: false };
    }
    if (now() >= deadline) return { outcome: 'pending', timedOut: true };
  }
  return { outcome: 'pending', timedOut: false };
}

export const octraTxUrl = (networkId: NetworkId, hash: string): string | null => {
  if (!hash) return null;
  if (isCustomNetworkId(networkId)) return getExplorerTxUrl(networkId, hash) || null;
  return networkId === 'devnet'
    ? `https://devnet.octrascan.io/tx.html?hash=${hash}`
    : `https://octrascan.io/tx.html?hash=${hash}`;
};

export const trimAmount = (amount: string) => {
  if (!amount.includes('.')) return amount || '0';
  const trimmed = amount.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed || '0';
};

export const bulkPollStage = (
  outcomes: PollOutcome[],
  total: number
): { stage: 'pending' | 'done' | 'failed'; sent: number } => {
  const sent = outcomes.filter((o) => o === 'done').length;
  if (outcomes.some((o) => o === 'pending')) return { stage: 'pending', sent };
  return { stage: sent >= total && total > 0 ? 'done' : 'failed', sent };
};

export type FeeOpType = 'transfer' | 'call' | 'stealth';

export const feeOpType = (isPrivate: boolean, isToken: boolean): FeeOpType =>
  isPrivate ? 'stealth' : isToken ? 'call' : 'transfer';

const positiveOu = (ou: string | null | undefined): ou is string =>
  !!ou && /^\d+$/.test(ou) && BigInt(ou) > 0n;

export const resolveSendOu = (
  custom: string,
  recommended: string | null | undefined
): string | null => (positiveOu(custom) ? custom : positiveOu(recommended) ? recommended : null);

export const amountUnits = (
  value: string | number | null | undefined,
  decimals: number
): bigint | null => {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value === 'number') return toUnits(value, decimals);
    const clean = cleanAmountInput(value, decimals, 30);
    return clean ? toUnits(clean, decimals) : null;
  } catch {
    return null;
  }
};

export const displayAmount = (
  value: string | number | null | undefined,
  decimals: number,
  maxFrac = 6
): string => {
  const units = amountUnits(value, decimals);
  return units === null ? '0' : formatUnits(units.toString(), decimals, maxFrac);
};

/** Token decimals as listed; 0 is a real value, only a missing one defaults to 6. */
export const tokenDecimals = (decimals: unknown): number => {
  const n = typeof decimals === 'string' && decimals.trim() !== '' ? Number(decimals) : decimals;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 36 ? n : 6;
};

export const tokenBalanceFromRaw = (raw: unknown, decimals: number): string => {
  const s = String(raw ?? '').trim();
  return /^\d+$/.test(s) ? fromUnits(s, decimals) : '0';
};

export const isSelfSend = (to: string, own: string | null | undefined): boolean =>
  !!own && !!to && normalizeAddress(to) === normalizeAddress(own);

export const assetForMode = <T extends { contractAddress: string | null }>(
  mode: string,
  selected: T,
  native: T
): T => (mode === 'bulk' && selected.contractAddress !== null ? native : selected);

export type SendKind = 'public' | 'token' | 'private';

export interface SendIssues {
  self: boolean;
  noFee: boolean;
  overBalance: boolean;
  feeShort: boolean;
}

export const sendIssues = (p: {
  kind: SendKind;
  to: string;
  own: string | null | undefined;
  amount: string;
  decimals: number;
  spendable: string | null;
  publicOct: string | null;
  ou: string | null;
}): SendIssues => {
  const amt = p.amount ? amountUnits(p.amount, p.decimals) : null;
  const fee = p.ou ? BigInt(p.ou) : null;
  const spendable = amountUnits(p.spendable, p.decimals);
  const oct = amountUnits(p.publicOct, 6);
  const overBalance =
    amt !== null &&
    spendable !== null &&
    amt + (p.kind === 'public' && fee !== null ? fee : 0n) > spendable;
  const feeShort = p.kind !== 'public' && fee !== null && oct !== null && fee > oct;
  return { self: isSelfSend(p.to, p.own), noFee: fee === null, overBalance, feeShort };
};

export const bulkTotalUnits = (rows: Array<{ amount: string }>): bigint =>
  rows.reduce((sum, r) => sum + (amountUnits(r.amount, 6) ?? 0n), 0n);

export const bulkIssues = (p: {
  rows: Array<{ address: string; amount: string }>;
  own: string | null | undefined;
  publicOct: string | null;
  ou: string | null;
}): Omit<SendIssues, 'feeShort'> => {
  const filled = p.rows.filter((r) => r.address && r.amount);
  const fee = p.ou ? BigInt(p.ou) : null;
  const oct = amountUnits(p.publicOct, 6);
  const need = bulkTotalUnits(filled) + (fee ?? 0n) * BigInt(filled.length);
  return {
    self: p.rows.some((r) => isSelfSend(r.address, p.own)),
    noFee: fee === null,
    overBalance: oct !== null && need > oct,
  };
};

export const maxSendable = (
  kind: SendKind,
  spendable: string | null,
  decimals: number,
  ou: string | null
): string | null => {
  if (!positiveOu(ou)) return null;
  const bal = amountUnits(spendable, decimals) ?? 0n;
  const fee = kind === 'public' ? BigInt(ou) : 0n;
  return fromUnits(bal > fee ? bal - fee : 0n, decimals);
};

const FEE_TIERS = [
  { label: 'Slow', eta: '~30s' },
  { label: 'Normal', eta: '~12s' },
  { label: 'Fast', eta: '~5s' },
];

export const feePresets = (
  fee: { minimum: string; recommended: string; fast?: string } | null | undefined
): Array<{ label: string; ou: string; eta: string }> => {
  if (!fee || !positiveOu(fee.recommended)) return [];
  if (!positiveOu(fee.fast)) {
    const slow = positiveOu(fee.minimum) ? fee.minimum : fee.recommended;
    return [
      { ...FEE_TIERS[0], ou: slow },
      { ...FEE_TIERS[1], ou: fee.recommended },
    ];
  }
  const live = [fee.minimum, fee.recommended, fee.fast];
  if (live.every(positiveOu) && new Set(live).size === 3) {
    return FEE_TIERS.map((tier, i) => ({ ...tier, ou: live[i] as string }));
  }
  const rec = BigInt(fee.recommended);
  const steps = [rec, (rec * 3n + 1n) / 2n, rec * 2n];
  return FEE_TIERS.map((tier, i) => ({ ...tier, ou: steps[i].toString() }));
};
