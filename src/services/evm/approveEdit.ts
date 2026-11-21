import { decodeKnownCall } from './calldata';

export const MAX_UINT256 = (1n << 256n) - 1n;

export type ApproveEdit = { unlimited: true } | { unlimited: false; amount: string };

export type ApproveAmountProblem = 'empty' | 'invalid' | 'zero' | 'decimals' | 'tooLarge' | 'above';

/**
 * A typed approve amount as base units. It must be above zero, fit the token's decimals and a
 * uint256, and never exceed what the site asked for: more than that is only Unlimited, picked on
 * its own.
 */
export function parseApproveAmount(
  text: string,
  decimals: number,
  asked: bigint
): { units: bigint } | { problem: ApproveAmountProblem } {
  let s = text.replace(/[\s\u00a0'_]/g, '');
  if (!s) return { problem: 'empty' };
  if (/^[1-9]\d{0,2}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, '');
  else if (!s.includes('.') && (s.match(/,/g) ?? []).length === 1) s = s.replace(',', '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return { problem: 'invalid' };
  const places = Math.max(0, Math.floor(decimals));
  const [int, frac = ''] = s.split('.');
  if (frac.replace(/0+$/, '').length > places) return { problem: 'decimals' };
  const units = BigInt((int || '0') + (frac + '0'.repeat(places)).slice(0, places));
  if (units === 0n) return { problem: 'zero' };
  if (units > MAX_UINT256) return { problem: 'tooLarge' };
  if (units > asked) return { problem: 'above' };
  return { units };
}

export function readApproveEdit(raw: unknown): ApproveEdit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.unlimited === true) return { unlimited: true };
  if (r.unlimited === false && typeof r.amount === 'string' && /^[1-9]\d{0,77}$/.test(r.amount)) {
    return { unlimited: false, amount: r.amount };
  }
  return null;
}

/**
 * The call data to sign for an approve or increaseAllowance after the user's edit: only the
 * amount word changes. An amount above the site's, zero, or past uint256 throws, so a bad edit
 * never reaches a signature. Unlimited keeps the site's own value when it already was unlimited.
 */
export function applyApproveEdit(data: string, edit: ApproveEdit | null): string {
  if (!edit) return data;
  const call = decodeKnownCall(data);
  if (!call || (call.kind !== 'approve' && call.kind !== 'increaseAllowance')) {
    throw new Error('Only a token approval amount can be changed');
  }
  const asked = BigInt(call.amount);
  let amount: bigint;
  if (edit.unlimited === true) {
    if (call.unlimited) return data;
    amount = MAX_UINT256;
  } else {
    if (!/^[1-9]\d{0,77}$/.test(edit.amount)) throw new Error('Invalid approval amount');
    amount = BigInt(edit.amount);
    if (amount > MAX_UINT256) throw new Error('Invalid approval amount');
    if (amount > asked) throw new Error('The approval amount is above what the site asked for');
  }
  return data.slice(0, 74).toLowerCase() + amount.toString(16).padStart(64, '0');
}
