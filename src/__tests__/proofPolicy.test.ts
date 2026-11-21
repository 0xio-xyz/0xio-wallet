import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('src/services/pvac/PvacManager', () => ({
  pvacManager: {
    makeKeyOwnerProof: vi.fn(async () => ({
      owner_cipher: 'hfhe_v1|oc',
      owner_proof: 'zkzp_v2|op',
    })),
    computeAesKat: vi.fn(async () => 'kat'),
  },
}));
vi.mock('src/services/network/txScope', async (actual) => ({
  ...(await actual<typeof import('src/services/network/txScope')>()),
  assertTxScope: vi.fn(async () => {}),
}));

import { networkService } from 'src/services/network/NetworkService';
import {
  PROOF_POLICY_CHANGED,
  PROOF_POLICY_UNAVAILABLE,
  PROOF_POLICY_UNREACHABLE,
  ProofPolicyError,
  cipherProofRoute,
  forgetProofPolicies,
  policyFromRuntime,
  policyFromStatus,
  proofPolicyFor,
  readProofPolicy,
  requireProofPolicy,
  type ProofPolicyRpc,
} from 'src/services/pvac/proofPolicy';
import { PrivacyNetworkService } from 'src/services/network/PrivacyNetworkService';
import { pvacManager } from 'src/services/pvac/PvacManager';
import { errorKey } from 'src/utils/plainError';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const devnet = { networkId: 'devnet' as const, rpcUrl: 'https://dev' };
const mainnet = { networkId: 'mainnet' as const, rpcUrl: 'https://main' };

const RUNTIME = {
  schema: 'octra-runtime-release-v1',
  chain_id: 'octra-devnet-9871-cluster',
  consensus_rules_id: 'finalized_rejection_commitment',
  consensus_profile: 16,
  runtime_profile_hash: '86a3e354b18cad2cd2ec35c63a61924aa78363fef2e93e1b5f5b37badd7d0c0c',
};

const node = (status: unknown, runtime: unknown = RUNTIME) => {
  const rpc = {
    readPvacMigrationStatus: vi.fn(async () =>
      status === 'unsupported'
        ? { kind: 'unsupported' as const }
        : status === 'failed'
          ? { kind: 'failed' as const, error: '503' }
          : { kind: 'ok' as const, status: status as never }
    ),
    jsonRpcCall: vi.fn(async () => {
      if (runtime instanceof Error) throw runtime;
      return runtime;
    }),
  };
  return rpc as typeof rpc & ProofPolicyRpc;
};

beforeEach(() => forgetProofPolicies());

describe('the proof policy announced in the migration status', () => {
  it.each([
    [{ proof_math: 'wide' }, 1],
    [{ proof_math: 'prior' }, 0],
    [{ proof_math: 'wide', proof_key: true }, 3],
    [{ proof_math: 'prior', proof_key: true }, 2],
    [{ proof_math: 'wide', proof_key: false }, 1],
  ])('%j reads as policy %i', (fields, policy) => {
    expect(policyFromStatus(fields)).toBe(policy);
  });

  it.each([
    [{ proof_math: 'fast' }],
    [{ proof_math: null }],
    [{ proof_math: 'wide', proof_key: 'yes' }],
    [{ proof_math: 'wide', proof_key: null }],
  ])('refuses %j', (fields) => {
    expect(() => policyFromStatus(fields)).toThrow(ProofPolicyError);
  });
});

