import type { networkService } from '../network/NetworkService';

type MigrationStatus = NonNullable<
  Awaited<ReturnType<typeof networkService.getPvacMigrationStatus>>
>;

export interface PrivateStatus {
  kind: 'empty' | 'held' | 'open';
  reason: string | null;
}

export function privateStatusOf(status: MigrationStatus | null | undefined): PrivateStatus | null {
  if (!status || typeof status.cipher_class !== 'string') return null;
  if (status.cipher_class === 'empty') return { kind: 'empty', reason: null };
  const routeOpen =
    status.can_key_switch === true ||
    status.can_v3_migrate === true ||
    status.legacy_public_replay?.can_public_migrate === true;
  if (status.can_key_switch === false && !routeOpen) {
    const reason = status.legacy_public_replay?.reason || status.reason || null;
    return { kind: 'held', reason };
  }
  return { kind: 'open', reason: null };
}
