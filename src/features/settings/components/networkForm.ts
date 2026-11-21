import type { TFunction } from 'src/i18n/core';
import { EvmNetworkError } from 'src/services/evm/registry';
import { quietField } from 'src/shared/ui/primitives';

export const inputProps = {
  spellCheck: false,
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
} as const;

export const fieldClass = (bad: boolean) => `${quietField} ${bad ? 'border-(--neg)!' : ''}`;

export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const shortUrl = (url: string) => url.replace(/^https:\/\//, '').replace(/\/+$/, '');

export type NetworkField = 'name' | 'rpc' | 'chainId' | 'symbol' | 'explorer';

export function networkProblem(
  e: unknown,
  t: TFunction,
  chainId?: number
): { field: NetworkField; text: string } {
  const rpcFailed = {
    field: 'rpc' as const,
    text: t('evmNetworks.rpcFailed', { defaultValue: 'RPC not responding. Check the URL.' }),
  };
  if (!(e instanceof EvmNetworkError)) return rpcFailed;
  switch (e.problem) {
    case 'name':
      return { field: 'name', text: t('evmNetworks.nameNeeded', { defaultValue: 'Enter a name' }) };
    case 'symbol':
      return {
        field: 'symbol',
        text: t('networks.symbolLength', { defaultValue: 'Use 1 to 11 characters' }),
      };
    case 'chainId':
      return {
        field: 'chainId',
        text: t('evmNetworks.badChainId', {
          defaultValue: 'Chain ID must be a positive whole number',
        }),
      };
    case 'builtin':
      return {
        field: 'rpc',
        text: t('evmNetworks.builtIn', { defaultValue: 'This network is already built in' }),
      };
    case 'exists':
      return {
        field: 'rpc',
        text: t('networks.exists', { defaultValue: 'This network is already added' }),
      };
    case 'duplicate':
      return {
        field: 'rpc',
        text: t('networks.rpcListed', { defaultValue: 'This RPC is already listed' }),
      };
    case 'explorer':
      return {
        field: 'explorer',
        text: t('evmNetworks.httpsOnly', { defaultValue: 'Enter an https:// URL' }),
      };
    case 'mismatch':
      return {
        field: 'rpc',
        text:
          chainId === undefined
            ? t('evmNetworks.mismatch', {
                served: e.served,
                defaultValue: 'RPC returned chain ID {{served}}',
              })
            : t('networks.rpcMismatch', {
                served: e.served,
                id: chainId,
                defaultValue: 'RPC returned chain ID {{served}}, expected {{id}}',
              }),
      };
    default:
      return /https/.test(e.message)
        ? {
            field: 'rpc',
            text: t('evmNetworks.httpsOnly', { defaultValue: 'Enter an https:// URL' }),
          }
        : rpcFailed;
  }
}
