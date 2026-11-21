import { useEffect, useState } from 'react';
import { useWallet } from 'src/contexts/WalletContext';
import { readEvmBalanceSnapshot } from 'src/hooks/wallet/useEvmBalances';
import { evmRowUsd, useEvmPriceState } from 'src/hooks/wallet/useEvmPrices';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import type { EvmBalanceRow } from 'src/services/evm/balances';
import { llamaKey } from 'src/services/evm/prices';

export function useHeldByChain(evmAddress: string | null | undefined): Record<number, number> {
  const { networkId } = useWallet();
  const scope = `${networkId}:${evmAddress?.toLowerCase() ?? ''}`;
  const [read, setRead] = useState<{ scope: string; rows: EvmBalanceRow[] }>({
    scope: '',
    rows: [],
  });

  // effect:audited - reads the stored EVM balances (chrome.storage) for this network + address;
  // a late answer for another scope is dropped
  useEffect(() => {
    if (!evmAddress) return;
    let live = true;
    void readEvmBalanceSnapshot(networkId, evmAddress).then((rows) => {
      if (live) setRead({ scope, rows });
    });
    return () => {
      live = false;
    };
  }, [scope, networkId, evmAddress]);

  const rows = read.scope === scope ? read.rows : [];
  const keys = rows.map((r) => llamaKey(r.chainId, r.token)).filter((k): k is string => !!k);
  const { prices } = useEvmPriceState(keys);
  const ethPrice = useTokenPrice().getPrice('ETH') || 0;

  const held: Record<number, number> = {};
  for (const r of rows) {
    const amount = parseFloat(r.amount) || 0;
    if (amount <= 0) continue;
    const key = llamaKey(r.chainId, r.token);
    const usd = evmRowUsd(r, amount, key ? prices[key] : undefined, ethPrice);
    if (usd && usd > 0) held[r.chainId] = (held[r.chainId] ?? 0) + usd;
  }
  return held;
}
