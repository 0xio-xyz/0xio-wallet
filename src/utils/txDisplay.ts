import type { TransactionHistoryItem } from 'src/types/transaction';

type Translate = (key: string, options?: Record<string, unknown>) => string;
const plain: Translate = (_key, options) => String(options?.defaultValue ?? '');

/** Raw token units as a decimal string, by string shift so large amounts keep every digit. */
export function formatRawUnits(raw: string, decimals?: number): string {
  let s = String(raw).replace(/[^0-9]/g, '');
  if (s === '' || /^0+$/.test(s)) return '0';
  s = s.replace(/^0+/, '');
  if (!decimals) return s;
  while (s.length <= decimals) s = '0' + s;
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, '');
  return fracPart ? `${intPart || '0'}.${fracPart}` : intPart || '0';
}

type TxLike = Pick<
  TransactionHistoryItem,
  'amount' | 'token_transfer' | 'insideCall' | 'amountUnknown'
> & {
  opType?: string;
};

const PRIVATE_SENDS = new Set(['private_transfer', 'stealth']);

export interface TxAsset {
  value: string;
  unit: string;
  isNft: boolean;
  pending: boolean;
  isZero: boolean;
  hidden: boolean;
}

export function txAsset(tx: TxLike): TxAsset {
  const base = { isNft: false, pending: false, isZero: false, hidden: false };
  const tt = tx.token_transfer;
  if (tt?.kind === 'nft') {
    return {
      ...base,
      value: `#${tt.raw_amount}`,
      unit: tt.symbol || tt.name || 'NFT',
      isNft: true,
    };
  }
  if (tt) {
    const value = formatRawUnits(tt.raw_amount, tt.decimals);
    return { ...base, value, unit: tt.symbol || 'TOKEN', isZero: value === '0' };
  }
  if (tx.insideCall) return { ...base, value: '...', unit: '', pending: true };
  if (tx.amountUnknown) return { ...base, value: '', unit: '', pending: true };
  const value = parseFloat((tx.amount || 0).toFixed(6)).toString();
  if (value === '0' && PRIVATE_SENDS.has(tx.opType || '')) {
    return { ...base, value: 'Hidden', unit: '', hidden: true };
  }
  return { ...base, value, unit: 'OCT', isZero: value === '0' };
}

export function amountSign(asset: TxAsset, sign: '+' | '-' | ''): '+' | '-' | '' {
  return asset.isZero || asset.isNft || asset.pending || asset.hidden ? '' : sign;
}

export function amountColor(asset: TxAsset, positive: boolean): string {
  if (asset.isZero || asset.pending || asset.hidden) return 'var(--fg-3)';
  return positive ? 'var(--pos)' : 'var(--fg)';
}

export function transferTitle(
  tx: Pick<TransactionHistoryItem, 'token_transfer' | 'insideCall' | 'callLabel'>,
  isReceived: boolean,
  t: Translate = plain
): string | null {
  if (tx.callLabel === 'Bridge unlock')
    return t('history.bridgeUnlock', { defaultValue: 'Bridge unlock' });
  if (tx.callLabel) return tx.callLabel;
  const tt = tx.token_transfer;
  if (tt?.kind === 'nft') {
    return isReceived
      ? t('history.receivedNft', { defaultValue: 'Received NFT' })
      : t('history.sentNft', { defaultValue: 'Transferred NFT' });
  }
  if (tt || tx.insideCall) {
    return isReceived
      ? t('history.receivedLabel', { defaultValue: 'Received' })
      : t('history.sentLabel', { defaultValue: 'Sent' });
  }
  return null;
}

export function counterparty(tx: TransactionHistoryItem, isReceived: boolean): string {
  if (isReceived) return tx.from;
  return tx.token_transfer?.recipient || tx.to;
}
