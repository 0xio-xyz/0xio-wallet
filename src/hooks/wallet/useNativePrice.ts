import { llamaKey } from 'src/services/evm/prices';
import type { EvmNetwork } from 'src/services/evm/networks';
import { isBuiltinChain } from 'src/services/evm/registry';
import { useEvmPrices } from 'src/hooks/wallet/useEvmPrices';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';

export function useNativePrice(
  network: Pick<EvmNetwork, 'chainId' | 'testnet' | 'nativeSymbol'> | null
): number | null {
  const key = network && !network.testnet ? llamaKey(network.chainId, { address: null }) : null;
  const prices = useEvmPrices(key ? [key] : []);
  const { getPrice } = useTokenPrice();
  if (!network || network.testnet) return null;
  const market = key ? prices[key] : undefined;
  if (market !== undefined && Number.isFinite(market) && market > 0) return market;
  if (network.nativeSymbol === 'ETH' && isBuiltinChain(network.chainId)) {
    const eth = getPrice('ETH');
    return eth && eth > 0 ? eth : null;
  }
  return null;
}
