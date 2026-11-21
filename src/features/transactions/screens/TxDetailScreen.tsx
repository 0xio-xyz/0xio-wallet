import { useNavigate, useSearchParams } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { XCircle, Clock, ArrowUpRight, Copy } from 'src/shared/ui/icons';
import { Mascot } from 'src/shared/ui/Mascot';
import Header from 'src/shared/ui/Header';
import { useWallet } from 'src/contexts/WalletContext';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import { useTransactionHistory } from 'src/hooks/wallet/useTransactionHistory';
import { txAsset, transferTitle, amountSign, amountColor as toneOf } from 'src/utils/txDisplay';
import { useMemo, useState, useEffect } from 'react';
import useCopied from 'src/hooks/ui/useCopied';
import { readTokenMeta, type TokenMeta } from 'src/services/tokens/octraTokens';
import { fromUnits } from 'src/utils/amount';

const timeAgo = (timestamp: number): string => {
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const diffMs = Date.now() - ts;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return `${Math.floor(diffMins / 1440)}d ago`;
};

const TxDetailScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const txHash = params.get('hash') || '';

  const { activeWallet, networkId, showMessage } = useWallet();
  const { copy, isCopied } = useCopied();
  const { getUsdValue } = useTokenPrice();
  const { transactions } = useTransactionHistory(activeWallet?.address);

  const tx = useMemo(() => transactions.find((t) => t.hash === txHash), [transactions, txHash]);

  const [tokenMeta, setTokenMeta] = useState<{ contract: string; meta: TokenMeta } | null>(null);
  const isContractCall = Boolean(
    tx && (tx.opType === 'call' || (tx.amount === 0 && tx.to && tx.message))
  );
  const txNetwork = tx?.network || networkId;
  useEffect(() => {
    const contract = tx?.to;
    if (!isContractCall || !contract || txNetwork !== networkId) return;
    let cancelled = false;
    readTokenMeta(networkId, contract)
      .then((meta) => {
        if (!cancelled && meta) setTokenMeta({ contract, meta });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isContractCall, tx?.to, txNetwork, networkId]);

  if (!tx) {
    return (
      <div className="flex! flex-col! h-full! bg-(--bg)!">
        <Header title={t('history.title')} showBack onBack={() => navigate(-1)} />
        <div className="flex-1! flex! items-center! justify-center!">
          <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{t('history.txNotFound')}</span>
        </div>
      </div>
    );
  }

  const isReceived = tx.type === 'incoming';
  const isPending = tx.pending || tx.queued;
  const isFailed = tx.status === 'failed';
  const token = tokenMeta && tokenMeta.contract === tx.to ? tokenMeta.meta : null;
  let displayAmount = tx.amount;
  let tokenAmount = '';
  let contractRecipient = '';
  if (isContractCall && tx.message) {
    try {
      let params: string[] | null = null;
      if (tx.message.startsWith('[')) {
        params = JSON.parse(tx.message);
      } else {
        const match = tx.message.match(/\[([^\]]+)\]/);
        if (match) params = JSON.parse(`[${match[1]}]`);
      }
      if (params && params.length >= 2) {
        contractRecipient = params[0];
        const raw = String(params[1]);
        if (token && /^\d+$/.test(raw) && BigInt(raw) > 0n) {
          tokenAmount = fromUnits(raw, token.decimals);
          displayAmount = Number(tokenAmount);
        }
      }
    } catch {}
  }

  const asset = txAsset(tx);
  const decoded = !!tx.token_transfer || asset.pending || asset.hidden;
  if (tx.token_transfer) contractRecipient = tx.token_transfer.recipient;
  const amountText = decoded
    ? `${asset.value || '-'}${asset.unit ? ` ${asset.unit}` : ''}`
    : tokenAmount && token
      ? `${tokenAmount} ${token.symbol}`
      : `${displayAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })} OCT`;
  const title = transferTitle(tx, isReceived, t);
  const sign =
    decoded || !isContractCall
      ? amountSign(asset, isReceived ? '+' : '-')
      : displayAmount === 0
        ? ''
        : isReceived
          ? '+'
          : '-';
  const amountColor =
    decoded || !isContractCall
      ? toneOf(asset, isReceived)
      : displayAmount === 0
        ? 'var(--fg-3)'
        : isReceived
          ? 'var(--pos)'
          : 'var(--fg)';
  const usd = decoded || isContractCall ? '' : getUsdValue('OCT', displayAmount);

  const explorerBase =
    (tx.network || networkId) === 'devnet'
      ? 'https://devnet.octrascan.io/tx.html?hash='
      : 'https://octrascan.io/tx.html?hash=';

  const statusLabel = isPending ? 'Pending' : isFailed ? 'Failed' : 'Confirmed';
  const StatusIcon = isPending ? Clock : XCircle;
  const settled = !isPending && !isFailed;
  const statusColor = isPending ? 'var(--fg-3)' : isFailed ? 'var(--neg)' : 'var(--pos)';

  const copyHash = async () => {
    if (!(await copy(tx.hash))) showMessage(t('toast.copyFailed'), 'error');
  };

  const openExplorer = () => {
    window.open(`${explorerBase}${tx.hash}`, '_blank', 'noopener');
  };

  const detailRows = [
    { label: 'Status', value: statusLabel },
    ...(title ? [{ label: 'Type', value: title }] : []),
    ...(tx.token_transfer?.kind === 'nft' && (tx.token_transfer.name || tx.token_transfer.symbol)
      ? [{ label: 'Collection', value: tx.token_transfer.name || tx.token_transfer.symbol || '' }]
      : []),
    ...(isReceived
      ? [{ label: 'From', value: tx.from ? `${tx.from.slice(0, 10)}…${tx.from.slice(-6)}` : '-' }]
      : []),
    ...((isContractCall || tx.token_transfer) && contractRecipient
      ? [
          { label: 'Contract', value: tx.to ? `${tx.to.slice(0, 10)}…${tx.to.slice(-6)}` : '-' },
          ...(isReceived
            ? []
            : [
                {
                  label: 'Recipient',
                  value: `${contractRecipient.slice(0, 10)}…${contractRecipient.slice(-6)}`,
                },
              ]),
        ]
      : isReceived && !tx.insideCall
        ? []
        : [
            {
              label: isReceived ? 'Contract' : 'To',
              value: tx.to ? `${tx.to.slice(0, 10)}…${tx.to.slice(-6)}` : '-',
            },
          ]),
    { label: 'Network', value: tx.network || networkId || 'mainnet' },
    ...(tx.epoch ? [{ label: 'Epoch', value: String(tx.epoch) }] : []),
    { label: 'Network fee', value: tx.priority ? `${tx.priority} OCT` : '0.01 OCT' },
    ...(tx.nonce > 0 ? [{ label: 'Nonce', value: String(tx.nonce) }] : []),
  ];

  return (
    <div className="flex! flex-col! h-full! bg-(--bg)!">
      <Header
        title={t('common.transaction')}
        showBack
        showSettings={false}
        onBack={() => navigate(-1)}
        rightAction={
          <button
            onClick={openExplorer}
            style={{ padding: '4px', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <ArrowUpRight size={16} style={{ color: 'var(--fg-2)' }} />
          </button>
        }
      />

      <div className="flex-1! overflow-y-auto! scrollbar-hide! px-(--gutter)!">
        <div className="flex! flex-col! items-center! pt-6! pb-2!" style={{ gap: '8px' }}>
          <div
            className="flex! items-center! justify-center!"
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '999px',
              background: settled
                ? undefined
                : `color-mix(in oklab, ${statusColor} 16%, transparent)`,
            }}
          >
            {settled ? (
              <Mascot mood="still" size={48} />
            ) : (
              <StatusIcon size={24} style={{ color: statusColor }} />
            )}
          </div>

          <span
            style={{
              fontSize: '22px',
              fontWeight: 600,
              color: amountColor,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {sign}
            {amountText}
          </span>

          <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
            <span className="flex! items-center!" style={{ gap: '8px' }}>
              <span>{usd || '-'}</span>
              <span>{timeAgo(tx.timestamp)}</span>
            </span>
          </span>
        </div>

        <div
          style={{
            margin: '16px 0',
            padding: '12px',
            backgroundColor: 'var(--bg-1)',
            border: 'none',
            borderRadius: '10px',
          }}
        >
          {detailRows.map((row) => (
            <div
              key={row.label}
              className="flex! items-center! justify-between!"
              style={{
                padding: '10px 4px',
                borderBottom: 'none',
              }}
            >
              <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{row.label}</span>
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 500,
                  color: 'var(--fg)',
                  fontFamily: 'monospace',
                }}
              >
                {row.value}
              </span>
            </div>
          ))}
        </div>

        <div className="flex! justify-center! pb-6!">
          <button
            onClick={copyHash}
            className="flex! items-center! gap-2! transition-colors! hover:bg-(--bg-1)!"
            style={{
              padding: '10px 16px',
              borderRadius: '8px',
              background: 'var(--bg-2)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <Copy size={12} style={{ color: 'var(--fg-2)' }} />
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg-2)' }}>
              {isCopied() ? t('toast.copied') : `${tx.hash.slice(0, 12)}…${tx.hash.slice(-8)}`}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default TxDetailScreen;
