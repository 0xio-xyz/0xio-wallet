import { MIN_OUT_RAW, type QuoteMode } from 'src/services/bridge/relay/anyChain';
import { OCT_DECIMALS, fromUnits, toUnits } from 'src/utils/amount';

export type AmountField = 'pay' | 'receive';

export interface Amounts {
  driver: AmountField;
  text: string;
}

export const NO_AMOUNTS: Amounts = { driver: 'pay', text: '' };

export function plainAmount(raw: bigint | string, decimals: number, places = 6): string {
  const [int, frac = ''] = fromUnits(raw, decimals).split('.');
  const cut = frac.slice(0, places).replace(/0+$/, '');
  return cut ? `${int}.${cut}` : int;
}

export function fieldValues(
  amounts: Amounts,
  quote: { outRaw: string | null; payRaw: string | null },
  payDecimals: number
): Record<AmountField, string> {
  if (!amounts.text) return { pay: '', receive: '' };
  if (amounts.driver === 'pay') {
    return {
      pay: amounts.text,
      receive: quote.outRaw ? plainAmount(quote.outRaw, OCT_DECIMALS) : '',
    };
  }
  return {
    pay: quote.payRaw ? plainAmount(quote.payRaw, payDecimals, Math.min(payDecimals, 8)) : '',
    receive: amounts.text,
  };
}

export function drivenAmount(
  amounts: Amounts,
  payDecimals: number
): { mode: QuoteMode; raw: bigint } {
  const mode: QuoteMode = amounts.driver === 'pay' ? 'spend' : 'receive';
  let raw = 0n;
  try {
    raw = amounts.text
      ? toUnits(amounts.text, amounts.driver === 'pay' ? payDecimals : OCT_DECIMALS)
      : 0n;
  } catch {
    raw = 0n;
  }
  return { mode, raw };
}

export function payToCheck(
  amounts: Amounts,
  raw: bigint,
  quotedPayRaw: string | null
): bigint | null {
  if (amounts.driver === 'pay') return raw;
  return quotedPayRaw ? BigInt(quotedPayRaw) : null;
}

export type AmountNote = 'balance' | 'over' | 'min' | 'fees' | 'noPrice' | 'pricing' | 'none';

export function amountNote(p: {
  amounts: Amounts;
  raw: bigint;
  balance: bigint | null;
  quoting: boolean;
  outRaw: string | null;
  payRaw: string | null;
  loading: boolean;
  failed: boolean;
}): AmountNote {
  if (p.raw <= 0n) return p.balance !== null ? 'balance' : 'none';
  if (p.amounts.driver === 'receive' && p.raw < MIN_OUT_RAW) return 'min';
  const pay = payToCheck(p.amounts, p.raw, p.payRaw);
  if (p.balance !== null && pay !== null && pay > p.balance) return 'over';
  if (!p.quoting) return p.balance !== null ? 'balance' : 'none';
  if (p.failed) return 'noPrice';
  if (p.outRaw === null) return 'pricing';
  if (p.amounts.driver === 'pay' && BigInt(p.outRaw) < MIN_OUT_RAW) return 'min';
  return 'fees';
}

/** The most a receive-mode order may charge: what was shown plus 1%, never above the balance. */
export function receiveMaxPay(shownPayRaw: bigint, balance: bigint | null): bigint {
  const tolerated = (shownPayRaw * 101n + 99n) / 100n;
  return balance !== null && tolerated > balance ? balance : tolerated;
}

export interface Order {
  mode: QuoteMode;
  amountRaw: bigint;
  shownOutRaw?: string;
  maxPayRaw: bigint;
}

export function freshQuoteProblem(
  order: Order,
  outRaw: bigint,
  payRaw: bigint | null
): 'min' | 'dropped' | 'moved' | null {
  if (outRaw < MIN_OUT_RAW) return 'min';
  if (order.mode === 'spend') {
    if (order.shownOutRaw && outRaw * 100n < BigInt(order.shownOutRaw) * 99n) return 'dropped';
    return null;
  }
  if (outRaw < order.amountRaw || payRaw === null || payRaw > order.maxPayRaw) return 'moved';
  return null;
}
