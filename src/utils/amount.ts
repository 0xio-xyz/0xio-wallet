export const OCT_DECIMALS = 6;
export const MAX_INTEGER_DIGITS = 15;

const THOUSANDS = /^[1-9]\d{0,2}(,\d{3})+(\.\d*)?$/;

/**
 * Turns what a person typed or pasted into a plain decimal string ("1234.5"), or null when the
 * text is not an amount (letters, a minus sign, exponent notation, two decimal points).
 * A comma is read as the decimal separator unless it groups thousands ("1,000.5"), so "1,5" is
 * 1.5 and never 15. Decimals past `decimals` and integer digits past `maxInt` are cut.
 */
export function cleanAmountInput(
  raw: string,
  decimals: number = OCT_DECIMALS,
  maxInt: number = MAX_INTEGER_DIGITS
): string | null {
  let s = (raw ?? '').replace(/[\s\u00a0'_]/g, '');
  if (s === '') return '';
  if (/[^0-9.,]/.test(s)) return null;

  if (THOUSANDS.test(s)) {
    s = s.replace(/,/g, '');
  } else if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    if ((s.match(/,/g) ?? []).length > 1) return null;
    s = s.replace(',', '.');
  }
  if (s.includes(',') || (s.match(/\./g) ?? []).length > 1) return null;

  let [int, frac] = s.split('.') as [string, string | undefined];
  int = int.replace(/^0+(?=\d)/, '');
  if (int.length > maxInt) int = int.slice(0, maxInt);
  if (frac === undefined) return int;
  if (int === '') int = '0';
  const places = Math.max(0, Math.floor(decimals));
  if (places === 0) return int;
  return `${int}.${frac.slice(0, places)}`;
}

/** Exact base units of a decimal string, with no floating point. Throws on anything else. */
export function toUnits(amount: string | number, decimals: number = OCT_DECIMALS): bigint {
  const places = Math.max(0, Math.floor(decimals));
  const s = typeof amount === 'number' ? numberToPlain(amount, places) : String(amount).trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) throw new Error('Invalid amount');
  const [int, frac = ''] = s.split('.');
  if (frac.length > places && /[1-9]/.test(frac.slice(places))) {
    throw new Error(`Amount has more than ${places} decimals`);
  }
  const padded = (frac + '0'.repeat(places)).slice(0, places);
  return BigInt((int || '0') + padded);
}

export function fromUnits(units: bigint | string, decimals: number = OCT_DECIMALS): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString();
  const places = Math.max(0, Math.floor(decimals));
  if (places === 0) return (neg ? '-' : '') + abs;
  const padded = abs.padStart(places + 1, '0');
  const int = padded.slice(0, -places);
  const frac = padded.slice(-places).replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${int}.${frac}` : int);
}

export function isValidAmount(amount: string, decimals: number = OCT_DECIMALS): boolean {
  try {
    return toUnits(amount, decimals) > 0n;
  } catch {
    return false;
  }
}

function numberToPlain(n: number, places: number): string {
  if (!Number.isFinite(n) || n < 0 || n >= 1e21) throw new Error('Invalid amount');
  return n.toFixed(Math.min(places, 100));
}

export function formatUnits(raw: string, decimals: number, maxFrac = 6): string {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return s;
  const [int, frac = ''] = fromUnits(s, decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cut = frac.slice(0, Math.max(0, maxFrac)).replace(/0+$/, '');
  return cut ? `${grouped}.${cut}` : grouped;
}