describe('the devnet runtime fallback', () => {
  it('reads policy 1 only from the exact devnet runtime and both known profiles', () => {
    expect(policyFromRuntime(RUNTIME)).toBe(1);
    expect(
      policyFromRuntime({
        ...RUNTIME,
        runtime_profile_hash: '1d46b19e336be6978b7a27b3fc04eda930cd58114858fd8a822c29c2e96ff13a',
      })
    ).toBe(1);
  });

  it.each([
    ['schema', 'octra-runtime-release-v2'],
    ['chain_id', 'octra-mainnet'],
    ['consensus_rules_id', 'other'],
    ['consensus_profile', 15],
    ['consensus_profile', '16'],
    ['runtime_profile_hash', '00'],
  ])('refuses a runtime whose %s is %j', (field, value) => {
    expect(() => policyFromRuntime({ ...RUNTIME, [field]: value })).toThrow(
      PROOF_POLICY_UNAVAILABLE
    );
  });
});

describe('reading the policy for an address', () => {
  it('uses proof_math when the status has it and never asks the runtime', async () => {
    const rpc = node({ address: A, proof_math: 'prior', proof_key: true });
    expect(await readProofPolicy(A, devnet, rpc)).toBe(2);
    expect(rpc.jsonRpcCall).not.toHaveBeenCalled();
  });

  it('falls back to the runtime without proof_math', async () => {
    const rpc = node({ address: A });
    expect(await readProofPolicy(A, devnet, rpc)).toBe(1);
    expect(rpc.jsonRpcCall).toHaveBeenCalledWith('octra_runtimeVersion', [], true, devnet);
  });

  it.each([
    ['a node without the status method', 'unsupported'],
    ['a status for another address', { address: B, proof_math: 'wide' }],
    ['a status without an address', { proof_math: 'wide' }],
    ['a status that is not an object', ['x']],
  ])('refuses private ops on %s', async (_why, status) => {
    await expect(readProofPolicy(A, devnet, node(status))).rejects.toThrow(
      PROOF_POLICY_UNAVAILABLE
    );
  });

  it('says the network could not be reached when a read fails on the way', async () => {
    await expect(readProofPolicy(A, devnet, node('failed'))).rejects.toThrow(
      PROOF_POLICY_UNREACHABLE
    );
    await expect(
      readProofPolicy(A, devnet, node({ address: A }, new Error('HTTP 429')))
    ).rejects.toThrow(PROOF_POLICY_UNREACHABLE);
  });

  it('refuses when the runtime cannot be read or is not the devnet one', async () => {
    await expect(
      readProofPolicy(A, devnet, node({ address: A }, new Error('-32601')))
    ).rejects.toThrow(PROOF_POLICY_UNAVAILABLE);
    await expect(
      readProofPolicy(A, mainnet, node({ address: A }, { ...RUNTIME, chain_id: 'octra-mainnet' }))
    ).rejects.toThrow(PROOF_POLICY_UNAVAILABLE);
  });

  it('caches per network and address and drops a failed read', async () => {
    const rpc = node({ address: A, proof_math: 'wide' });
    await proofPolicyFor(A, devnet, rpc);
    await proofPolicyFor(A, devnet, rpc);
    expect(rpc.readPvacMigrationStatus).toHaveBeenCalledTimes(1);
    await proofPolicyFor(A, mainnet, rpc);
    expect(rpc.readPvacMigrationStatus).toHaveBeenCalledTimes(2);
    await expect(proofPolicyFor(B, devnet, rpc)).rejects.toThrow(PROOF_POLICY_UNAVAILABLE);
  });
});

describe('the check right before submit', () => {
  it('reads fresh and passes when the policy is the one the proofs were made under', async () => {
    const rpc = node({ address: A, proof_math: 'wide' });
    expect(await proofPolicyFor(A, devnet, rpc)).toBe(1);
    await requireProofPolicy(1, A, devnet, rpc);
    expect(rpc.readPvacMigrationStatus).toHaveBeenCalledTimes(2);
  });

  it('refuses when the policy changed after the proofs', async () => {
    const before = node({ address: A, proof_math: 'wide' });
    const prepared = await proofPolicyFor(A, devnet, before);
    const after = node({ address: A, proof_math: 'wide', proof_key: true });
    await expect(requireProofPolicy(prepared, A, devnet, after)).rejects.toThrow(
      PROOF_POLICY_CHANGED
    );
    expect(errorKey(new ProofPolicyError(PROOF_POLICY_CHANGED))).toBe(
      'toast.err.proofPolicyChanged'
    );
    expect(errorKey(new ProofPolicyError(PROOF_POLICY_UNAVAILABLE))).toBe(
      'toast.err.proofPolicyUnavailable'
    );
  });
});

