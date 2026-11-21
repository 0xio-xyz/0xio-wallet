/* tslint:disable */
/* eslint-disable */

/**
 * PVAC context holding keys for a single wallet.
 */
export class PvacContext {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Assemble a complete range proof from pre-computed bit proof batches.
     * `batch_parts` is a JS array of Uint8Array batch results (from make_bit_proofs_batch).
     * Computes the LC proof and returns the final serialized range proof bytes.
     */
    assemble_range_proof(cipher_bytes: Uint8Array, batch_parts: Array<any>): Uint8Array;
    /**
     * webcli `cipher_migration` (lib/pvac_migration.hpp, 52fca46): the `cipher_proof`
     * key_switch fields for a proven balance on a historical (MIMC_X3_V6) registered key.
     * `source` is the on-chain "hfhe_v1|..." string as fetched, `amount` its value. Returns
     * the JSON object (migration_mode, source_cipher_hash, new_cipher, old_zero_proof,
     * new_range_proof, amount_commitment) to merge into `encrypted_data`.
     */
    buildCipherProofMigration(pubkey_bytes: Uint8Array, source: string, amount: bigint, policy: number): string;
    /**
     * Private-spend readiness: whether the cipher is key-bound-provable, its base-layer count, and
     * whether its R_com is canonical. Returns JSON. Shares the core `check_bound_provable` with the
     * desktop pvac-handler, so the extension's compact-refresh gate matches webcli exactly.
     */
    check_bound_provable(cipher_bytes: Uint8Array): string;
    /**
     * Compute SHA-256 commitment of a serialized cipher. Returns 32 bytes.
     */
    commit(cipher_bytes: Uint8Array): Uint8Array;
    /**
     * Homomorphic addition: a + b. All args/result are serialized ciphers.
     */
    ct_add(a: Uint8Array, b: Uint8Array): Uint8Array;
    /**
     * Homomorphic subtraction: a - b. All args/result are serialized ciphers.
     * If either input was deserialized from V1 format (no Pedersen Commitments),
     * PCs are computed before the operation. This ensures verify_zero always has
     * the PCs it needs on all base layers. For V2 inputs, attach_pedersen_commitments
     * produces identical PCs (confirmed by test_attach_pc_vs_original_pc_cross_verify).
     */
    ct_sub(a: Uint8Array, b: Uint8Array): Uint8Array;
    /**
     * Decrypt a serialized cipher, returning the balance as i64.
     * Handles full Fp field element: if hi != 0 and val > p/2, treats as negative.
     * Validates balance is in the valid range [0, MAX_BALANCE_RAW].
     * Matches cli.py get_balance() logic (webcli pvac_bridge.hpp).
     */
    decrypt(cipher_bytes: Uint8Array): bigint;
    /**
     * Decrypt with the pre-canonical-parity keys (older pvac-rs builds' H matrix). Read-only
     * fallback for ciphers those builds wrote: call when `decrypt` rejects the value as out of
     * range. A success here means the balance is legacy-keyed and must be re-encrypted before
     * canonical private ops can touch it.
     */
    decryptLegacy(cipher_bytes: Uint8Array): bigint;
    /**
     * Safe balance query: returns the decrypted balance, or 0 and a descriptive error string.
     * Never throws; useful for graceful degradation in the UI.
     * Matches webcli pvac_bridge.hpp try_get_balance().
     */
    decryptSafe(cipher_bytes: Uint8Array): bigint;
    /**
     * Diagnose a serialized cipher: return JSON with layer count, PC status, etc.
     * Useful for debugging proof verification failures.
     */
    diagnose_cipher(cipher_bytes: Uint8Array): string;
    /**
     * Diagnose a serialized zero proof: return JSON with proof structure info.
     * Useful for debugging bound proof deserialization failures.
     * Accepts RAW format (no PVAC header), matching the C API.
     */
    diagnose_proof(proof_bytes: Uint8Array): string;
    /**
     * Encrypt a u64 value. Returns serialized cipher bytes.
     */
    encrypt(value: bigint): Uint8Array;
    /**
     * Encrypt a u64 value deterministically from a 32-byte seed.
     */
    encrypt_seeded(value: bigint, seed: Uint8Array): Uint8Array;
    /**
     * Encrypt zero. Returns serialized cipher bytes.
     */
    encrypt_zero(): Uint8Array;
    /**
     * Encrypt zero deterministically from a 32-byte seed.
     */
    encrypt_zero_seeded(seed: Uint8Array): Uint8Array;
    /**
     * Key-bound zero proof using the elevated KeySwitchRefresh R1CS profile
     * (webcli `make_zero_proof_bound_key_switch`). This is the `old_zero_proof` of a same-key
     * compact-refresh: it proves `amount` against the DEEP on-chain cipher (up to the key-switch
     * base-layer limit), so it needs the higher constraint cap than the plain bound proof.
     * `blinding` must be 32 bytes. Returns RAW zero-proof bytes (no PVAC header), like make_bound_proof.
     */
    makeBoundKeySwitchProof(cipher_bytes: Uint8Array, amount: bigint, blinding: Uint8Array): Uint8Array;
    /**
     * webcli `make_zero_proof_bound_key_switch_with_pubkey` (lib/pvac_bridge.hpp:395): the
     * migration `old_zero_proof` - KeySwitchRefresh limits, proven under the OLD registered
     * pubkey. Same container unwrapping and `pubkey_compatible` gate as
     * makeBoundProofWithPubkey. Returns RAW zero-proof bytes.
     */
    makeBoundKeySwitchProofWithPubkey(pubkey_bytes: Uint8Array, cipher_bytes: Uint8Array, amount: bigint, blinding: Uint8Array): Uint8Array;
    /**
     * webcli `make_zero_proof_bound_with_pubkey` (lib/pvac_bridge.hpp:382): bound proof under a
     * DESERIALIZED registered pubkey (e.g. the OLD key of a migration) instead of the context's
     * own. `pubkey_bytes` is the blob from `octra_pvacPubkey`; the 0xEC compressed container is
     * unwrapped automatically, same as matchesSecretProfile. Fails unless the key passes the
     * 3-way `pubkey_compatible` gate (it must be OURS in some historical form).
     * Returns RAW zero-proof bytes (no PVAC header), like make_bound_proof.
     */
    makeBoundProofWithPubkey(pubkey_bytes: Uint8Array, cipher_bytes: Uint8Array, amount: bigint, blinding: Uint8Array): Uint8Array;
    /**
     * Key-bound range proof over a cipher for a known value (webcli make_bound_range_proof).
     * The blinding is drawn internally and the amount commitment is self-carried as the proof's
     * last committed point. Returns the TAG_BOUND_RANGE_PROOF envelope (WITH header), which the
     * caller wraps as "rp_v1|" + base64 - the byte layout confirmed on devnet (tx 830f320...).
     */
    makeBoundRangeProof(cipher_bytes: Uint8Array, value: bigint): Uint8Array;
    /**
     * key_switch `owner_cipher` + `owner_proof` for a `proof_key` network (webcli
     * main.cpp:2327, 52fca46), bound to the sender `address`. Returns the JSON
     * `{"owner_cipher":"hfhe_v1|...","owner_proof":"zkzp_v2|..."}` for `encrypted_data`.
     */
    makeKeyOwnerProof(address: string, policy: number): string;
    /**
     * Generate an aggregated range proof (single R1CS proof for all 65 constraints).
     * Much smaller than standard range proof (~200-300KB vs ~2MB+).
     */
    make_aggregated_range_proof(cipher_bytes: Uint8Array, value: bigint): Uint8Array;
    /**
     * Generate bit proofs for bits [start_bit, end_bit) of `value`.
     * Used by the parallel worker pool - each worker computes a subset of bits.
     * Returns serialized batch bytes (internal format for reassembly).
     */
    make_bit_proofs_batch(value: bigint, start_bit: number, end_bit: number, on_progress: Function): Uint8Array;
    /**
     * Generate a bound zero proof linking cipher to a Pedersen commitment.
     * `blinding` must be 32 bytes (scalar mod l).
     * Returns serialized zero proof bytes in RAW format (no PVAC header),
     * matching the C API `pvac_serialize_zero_proof()` for server interop.
     */
    make_bound_proof(cipher_bytes: Uint8Array, amount: bigint, blinding: Uint8Array): Uint8Array;
    /**
     * Generate a range proof for a cipher that encrypts `value`.
     * Returns serialized range proof bytes (PVAC wire format).
     */
    make_range_proof(cipher_bytes: Uint8Array, value: bigint): Uint8Array;
    /**
     * Generate a range proof using rayon parallel threads (wasm-parallel feature).
     * All 64 bit proofs run concurrently across the thread pool.
     * Requires `initThreadPool()` to have been called first.
     * Returns serialized range proof bytes.
     */
    make_range_proof_parallel(cipher_bytes: Uint8Array, value: bigint): Uint8Array;
    /**
     * Generate a range proof with per-circuit progress reporting.
     * `on_progress` is a JS function called as `on_progress(current, total)` after each circuit.
     */
    make_range_proof_with_progress(cipher_bytes: Uint8Array, value: bigint, on_progress: Function): Uint8Array;
    /**
     * webcli `pvac_registered_key_compatible` (main.cpp:2195-2205): the full 3-way check
     * (key-bound extension || legacy v1 || secret profile). `secret_profile_matches` alone
     * rejects our own pre-binding registered keys (zero commit vs the nonzero local one).
     *
     * Pass the serialized pubkey from `octra_pvacPubkey`; the compressed container is
     * unwrapped automatically. Returns false rather than throwing when it cannot parse,
     * so a malformed remote key is a mismatch, not a crash.
     */
    matchesSecretProfile(candidate_bytes: Uint8Array): boolean;
    /**
     * Create a new context by deriving keys from a 32-byte seed. The generator table is built
     * separately (`pvac_prewarm_generators`) or on first proof.
     */
    constructor(seed: Uint8Array);
    /**
     * Compute a Pedersen commitment: amount * B + blinding * B_blinding.
     * Returns 32-byte compressed Ristretto point.
     */
    pedersen_commit(amount: bigint, blinding: Uint8Array): Uint8Array;
    /**
     * webcli `pvac_prove_amount` (52fca46): bound proof of `kind` (0 amount, 1 refresh,
     * 2 range, 3 history) under the network proof `policy` (bit 0 wide, bit 1 bind key, read
     * from octra_pvacMigrationStatus). An empty `pubkey_bytes` proves under this context's key;
     * otherwise it is the registered pubkey blob behind the `pubkey_compatible` gate.
     * Returns the bound range envelope for kind 2 (rp_v1) and RAW zero-proof bytes otherwise.
     */
    proveAmount(pubkey_bytes: Uint8Array, cipher_bytes: Uint8Array, amount: bigint, blinding: Uint8Array, kind: number, policy: number): Uint8Array;
    /**
     * Return the number of threads in the rayon thread pool.
     * Returns 0 if rayon is not initialized or not available.
     */
    rayon_thread_count(): number;
    /**
     * Serialize the public key to bytes.
     */
    serialize_pubkey(): Uint8Array;
    /**
     * webcli `pvac_verify_amount` (52fca46): verify a `proveAmount` proof against the cipher
     * and 32-byte commitment under the same `kind` and `policy`. Empty `pubkey_bytes` = this
     * context's key. Kind 2 takes the bound range envelope (RAW bytes are accepted too).
     */
    verifyAmount(pubkey_bytes: Uint8Array, cipher_bytes: Uint8Array, proof_bytes: Uint8Array, commitment: Uint8Array, kind: number, policy: number): boolean;
    /**
     * webcli `verify_zero_bound_key_switch`: same statement as verify_bound_proof but with the
     * KeySwitchRefresh limits (one extra base layer, 1,550,000 constraints). The Default-profile
     * verifier falsely rejects a legitimate 6-base-layer key-switch proof - self-checks of a
     * compact/migration payload MUST use this one.
     */
    verifyBoundKeySwitchProof(cipher_bytes: Uint8Array, proof_bytes: Uint8Array, commitment: Uint8Array): boolean;
    /**
     * webcli `verify_zero_proof_bound_key_switch_with_pubkey` (lib/pvac_bridge.hpp:415): the
     * KeySwitchRefresh-limit verifier under a deserialized registered pubkey - the self-check
     * for a migration payload's `old_zero_proof`.
     */
    verifyBoundKeySwitchProofWithPubkey(pubkey_bytes: Uint8Array, cipher_bytes: Uint8Array, proof_bytes: Uint8Array, commitment: Uint8Array): boolean;
    /**
     * webcli `verify_zero_proof_bound_with_pubkey` (lib/pvac_bridge.hpp:401): verify a bound
     * proof against a cipher and commitment under a deserialized registered pubkey. Returns
     * false (not an error) when the key fails the `pubkey_compatible` gate, mirroring webcli.
     */
    verifyBoundProofWithPubkey(pubkey_bytes: Uint8Array, cipher_bytes: Uint8Array, proof_bytes: Uint8Array, commitment: Uint8Array): boolean;
    /**
     * Verify an aggregated range proof against a ciphertext.
     */
    verify_aggregated_range_proof(cipher_bytes: Uint8Array, proof_bytes: Uint8Array): boolean;
    /**
     * Verify a bound zero proof against a ciphertext and Pedersen commitment.
     * `commitment` must be 32 bytes (compressed Ristretto point).
     * Proof bytes must be in RAW format (no PVAC header), matching the C API.
     * Returns true if the proof is valid, false otherwise.
     */
    verify_bound_proof(cipher_bytes: Uint8Array, proof_bytes: Uint8Array, commitment: Uint8Array): boolean;
    /**
     * Auto-detect proof format (standard or aggregated) and verify.
     */
    verify_range_any(cipher_bytes: Uint8Array, proof_bytes: Uint8Array): boolean;
    /**
     * Verify a range proof against a ciphertext.
     * Both arguments are serialized bytes.
     * Returns true if the proof is valid, false otherwise.
     */
    verify_range_proof(cipher_bytes: Uint8Array, proof_bytes: Uint8Array): boolean;
}

