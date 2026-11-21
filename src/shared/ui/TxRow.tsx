import { useTranslation } from 'src/i18n/react';
import type { TFunction } from 'src/i18n/core';
import type { TransactionHistoryItem } from 'src/types/transaction';
import type { EvmHistoryItem } from 'src/services/evm/history';
import { Facts } from 'src/shared/ui/primitives';
import { txAsset, transferTitle, counterparty, amountColor as toneOf } from 'src/utils/txDisplay';
import {
  evmAmountSign,
  evmChainLabel,
  evmIsTransfer,
  evmPrimaryDirection,
  evmMovedNothing,
  evmTitle,
  octraAmountSign,
  octraCallMovedNothing,
  octraCallView,
  signedAmount,
} from './txLabels';
import { useEvmCallContract } from 'src/hooks/transactions/useCallDetails';
import OutlineTag from './OutlineTag';
import { BoneLine } from './Skeleton';
import PrimaryName from './PrimaryName';
import { usePrimaryName } from 'src/hooks/wallet/usePrimaryName';

interface TxRowProps {
  tx: TransactionHistoryItem;
  method?: string;
  usd?: string | null;
  network?: string;
  action?: { label: string; onAction: (tx: TransactionHistoryItem) => void };
  onClick?: (tx: TransactionHistoryItem) => void;
}

const shortAddress = (address: string) =>
  !address || address.length < 10 ? 'Unknown' : `${address.slice(0, 6)}…${address.slice(-4)}`;

const formatAmount = (amount: string | number) => {
  const num = parseFloat(typeof amount === 'number' ? amount.toString() : amount);
  if (isNaN(num)) return '0.00';
  if (num > 0 && num < 0.000001) return '< 0.000001';
  return parseFloat(num.toFixed(6)).toString();
};

