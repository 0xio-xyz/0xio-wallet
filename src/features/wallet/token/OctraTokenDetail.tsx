import { useMemo, useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { ArrowDown, ArrowUp, Lock, Unlock } from 'src/shared/ui/icons';
import TxRow from 'src/shared/ui/TxRow';
import TxDetailSheet from 'src/shared/ui/TxDetailSheet';
import ConfirmDialog from 'src/shared/ui/ConfirmDialog';
import { TextButton } from 'src/shared/ui/primitives';
import { useWallet } from 'src/contexts/WalletContext';
import { getNetworkConfig, networkCapabilities } from 'src/utils/network';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import { useOctChart } from 'src/hooks/wallet/useOctChart';
import useBackupPending from 'src/hooks/wallet/useBackupPending';
import { useTransactionHistory } from 'src/hooks/wallet/useTransactionHistory';
import { methodKey, useContractMethods } from 'src/hooks/transactions/useContractMethods';
import BackupFirstSheet from 'src/features/wallet/components/BackupFirstSheet';
import OutlineTag from 'src/shared/ui/OutlineTag';
import type { ChartRange } from 'src/services/evm/prices';
import type { TransactionHistoryItem } from 'src/types/transaction';
import TokenDetailSheet, { type TokenAction } from './TokenDetailSheet';

export interface TokenSelection {
  symbol: string;
  name?: string;
  isPrivate?: boolean;
  contract?: string;
  balance?: string;
  logo?: string;
  remove?: () => Promise<void>;
}

const OCT_LOGO =
  'https://raw.githubusercontent.com/0xio-xyz/Token-lists/refs/heads/main/logos/Octra/Oct_Public.svg';

const formatBalance = (val: string | number) => {
  const num = parseFloat(String(val).replace(/,/g, ''));
  if (isNaN(num)) return '0';
  if (num >= 1_000_000) return `${parseFloat((num / 1_000_000).toFixed(2))}M`;
  if (num >= 1_000) return num.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return parseFloat(num.toFixed(num < 1 ? 6 : 3)).toString();
};

const TokenMark = ({ logo, symbol }: { logo?: string; symbol: string }) => {
  const [broken, setBroken] = useState(false);
  return logo && !broken ? (
    <img
      src={logo}
      alt=""
      width={36}
      height={36}
      className="shrink-0! rounded-full! object-cover!"
      style={{ width: '36px', height: '36px' }}
      onError={() => setBroken(true)}
    />
  ) : (
    <span
      className="grid! shrink-0! place-items-center! rounded-full! bg-(--bg-2)!"
      style={{ width: '36px', height: '36px', fontSize: '11px', fontWeight: 700 }}
    >
      {symbol.slice(0, 3)}
    </span>
  );
};

const OctraTokenDetail = ({
  selection,
  onClose,
}: {
  selection: TokenSelection;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const symbol = selection.symbol || 'OCT';
  const isPrivate = !!selection.isPrivate;
  const contract = selection.contract ?? null;

  const {
    balance: publicBalance,
    privateBalance,
    showBalanceValues,
    activeWallet,
    networkId,
  } = useWallet();
  const { priceHistory, getUsdValue } = useTokenPrice();
  const backupPending = useBackupPending(activeWallet);
  const [backupGate, setBackupGate] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [range, setRange] = useState<ChartRange>('1D');
  const chart = useOctChart(range, !contract, priceHistory);

  const { transactions } = useTransactionHistory(activeWallet?.address);
  const contractMethods = useContractMethods(transactions, networkId);
  const [selectedTx, setSelectedTx] = useState<TransactionHistoryItem | null>(null);

  const recentTxs = useMemo(() => {
    const onNetwork = transactions.filter((tx) => (tx.network || 'mainnet') === networkId);
    if (contract) {
      const addr = contract.toLowerCase();
      return onNetwork
        .filter(
          (tx) =>
            tx.token_transfer?.contract_address?.toLowerCase() === addr ||
            (tx.opType === 'call' && tx.to?.toLowerCase() === addr)
        )
        .slice(0, 10);
    }
    if (isPrivate) {
      return onNetwork
        .filter((tx) => {
          const op = tx.opType || 'transfer';
          return (
            op === 'encrypt' || op === 'decrypt' || op === 'private_transfer' || op === 'claim'
          );
        })
        .slice(0, 10);
    }
    return onNetwork.filter((tx) => !tx.token_transfer && !tx.insideCall).slice(0, 10);
  }, [transactions, isPrivate, contract, networkId]);

  const held = contract
    ? selection.balance || '0'
    : isPrivate
      ? (privateBalance ?? '---')
      : (publicBalance ?? '---');
  const known = held !== '---';
  const usd = contract
    ? null
    : known
      ? (getUsdValue(symbol, parseFloat(String(held).replace(/,/g, '')) || 0) ?? '--')
      : '--';

  const actions: TokenAction[] = [
    {
      id: 'send',
      label: t('action.send'),
      icon: ArrowUp,
      primary: true,
      onClick: () => navigate('/send', { state: { token: contract, private: isPrivate } }),
    },
    {
      id: 'receive',
      label: t('action.receive'),
      icon: ArrowDown,
      onClick: () =>
        backupPending ? setBackupGate(true) : navigate('/receive', { state: { tab: 'oct' } }),
    },
    ...(!contract && networkCapabilities(networkId).privacy
      ? [
          isPrivate
            ? {
                id: 'decrypt',
                label: t('action.decrypt'),
                icon: Unlock,
                onClick: () => navigate('/privacy?mode=decrypt'),
              }
            : {
                id: 'encrypt',
                label: t('action.encrypt'),
                icon: Lock,
                onClick: () => navigate('/privacy'),
              },
        ]
      : []),
  ];

  const remove = async () => {
    if (!selection.remove || removing) return;
    setRemoving(true);
    await selection.remove();
    setRemoving(false);
    setConfirmRemove(false);
    onClose();
  };

  return (
    <>
      <TokenDetailSheet
        onClose={onClose}
        icon={
          <TokenMark logo={selection.logo || (contract ? undefined : OCT_LOGO)} symbol={symbol} />
        }
        title={selection.name || symbol}
        tag={
          isPrivate ? (
            <OutlineTag label={t('token.encrypted', { defaultValue: 'Encrypted' })} />
          ) : undefined
        }
        subtitle={
          contract
            ? `${contract.slice(0, 8)}…${contract.slice(-6)}`
            : `${symbol} ${t('evmDetail.on', { defaultValue: 'on' })} ${getNetworkConfig(networkId).name}`
        }
        market={contract ? null : { ...chart, range, onRange: setRange }}
        balance={{
          amount: !showBalanceValues ? '••••' : known ? formatBalance(held) : '---',
          symbol,
          value: usd === null ? null : showBalanceValues ? usd : '••••',
        }}
        actions={actions}
        activity={recentTxs.map((tx, i) => (
          <TxRow
            key={`${tx.hash}-${i}`}
            tx={tx}
            method={
              tx.hash ? contractMethods[methodKey(tx.network || networkId, tx.hash)] : undefined
            }
            usd={getUsdValue('OCT', tx.amount)}
            onClick={setSelectedTx}
          />
        ))}
        activityEmpty={t('evmDetail.noActivity', {
          defaultValue: 'No activity for this token yet.',
        })}
        footer={
          selection.remove ? (
            <TextButton muted onClick={() => setConfirmRemove(true)}>
              {t('token.removeToken')}
            </TextButton>
          ) : undefined
        }
      />
      {selectedTx && (
        <div className="relative! z-nested!">
          <TxDetailSheet tx={selectedTx} onClose={() => setSelectedTx(null)} />
        </div>
      )}
      <div className="relative! z-nested!">
        <BackupFirstSheet open={backupGate} onClose={() => setBackupGate(false)} />
      </div>
      <ConfirmDialog
        isOpen={confirmRemove}
        title={t('token.removeConfirmTitle', { defaultValue: 'Remove this token?' })}
        message={t('token.removeConfirmBody', {
          defaultValue:
            'Removes it from your list on this network. Your balance stays on chain. You can import the token again any time.',
        })}
        confirmText={t('token.removeConfirm', { defaultValue: 'Remove' })}
        cancelText={t('common.cancel')}
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
      />
    </>
  );
};

export default OctraTokenDetail;
