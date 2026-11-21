import { useTranslation } from 'src/i18n/react';
import type { EvmHistoryItem } from 'src/services/evm/history';
import { evmTokensFor } from 'src/services/evm/tokens';
import { evmCallCut } from 'src/services/evm/callDetail';
import { useEvmContractNames, useEvmTxDetail } from 'src/hooks/transactions/useCallDetails';
import { methodRow, readableMethod } from 'src/utils/callReading';
import { fromUnits } from 'src/utils/amount';
import { TxDetails, middleOf, whenOf, type TxDetailRow } from './TxDetails';
import { trimAmount } from './TxRow';
import {
  callInput,
  callMethod,
  callSelector,
  evmArgRow,
  evmCallData,
  evmShownArgs,
  type CallData,
} from './callRows';
import {
  evmAmountSign,
  evmChainLabel,
  evmIsTransfer,
  evmMovedNothing,
  evmPrimaryDirection,
  evmTitle,
  signedAmount,
} from './txLabels';

const EvmTxDetailSheet = ({
  item,
  onClose,
}: {
  item: EvmHistoryItem | null;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const detail = useEvmTxDetail(item);
  const call = detail.call;
  const isCall = !!item && !!call && !evmIsTransfer(item);
  const params = isCall && call ? evmShownArgs(call) : [];
  const lookups = [
    ...(isCall && call && !call.token ? [call.contract] : []),
    ...params.filter(({ param }) => param.type === 'address').map(({ param }) => param.value),
  ];
  const names = useEvmContractNames(
    item?.chainId ?? 0,
    item ? lookups : [],
    item?.explorerUrl ?? ''
  );
  if (!item) return null;

  const received = evmPrimaryDirection(item) === 'incoming';
  const self = item.direction === 'self';
  const sign = evmAmountSign(item);
  const title = evmTitle(item, t);
  const shown = item.token && !evmMovedNothing(item) ? item.token : null;
  const amount = shown ? `${signedAmount(sign, trimAmount(item.amount))} ${shown.symbol}` : title;
  const tone = item.failed ? 'var(--fg-3)' : shown && received ? 'var(--pos)' : 'var(--fg)';
  const native = evmTokensFor(item.chainId).find((tk) => tk.address === null)?.symbol ?? 'ETH';
  const moved = item.moved ?? [];
  const method = call
    ? (methodRow(call.method, title) ?? (readableMethod(call.method) ? null : call.selector))
    : null;
  const contractName = call
    ? (call.token?.symbol ?? names[call.contract.toLowerCase()] ?? null)
    : null;
  const callDataPending = isCall && detail.loading && (!call?.params || evmCallCut(item.call));
  const callData: CallData | null =
    isCall && call && !callDataPending
      ? {
          ...callMethod(call.method, call.signature),
          selector: callSelector(call.selector),
          contract: { address: call.contract, name: contractName },
          args: evmCallData(call, names, t),
          input: callInput(call.input),
        }
      : null;

  const rows: TxDetailRow[] = [
    {
      label: t('txDetail.status', { defaultValue: 'Status' }),
      value: item.failed
        ? t('txDetail.failed', { defaultValue: 'Failed' })
        : t('txDetail.confirmed', { defaultValue: 'Confirmed' }),
      tone: item.failed ? 'var(--neg)' : 'var(--fg)',
    },
    {
      label: t('txDetail.type', { defaultValue: 'Type' }),
      value: self && !isCall ? t('txDetail.self', { defaultValue: 'To yourself' }) : title,
    },
    ...(isCall && method
      ? [
          {
            label: t('txDetail.method', { defaultValue: 'Method' }),
            value: method,
            mono: !readableMethod(call?.method),
          },
        ]
      : []),
    ...(isCall && call
      ? [
          {
            label: t('txDetail.contract', { defaultValue: 'Contract' }),
            value: contractName ?? middleOf(call.contract),
            mono: !contractName,
            copy: call.contract,
            logo: call.token?.logo ?? null,
          },
        ]
      : [
          {
            label: t('txDetail.from', { defaultValue: 'From' }),
            value: middleOf(item.from),
            mono: true,
            copy: item.from,
          },
          {
            label: t('txDetail.to', { defaultValue: 'To' }),
            value: middleOf(item.to),
            mono: true,
            copy: item.to,
          },
        ]),
    ...(!isCall && item.token
      ? [
          {
            label: t('txDetail.token', { defaultValue: 'Token' }),
            value: item.token.name
              ? `${item.token.name} (${item.token.symbol})`
              : item.token.symbol,
            logo: item.token.logo,
            copy: item.token.address ?? undefined,
          },
        ]
      : []),
    ...(call ? params.map(({ param }) => evmArgRow(call, param, names, t)) : []),
    ...(isCall && moved.length > 1
      ? moved.map((m) => ({
          label:
            m.direction === 'incoming'
              ? t('history.receivedLabel', { defaultValue: 'Received' })
              : t('history.sentLabel', { defaultValue: 'Sent' }),
          value: `${signedAmount(item.failed ? '' : m.direction === 'incoming' ? '+' : '-', trimAmount(m.amount))} ${m.token.symbol}`,
          tone: item.failed
            ? 'var(--fg-3)'
            : m.direction === 'incoming'
              ? 'var(--pos)'
              : 'var(--fg)',
          logo: m.token.logo,
        }))
      : []),
    ...(detail.fee && item.direction !== 'incoming'
      ? [
          {
            label: t('txDetail.fee', { defaultValue: 'Network fee' }),
            value: `${trimAmount(fromUnits(detail.fee, 18))} ${native}`,
          },
        ]
      : []),
    { label: t('txDetail.network', { defaultValue: 'Network' }), value: evmChainLabel(item) },
  ];

  return (
    <TxDetails
      open
      onClose={onClose}
      tag={item.testnet ? t('history.testnet', { defaultValue: 'Testnet' }) : null}
      amount={amount}
      amountTone={tone}
      sub={whenOf(item.timestamp)}
      rows={rows}
      hash={item.hash}
      explorerUrl={item.explorerUrl || null}
      callData={callData}
      callDataPending={callDataPending}
    />
  );
};

export default EvmTxDetailSheet;
