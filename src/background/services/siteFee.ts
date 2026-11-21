import { networkService } from 'src/services/network/NetworkService';
import type { NetworkPin } from 'src/services/network/txScope';
import { FEE_UNAVAILABLE, reviewedFeeError, siteFeeOu } from 'src/utils/octra/dappTx';

export type SiteFeeOp = 'transfer' | 'call' | 'stealth' | 'claim' | 'deploy';

export interface SiteFeeRefusal {
  code: string;
  message: string;
}

export const FEE_UNAVAILABLE_REFUSAL: SiteFeeRefusal = {
  code: 'NETWORK_ERROR',
  message: FEE_UNAVAILABLE,
};

export type SiteFee = { ok: true; ou: bigint } | { ok: false; error: SiteFeeRefusal };

/** The fee a site write is reviewed at: read live before any review, refused when unread. */
export async function siteFee(op: SiteFeeOp, requested: unknown, at: NetworkPin): Promise<SiteFee> {
  const quote = await networkService.getRecommendedFeeStrict(op, at);
  const ou = siteFeeOu(requested, quote);
  return ou == null ? { ok: false, error: FEE_UNAVAILABLE_REFUSAL } : { ok: true, ou };
}

/** Read again right before signing: the reviewed fee stands unless the live minimum rose above it. */
export async function reviewedFeeRefusal(
  op: SiteFeeOp,
  reviewedOu: bigint,
  at: NetworkPin
): Promise<SiteFeeRefusal | null> {
  const message = reviewedFeeError(
    reviewedOu,
    await networkService.getRecommendedFeeStrict(op, at)
  );
  if (message == null) return null;
  return message === FEE_UNAVAILABLE ? FEE_UNAVAILABLE_REFUSAL : { code: 'FEE_CHANGED', message };
}

export function paramsWithFee<T>(raw: T, ou: bigint): T {
  const fee = ou.toString();
  if (Array.isArray(raw)) return [{ ...(raw[0] ?? {}), ou: fee }, ...raw.slice(1)] as T;
  return { ...((raw ?? {}) as object), ou: fee } as T;
}
