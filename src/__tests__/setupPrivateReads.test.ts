import { describe, it, expect, vi, beforeEach } from 'vitest';

const feeQuote = vi.fn();
const migration = vi.fn();
const pubkey = vi.fn();

vi.mock('src/services/network/NetworkService', () => ({
  networkService: { getPvacMigrationStatus: migration },
  privacyNetworkService: { getPvacPubkey: pubkey, getKeySwitchFeeQuote: feeQuote },
}));
vi.mock('src/services/pvac/keySwitchService', () => ({
  getPendingKeySwitch: vi.fn(async () => null),
}));
vi.mock('src/services/network/txScope', () => ({
  resolveNetworkPin: vi.fn(async (networkId: string) => ({
    networkId,
    rpcUrl: `rpc:${networkId}`,
  })),
}));

const { nodeReads } = await import('src/services/privacy/setupPrivateReads');

describe('Set up private reads', () => {
  beforeEach(() => {
    feeQuote.mockReset();
    migration.mockReset();
  });

  it('reads the live key_switch fee on the wallet network', async () => {
    feeQuote.mockResolvedValueOnce('49000');
    expect(await nodeReads('custom-fee-a' as never, 'oct1').feeRaw()).toBe('49000');
    expect(feeQuote).toHaveBeenCalledWith('recommended', {
      networkId: 'custom-fee-a',
      rpcUrl: 'rpc:custom-fee-a',
    });
  });

  it('yields null on a failed fee read, never a fixed fallback, and never caches it', async () => {
    feeQuote.mockResolvedValueOnce(null);
    expect(await nodeReads('custom-fee-c' as never, 'oct1').feeRaw()).toBeNull();
    feeQuote.mockResolvedValueOnce('5000');
    expect(await nodeReads('custom-fee-c' as never, 'oct1').feeRaw()).toBe('5000');
    expect(feeQuote).toHaveBeenCalledTimes(2);
  });

  it('caches the migration status per network and address but never a failed read', async () => {
    migration.mockResolvedValueOnce(null).mockResolvedValue({ can_key_switch: true });
    const reads = nodeReads('custom-mig' as never, 'oct2');
    expect(await reads.migration()).toBeNull();
    expect(await reads.migration()).toEqual({ can_key_switch: true });
    expect(await reads.migration()).toEqual({ can_key_switch: true });
    expect(migration).toHaveBeenCalledTimes(2);
    await nodeReads('custom-mig' as never, 'oct3').migration();
    expect(migration).toHaveBeenCalledTimes(3);
  });

  it('reads the registered key pinned to the wallet network', async () => {
    pubkey.mockResolvedValueOnce(null);
    expect(await nodeReads('devnet', 'oct4').remoteKey()).toBeNull();
    expect(pubkey).toHaveBeenCalledWith('oct4', { networkId: 'devnet', rpcUrl: 'rpc:devnet' });
  });
});
