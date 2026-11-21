import { FEE_FLOORS } from '../network/feeQuotes';

export interface SetupPrivateLocal {
  privacy: boolean;
  canSign: boolean;
  blocked: boolean;
  publicRaw: number;
}

export interface SetupPrivateReads {
  pending: () => Promise<boolean>;
  remoteKey: () => Promise<string | null>;
  migration: () => Promise<{ can_key_switch?: boolean } | null>;
  feeRaw: () => Promise<string | null>;
}

export async function checkSetupPrivate(
  local: SetupPrivateLocal,
  reads: SetupPrivateReads
): Promise<string | null> {
  if (!local.privacy || !local.canSign || local.blocked) return null;
  if (!(local.publicRaw >= FEE_FLOORS.key_switch)) return null;
  try {
    if (await reads.pending()) return null;
    const fee = await reads.feeRaw();
    if (!fee || local.publicRaw < Number(fee)) return null;
    if ((await reads.remoteKey()) !== null) return null;
    const status = await reads.migration();
    if (!status || status.can_key_switch === false) return null;
    return fee;
  } catch {
    return null;
  }
}

export function ttlCache<T>(ttlMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { value: T; at: number }>();
  return {
    async get(key: string, read: () => Promise<T | null>): Promise<T | null> {
      const hit = hits.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = await read();
      if (value === null || value === undefined) hits.delete(key);
      else hits.set(key, { value, at: now() });
      return value;
    },
    clear(key?: string) {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    },
  };
}

export const rawToOct = (raw: string): string => {
  const n = Number(raw) / 1_000_000;
  return Number.isFinite(n) ? String(parseFloat(n.toFixed(6))) : '0';
};
