import type { TFunction } from 'src/i18n/core';
import type { TransactionHistoryItem } from 'src/types/transaction';
import type { EvmHistoryItem } from 'src/services/evm/history';
import { isCustomNetworkId, peekNetwork, ZeroXIOConfig } from 'src/utils/config';
import { amountSign, type TxAsset } from 'src/utils/txDisplay';
import {
  actionLabel,
  callAction,
  callTitle,
  knownOctraContract,
  methodRow,
} from 'src/utils/callReading';
import { callArgs } from 'src/services/evm/callDetail';
import { peekTokenList } from 'src/services/tokens/octraTokens';
import { collectionSpamReason, octraSpamReason } from 'src/services/tokens/tokenSpam';

type Translate = TFunction | ((key: string, options?: Record<string, unknown>) => string);

export function octraAmountSign(
  tx: Pick<TransactionHistoryItem, 'type' | 'opType' | 'status'>,
  asset: TxAsset
): '+' | '-' | '' {
  if (tx.status === 'failed') return '';
  const base =
    tx.type === 'incoming' || tx.opType === 'decrypt' || tx.opType === 'claim'
      ? '+'
      : tx.opType === 'key_switch'
        ? ''
        : '-';
  return amountSign(asset, base);
}

export function evmAmountSign(
  item: Pick<EvmHistoryItem, 'direction' | 'failed' | 'moved'>
): '+' | '-' | '' {
  if (item.failed) return '';
  const first = item.moved?.[0];
  if (item.direction === 'self' && (!first || first.token.address === null)) return '';
  return evmPrimaryDirection(item) === 'incoming' ? '+' : '-';
}

export function signedAmount(sign: '+' | '-' | '', amount: string): string {
  return amount.startsWith('<') ? amount : `${sign}${amount}`;
}

export function octraCallMovedNothing(
  tx: Pick<TransactionHistoryItem, 'amount' | 'token_transfer'>,
  isCall: boolean,
  asset: TxAsset
): boolean {
  return (
    isCall && !tx.token_transfer && !asset.pending && !asset.hidden && !(Number(tx.amount) > 0)
  );
}

export function evmMovedNothing(item: Pick<EvmHistoryItem, 'token' | 'amount'>): boolean {
  return !item.token || !(Number(item.amount) > 0);
}

export function octraNetworkLabel(networkId: string, t: Translate): string {
  const name =
    peekNetwork(networkId)?.name ??
    (isCustomNetworkId(networkId)
      ? String(t('history.customNetwork', { defaultValue: 'Custom network' }))
      : networkId);
  return name;
}

export function evmChainLabel(item: Pick<EvmHistoryItem, 'chainName'>) {
  return item.chainName;
}

export interface CallView {
  title: string;
  contract: { address: string; name: string | null } | null;
  method: string | null;
}

export function octraContractName(
  network: string,
  address: string,
  tt?: TransactionHistoryItem['token_transfer']
): string | null {
  const known = knownOctraContract(network, address);
  if (known) return known.name;
  if (ZeroXIOConfig.CONTRACTS.WOCT[network] === address) return 'WOCT';
  const listed = peekTokenList()?.tokens.find(
    (t) => t.network === network && t.address === address
  );
  if (listed) return listed.symbol;
  if (tt && tt.contract_address === address) {
    const name = tt.kind === 'nft' ? tt.name || tt.symbol : tt.symbol || tt.name;
    if (!name) return null;
    const spam =
      tt.kind === 'nft'
        ? collectionSpamReason(name)
        : octraSpamReason(network, address, { symbol: tt.symbol, name: tt.name, priced: false });
    return spam ? null : name;
  }
  return null;
}

export function octraCallView(
  tx: Pick<TransactionHistoryItem, 'opType' | 'to' | 'token_transfer' | 'network'>,
  method: string | null | undefined,
  network: string,
  t: Translate,
  args?: readonly unknown[] | null
): CallView | null {
  if (tx.opType !== 'call' || !tx.to) return null;
  const known = knownOctraContract(network, tx.to);
  const title = callTitle(method, t, { swapVault: known?.swapVault, args });
  return {
    title,
    contract: { address: tx.to, name: octraContractName(network, tx.to, tx.token_transfer) },
    method: methodRow(method, title),
  };
}

export function evmPrimaryDirection(
  item: Pick<EvmHistoryItem, 'direction' | 'moved'>
): EvmHistoryItem['direction'] {
  return item.moved?.[0]?.direction ?? item.direction;
}

export function evmIsTransfer(item: Pick<EvmHistoryItem, 'call' | 'moved' | 'token'>): boolean {
  const call = item.call ?? null;
  if (!call) return true;
  const action = callAction(call.method, { args: callArgs(call) });
  return action === 'transfer' && !!item.token && (item.moved?.length ?? 1) <= 1;
}

export function evmSwapped(item: Pick<EvmHistoryItem, 'moved'>): boolean {
  const moved = item.moved ?? [];
  const out = moved.filter((m) => m.direction === 'outgoing').map((m) => m.token.address);
  const back = moved.filter((m) => m.direction === 'incoming').map((m) => m.token.address);
  return out.length > 0 && back.some((a) => !out.includes(a));
}

export function evmTitle(item: EvmHistoryItem, t: Translate): string {
  const call = item.call ?? null;
  if (call && !evmIsTransfer(item)) {
    const args = callArgs(call);
    const action = callAction(call.method, { args });
    if ((!action || action === 'multicall') && evmSwapped(item)) return actionLabel('swap', t);
    return callTitle(call.method, t, { args });
  }
  if (!item.token) return callTitle(item.method, t);
  return evmPrimaryDirection(item) === 'incoming'
    ? String(t('history.receivedLabel', { defaultValue: 'Received' }))
    : String(t('history.sentLabel', { defaultValue: 'Sent' }));
}
