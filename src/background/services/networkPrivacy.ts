import {
  ZeroXIOConfig,
  isCustomNetworkId,
  resolveCustomNetwork,
  type NetworkId,
} from '../../utils/config';
import { networkCapabilities } from '../../utils/network';

/**
 * Whether the active network runs private operations. A custom network is read from storage, so a
 * request that lands before the worker has loaded its network list still gets the user's answer.
 */
export async function activeNetworkHasPrivacy(): Promise<boolean> {
  const key = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;
  const id: string = (await chrome.storage.local.get(key))[key] || 'mainnet';
  if (isCustomNetworkId(id)) return !!(await resolveCustomNetwork(id))?.supports_privacy;
  return networkCapabilities(id as NetworkId).privacy;
}
