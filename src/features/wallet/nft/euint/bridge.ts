import { networkService } from 'src/services/network/NetworkService';
import { logger } from 'src/utils/logger';
import { resolveCircleAssetReply, type CircleAssetReply } from 'src/utils/octra/circleAsset';

// Only these (idempotent, key-less) read methods are exposed to NFT programs.
const READ_METHODS = new Set(['contract_call', 'circle_asset', 'octra_contractAbi']);

export async function handleBridgeRequest(
  networkId: string,
  method: string,
  params: unknown[]
): Promise<unknown> {
  if (!READ_METHODS.has(method)) {
    throw new Error(`method not allowed: ${method}`);
  }
  if (!Array.isArray(params)) {
    throw new Error('params must be an array');
  }
  // The frame belongs to the network it opened on; after a switch it gets nothing.
  if ((await networkService.getCurrentNetworkId()) !== networkId) {
    throw new Error('network changed');
  }
  logger.debug(`[LivingNFT bridge] ${method}(${params.length} args)`);
  if (method === 'circle_asset') {
    const [circleId, path] = params;
    if (typeof circleId !== 'string' || typeof path !== 'string') {
      throw new Error('circle_asset takes a circle id and a path');
    }
    return resolveCircleAssetReply(
      (item) =>
        networkService.jsonRpcCall('circle_asset', [circleId, item]) as Promise<CircleAssetReply>,
      path
    );
  }
  return networkService.jsonRpcCall(method, params);
}
