import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readStatus: vi.fn(),
  encBal: vi.fn(),
}));

vi.mock('src/services/network/NetworkService', () => ({
  networkService: { readPvacMigrationStatus: h.readStatus },
  privacyNetworkService: { getEncryptedBalanceDevnet: h.encBal },
}));

import { ACCOUNT_STATE_UNREAD, resolveKeySwitchMode } from 'src/services/pvac/keySwitchService';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const pin = { networkId: 'mainnet' as const, rpcUrl: 'https://node' };
const bal = (over: Record<string, unknown>) => ({
  success: true,
  public: 1,
  publicRaw: 1_000_000,
  encrypted: 0,
  encryptedRaw: 0,
  total: 1,
  ...over,
});

beforeEach(() => {
  h.readStatus.mockReset();
  h.encBal.mockReset();
});

describe('key update mode', () => {
  it('blocks when the migration status read fails, without reading the balance', async () => {
    h.readStatus.mockResolvedValue({ kind: 'failed', error: '503' });
    expect(await resolveKeySwitchMode(A, 'sk', 'pk', pin)).toEqual({
      mode: 'blocked',
      reason: ACCOUNT_STATE_UNREAD,
    });
    expect(h.encBal).not.toHaveBeenCalled();
  });

  it('blocks on a node without the status method when the balance read fails', async () => {
    h.readStatus.mockResolvedValue({ kind: 'unsupported' });
    h.encBal.mockResolvedValue(bal({ success: false, error: 'timeout' }));
    expect(await resolveKeySwitchMode(A, 'sk', 'pk', pin)).toEqual({
      mode: 'blocked',
      reason: ACCOUNT_STATE_UNREAD,
    });
  });

  it('allows a bare rotation on such a node only when no cipher exists', async () => {
    h.readStatus.mockResolvedValue({ kind: 'unsupported' });
    h.encBal.mockResolvedValue(bal({ cipher: undefined }));
    expect(await resolveKeySwitchMode(A, 'sk', 'pk', pin)).toEqual({ mode: 'empty_key_switch' });
    h.encBal.mockResolvedValue(bal({ cipher: '0' }));
    expect(await resolveKeySwitchMode(A, 'sk', 'pk', pin)).toEqual({ mode: 'empty_key_switch' });
  });

  it('never takes a decrypted 0 as an empty balance', async () => {
    h.readStatus.mockResolvedValue({ kind: 'unsupported' });
    for (const over of [
      { cipher: 'hfhe_v1|abc' },
      { cipher: 'hfhe_v1|abc', cipherCorrupted: true },
      { cipher: 'hfhe_v1|abc', decryptSkipped: true },
    ]) {
      h.encBal.mockResolvedValue(bal(over));
      expect((await resolveKeySwitchMode(A, 'sk', 'pk', pin)).mode).toBe('blocked');
    }
  });

  it('follows the node when it reports an empty cipher', async () => {
    h.readStatus.mockResolvedValue({ kind: 'ok', status: { cipher_class: 'empty' } });
    expect(await resolveKeySwitchMode(A, 'sk', 'pk', pin)).toEqual({ mode: 'empty_key_switch' });
  });

  it('blocks a legacy replay when the local decrypt was skipped', async () => {
    h.readStatus.mockResolvedValue({
      kind: 'ok',
      status: {
        cipher_class: 'legacy_hfhe',
        legacy_public_replay: { can_public_migrate: true, public_net_raw: '0' },
      },
    });
    h.encBal.mockResolvedValue(bal({ cipher: 'hfhe_v1|abc', decryptSkipped: true }));
    expect((await resolveKeySwitchMode(A, 'sk', 'pk', pin)).mode).toBe('blocked');
    h.encBal.mockResolvedValue(bal({ cipher: 'hfhe_v1|abc' }));
    expect((await resolveKeySwitchMode(A, 'sk', 'pk', pin)).mode).toBe('legacy_zero_reset');
  });

  it('reads every answer on the pinned network', async () => {
    h.readStatus.mockResolvedValue({ kind: 'unsupported' });
    h.encBal.mockResolvedValue(bal({}));
    await resolveKeySwitchMode(A, 'sk', 'pk', pin);
    expect(h.readStatus).toHaveBeenCalledWith(A, pin);
    expect(h.encBal).toHaveBeenCalledWith(A, 'sk', 'pk', pin);
  });
});
