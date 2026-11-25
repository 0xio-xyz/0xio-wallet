import { ZeroXIOConfig, NetworkId, NetworkConfig, peekNetwork, isCustomNetworkId } from './config';

export function getNetworkConfig(id: NetworkId): NetworkConfig {
  return peekNetwork(id) ?? ZeroXIOConfig.NETWORKS.mainnet;
}

export interface NetworkCapabilities {
  proxy: boolean;
  privacy: boolean;
  market: boolean;
  bridge: boolean;
  tokenListTag?: 'octra-mainnet' | 'octra-devnet';
}

export function networkCapabilities(id: NetworkId): NetworkCapabilities {
  if (isCustomNetworkId(id)) {
    return {
      proxy: false,
      privacy: getNetworkConfig(id).supports_privacy,
      market: false,
      bridge: false,
      tokenListTag: undefined,
    };
  }
  const devnet = id === 'devnet';
  return {
    proxy: true,
    privacy: getNetworkConfig(id).supports_privacy,
    market: true,
    bridge: !devnet,
    tokenListTag: devnet ? 'octra-devnet' : 'octra-mainnet',
  };
}

/**
 * The networks History should read for the active one. The two built-ins are read together and
 * tagged; a custom node is only itself, since reading the built-ins would put Octra's
 * transactions under the user's own node.
 */
export function historyNetworks(activeId: NetworkId): NetworkId[] {
  return isCustomNetworkId(activeId) ? [activeId] : ['mainnet', 'devnet'];
}

export function getExplorerTxUrl(networkId: NetworkId, hash: string): string {
  const config = getNetworkConfig(networkId);
  if (!config.explorer_url) return '';
  const sep = config.explorer_url.endsWith('=') ? '' : '/';
  return `${config.explorer_url}${sep}${hash}`;
}

export function getExplorerAddressUrl(networkId: NetworkId, address: string): string {
  const config = getNetworkConfig(networkId);
  if (!config.explorer_address_url) return '';
  const sep = config.explorer_address_url.endsWith('=') ? '' : '/';
  return `${config.explorer_address_url}${sep}${address}`;
}

export function supportsPrivacy(networkId: NetworkId): boolean {
  return getNetworkConfig(networkId).supports_privacy;
}
