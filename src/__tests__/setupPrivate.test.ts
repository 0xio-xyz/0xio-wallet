import { describe, it, expect, vi } from 'vitest';
import {
  checkSetupPrivate,
  rawToOct,
  ttlCache,
  type SetupPrivateLocal,
  type SetupPrivateReads,
} from 'src/services/privacy/setupPrivate';
import { homeTagOrder } from 'src/features/wallet/home/homeTags';

const local = (over: Partial<SetupPrivateLocal> = {}): SetupPrivateLocal => ({
  privacy: true,
  canSign: true,
  blocked: false,
  publicRaw: 25_000_000,
  ...over,
});

const reads = (over: Partial<SetupPrivateReads> = {}): SetupPrivateReads => ({
  pending: vi.fn(async () => false),
  remoteKey: vi.fn(async () => null),
  migration: vi.fn(async () => ({ can_key_switch: true })),
  feeRaw: vi.fn(async () => '49000'),
  ...over,
});

describe('Set up private visibility', () => {
  it('shows with the live fee when every condition holds', async () => {
    expect(await checkSetupPrivate(local(), reads())).toBe('49000');
  });

  it('hides on a network without privacy', async () => {
    expect(await checkSetupPrivate(local({ privacy: false }), reads())).toBeNull();
  });

  it('hides on a wallet that cannot sign', async () => {
    expect(await checkSetupPrivate(local({ canSign: false }), reads())).toBeNull();
  });

  it('hides while the key update is blocked', async () => {
    expect(await checkSetupPrivate(local({ blocked: true }), reads())).toBeNull();
  });

  it('hides when a key is already registered', async () => {
    expect(await checkSetupPrivate(local(), reads({ remoteKey: async () => 'pk' }))).toBeNull();
  });

  it('hides when the key read fails, never reading it as no key', async () => {
    const r = reads({
      remoteKey: async () => {
        throw new Error('503');
      },
    });
    expect(await checkSetupPrivate(local(), r)).toBeNull();
    expect(r.migration).not.toHaveBeenCalled();
  });

  it('hides when the fee read fails instead of showing a guess', async () => {
    const r = reads({ feeRaw: async () => null });
    expect(await checkSetupPrivate(local(), r)).toBeNull();
    expect(r.remoteKey).not.toHaveBeenCalled();
  });

  it('hides when the node refuses a key_switch', async () => {
    expect(
      await checkSetupPrivate(
        local(),
        reads({ migration: async () => ({ can_key_switch: false }) })
      )
    ).toBeNull();
  });

  it('hides when the migration status read fails', async () => {
    expect(await checkSetupPrivate(local(), reads({ migration: async () => null }))).toBeNull();
    expect(
      await checkSetupPrivate(
        local(),
        reads({
          migration: async () => {
            throw new Error('429');
          },
        })
      )
    ).toBeNull();
  });

  it('shows when the status leaves can_key_switch out', async () => {
    expect(await checkSetupPrivate(local(), reads({ migration: async () => ({}) }))).toBe('49000');
  });

  it('hides while a registration is pending', async () => {
    expect(await checkSetupPrivate(local(), reads({ pending: async () => true }))).toBeNull();
  });

  it('hides when the pending record cannot be read', async () => {
    const r = reads({
      pending: async () => {
        throw new Error('storage');
      },
    });
    expect(await checkSetupPrivate(local(), r)).toBeNull();
  });

  it('compares the public balance against the live fee', async () => {
    const r = () => reads({ feeRaw: async () => '1000000' });
    expect(await checkSetupPrivate(local({ publicRaw: 999_999 }), r())).toBeNull();
    expect(await checkSetupPrivate(local({ publicRaw: 1_000_000 }), r())).toBe('1000000');
    expect(await checkSetupPrivate(local({ publicRaw: 60_000 }), reads())).toBe('49000');
    expect(await checkSetupPrivate(local({ publicRaw: 48_999 }), reads())).toBeNull();
  });

  it('asks the node nothing for a balance below any fee', async () => {
    const r = reads();
    expect(await checkSetupPrivate(local({ publicRaw: 0 }), r)).toBeNull();
    expect(r.pending).not.toHaveBeenCalled();
    expect(r.feeRaw).not.toHaveBeenCalled();
    expect(r.remoteKey).not.toHaveBeenCalled();
  });
});

describe('short read cache', () => {
  it('serves a fresh answer and reads again once it is old', async () => {
    let t = 0;
    const cache = ttlCache<string>(1000, () => t);
    const read = vi.fn(async () => 'a');
    await cache.get('k', read);
    t = 999;
    await cache.get('k', read);
    expect(read).toHaveBeenCalledTimes(1);
    t = 1000;
    await cache.get('k', read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never stores a failed read', async () => {
    const cache = ttlCache<string>(60_000);
    const failed = vi.fn(async () => null);
    expect(await cache.get('k', failed)).toBeNull();
    await expect(
      cache.get('k', async () => {
        throw new Error('down');
      })
    ).rejects.toThrow('down');
    const ok = vi.fn(async () => 'v');
    expect(await cache.get('k', ok)).toBe('v');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('keeps network and address apart', async () => {
    const cache = ttlCache<string>(60_000);
    await cache.get('mainnet:oct1', async () => 'm');
    expect(await cache.get('devnet:oct1', async () => 'd')).toBe('d');
    expect(await cache.get('mainnet:oct1', async () => 'x')).toBe('m');
  });
});

describe('Home tag order', () => {
  it('runs from most urgent to least', () => {
    expect(
      homeTagOrder({ padded: true, backup: true, keyBlocked: false, setupPrivate: true })
    ).toEqual(['moveFunds', 'backUp', 'setupPrivate']);
    expect(
      homeTagOrder({ padded: true, backup: true, keyBlocked: true, setupPrivate: false })
    ).toEqual(['moveFunds', 'backUp', 'keyBlocked']);
  });

  it('never shows Set up private beside a blocked key', () => {
    expect(
      homeTagOrder({ padded: false, backup: false, keyBlocked: true, setupPrivate: true })
    ).toEqual(['keyBlocked']);
  });

  it('is empty when nothing applies', () => {
    expect(
      homeTagOrder({ padded: false, backup: false, keyBlocked: false, setupPrivate: false })
    ).toEqual([]);
  });
});

describe('fee figure', () => {
  it('shows raw units as OCT without trailing zeros', () => {
    expect(rawToOct('49000')).toBe('0.049');
    expect(rawToOct('1000000')).toBe('1');
  });
});
