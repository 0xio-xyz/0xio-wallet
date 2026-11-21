import type { NetworkPin } from '../network/txScope';
import type { PvacMigrationRead } from '../network/NetworkService';

/**
 * The network's PVAC proof policy, read exactly as the webcli does (main.cpp read_proof_policy,
 * lib/pvac_migration.hpp, 52fca46): bit 0 = wide challenge reduction, bit 1 = proofs bound to
 * the registered key. A network that announces neither refuses every private op.
 */

export const PROOF_WIDE = 1;
export const PROOF_BIND_KEY = 2;

export const PROOF_POLICY_UNAVAILABLE = 'Network proof arithmetic is unavailable';
export const PROOF_KEY_POLICY_UNAVAILABLE = 'Network proof key policy is unavailable';
export const PROOF_POLICY_UNREACHABLE = 'Network proof rules could not be read';
export const PROOF_POLICY_CHANGED =
  'Proof policy changed. Nothing sent. Prepare the transaction again.';

export class ProofPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofPolicyError';
  }
}

const RUNTIME_PROFILES = new Set([
  '86a3e354b18cad2cd2ec35c63a61924aa78363fef2e93e1b5f5b37badd7d0c0c',
  '1d46b19e336be6978b7a27b3fc04eda930cd58114858fd8a822c29c2e96ff13a',
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** webcli octra::proof_policy over an octra_pvacMigrationStatus result that has proof_math. */
export function policyFromStatus(status: Record<string, unknown>): number {
  const key = 'proof_key' in status ? status.proof_key : false;
  if (typeof key !== 'boolean') throw new ProofPolicyError(PROOF_KEY_POLICY_UNAVAILABLE);
  const math = status.proof_math;
  if (math !== 'wide' && math !== 'prior') throw new ProofPolicyError(PROOF_POLICY_UNAVAILABLE);
  return (math === 'wide' ? PROOF_WIDE : 0) | (key ? PROOF_BIND_KEY : 0);
}

/** webcli octra::profile_math: only the exact devnet runtime implies the wide policy. */
export function policyFromRuntime(runtime: unknown): number {
  if (
    isObject(runtime) &&
    runtime.schema === 'octra-runtime-release-v1' &&
    runtime.chain_id === 'octra-devnet-9871-cluster' &&
    runtime.consensus_rules_id === 'finalized_rejection_commitment' &&
    runtime.consensus_profile === 16 &&
    typeof runtime.runtime_profile_hash === 'string' &&
    RUNTIME_PROFILES.has(runtime.runtime_profile_hash)
  ) {
    return PROOF_WIDE;
  }
  throw new ProofPolicyError(PROOF_POLICY_UNAVAILABLE);
}

export interface ProofPolicyRpc {
  readPvacMigrationStatus(address: string, at?: NetworkPin): Promise<PvacMigrationRead>;
  jsonRpcCall(method: string, params?: unknown[], quiet?: boolean, at?: NetworkPin): Promise<any>;
}

const defaultRpc = async (): Promise<ProofPolicyRpc> =>
  (await import('../network/NetworkService')).networkService;

export async function readProofPolicy(
  address: string,
  at: NetworkPin,
  rpc?: ProofPolicyRpc
): Promise<number> {
  const node = rpc ?? (await defaultRpc());
  const read = await node.readPvacMigrationStatus(address, at);
  if (read.kind === 'failed') throw new ProofPolicyError(PROOF_POLICY_UNREACHABLE);
  if (read.kind !== 'ok') throw new ProofPolicyError(PROOF_POLICY_UNAVAILABLE);
  const status = read.status as unknown;
  if (!isObject(status) || status.address !== address) {
    throw new ProofPolicyError(PROOF_POLICY_UNAVAILABLE);
  }
  if ('proof_math' in status) return policyFromStatus(status);
  let runtime: unknown;
  try {
    runtime = await node.jsonRpcCall('octra_runtimeVersion', [], true, at);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ProofPolicyError(
      /method not found|-32601/i.test(message) ? PROOF_POLICY_UNAVAILABLE : PROOF_POLICY_UNREACHABLE
    );
  }
  return policyFromRuntime(runtime);
}

const POLICY_TTL_MS = 5 * 60_000;
const cache = new Map<string, { policy: number; ts: number }>();
const cacheKey = (address: string, at: NetworkPin) => `${at.networkId}|${at.rpcUrl}|${address}`;

export async function proofPolicyFor(
  address: string,
  at: NetworkPin,
  rpc?: ProofPolicyRpc
): Promise<number> {
  const key = cacheKey(address, at);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < POLICY_TTL_MS) return hit.policy;
  try {
    const policy = await readProofPolicy(address, at, rpc);
    cache.set(key, { policy, ts: Date.now() });
    return policy;
  } catch (e) {
    cache.delete(key);
    throw e;
  }
}

/** Read again right before submitting: a policy that moved since the proofs means nothing goes. */
export async function requireProofPolicy(
  prepared: number,
  address: string,
  at: NetworkPin,
  rpc?: ProofPolicyRpc
): Promise<void> {
  cache.delete(cacheKey(address, at));
  const current = await proofPolicyFor(address, at, rpc);
  if (current !== prepared) throw new ProofPolicyError(PROOF_POLICY_CHANGED);
}

export const bindsKey = (policy: number) => (policy & PROOF_BIND_KEY) !== 0;

export function forgetProofPolicies(): void {
  cache.clear();
}

/** webcli octra::cipher_route: a proven balance on a historical key migrates by cipher proof. */
export function cipherProofRoute(status: unknown): boolean {
  if (!isObject(status)) return false;
  const proven =
    status.cipher_format === 'proven' ||
    (!('cipher_format' in status) && status.cipher_class === 'v3');
  return (
    status.cipher_proof_rule === 'active' &&
    status.can_cipher_proof_migrate === true &&
    proven &&
    status.key_class === 'historical'
  );
}