export function initThreadPool(num_threads: number): Promise<any>;

/**
 * Compute AES-256 KAT matching the C++ `pvac_aes_kat()` function:
 * 1. SHA-256("pvac.aes.kat.key") -> 32-byte AES key
 * 2. AesCtr256(key, nonce=0) -> next_u64() twice -> 16 bytes
 * Returns lowercase hex (32 chars).
 */
export function pvac_compute_aes_kat(): string;

/**
 * Deserialize a public key from bytes (standalone function).
 */
export function pvac_deserialize_pubkey(data: Uint8Array): Uint8Array;

/**
 * Encode serialized cipher bytes as "hfhe_v1|<base64>".
 * Matches cli.py `encode_cipher()`.
 */
export function pvac_encode_cipher(cipher_bytes: Uint8Array): string;

/**
 * Encode serialized range proof bytes as "rp_v1|<base64>".
 * Matches cli.py `encode_range_proof()`.
 */
export function pvac_encode_range_proof(proof_bytes: Uint8Array): string;

/**
 * Encode serialized zero proof bytes as "zkzp_v2|<base64>".
 * Matches cli.py `encode_zero_proof()`.
 */
export function pvac_encode_zero_proof(proof_bytes: Uint8Array): string;

export function pvac_max_balance_raw(): bigint;

