import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('src/services/network/NetworkService', () => ({
  privacyNetworkService: {
    getViewPubkey: vi.fn(),
    getEncryptedBalanceDevnet: vi.fn(),
  },
}));
vi.mock('src/services/pvac/PvacManager', () => ({
  pvacManager: {
    verifyRegistration: vi.fn(async () => true),
    encryptRawAsync: vi.fn(async () => ({
      cipherBytes: new Uint8Array([1]),
      commitmentBytes: new Uint8Array([2]),
    })),
    getCipherBytes: vi.fn(() => new Uint8Array([3])),
    ctSubRawAsync: vi.fn(async () => new Uint8Array([4])),
    makeBoundRangeProof: vi.fn(async () => 'rp_v1|x'),
    pedersenCommitAsync: vi.fn(async () => 'commit'),
    makeBoundProof: vi.fn(async () => 'zkzp_v2|z'),
    encodeCipher: vi.fn(() => 'hfhe_v1|d'),
  },
}));
vi.mock('src/services/crypto/PrivateCrypto', () => ({
  generateEphemeralKeypair: vi.fn(() => ({
    ephSk: new Uint8Array(32),
    ephPub: new Uint8Array(32),
  })),
  ecdhSharedSecret: vi.fn(async () => new Uint8Array(32)),
  computePrivateTag: vi.fn(async () => new Uint8Array(16)),
  computeClaimSecret: vi.fn(async () => new Uint8Array(32)),
  computeClaimPub: vi.fn(async () => new Uint8Array(32)),
  encryptPrivateAmount: vi.fn(async () => 'enc'),
}));

import { buildStealthSendPayload } from 'src/services/privacy/stealthSend';
import { privacyNetworkService } from 'src/services/network/NetworkService';
import { pvacManager } from 'src/services/pvac/PvacManager';

const net = privacyNetworkService as unknown as Record<string, ReturnType<typeof vi.fn>>;
const pvac = pvacManager as unknown as Record<string, ReturnType<typeof vi.fn>>;
const build = () =>
  buildStealthSendPayload({
    from: 'octA',
    to: 'octB',
    privateKey: 'pk',
    publicKey: 'pub',
    amountRaw: 2_000_000,
    scope: { networkId: 'mainnet', rpcUrl: 'https://octra.network', address: 'octA' },
    policy: 1,
  });

beforeEach(() => {
  vi.clearAllMocks();
  net.getViewPubkey.mockResolvedValue('AAAA');
  net.getEncryptedBalanceDevnet.mockResolvedValue({
    success: true,
    cipher: 'hfhe_v1|c',
    encryptedRaw: 5_000_000,
  });
});

describe('a dApp private send', () => {
  it('is a webcli v5 stealth payload on mainnet, never the plain {to, amount}', async () => {
    const data = JSON.parse(await build());
    expect(Object.keys(data).sort()).toEqual(
      [
        'amount_commitment',
        'claim_pub',
        'commitment',
        'delta_cipher',
        'enc_amount',
        'eph_pub',
        'range_proof_balance',
        'range_proof_delta',
        'send_zero_proof',
        'stealth_tag',
        'version',
      ].sort()
    );
    expect(data.version).toBe(5);
    expect(data).not.toHaveProperty('to');
    expect(data).not.toHaveProperty('amount');
    expect(pvac.verifyRegistration).toHaveBeenCalledWith(
      'octA',
      'pk',
      'pub',
      privacyNetworkService,
      false,
      'mainnet'
    );
  });

  it('stops before any proof without a view key or enough private balance', async () => {
    net.getViewPubkey.mockResolvedValueOnce(null);
    await expect(build()).rejects.toThrow(/view pubkey/);
    net.getEncryptedBalanceDevnet.mockResolvedValueOnce({
      success: true,
      cipher: 'hfhe_v1|c',
      encryptedRaw: 1,
    });
    await expect(build()).rejects.toThrow(/Insufficient/);
    expect(pvac.makeBoundRangeProof).not.toHaveBeenCalled();
    expect(pvac.makeBoundProof).not.toHaveBeenCalled();
  });
});
