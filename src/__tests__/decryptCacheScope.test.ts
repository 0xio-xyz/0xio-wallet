import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  network: 'devnet',
  ciphers: {} as Record<string, string>,
  values: {} as Record<string, number>,
  pvac: {
    proofGenerationActive: false,
    isReady: true,
    lastDecryptLegacy: false,
    lastDecryptCorrupted: false,
    initialize: async () => {},
    decryptAsync: null as unknown as (c: string) => Promise<number>,
  },
}));

vi.mock('src/services/crypto/CryptoManager', () => ({
  cryptoManager: { signTransaction: () => 'sig' },
  CryptoManager: class {},
}));
vi.mock('src/services/pvac/PvacManager', () => ({
  pvacManager: h.pvac,
  MAX_BALANCE_RAW: 1_000_000_000_000_000,
}));
vi.mock('src/services/privacy/claimBudget', () => ({
  seedClaimBudget: vi.fn(),
  seedClaimBudgetEmpty: vi.fn(),
  consumeClaimSlot: vi.fn(),
  refundClaimSlot: vi.fn(),
  plausibleLayers: vi.fn(),
}));

import { PrivacyNetworkService } from 'src/services/network/PrivacyNetworkService';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const ns = {
  getCurrentNetworkId: async () => h.network,
  resolveNetwork: async () => ({ networkId: h.network, rpcUrl: `https://${h.network}` }),
  jsonRpcCall: vi.fn(
    async (method: string, params: string[], _q?: boolean, at?: { networkId: string }) => {
      const net = at?.networkId ?? h.network;
      if (method === 'octra_encryptedBalance') return { cipher: h.ciphers[`${net}:${params[0]}`] };
      if (method === 'octra_balance') return { balance: '10' };
      throw new Error(method);
    }
  ),
};

let svc: PrivacyNetworkService;
const decrypt = vi.fn(async (c: string) => h.values[c]);

beforeEach(() => {
  h.network = 'devnet';
  h.ciphers = {};
  h.values = { 'hfhe_v1|one': 5_000_000, 'hfhe_v1|two': 8_000_000 };
  decrypt.mockClear();
  h.pvac.decryptAsync = decrypt;
  svc = new PrivacyNetworkService(ns as never);
});

describe('decrypt cache', () => {
  it('never serves the old amount for a cipher a cipher-only read saw first', async () => {
    h.ciphers[`devnet:${A}`] = 'hfhe_v1|one';
    expect((await svc.getEncryptedBalanceDevnet(A, 'pk', 'pub')).encrypted).toBe(5);

    h.ciphers[`devnet:${A}`] = 'hfhe_v1|two';
    expect(await svc.fetchCipherOnly(A, 'pk', 'pub')).toBe('hfhe_v1|two');

    const r = await svc.getEncryptedBalanceDevnet(A, 'pk', 'pub');
    expect(r.encrypted).toBe(8);
    expect(r.total).toBe(18);
  });

  it('does not answer with a cleared amount after a cipher-only read', async () => {
    h.ciphers[`devnet:${A}`] = 'hfhe_v1|one';
    await svc.getEncryptedBalanceDevnet(A, 'pk', 'pub');
    svc.clearDecryptCache();

    h.ciphers[`devnet:${A}`] = 'hfhe_v1|two';
    await svc.fetchCipherOnly(A, 'pk', 'pub');

    expect((await svc.getEncryptedBalanceDevnet(A, 'pk', 'pub')).encrypted).toBe(8);
  });

  it('is keyed by network and address, not by cipher alone', async () => {
    h.ciphers[`devnet:${A}`] = 'hfhe_v1|one';
    await svc.getEncryptedBalanceDevnet(A, 'pk', 'pub');
    expect(decrypt).toHaveBeenCalledTimes(1);

    h.ciphers[`devnet:${B}`] = 'hfhe_v1|one';
    await svc.getEncryptedBalanceDevnet(B, 'pkB', 'pubB');
    expect(decrypt).toHaveBeenCalledTimes(2);

    h.network = 'mainnet';
    h.ciphers[`mainnet:${A}`] = 'hfhe_v1|one';
    await svc.getEncryptedBalanceDevnet(A, 'pk', 'pub');
    expect(decrypt).toHaveBeenCalledTimes(3);
  });

  it('still reuses a decrypt for the same wallet, network and cipher', async () => {
    h.ciphers[`devnet:${A}`] = 'hfhe_v1|one';
    await svc.getEncryptedBalanceDevnet(A, 'pk', 'pub');
    await svc.getEncryptedBalanceDevnet(A, 'pk', 'pub');
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('reports a cipher it could not decrypt as skipped, not as zero', async () => {
    h.ciphers[`devnet:${A}`] = 'hfhe_v1|one';
    decrypt.mockRejectedValueOnce(new Error('worker gone'));
    const r = await svc.getEncryptedBalanceDevnet(A, 'pk', 'pub');
    expect(r.success).toBe(true);
    expect(r.decryptSkipped).toBe(true);
  });
});
