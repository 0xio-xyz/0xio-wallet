import { useMemo } from 'react';
import { useTranslation } from 'src/i18n/react';
import type { TransactionHistoryItem } from 'src/types/transaction';
import { useWallet } from 'src/contexts/WalletContext';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import { txAsset, transferTitle, counterparty, amountColor as toneOf } from 'src/utils/txDisplay';
import { octraTxUrl } from 'src/features/transactions/sendStage';
import type { NetworkId } from 'src/utils/config';
import { TxDetails, middleOf, whenOf, type TxDetailRow } from './TxDetails';
import { octraAmountSign, octraCallView, octraContractName, octraNetworkLabel } from './txLabels';
import { methodKey, useContractMethods } from 'src/hooks/transactions/useContractMethods';
import { useOctraAbiNames, useOctraCallDetail } from 'src/hooks/transactions/useCallDetails';
import { knownOctraContract } from 'src/utils/callReading';
import { knownCallArgs } from 'src/utils/callArgs';
import { callMethod, knownArgPlaceholders, octraArgRows, ouToOct, type CallData } from './callRows';

const NO_TXS: TransactionHistoryItem[] = [];

interface TxDetailSheetProps {
  tx: TransactionHistoryItem | null;
  onClose: () => void;
}

const TxDetailSheet = ({ tx, onClose }: TxDetailSheetProps) => {
  const { t } = useTranslation();
  const { networkId } = useWallet();
  const { getUsdValue } = useTokenPrice();
  const txNetwork = tx?.network || networkId || 'mainnet';
  const listed = useMemo(() => (tx ? [tx] : NO_TXS), [tx]);
  const methods = useContractMethods(listed, txNetwork);
  const detail = useOctraCallDetail(tx && !tx.token_transfer ? tx : null, txNetwork);
  const isCall = !!tx && tx.opType === 'call' && !!tx.to && !tx.token_transfer;
  const method = tx?.hash ? methods[methodKey(txNetwork, tx.hash)] : undefined;
  const specs = isCall ? knownCallArgs(knownOctraContract(txNetwork, tx?.to)?.calls, method) : null;
  const abi = useOctraAbiNames(
    txNetwork,
    isCall && !specs && method && detail.args?.length ? (tx?.to ?? null) : null,
    method ?? null
  );
  if (!tx) return null;

  const isReceived = tx.type === 'incoming';
  const isPending = tx.pending || tx.queued;
  const isFailed = tx.status === 'failed';
  const asset = txAsset(tx);
  const moved = !!tx.token_transfer || asset.pending || asset.hidden;
  const transfer = transferTitle(tx, isReceived);
  const call = transfer ? null : octraCallView(tx, method, txNetwork, t, detail.args);
  const title = transfer ?? call?.title ?? null;
  const sign = octraAmountSign(tx, asset);
  const usd = moved || asset.isZero || txNetwork !== 'mainnet' ? '' : getUsdValue('OCT', tx.amount);
  const other = counterparty(tx, isReceived);
  const tt = tx.token_transfer;
  const priority = Number(tx.priority);
  const fee =
    ouToOct(tx.ou ?? detail.ou) ??
    (Number.isFinite(priority) && priority > 0 ? String(priority) : null);
  const words = call && !moved && asset.isZero;
  const contractRow = (label: string, address: string, name: string | null): TxDetailRow => ({
    label,
    value: name ?? middleOf(address),
    mono: !name,
    copy: address,
  });
  const argView =
    call && detail.args
      ? octraArgRows(detail.args, specs, abi.names, t)
      : {
          rows: call && specs && detail.loading ? knownArgPlaceholders(specs, t) : [],
          args: [],
        };
  const callDataPending =
    !!call && (detail.loading || (!specs && !!detail.args?.length && !!method && abi.loading));
  const callData: CallData | null =
    call && !callDataPending
      ? {
          ...callMethod(method),
          selector: null,
          contract: call.contract,
          args: argView.args,
          input: null,
        }
      : null;

  const rows: TxDetailRow[] = [
    {
      label: t('txDetail.status', { defaultValue: 'Status' }),
      value: isPending
        ? t('txDetail.pending', { defaultValue: 'Pending' })
        : isFailed
          ? t('txDetail.failed', { defaultValue: 'Failed' })
          : t('txDetail.confirmed', { defaultValue: 'Confirmed' }),
      tone: isPending ? 'var(--fg-3)' : isFailed ? 'var(--neg)' : 'var(--fg)',
    },
    ...(title ? [{ label: t('txDetail.type', { defaultValue: 'Type' }), value: title }] : []),
    ...(call?.method
      ? [{ label: t('txDetail.method', { defaultValue: 'Method' }), value: call.method }]
      : []),
    ...(call?.contract
      ? [
          contractRow(
            t('txDetail.contract', { defaultValue: 'Contract' }),
            call.contract.address,
            call.contract.name
          ),
        ]
      : [
          {
            label: isReceived
              ? t('txDetail.from', { defaultValue: 'From' })
              : t('txDetail.to', { defaultValue: 'To' }),
            value: other ? middleOf(other) : '-',
            mono: true,
            copy: other || undefined,
          },
        ]),
    ...(tt
      ? [
          contractRow(
            tt.kind === 'nft'
              ? t('txDetail.collection', { defaultValue: 'Collection' })
              : t('txDetail.token', { defaultValue: 'Token' }),
            tt.contract_address,
            octraContractName(txNetwork, tt.contract_address, tt)
          ),
        ]
      : []),
    ...argView.rows,
    {
      label: t('txDetail.network', { defaultValue: 'Network' }),
      value: octraNetworkLabel(txNetwork, t),
    },
    ...(tx.epoch
      ? [{ label: t('txDetail.epoch', { defaultValue: 'Epoch' }), value: String(tx.epoch) }]
      : []),
    ...(fee && !isReceived
      ? [{ label: t('txDetail.fee', { defaultValue: 'Network fee' }), value: `${fee} OCT` }]
      : []),
    ...(tx.nonce > 0
      ? [{ label: t('txDetail.nonce', { defaultValue: 'Nonce' }), value: String(tx.nonce) }]
      : []),
  ];

  return (
    <TxDetails
      open
      onClose={onClose}
      tag={txNetwork === 'devnet' ? t('history.testnet', { defaultValue: 'Testnet' }) : null}
      amount={
        words && call
          ? call.title
          : `${sign}${asset.value || '-'}${asset.unit ? ` ${asset.unit}` : ''}`
      }
      amountTone={isFailed ? 'var(--fg-3)' : words ? 'var(--fg)' : toneOf(asset, isReceived)}
      sub={[usd, whenOf(tx.timestamp)].filter(Boolean).join('   ')}
      rows={rows}
      hash={tx.hash}
      explorerUrl={octraTxUrl(txNetwork as NetworkId, tx.hash)}
      callData={callData}
      callDataPending={callDataPending}
    />
  );
};

export default TxDetailSheet;
