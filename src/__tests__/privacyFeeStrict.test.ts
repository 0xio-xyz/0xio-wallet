import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NetworkService,
  resetMigrationStatusSupportForTests,
  setFeeRetrySleepForTests,
} from 'src/services/network/NetworkService';
import { PrivacyNetworkService } from 'src/services/network/PrivacyNetworkService';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const mainnet = { networkId: 'mainnet' as const, rpcUrl: 'https://main' };
const devnet = { networkId: 'devnet' as const, rpcUrl: 'https://dev' };

let ns: NetworkService;
let rpc: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetMigrationStatusSupportForTests();
  setFeeRetrySleepForTests(async () => {});
  ns = new NetworkService();
  rpc = vi.spyOn(ns, 'jsonRpcCall');
});

describe('strict fee reads', () => {
  it('returns null when the node fails, never a fixed fallback', async () => {
    rpc.mockRejectedValue(new Error('429'));
    expect(await ns.getRecommendedFeeStrict('encrypt', mainnet)).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(3);
    rpc.mockResolvedValue({});
    expect(await ns.getRecommendedFeeStrict('encrypt', mainnet)).toBeNull();
  });

  it('reads the quote on the pinned network', async () => {
    rpc.mockResolvedValueOnce({ minimum: '900000', recommended: '1000000', fast: '1500000' });
    expect(await ns.getRecommendedFeeStrict('claim', devnet)).toEqual({
      minimum: '900000',
      recommended: '1000000',
      fast: '1500000',
    });
    expect(rpc).toHaveBeenCalledWith('octra_recommendedFee', ['claim'], undefined, devnet, {
      timeoutMs: 8_000,
    });
  });

  it('blocks a key update when its fee cannot be read or is out of range', async () => {
    const privacy = new PrivacyNetworkService(ns);
    rpc.mockRejectedValue(new Error('503'));
    expect(await privacy.getKeySwitchFeeQuote('recommended', devnet)).toBeNull();
    rpc.mockResolvedValueOnce({ minimum: '1000', recommended: '99999999', fast: '99999999' });
    expect(await privacy.getKeySwitchFeeQuote('recommended', devnet)).toBeNull();
    ns.forgetFeeQuotes();
    rpc.mockResolvedValueOnce({ minimum: '3000', recommended: '49000', fast: '60000' });
    expect(await privacy.getKeySwitchFeeQuote('fast', devnet)).toBe('60000');
    ns.forgetFeeQuotes();
    rpc.mockResolvedValueOnce({ minimum: '1000', recommended: '3000', fast: '4000' });
    expect(await privacy.getKeySwitchFeeQuote('recommended', devnet)).toBe('5000');
  });

  it('refuses to sign a key_switch when the fee read fails', async () => {
    const privacy = new PrivacyNetworkService(ns);
    rpc.mockRejectedValue(new Error('503'));
    await expect(
      privacy.buildKeySwitchTransaction({
        from: A,
        nonce: 1,
        privateKey: 'sk',
        newPubkeyB64: 'AA==',
        policy: 1,
        aesKat: 'kat',
        pubkeyHashPrefix: '00',
        at: devnet,
      })
    ).rejects.toThrow('Network fee unavailable');
  });
});

describe('migration status reads', () => {
  it('tells a node without the method apart from a failed read and remembers it', async () => {
    rpc.mockRejectedValueOnce(new Error('Method not found'));
    expect(await ns.readPvacMigrationStatus(A, mainnet)).toEqual({ kind: 'unsupported' });
    expect(await ns.readPvacMigrationStatus(A, mainnet)).toEqual({ kind: 'unsupported' });
    expect(rpc).toHaveBeenCalledTimes(1);

    rpc.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    expect((await ns.readPvacMigrationStatus(A, devnet)).kind).toBe('failed');
    rpc.mockResolvedValueOnce({ cipher_class: 'empty', can_key_switch: true });
    expect(await ns.readPvacMigrationStatus(A, devnet)).toEqual({
      kind: 'ok',
      status: { cipher_class: 'empty', can_key_switch: true },
    });
  });
});
