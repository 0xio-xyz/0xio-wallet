import { MICRO_OCT } from 'src/features/wallet/nft/xpectrum/config';
import { cleanAmountInput } from 'src/utils/amount';

export const fmtOct = (oct: number) =>
  oct.toLocaleString('en-US', { maximumFractionDigits: oct < 1 ? 6 : 2 });

export const fmtMicro = (micro: number) => fmtOct(micro / MICRO_OCT);

export function fmtUsd(oct: number, octUsd: number | null): string | null {
  if (!octUsd || octUsd <= 0) return null;
  const v = oct * octUsd;
  if (!(v > 0)) return '$0';
  if (v < 0.01) return '< $0.01';
  const s = v < 1 ? v.toFixed(4) : v.toFixed(2);
  const [whole, frac = ''] = s.split('.');
  const trimmed = frac.replace(/0+$/, '');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${trimmed ? `.${trimmed}` : ''}`;
}

export function splitOct(oct: number): [string, string] {
  const s = fmtOct(oct);
  const dot = s.indexOf('.');
  return dot < 0 ? [s, ''] : [s.slice(0, dot), s.slice(dot)];
}

export const cleanAmount = (raw: string, previous = '') => cleanAmountInput(raw, 6) ?? previous;

export const middleCut = (addr: string, keep = 10) =>
  addr.length > keep * 2 + 1 ? `${addr.slice(0, keep)}…${addr.slice(-keep)}` : addr;

export const fmtDay = (unixSeconds: number, language: string) =>
  new Date(unixSeconds * 1000).toLocaleDateString(language === 'en' ? 'en-GB' : language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

export async function readOctUsd(): Promise<number | null> {
  try {
    const r = await chrome.storage.local.get('0xio_token_prices');
    const p = (r['0xio_token_prices'] as Record<string, number> | undefined)?.OCT;
    return typeof p === 'number' && p > 0 ? p : null;
  } catch {
    return null;
  }
}
