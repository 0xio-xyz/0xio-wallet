import React, { useMemo, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { RefreshCw } from 'src/shared/ui/icons';
import { Mascot } from 'src/shared/ui/Mascot';
import { useWallet } from 'src/contexts/WalletContext';
import { useMempoolTxs, useTransactionHistory } from 'src/hooks/wallet/useTransactionHistory';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import Header from 'src/shared/ui/Header';
import IconButton from 'src/shared/ui/IconButton';
import TxDetailSheet from 'src/shared/ui/TxDetailSheet';
import EvmTxDetailSheet from 'src/shared/ui/EvmTxDetailSheet';
import TxRow, { EvmTxRow, TxRowsSkeleton } from 'src/shared/ui/TxRow';
import { Loading } from 'src/shared/ui/Skeleton';
import { octraNetworkLabel } from 'src/shared/ui/txLabels';
import { useEvmHistory } from 'src/hooks/wallet/useEvmHistory';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import { isLocalRow, legacyNetwork, toMs } from 'src/services/wallet/historyRows';
import { methodKey, useContractMethods } from 'src/hooks/transactions/useContractMethods';
import type { TransactionHistoryItem } from 'src/types/transaction';
import type { EvmHistoryItem } from 'src/services/evm/history';

type Side = 'mainnet' | 'testnet';

const { ListFormat } = Intl as unknown as {
  ListFormat: new (
    lang: string | undefined,
    opts: { type: 'conjunction' }
  ) => { format: (list: string[]) => string };
};

type Row = { ts: number; oct: TransactionHistoryItem | null; evm: EvmHistoryItem | null };

const HistoryScreen = () => {
  const { t, i18n } = useTranslation();
  const { activeWallet, showMessage, refreshBalance, networkId } = useWallet();
  const [selectedTx, setSelectedTx] = useState<TransactionHistoryItem | null>(null);
  const [selectedEvm, setSelectedEvm] = useState<EvmHistoryItem | null>(null);
  const isWatchOnly = activeWallet?.type === 'watch';
  const tokenPrices = useTokenPrice();

  const handleTransactionConfirmed = React.useCallback(() => {
    if (activeWallet?.address) {
      refreshBalance(activeWallet.address);
    }
  }, [activeWallet?.address, refreshBalance]);

  const { transactions, cancellable, isLoading, reload, hideTransaction, cancelTransaction } =
    useTransactionHistory(activeWallet?.address, handleTransactionConfirmed);
  const { evmOn, evmAddress } = useHomeView();
  const evm = useEvmHistory(evmAddress, evmOn);

  const listed = new Set(transactions.map((tx) => tx.hash).filter(Boolean));
  const mempoolAll = useMempoolTxs(activeWallet?.address, networkId).filter(
    (tx) => !tx.hash || !listed.has(tx.hash)
  );

  const fallbackNet = legacyNetwork(networkId);
  const netOf = (tx: TransactionHistoryItem) => tx.network || fallbackNet;
  const footerSide: Side = networkId === 'devnet' ? 'testnet' : 'mainnet';
  const [picked, setPicked] = useState<{ net: string; side: Side }>({
    net: networkId,
    side: footerSide,
  });
  const side = picked.net === networkId ? picked.side : footerSide;
  const octSide = (tx: TransactionHistoryItem): Side =>
    netOf(tx) === 'devnet' ? 'testnet' : 'mainnet';
  const evmSide = (item: EvmHistoryItem): Side => (item.testnet ? 'testnet' : 'mainnet');
  const allRows: (Row & { side: Side })[] = [
    ...transactions.map((tx): Row & { side: Side } => ({
      ts: toMs(tx.timestamp),
      oct: tx,
      evm: null,
      side: octSide(tx),
    })),
    ...evm.items.map((item): Row & { side: Side } => ({
      ts: toMs(item.timestamp),
      oct: null,
      evm: item,
      side: evmSide(item),
    })),
  ].sort((a, b) => b.ts - a.ts);
  const rows: Row[] = allRows.filter((r) => r.side === side);
  const shownTxs = useMemo(
    () =>
      transactions.filter(
        (tx) => ((tx.network || fallbackNet) === 'devnet' ? 'testnet' : 'mainnet') === side
      ),
    [transactions, fallbackNet, side]
  );
  const contractMethods = useContractMethods(shownTxs, fallbackNet);
  const mempool = side === footerSide ? mempoolAll : [];
  const counts = {
    mainnet: allRows.filter((r) => r.side === 'mainnet').length,
    testnet: allRows.filter((r) => r.side === 'testnet').length,
  };
  const namesOn = (list: { name: string; testnet: boolean }[]) => {
    const names = list.filter((n) => (n.testnet ? 'testnet' : 'mainnet') === side);
    return names.length
      ? new ListFormat(i18n?.resolvedLanguage, { type: 'conjunction' }).format(
          names.map((n) => n.name)
        )
      : null;
  };
  const failedEvm = namesOn(evm.failed);
  const unavailableEvm = namesOn(evm.unavailable);
  const evmNotes = [
    failedEvm &&
      t('history.evmFailed', {
        chains: failedEvm,
        defaultValue: 'Could not load {{chains}} activity. Refresh to try again.',
      }),
    unavailableEvm &&
      t('history.evmUnavailable', {
        chains: unavailableEvm,
        defaultValue: 'History not available on {{chains}}.',
      }),
  ]
    .filter((note): note is string => !!note)
    .map((note) => (
      <p key={note} style={{ margin: '10px 8px 0', fontSize: '11px', color: 'var(--fg-3)' }}>
        {note}
      </p>
    ));

  const actionFor = (tx: TransactionHistoryItem) => {
    const queuedOnly = (tx.pending || tx.queued) && !tx.hash;
    if (queuedOnly && tx.txId && cancellable.includes(tx.txId)) {
      return {
        label: t('history.cancel', { defaultValue: 'Cancel' }),
        onAction: async (row: TransactionHistoryItem) => {
          if ((await cancelTransaction(row)) === 'sent') {
            showMessage(
              t('history.cannotCancel', {
                defaultValue: 'Already broadcast. It cannot be cancelled.',
              }),
              'info'
            );
          }
        },
      };
    }
    if (queuedOnly || (tx.status === 'failed' && isLocalRow(tx))) {
      return {
        label: t('history.hide', { defaultValue: 'Hide' }),
        onAction: async (row: TransactionHistoryItem) => {
          if (!(await hideTransaction(row))) {
            showMessage(
              t('history.hideFailed', { defaultValue: 'Could not hide this transaction.' }),
              'error'
            );
          }
        },
      };
    }
    return undefined;
  };

  return (
    <div className="w-full! h-full! flex! flex-col! overflow-hidden! bg-(--bg)! text-(--fg)!">
      <Header
        title={t('history.title')}
        showBack
        showSettings={false}
        rightAction={
          <IconButton
            onClick={() => {
              reload();
              evm.refresh();
            }}
            disabled={isLoading}
            title={t('token.refresh')}
            aria-label={t('token.refresh')}
          >
            <RefreshCw size={16} className={isLoading ? 'animate-spin!' : ''} />
          </IconButton>
        }
      />

      <div
        className="shrink-0! flex! items-center!"
        style={{ padding: '0 var(--gutter) 6px', gap: '14px' }}
      >
        {(['mainnet', 'testnet'] as const).map((s2) => {
          const on = side === s2;
          return (
            <button
              key={s2}
              type="button"
              onClick={() => setPicked({ net: networkId, side: s2 })}
              aria-pressed={on}
              className="flex! items-center! transition-colors!"
              style={{
                gap: '5px',
                background: 'none',
                border: 'none',
                padding: '4px 0',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: on ? 600 : 500,
                color: on ? 'var(--fg)' : 'var(--fg-3)',
              }}
            >
              {s2 === 'mainnet'
                ? t('history.mainnet', { defaultValue: 'Mainnet' })
                : t('history.testnet', { defaultValue: 'Testnet' })}
              {counts[s2] > 0 && (
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 400,
                    color: 'var(--fg-3)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {counts[s2]}
                </span>
              )}
            </button>
          );
        })}
        {isWatchOnly && (
          <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--fg-3)' }}>
            {t('history.watchOnly', { defaultValue: 'Watch-only' })}
          </span>
        )}
      </div>

      <div
        className="footer-clear flex-1! overflow-y-auto! scrollbar-hide! min-h-0!"
        style={{ padding: '0 calc(var(--gutter) - 8px) 16px' }}
      >
        {mempool.length > 0 && (
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--fg-3)', padding: '8px 8px 2px' }}>
              {t('history.pending')} ({mempool.length})
            </div>
            {mempool.slice(0, 5).map((tx, i) => (
              <div
                key={tx.hash || i}
                onClick={() =>
                  setSelectedTx({
                    hash: tx.hash,
                    timestamp: tx.timestamp,
                    type: 'outgoing',
                    amount: tx.amount,
                    from: tx.from,
                    to: tx.to,
                    address: tx.to,
                    nonce: tx.nonce,
                    confirmed: false,
                    status: 'pending',
                    pending: true,
                    opType: tx.opType as TransactionHistoryItem['opType'],
                    network: tx.network,
                  })
                }
                className="flex! items-center! justify-between! rounded-lg! [--row-bg:var(--bg)] hover:bg-(--bg-1)! hover:[--row-bg:var(--bg-1)] transition-colors!"
                style={{ padding: '10px 8px', gap: '10px', cursor: 'pointer' }}
              >
                <div className="flex-1! min-w-0! flex! flex-col!" style={{ gap: '2px' }}>
                  <span
                    className="flex! items-center!"
                    style={{
                      gap: '6px',
                      fontSize: '13px',
                      fontWeight: 600,
                      color: 'var(--fg)',
                      textTransform: 'capitalize',
                    }}
                  >
                    {tx.opType || 'transfer'}
                    <Mascot
                      mood="loading"
                      size={12}
                      hole="var(--row-bg)"
                      className="text-caution!"
                    />
                  </span>
                  {tx.hash && (
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'var(--fg-3)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {tx.hash.slice(0, 8)}…{tx.hash.slice(-6)}
                    </span>
                  )}
                </div>
                <div className="flex! flex-col! items-end! shrink-0!" style={{ gap: '2px' }}>
                  {tx.amount > 0 && (
                    <span
                      style={{
                        fontSize: '13px',
                        fontWeight: 600,
                        color: 'var(--fg)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {parseFloat(tx.amount.toFixed(6))} OCT
                    </span>
                  )}
                  <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                    {octraNetworkLabel(tx.network, t)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {isLoading && rows.length === 0 ? (
          <Loading label={t('common.loading', { defaultValue: 'Loading' })}>
            <TxRowsSkeleton />
          </Loading>
        ) : rows.length === 0 ? (
          <div
            className="flex! flex-col! items-center! justify-center! h-full! text-center!"
            style={{ gap: '4px', padding: '24px 0' }}
          >
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
              {t('history.noTransactions')}
            </span>
            {evmNotes}
          </div>
        ) : (
          <div>
            {rows.map(({ oct: tx, evm: item }, index) =>
              item ? (
                <EvmTxRow key={item.key} item={item} onClick={setSelectedEvm} />
              ) : (
                <TxRow
                  key={`${netOf(tx!)}-${tx!.hash || tx!.txId || index}`}
                  tx={tx!}
                  method={tx!.hash ? contractMethods[methodKey(netOf(tx!), tx!.hash)] : undefined}
                  usd={
                    netOf(tx!) === 'mainnet'
                      ? tokenPrices.getUsdValue('OCT', parseFloat(String(tx!.amount)) || 0)
                      : null
                  }
                  network={octraNetworkLabel(netOf(tx!), t)}
                  action={actionFor(tx!)}
                  onClick={setSelectedTx}
                />
              )
            )}
            {evmNotes}
          </div>
        )}
      </div>
      {selectedTx && <TxDetailSheet tx={selectedTx} onClose={() => setSelectedTx(null)} />}
      {selectedEvm && <EvmTxDetailSheet item={selectedEvm} onClose={() => setSelectedEvm(null)} />}
    </div>
  );
};

export default HistoryScreen;
