import { fromUnits } from 'src/utils/amount';
import { formatUsd } from 'src/hooks/wallet/useTokenPrice';

export function usdOf(
  raw: bigint,
  decimals: number,
  price: number | null | undefined
): number | null {
  if (!price || !Number.isFinite(price) || price <= 0) return null;
  const value = Number(fromUnits(raw, decimals)) * price;
  return Number.isFinite(value) ? value : null;
}

export const fmtFeeUsd = (usd: number): string =>
  usd < 0.01
    ? '< $0.01'
    : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface FeeFigure {
  primary: string;
  secondary: string | null;
}

export function feeFigure(
  raw: bigint,
  decimals: number,
  native: string,
  price: number | null | undefined
): FeeFigure {
  const usd = usdOf(raw, decimals, price);
  return usd === null
    ? { primary: native, secondary: null }
    : { primary: fmtFeeUsd(usd), secondary: native };
}

export function amountUsd(
  raw: bigint,
  decimals: number,
  price: number | null | undefined
): string | null {
  const usd = usdOf(raw, decimals, price);
  return usd === null ? null : formatUsd(usd);
}
