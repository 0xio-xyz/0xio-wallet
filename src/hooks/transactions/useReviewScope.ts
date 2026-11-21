import { useRef } from 'react';
import { captureTxScope, TxScopeError, type TxScope } from 'src/services/network/txScope';
import type { NetworkId } from 'src/utils/config';

/**
 * Binds a signing flow to the network, RPC and wallet its review showed. `bind` when the review
 * opens; the confirmed action `take`s that scope once and hands it to the submit, which refuses
 * after a switch instead of sending under whatever is active by then.
 */
export function useReviewScope() {
  const pending = useRef<Promise<TxScope> | null>(null);

  const bind = (address: string | null | undefined, networkId: NetworkId) => {
    if (!address) {
      pending.current = null;
      return;
    }
    const scope = captureTxScope(address, networkId);
    scope.catch(() => {});
    pending.current = scope;
  };

  const take = (): Promise<TxScope> => {
    const scope = pending.current;
    pending.current = null;
    return scope ?? Promise.reject(new TxScopeError('Review this transaction again to send it.'));
  };

  return { bind, take };
}