export function pvac_max_fee_raw(): bigint;

export function pvac_min_balance_raw(): bigint;

export function pvac_min_fee_raw(): bigint;

/**
 * Pre-compute Bulletproofs generator table up to `n` entries.
 */
export function pvac_pre_warm_generators(n: number): void;

/**
 * Derive the generator table proofs need. `PvacContext` creation no longer does this: call it
 * once per worker in the background after unlock so the first proof does not pay for it.
 * Later calls are no-ops.
 */
export function pvac_prewarm_generators(): void;

/**
 * Advance the allocator's break past the next proof's working set, then free it.
 *
 * The threaded build's bound/range proofs allocate ~200MB+ DURING their parallel (rayon) phase.
 * dlmalloc satisfies that by calling `memory.grow`, which on a SharedArrayBuffer detaches the buffer
 * under the live rayon sub-workers mid-MSM -> they trap `unreachable` (wasm-bindgen#3290). A bigger
 * `--initial-memory` does not prevent it (dlmalloc grows regardless of free linear memory).
 *
 * The caller runs this from the worker RIGHT BEFORE the proof, while the rayon workers are still
 * PARKED (a grow while parked is harmless -- proven by encryptRaw growing without a trap). Allocating
 * `bytes` forces dlmalloc to sbrk (grow) now; freeing it keeps that space in dlmalloc's pool (wasm
 * memory never shrinks), so the proof reuses it and never grows during the parallel phase.
 */