const formatDateTime = (timestamp: number) => {
  const d = new Date(timestamp > 1e12 ? timestamp : timestamp * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const typeLabel = (opType: string | undefined, isReceived: boolean, t: TFunction) => {
  switch (opType) {
    case 'encrypt':
      return t('history.encryptBalance');
    case 'decrypt':
      return t('history.decryptBalance');
    case 'private_transfer':
      return isReceived ? t('history.privateReceived') : t('history.privateSent');
    case 'claim':
      return t('history.claimPrivate');
    case 'stealth':
      return t('history.stealthSend');
    case 'key_switch':
      return t('history.keySwitch');
    case 'call':
      return t('history.contractCall');
    case 'deploy':
      return t('history.contractDeploy');
    default:
      return isReceived ? t('history.receivedLabel') : t('history.sentLabel');
  }
};

const TxRow = ({ tx, method, usd, network, action, onClick }: TxRowProps) => {
  const { t } = useTranslation();
  const isReceived = tx.type === 'incoming';
  const isPending = tx.pending || tx.queued;
  const isFailed = tx.status === 'failed';
  const asset = txAsset(tx);
  const moved = !!tx.token_transfer || asset.pending || asset.hidden;
  const transfer = transferTitle(tx, isReceived, t);
  const call = transfer ? null : octraCallView(tx, method, tx.network || 'mainnet', t);
  const label = transfer ?? call?.title ?? typeLabel(tx.opType, isReceived, t);
  const sign = octraAmountSign(tx, asset);
  const amount = moved ? asset.value : formatAmount(tx.amount);
  const unit = moved ? asset.unit : 'OCT';
  const nothingMoved = octraCallMovedNothing(tx, !!call, asset);
  const peer = counterparty(tx, isReceived);
  const primary = usePrimaryName(call?.contract ? null : peer, tx.network);

  return (
    <div
      ref={primary.ref}
      onClick={() => onClick?.(tx)}
      className="flex! items-center! rounded-lg! hover:bg-(--bg-1)! transition-colors!"
      style={{ padding: '10px 8px', gap: '10px', cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="flex-1! min-w-0! flex! flex-col!" style={{ gap: '2px' }}>
        <span className="flex! items-center! min-w-0!" style={{ gap: '6px' }}>
          <span
            className="truncate!"
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--fg)',
              textTransform: 'capitalize',
            }}
          >
            {label}
          </span>
          {tx.network === 'devnet' && (
            <span className="flex! shrink-0!" style={{ margin: '-1px 0' }}>
              <OutlineTag label={t('history.testnet', { defaultValue: 'Testnet' })} />
            </span>
          )}
          {isPending && (
            <span style={{ fontSize: '11px', color: 'var(--color-caution)', flexShrink: 0 }}>
              {t('history.pending')}
            </span>
          )}
          {isFailed && (
            <span style={{ fontSize: '11px', color: 'var(--neg)', flexShrink: 0 }}>
              {t('history.failed')}
            </span>
          )}
        </span>
        <span
          className="truncate!"
          style={{ fontSize: '11px', color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}
        >
          <Facts>
            <span>{formatDateTime(tx.timestamp)}</span>
            {call?.contract ? (
              <span>{call.contract.name ?? shortAddress(call.contract.address)}</span>
            ) : (
              <span className="flex! items-center! min-w-0!" style={{ gap: '6px' }}>
                <span className="shrink-0!">{isReceived ? 'from' : 'to'}</span>
                <PrimaryName name={primary.name} />
                <span className="truncate!">{shortAddress(peer)}</span>
              </span>
            )}
          </Facts>
        </span>
      </div>

      <div className="flex! flex-col! items-end! shrink-0!" style={{ gap: '2px' }}>
        <span
          style={{
            fontSize: '13px',
            fontWeight: 600,
            color: isFailed ? 'var(--fg-3)' : toneOf(asset, isReceived),
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {nothingMoved ? '\u00a0' : `${signedAmount(sign, amount)}${unit ? ` ${unit}` : ''}`}
        </span>
        {((usd && !moved && !asset.isZero) || network) && (
          <span
            style={{ fontSize: '11px', color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}
          >
            <Facts gap={6}>
              {usd && !moved && !asset.isZero && <span>{usd}</span>}
              {network && <span>{network}</span>}
            </Facts>
          </span>
        )}
      </div>

      {action && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            action.onAction(tx);
          }}
          className="shrink-0! hover:text-(--fg)! transition-colors!"
          style={{
            background: 'transparent',
            border: 'none',
            padding: '4px 2px',
            cursor: 'pointer',
            fontSize: '11px',
            color: 'var(--fg-3)',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
};

const SKELETON_WIDTHS: [number, number, number][] = [
  [64, 148, 60],
  [72, 132, 72],
  [56, 156, 52],
  [70, 140, 68],
  [52, 128, 56],
  [60, 150, 64],
  [66, 136, 58],
  [58, 144, 70],
];

export const TxRowsSkeleton = () => (
  <>
    {SKELETON_WIDTHS.map(([title, meta, amount], i) => (
      <div key={i} className="flex! items-center!" style={{ padding: '10px 8px', gap: '10px' }}>
        <div className="flex-1! min-w-0! flex! flex-col!" style={{ gap: '2px' }}>
          <BoneLine size={13} w={title} h={12} />
          <BoneLine size={11} w={meta} h={9} />
        </div>
        <div className="flex! flex-col! items-end! shrink-0!" style={{ gap: '2px' }}>
          <BoneLine size={13} w={amount} h={12} />
          <BoneLine size={11} w={76} h={9} />
        </div>
      </div>
    ))}
  </>
);

export const trimAmount = (amount: string) => {
  const [int, frac = ''] = amount.split('.');
  const cut = frac.slice(0, 6).replace(/0+$/, '');
  if (!cut && frac && int === '0') return '< 0.000001';
  return cut ? `${int}.${cut}` : int;
};

export const EvmTxRow = ({
  item,
  onClick,
}: {
  item: EvmHistoryItem;
  onClick?: (item: EvmHistoryItem) => void;
}) => {
  const { t } = useTranslation();
  const received = evmPrimaryDirection(item) === 'incoming';
  const label = evmTitle(item, t);
  const isCall = !!item.call && !evmIsTransfer(item);
  const contractName = useEvmCallContract(item);
  const peer = item.direction === 'incoming' ? item.from : item.to;

  return (
    <div
      onClick={() =>
        onClick ? onClick(item) : window.open(item.explorerUrl, '_blank', 'noopener')
      }
      className="flex! items-center! rounded-lg! hover:bg-(--bg-1)! transition-colors!"
      style={{ padding: '10px 8px', gap: '10px', cursor: 'pointer' }}
    >
      <div className="flex-1! min-w-0! flex! flex-col!" style={{ gap: '2px' }}>
        <span className="flex! items-center! min-w-0!" style={{ gap: '6px' }}>
          <span
            className="truncate!"
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--fg)',
              textTransform: 'capitalize',
            }}
          >
            {label}
          </span>
          {item.testnet && (
            <span className="flex! shrink-0!" style={{ margin: '-1px 0' }}>
              <OutlineTag label={t('history.testnet', { defaultValue: 'Testnet' })} />
            </span>
          )}
          {item.failed && (
            <span style={{ fontSize: '11px', color: 'var(--neg)', flexShrink: 0 }}>
              {t('history.failed')}
            </span>
          )}
        </span>
        <span
          className="truncate!"
          style={{ fontSize: '11px', color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}
        >
          <Facts>
            <span>{formatDateTime(item.timestamp)}</span>
            {isCall && item.call ? (
              <span>{contractName ?? shortAddress(item.call.contract)}</span>
            ) : (
              <span>
                {item.direction === 'incoming' ? 'from' : 'to'} {shortAddress(peer)}
              </span>
            )}
          </Facts>
        </span>
      </div>
      <div className="flex! flex-col! items-end! shrink-0!" style={{ gap: '2px' }}>
        <span
          style={{
            fontSize: '13px',
            fontWeight: 600,
            color: item.failed ? 'var(--fg-3)' : received ? 'var(--pos)' : 'var(--fg)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {item.token && !evmMovedNothing(item)
            ? `${signedAmount(evmAmountSign(item), trimAmount(item.amount))} ${item.token.symbol}`
            : '\u00a0'}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>{evmChainLabel(item)}</span>
      </div>
    </div>
  );
};

export default TxRow;
