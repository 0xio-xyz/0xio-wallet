import { networkService } from 'src/services/network/NetworkService';
import { logger } from 'src/utils/logger';

const contractAbiCache = new Map<string, Promise<string[]>>();

export function getContractAbiMethods(
  networkId: string,
  contractAddress: string
): Promise<string[]> {
  const key = `${networkId}:${contractAddress}`;
  const hit = contractAbiCache.get(key);
  if (hit) {
    logger.debug(`[NFT] ABI cache hit | ${contractAddress.slice(0, 10)}…`);
    return hit;
  }
  logger.debug(`[NFT] ABI fetch | ${contractAddress.slice(0, 10)}…`);
  const p = (async () => {
    try {
      const abi = await networkService.jsonRpcCall('octra_contractAbi', [contractAddress]);
      return (
        ((abi as { methods?: unknown[] })?.methods || []) as Array<{ name?: string } | string>
      ).map((m) => (typeof m === 'string' ? m : (m?.name ?? '')));
    } catch (e) {
      contractAbiCache.delete(key);
      throw e;
    }
  })();
  contractAbiCache.set(key, p);
  return p;
}

export function clearAbiCache(): void {
  contractAbiCache.clear();
}