export function pvac_prewarm_heap(bytes: number): boolean;

/**
 * Lowercase hex of SHA-256 (webcli `octra::sha256_hex`). Migration payloads use it for
 * `source_cipher_hash`: the hash of the ENCODED "hfhe_v1|..." cipher STRING bytes.
 */
export function sha256Hex(data: Uint8Array): string;

export class wbg_rayon_PoolBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): void;
    mainJS(): string;
    numThreads(): number;
    receiver(): number;
}

export function wbg_rayon_start_worker(receiver: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_pvaccontext_free: (a: number, b: number) => void;
    readonly pvac_compute_aes_kat: (a: number) => void;
    readonly pvac_deserialize_pubkey: (a: number, b: number, c: number) => void;
    readonly pvac_encode_cipher: (a: number, b: number, c: number) => void;
    readonly pvac_encode_range_proof: (a: number, b: number, c: number) => void;
    readonly pvac_encode_zero_proof: (a: number, b: number, c: number) => void;
    readonly pvac_max_balance_raw: () => bigint;
    readonly pvac_max_fee_raw: () => bigint;
    readonly pvac_min_balance_raw: () => bigint;
    readonly pvac_min_fee_raw: () => bigint;
    readonly pvac_prewarm_heap: (a: number) => number;
    readonly pvaccontext_assemble_range_proof: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pvaccontext_buildCipherProofMigration: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint, h: number) => void;
    readonly pvaccontext_check_bound_provable: (a: number, b: number, c: number, d: number) => void;
    readonly pvaccontext_commit: (a: number, b: number, c: number, d: number) => void;
    readonly pvaccontext_ct_add: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvaccontext_ct_sub: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvaccontext_decrypt: (a: number, b: number, c: number, d: number) => void;
    readonly pvaccontext_decryptLegacy: (a: number, b: number, c: number, d: number) => void;
    readonly pvaccontext_decryptSafe: (a: number, b: number, c: number) => bigint;
    readonly pvaccontext_diagnose_cipher: (a: number, b: number, c: number, d: number) => void;
    readonly pvaccontext_diagnose_proof: (a: number, b: number, c: number, d: number) => void;
    readonly pvaccontext_encrypt: (a: number, b: number, c: bigint) => void;
    readonly pvaccontext_encrypt_seeded: (a: number, b: number, c: bigint, d: number, e: number) => void;
    readonly pvaccontext_encrypt_zero: (a: number, b: number) => void;
    readonly pvaccontext_encrypt_zero_seeded: (a: number, b: number, c: number, d: number) => void;
    readonly pvaccontext_makeBoundKeySwitchProof: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number) => void;
    readonly pvaccontext_makeBoundKeySwitchProofWithPubkey: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint, h: number, i: number) => void;
    readonly pvaccontext_makeBoundProofWithPubkey: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint, h: number, i: number) => void;
    readonly pvaccontext_makeBoundRangeProof: (a: number, b: number, c: number, d: number, e: bigint) => void;
    readonly pvaccontext_makeKeyOwnerProof: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pvaccontext_make_aggregated_range_proof: (a: number, b: number, c: number, d: number, e: bigint) => void;
    readonly pvaccontext_make_bit_proofs_batch: (a: number, b: number, c: bigint, d: number, e: number, f: number) => void;
    readonly pvaccontext_make_bound_proof: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number) => void;
    readonly pvaccontext_make_range_proof: (a: number, b: number, c: number, d: number, e: bigint) => void;
    readonly pvaccontext_make_range_proof_parallel: (a: number, b: number, c: number, d: number, e: bigint) => void;
    readonly pvaccontext_make_range_proof_with_progress: (a: number, b: number, c: number, d: number, e: bigint, f: number) => void;
    readonly pvaccontext_matchesSecretProfile: (a: number, b: number, c: number) => number;
    readonly pvaccontext_new: (a: number, b: number, c: number) => void;
    readonly pvaccontext_pedersen_commit: (a: number, b: number, c: bigint, d: number, e: number) => void;
    readonly pvaccontext_proveAmount: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint, h: number, i: number, j: number, k: number) => void;
    readonly pvaccontext_rayon_thread_count: (a: number) => number;
    readonly pvaccontext_serialize_pubkey: (a: number, b: number) => void;
    readonly pvaccontext_verifyAmount: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => void;
    readonly pvaccontext_verifyBoundKeySwitchProof: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly pvaccontext_verifyBoundKeySwitchProofWithPubkey: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly pvaccontext_verifyBoundProofWithPubkey: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly pvaccontext_verify_aggregated_range_proof: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvaccontext_verify_bound_proof: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly pvaccontext_verify_range_any: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly pvaccontext_verify_range_proof: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly sha256Hex: (a: number, b: number, c: number) => void;
    readonly pvac_prewarm_generators: () => void;
    readonly pvac_pre_warm_generators: (a: number) => void;
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly initThreadPool: (a: number) => number;
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_mainJS: (a: number) => number;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export3: (a: number, b: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