describe('the cipher proof route', () => {
  const route = {
    cipher_proof_rule: 'active',
    can_cipher_proof_migrate: true,
    cipher_format: 'proven',
    key_class: 'historical',
  };
  it('opens only for a proven balance on a historical key', () => {
    expect(cipherProofRoute(route)).toBe(true);
    const { cipher_format: _f, ...noFormat } = route;
    expect(cipherProofRoute({ ...noFormat, cipher_class: 'v3' })).toBe(true);
    expect(cipherProofRoute({ ...noFormat, cipher_class: 'key_bound' })).toBe(false);
    expect(cipherProofRoute({ ...route, cipher_format: 'legacy', cipher_class: 'v3' })).toBe(false);
    expect(cipherProofRoute({ ...route, key_class: 'current' })).toBe(false);
    expect(cipherProofRoute({ ...route, can_cipher_proof_migrate: 'true' })).toBe(false);
    expect(cipherProofRoute({ ...route, cipher_proof_rule: 'ready' })).toBe(false);
    expect(cipherProofRoute(null)).toBe(false);
  });
});

describe('key_switch under a key binding policy', () => {
  const build = async (policy: number) => {
    const privacy = new PrivacyNetworkService({} as never);
    const hfhe = vi.spyOn(privacy, 'buildHfheTransaction').mockResolvedValue({} as never);
    await privacy.buildKeySwitchTransaction({
      from: A,
      nonce: 1,
      privateKey: 'sk',
      newPubkeyB64: 'AA==',
      aesKat: 'kat',
      pubkeyHashPrefix: '00',
      migration: { new_cipher: 'c' },
      policy,
      ou: '5000',
    });
    return JSON.parse(hfhe.mock.calls[0][0].encryptedData);
  };

  it('adds owner_cipher and owner_proof only when the policy binds the key', async () => {
    vi.mocked(pvacManager.makeKeyOwnerProof).mockClear();
    expect(await build(1)).toEqual({ new_pubkey: 'AA==', aes_kat: 'kat', new_cipher: 'c' });
    expect(pvacManager.makeKeyOwnerProof).not.toHaveBeenCalled();
    expect(await build(3)).toEqual({
      new_pubkey: 'AA==',
      aes_kat: 'kat',
      new_cipher: 'c',
      owner_cipher: 'hfhe_v1|oc',
      owner_proof: 'zkzp_v2|op',
    });
    expect(pvacManager.makeKeyOwnerProof).toHaveBeenCalledWith(A, 3);
  });

  it('sends nothing when the policy moved after the migration was proven', async () => {
    const ns = {
      readPvacMigrationStatus: vi.fn(async () => ({
        kind: 'ok',
        status: { address: A, proof_math: 'wide', proof_key: true },
      })),
      jsonRpcCall: vi.fn(),
      getNextNonce: vi.fn(async () => 1),
    };
    vi.spyOn(networkService, 'readPvacMigrationStatus').mockImplementation(
      ns.readPvacMigrationStatus as never
    );
    const send = vi.fn();
    (chrome.runtime as any).sendMessage = send;
    const privacy = new PrivacyNetworkService(ns as never);
    await expect(
      privacy.registerPvacViaKeySwitch(
        A,
        'AA==',
        'sk',
        null,
        { new_cipher: 'c' },
        'recommended',
        '5000',
        { ...devnet, address: A },
        1
      )
    ).rejects.toThrow(PROOF_POLICY_CHANGED);
    expect(ns.getNextNonce).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
