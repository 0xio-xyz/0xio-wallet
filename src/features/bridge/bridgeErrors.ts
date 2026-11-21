import type { TFunction } from 'src/i18n/core';
import { rpcErrorObject } from 'src/services/evm/rpcErrors';
import { RpcHttpError, RpcResponseError } from 'src/services/network/txOutcome';
import { TxScopeError } from 'src/services/network/txScope';

export type BridgeSide = 'Octra' | 'Ethereum' | (string & {});

const BUSY =
  /\b429\b|too many requests|rate.?limit|failed to fetch|network ?error|load failed|timed? ?out|timeout|unreachable|could not reach|aborted|econn|\b50[234]\b|unable to determine nonce/i;
const NONCE = /nonce/i;
const FUNDS = /insufficient|not enough|exceeds (the )?balance/i;
const FEE = /\bfee\b|\bou\b|underpriced|max fee per gas|tip (is )?(higher|above)|gas price/i;

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : '');

const plainReason = (text: string) => {
  const clean = text
    .replace(/^RPC [\w.]+: /, '')
    .replace(/\s*\((-?\d+|\?)\)$/, '')
    .replace(/[{}"[\]]/g, '')
    .replace(/[_\s]+/g, ' ')
    .trim();
  const cut = clean.length > 90 ? `${clean.slice(0, 90).trimEnd()}...` : clean;
  return cut ? `${cut.charAt(0).toUpperCase()}${cut.slice(1)}${/[.!?]$/.test(cut) ? '' : '.'}` : '';
};

/** A send whose outcome is unknown is never passed here. */
export function bridgeErrorText(
  e: unknown,
  t: TFunction,
  network: BridgeSide,
  fallback: string
): string {
  const msg = message(e);
  if (/locked/i.test(msg))
    return t('bridge.locked', { defaultValue: 'Unlock 0xio and try again.' });
  if (e instanceof TxScopeError)
    return t('bridge.err.scope', { defaultValue: 'Wallet or network changed. Review again.' });
  if (/paused/i.test(msg))
    return t('bridge.paused', { defaultValue: 'Bridge paused. Try again later.' });
  const verdict = e instanceof RpcResponseError ? msg : (rpcErrorObject(e)?.message ?? null);
  if (verdict !== null) {
    if (NONCE.test(verdict))
      return t('bridge.err.nonce', {
        defaultValue: 'Another transaction is still pending. Try again in a moment.',
      });
    if (FUNDS.test(verdict))
      return network === 'Octra'
        ? t('bridge.err.noOct', { defaultValue: 'Insufficient OCT for the amount and fee.' })
        : network === 'Ethereum'
          ? t('bridge.noEth', { defaultValue: 'Insufficient ETH on Ethereum for network fee' })
          : t('bridge.err.noFunds', {
              defaultValue: 'Insufficient funds on {{network}} for this transaction.',
              network,
            });
    if (FEE.test(verdict))
      return t('bridge.err.feeLow', { defaultValue: 'Network fee too low. Review again.' });
    if (BUSY.test(verdict))
      return t('bridge.err.busy', {
        defaultValue: '{{network}} network is busy. Try again in a moment.',
        network,
      });
    const reason = plainReason(verdict);
    return reason
      ? t('bridge.err.refused', {
          defaultValue: '{{network}} refused the transaction. {{reason}}',
          network,
          reason,
        })
      : fallback;
  }
  if (e instanceof RpcHttpError || BUSY.test(msg))
    return t('bridge.err.busy', {
      defaultValue: '{{network}} network is busy. Try again in a moment.',
      network,
    });
  if (NONCE.test(msg))
    return t('bridge.err.nonce', {
      defaultValue: 'Another transaction is still pending. Try again in a moment.',
    });
  return fallback;
}
