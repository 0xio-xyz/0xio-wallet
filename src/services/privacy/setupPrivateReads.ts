import { networkService, privacyNetworkService } from '../network/NetworkService';
import { getPendingKeySwitch } from '../pvac/keySwitchService';
import { ttlCache, type SetupPrivateReads } from './setupPrivate';
import { resolveNetworkPin } from '../network/txScope';
import type { NetworkId } from 'src/utils/config';

const TTL_MS = 60_000;
type MigrationStatus = NonNullable<
  Awaited<ReturnType<typeof networkService.getPvacMigrationStatus>>
>;

const migrationCache = ttlCache<MigrationStatus>(TTL_MS);
const migrationInflight = new Map<string, Promise<MigrationStatus | null>>();
const feeCache = ttlCache<string>(TTL_MS);

export function readMigrationStatus(
  networkId: NetworkId,
  address: string
): Promise<MigrationStatus | null> {
  const key = `${networkId}:${address}`;
  const running = migrationInflight.get(key);
  if (running) return running;
  const job = migrationCache
    .get(key, async () =>
      networkService.getPvacMigrationStatus(address, await resolveNetworkPin(networkId))
    )
    .finally(() => migrationInflight.delete(key));
  migrationInflight.set(key, job);
  return job;
}

export const nodeReads = (networkId: NetworkId, address: string): SetupPrivateReads => {
  return {
    pending: async () => !!(await getPendingKeySwitch({ networkId, address })),
    remoteKey: async () =>
      privacyNetworkService.getPvacPubkey(address, await resolveNetworkPin(networkId)),
    migration: () => readMigrationStatus(networkId, address),
    feeRaw: async () =>
      feeCache.get(networkId, async () =>
        privacyNetworkService.getKeySwitchFeeQuote(
          'recommended',
          await resolveNetworkPin(networkId)
        )
      ),
  };
};
