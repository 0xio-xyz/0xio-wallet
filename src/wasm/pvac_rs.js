/* @ts-self-types="./pvac_rs.d.ts" */
import { startWorkers } from './snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.no-bundler.js';

/**
 * PVAC context holding keys for a single wallet.
 */
export class PvacContext {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PvacContextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pvaccontext_free(ptr, 0);
    }
    /**
     * Assemble a complete range proof from pre-computed bit proof batches.
     * `batch_parts` is a JS array of Uint8Array batch results (from make_bit_proofs_batch).
     * Computes the LC proof and returns the final serialized range proof bytes.
     * @param {Uint8Array} cipher_bytes
     * @param {Array<any>} batch_parts
     * @returns {Uint8Array}
     */
    assemble_range_proof(cipher_bytes, batch_parts) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_assemble_range_proof(retptr, this.__wbg_ptr, ptr0, len0, addBorrowedObject(batch_parts));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * webcli `cipher_migration` (lib/pvac_migration.hpp, 52fca46): the `cipher_proof`
     * key_switch fields for a proven balance on a historical (MIMC_X3_V6) registered key.
     * `source` is the on-chain "hfhe_v1|..." string as fetched, `amount` its value. Returns
     * the JSON object (migration_mode, source_cipher_hash, new_cipher, old_zero_proof,
     * new_range_proof, amount_commitment) to merge into `encrypted_data`.
     * @param {Uint8Array} pubkey_bytes
     * @param {string} source
     * @param {bigint} amount
     * @param {number} policy
     * @returns {string}
     */
    buildCipherProofMigration(pubkey_bytes, source, amount, policy) {
        let deferred4_0;
        let deferred4_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(pubkey_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(source, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
            const len1 = WASM_VECTOR_LEN;
            wasm.pvaccontext_buildCipherProofMigration(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, amount, policy);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            var ptr3 = r0;
            var len3 = r1;
            if (r3) {
                ptr3 = 0; len3 = 0;
                throw takeObject(r2);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Private-spend readiness: whether the cipher is key-bound-provable, its base-layer count, and
     * whether its R_com is canonical. Returns JSON. Shares the core `check_bound_provable` with the
     * desktop pvac-handler, so the extension's compact-refresh gate matches webcli exactly.
     * @param {Uint8Array} cipher_bytes
     * @returns {string}
     */
    check_bound_provable(cipher_bytes) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_check_bound_provable(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            var ptr2 = r0;
            var len2 = r1;
            if (r3) {
                ptr2 = 0; len2 = 0;
                throw takeObject(r2);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Compute SHA-256 commitment of a serialized cipher. Returns 32 bytes.
     * @param {Uint8Array} cipher_bytes
     * @returns {Uint8Array}
     */
    commit(cipher_bytes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_commit(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Homomorphic addition: a + b. All args/result are serialized ciphers.
     * @param {Uint8Array} a
     * @param {Uint8Array} b
     * @returns {Uint8Array}
     */
    ct_add(a, b) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(a, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(b, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            wasm.pvaccontext_ct_add(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Homomorphic subtraction: a - b. All args/result are serialized ciphers.
     * If either input was deserialized from V1 format (no Pedersen Commitments),
     * PCs are computed before the operation. This ensures verify_zero always has
     * the PCs it needs on all base layers. For V2 inputs, attach_pedersen_commitments
     * produces identical PCs (confirmed by test_attach_pc_vs_original_pc_cross_verify).
     * @param {Uint8Array} a
     * @param {Uint8Array} b
     * @returns {Uint8Array}
     */
    ct_sub(a, b) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(a, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(b, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            wasm.pvaccontext_ct_sub(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Decrypt a serialized cipher, returning the balance as i64.
     * Handles full Fp field element: if hi != 0 and val > p/2, treats as negative.
     * Validates balance is in the valid range [0, MAX_BALANCE_RAW].
     * Matches cli.py get_balance() logic (webcli pvac_bridge.hpp).
     * @param {Uint8Array} cipher_bytes
     * @returns {bigint}
     */
    decrypt(cipher_bytes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_decrypt(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getBigInt64(retptr + 8 * 0, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            return r0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Decrypt with the pre-canonical-parity keys (older pvac-rs builds' H matrix). Read-only
     * fallback for ciphers those builds wrote: call when `decrypt` rejects the value as out of
     * range. A success here means the balance is legacy-keyed and must be re-encrypted before
     * canonical private ops can touch it.
     * @param {Uint8Array} cipher_bytes
     * @returns {bigint}
     */
    decryptLegacy(cipher_bytes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_decryptLegacy(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getBigInt64(retptr + 8 * 0, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            return r0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Safe balance query: returns the decrypted balance, or 0 and a descriptive error string.
     * Never throws; useful for graceful degradation in the UI.
     * Matches webcli pvac_bridge.hpp try_get_balance().
     * @param {Uint8Array} cipher_bytes
     * @returns {bigint}
     */
    decryptSafe(cipher_bytes) {
        const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pvaccontext_decryptSafe(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Diagnose a serialized cipher: return JSON with layer count, PC status, etc.
     * Useful for debugging proof verification failures.
     * @param {Uint8Array} cipher_bytes
     * @returns {string}
     */
    diagnose_cipher(cipher_bytes) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_diagnose_cipher(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            var ptr2 = r0;
            var len2 = r1;
            if (r3) {
                ptr2 = 0; len2 = 0;
                throw takeObject(r2);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Diagnose a serialized zero proof: return JSON with proof structure info.
     * Useful for debugging bound proof deserialization failures.
     * Accepts RAW format (no PVAC header), matching the C API.
     * @param {Uint8Array} proof_bytes
     * @returns {string}
     */
    diagnose_proof(proof_bytes) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_diagnose_proof(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            var ptr2 = r0;
            var len2 = r1;
            if (r3) {
                ptr2 = 0; len2 = 0;
                throw takeObject(r2);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Encrypt a u64 value. Returns serialized cipher bytes.
     * @param {bigint} value
     * @returns {Uint8Array}
     */
    encrypt(value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.pvaccontext_encrypt(retptr, this.__wbg_ptr, value);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Encrypt a u64 value deterministically from a 32-byte seed.
     * @param {bigint} value
     * @param {Uint8Array} seed
     * @returns {Uint8Array}
     */
    encrypt_seeded(value, seed) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_encrypt_seeded(retptr, this.__wbg_ptr, value, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Encrypt zero. Returns serialized cipher bytes.
     * @returns {Uint8Array}
     */
    encrypt_zero() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.pvaccontext_encrypt_zero(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Encrypt zero deterministically from a 32-byte seed.
     * @param {Uint8Array} seed
     * @returns {Uint8Array}
     */
    encrypt_zero_seeded(seed) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_encrypt_zero_seeded(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Key-bound zero proof using the elevated KeySwitchRefresh R1CS profile
     * (webcli `make_zero_proof_bound_key_switch`). This is the `old_zero_proof` of a same-key
     * compact-refresh: it proves `amount` against the DEEP on-chain cipher (up to the key-switch
     * base-layer limit), so it needs the higher constraint cap than the plain bound proof.
     * `blinding` must be 32 bytes. Returns RAW zero-proof bytes (no PVAC header), like make_bound_proof.
     * @param {Uint8Array} cipher_bytes
     * @param {bigint} amount
     * @param {Uint8Array} blinding
     * @returns {Uint8Array}
     */
    makeBoundKeySwitchProof(cipher_bytes, amount, blinding) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(blinding, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            wasm.pvaccontext_makeBoundKeySwitchProof(retptr, this.__wbg_ptr, ptr0, len0, amount, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * webcli `make_zero_proof_bound_key_switch_with_pubkey` (lib/pvac_bridge.hpp:395): the
     * migration `old_zero_proof` - KeySwitchRefresh limits, proven under the OLD registered
     * pubkey. Same container unwrapping and `pubkey_compatible` gate as
     * makeBoundProofWithPubkey. Returns RAW zero-proof bytes.
     * @param {Uint8Array} pubkey_bytes
     * @param {Uint8Array} cipher_bytes
     * @param {bigint} amount
     * @param {Uint8Array} blinding
     * @returns {Uint8Array}
     */
    makeBoundKeySwitchProofWithPubkey(pubkey_bytes, cipher_bytes, amount, blinding) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(pubkey_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(blinding, wasm.__wbindgen_export3);
            const len2 = WASM_VECTOR_LEN;
            wasm.pvaccontext_makeBoundKeySwitchProofWithPubkey(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, amount, ptr2, len2);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v4 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v4;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * webcli `make_zero_proof_bound_with_pubkey` (lib/pvac_bridge.hpp:382): bound proof under a
     * DESERIALIZED registered pubkey (e.g. the OLD key of a migration) instead of the context's
     * own. `pubkey_bytes` is the blob from `octra_pvacPubkey`; the 0xEC compressed container is
     * unwrapped automatically, same as matchesSecretProfile. Fails unless the key passes the
     * 3-way `pubkey_compatible` gate (it must be OURS in some historical form).
     * Returns RAW zero-proof bytes (no PVAC header), like make_bound_proof.
     * @param {Uint8Array} pubkey_bytes
     * @param {Uint8Array} cipher_bytes
     * @param {bigint} amount
     * @param {Uint8Array} blinding
     * @returns {Uint8Array}
     */
    makeBoundProofWithPubkey(pubkey_bytes, cipher_bytes, amount, blinding) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(pubkey_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(blinding, wasm.__wbindgen_export3);
            const len2 = WASM_VECTOR_LEN;
            wasm.pvaccontext_makeBoundProofWithPubkey(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, amount, ptr2, len2);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v4 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v4;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Key-bound range proof over a cipher for a known value (webcli make_bound_range_proof).
     * The blinding is drawn internally and the amount commitment is self-carried as the proof's
     * last committed point. Returns the TAG_BOUND_RANGE_PROOF envelope (WITH header), which the
     * caller wraps as "rp_v1|" + base64 - the byte layout confirmed on devnet (tx 830f320...).
     * @param {Uint8Array} cipher_bytes
     * @param {bigint} value
     * @returns {Uint8Array}
     */
    makeBoundRangeProof(cipher_bytes, value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_makeBoundRangeProof(retptr, this.__wbg_ptr, ptr0, len0, value);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * key_switch `owner_cipher` + `owner_proof` for a `proof_key` network (webcli
     * main.cpp:2327, 52fca46), bound to the sender `address`. Returns the JSON
     * `{"owner_cipher":"hfhe_v1|...","owner_proof":"zkzp_v2|..."}` for `encrypted_data`.
     * @param {string} address
     * @param {number} policy
     * @returns {string}
     */
    makeKeyOwnerProof(address, policy) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(address, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_makeKeyOwnerProof(retptr, this.__wbg_ptr, ptr0, len0, policy);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            var ptr2 = r0;
            var len2 = r1;
            if (r3) {
                ptr2 = 0; len2 = 0;
                throw takeObject(r2);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Generate an aggregated range proof (single R1CS proof for all 65 constraints).
     * Much smaller than standard range proof (~200-300KB vs ~2MB+).
     * @param {Uint8Array} cipher_bytes
     * @param {bigint} value
     * @returns {Uint8Array}
     */
    make_aggregated_range_proof(cipher_bytes, value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_make_aggregated_range_proof(retptr, this.__wbg_ptr, ptr0, len0, value);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Generate bit proofs for bits [start_bit, end_bit) of `value`.
     * Used by the parallel worker pool - each worker computes a subset of bits.
     * Returns serialized batch bytes (internal format for reassembly).
     * @param {bigint} value
     * @param {number} start_bit
     * @param {number} end_bit
     * @param {Function} on_progress
     * @returns {Uint8Array}
     */
    make_bit_proofs_batch(value, start_bit, end_bit, on_progress) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.pvaccontext_make_bit_proofs_batch(retptr, this.__wbg_ptr, value, start_bit, end_bit, addBorrowedObject(on_progress));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * Generate a bound zero proof linking cipher to a Pedersen commitment.
     * `blinding` must be 32 bytes (scalar mod l).
     * Returns serialized zero proof bytes in RAW format (no PVAC header),
     * matching the C API `pvac_serialize_zero_proof()` for server interop.
     * @param {Uint8Array} cipher_bytes
     * @param {bigint} amount
     * @param {Uint8Array} blinding
     * @returns {Uint8Array}
     */
    make_bound_proof(cipher_bytes, amount, blinding) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(blinding, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            wasm.pvaccontext_make_bound_proof(retptr, this.__wbg_ptr, ptr0, len0, amount, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Generate a range proof for a cipher that encrypts `value`.
     * Returns serialized range proof bytes (PVAC wire format).
     * @param {Uint8Array} cipher_bytes
     * @param {bigint} value
     * @returns {Uint8Array}
     */
    make_range_proof(cipher_bytes, value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_make_range_proof(retptr, this.__wbg_ptr, ptr0, len0, value);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Generate a range proof using rayon parallel threads (wasm-parallel feature).
     * All 64 bit proofs run concurrently across the thread pool.
     * Requires `initThreadPool()` to have been called first.
     * Returns serialized range proof bytes.
     * @param {Uint8Array} cipher_bytes
     * @param {bigint} value
     * @returns {Uint8Array}
     */
    make_range_proof_parallel(cipher_bytes, value) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_make_range_proof_parallel(retptr, this.__wbg_ptr, ptr0, len0, value);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Generate a range proof with per-circuit progress reporting.
     * `on_progress` is a JS function called as `on_progress(current, total)` after each circuit.
     * @param {Uint8Array} cipher_bytes
     * @param {bigint} value
     * @param {Function} on_progress
     * @returns {Uint8Array}
     */
    make_range_proof_with_progress(cipher_bytes, value, on_progress) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_make_range_proof_with_progress(retptr, this.__wbg_ptr, ptr0, len0, value, addBorrowedObject(on_progress));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * webcli `pvac_registered_key_compatible` (main.cpp:2195-2205): the full 3-way check
     * (key-bound extension || legacy v1 || secret profile). `secret_profile_matches` alone
     * rejects our own pre-binding registered keys (zero commit vs the nonzero local one).
     *
     * Pass the serialized pubkey from `octra_pvacPubkey`; the compressed container is
     * unwrapped automatically. Returns false rather than throwing when it cannot parse,
     * so a malformed remote key is a mismatch, not a crash.
     * @param {Uint8Array} candidate_bytes
     * @returns {boolean}
     */
    matchesSecretProfile(candidate_bytes) {
        const ptr0 = passArray8ToWasm0(candidate_bytes, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pvaccontext_matchesSecretProfile(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Create a new context by deriving keys from a 32-byte seed. The generator table is built
     * separately (`pvac_prewarm_generators`) or on first proof.
     * @param {Uint8Array} seed
     */
    constructor(seed) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_new(retptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            PvacContextFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Compute a Pedersen commitment: amount * B + blinding * B_blinding.
     * Returns 32-byte compressed Ristretto point.
     * @param {bigint} amount
     * @param {Uint8Array} blinding
     * @returns {Uint8Array}
     */
    pedersen_commit(amount, blinding) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(blinding, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.pvaccontext_pedersen_commit(retptr, this.__wbg_ptr, amount, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * webcli `pvac_prove_amount` (52fca46): bound proof of `kind` (0 amount, 1 refresh,
     * 2 range, 3 history) under the network proof `policy` (bit 0 wide, bit 1 bind key, read
     * from octra_pvacMigrationStatus). An empty `pubkey_bytes` proves under this context's key;
     * otherwise it is the registered pubkey blob behind the `pubkey_compatible` gate.
     * Returns the bound range envelope for kind 2 (rp_v1) and RAW zero-proof bytes otherwise.
     * @param {Uint8Array} pubkey_bytes
     * @param {Uint8Array} cipher_bytes
     * @param {bigint} amount
     * @param {Uint8Array} blinding
     * @param {number} kind
     * @param {number} policy
     * @returns {Uint8Array}
     */
    proveAmount(pubkey_bytes, cipher_bytes, amount, blinding, kind, policy) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(pubkey_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(blinding, wasm.__wbindgen_export3);
            const len2 = WASM_VECTOR_LEN;
            wasm.pvaccontext_proveAmount(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, amount, ptr2, len2, kind, policy);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v4 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v4;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Return the number of threads in the rayon thread pool.
     * Returns 0 if rayon is not initialized or not available.
     * @returns {number}
     */
    rayon_thread_count() {
        const ret = wasm.pvaccontext_rayon_thread_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Serialize the public key to bytes.
     * @returns {Uint8Array}
     */
    serialize_pubkey() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.pvaccontext_serialize_pubkey(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * webcli `pvac_verify_amount` (52fca46): verify a `proveAmount` proof against the cipher
     * and 32-byte commitment under the same `kind` and `policy`. Empty `pubkey_bytes` = this
     * context's key. Kind 2 takes the bound range envelope (RAW bytes are accepted too).
     * @param {Uint8Array} pubkey_bytes
     * @param {Uint8Array} cipher_bytes
     * @param {Uint8Array} proof_bytes
     * @param {Uint8Array} commitment
     * @param {number} kind
     * @param {number} policy
     * @returns {boolean}
     */
    verifyAmount(pubkey_bytes, cipher_bytes, proof_bytes, commitment, kind, policy) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(pubkey_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArray8ToWasm0(commitment, wasm.__wbindgen_export3);
            const len3 = WASM_VECTOR_LEN;
            wasm.pvaccontext_verifyAmount(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, kind, policy);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return r0 !== 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * webcli `verify_zero_bound_key_switch`: same statement as verify_bound_proof but with the
     * KeySwitchRefresh limits (one extra base layer, 1,550,000 constraints). The Default-profile
     * verifier falsely rejects a legitimate 6-base-layer key-switch proof - self-checks of a
     * compact/migration payload MUST use this one.
     * @param {Uint8Array} cipher_bytes
     * @param {Uint8Array} proof_bytes
     * @param {Uint8Array} commitment
     * @returns {boolean}
     */
    verifyBoundKeySwitchProof(cipher_bytes, proof_bytes, commitment) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(commitment, wasm.__wbindgen_export3);
            const len2 = WASM_VECTOR_LEN;
            wasm.pvaccontext_verifyBoundKeySwitchProof(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return r0 !== 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * webcli `verify_zero_proof_bound_key_switch_with_pubkey` (lib/pvac_bridge.hpp:415): the
     * KeySwitchRefresh-limit verifier under a deserialized registered pubkey - the self-check
     * for a migration payload's `old_zero_proof`.
     * @param {Uint8Array} pubkey_bytes
     * @param {Uint8Array} cipher_bytes
     * @param {Uint8Array} proof_bytes
     * @param {Uint8Array} commitment
     * @returns {boolean}
     */
    verifyBoundKeySwitchProofWithPubkey(pubkey_bytes, cipher_bytes, proof_bytes, commitment) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(pubkey_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArray8ToWasm0(commitment, wasm.__wbindgen_export3);
            const len3 = WASM_VECTOR_LEN;
            wasm.pvaccontext_verifyBoundKeySwitchProofWithPubkey(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return r0 !== 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * webcli `verify_zero_proof_bound_with_pubkey` (lib/pvac_bridge.hpp:401): verify a bound
     * proof against a cipher and commitment under a deserialized registered pubkey. Returns
     * false (not an error) when the key fails the `pubkey_compatible` gate, mirroring webcli.
     * @param {Uint8Array} pubkey_bytes
     * @param {Uint8Array} cipher_bytes
     * @param {Uint8Array} proof_bytes
     * @param {Uint8Array} commitment
     * @returns {boolean}
     */
    verifyBoundProofWithPubkey(pubkey_bytes, cipher_bytes, proof_bytes, commitment) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(pubkey_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArray8ToWasm0(commitment, wasm.__wbindgen_export3);
            const len3 = WASM_VECTOR_LEN;
            wasm.pvaccontext_verifyBoundProofWithPubkey(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return r0 !== 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Verify an aggregated range proof against a ciphertext.
     * @param {Uint8Array} cipher_bytes
     * @param {Uint8Array} proof_bytes
     * @returns {boolean}
     */
    verify_aggregated_range_proof(cipher_bytes, proof_bytes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            wasm.pvaccontext_verify_aggregated_range_proof(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return r0 !== 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Verify a bound zero proof against a ciphertext and Pedersen commitment.
     * `commitment` must be 32 bytes (compressed Ristretto point).
     * Proof bytes must be in RAW format (no PVAC header), matching the C API.
     * Returns true if the proof is valid, false otherwise.
     * @param {Uint8Array} cipher_bytes
     * @param {Uint8Array} proof_bytes
     * @param {Uint8Array} commitment
     * @returns {boolean}
     */
    verify_bound_proof(cipher_bytes, proof_bytes, commitment) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(commitment, wasm.__wbindgen_export3);
            const len2 = WASM_VECTOR_LEN;
            wasm.pvaccontext_verify_bound_proof(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return r0 !== 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Auto-detect proof format (standard or aggregated) and verify.
     * @param {Uint8Array} cipher_bytes
     * @param {Uint8Array} proof_bytes
     * @returns {boolean}
     */
    verify_range_any(cipher_bytes, proof_bytes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            wasm.pvaccontext_verify_range_any(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return r0 !== 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Verify a range proof against a ciphertext.
     * Both arguments are serialized bytes.
     * Returns true if the proof is valid, false otherwise.
     * @param {Uint8Array} cipher_bytes
     * @param {Uint8Array} proof_bytes
     * @returns {boolean}
     */
    verify_range_proof(cipher_bytes, proof_bytes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            wasm.pvaccontext_verify_range_proof(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return r0 !== 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) PvacContext.prototype[Symbol.dispose] = PvacContext.prototype.free;

/**
 * @param {number} num_threads
 * @returns {Promise<any>}
 */
export function initThreadPool(num_threads) {
    const ret = wasm.initThreadPool(num_threads);
    return takeObject(ret);
}

/**
 * Compute AES-256 KAT matching the C++ `pvac_aes_kat()` function:
 * 1. SHA-256("pvac.aes.kat.key") -> 32-byte AES key
 * 2. AesCtr256(key, nonce=0) -> next_u64() twice -> 16 bytes
 * Returns lowercase hex (32 chars).
 * @returns {string}
 */
export function pvac_compute_aes_kat() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.pvac_compute_aes_kat(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Deserialize a public key from bytes (standalone function).
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function pvac_deserialize_pubkey(data) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        wasm.pvac_deserialize_pubkey(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeObject(r2);
        }
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Encode serialized cipher bytes as "hfhe_v1|<base64>".
 * Matches cli.py `encode_cipher()`.
 * @param {Uint8Array} cipher_bytes
 * @returns {string}
 */
export function pvac_encode_cipher(cipher_bytes) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(cipher_bytes, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        wasm.pvac_encode_cipher(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Encode serialized range proof bytes as "rp_v1|<base64>".
 * Matches cli.py `encode_range_proof()`.
 * @param {Uint8Array} proof_bytes
 * @returns {string}
 */
export function pvac_encode_range_proof(proof_bytes) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        wasm.pvac_encode_range_proof(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Encode serialized zero proof bytes as "zkzp_v2|<base64>".
 * Matches cli.py `encode_zero_proof()`.
 * @param {Uint8Array} proof_bytes
 * @returns {string}
 */
export function pvac_encode_zero_proof(proof_bytes) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(proof_bytes, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        wasm.pvac_encode_zero_proof(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
    }
}

/**
 * @returns {bigint}
 */
export function pvac_max_balance_raw() {
    const ret = wasm.pvac_max_balance_raw();
    return ret;
}

/**
 * @returns {bigint}
 */
export function pvac_max_fee_raw() {
    const ret = wasm.pvac_max_fee_raw();
    return ret;
}

/**
 * @returns {bigint}
 */
export function pvac_min_balance_raw() {
    const ret = wasm.pvac_min_balance_raw();
    return ret;
}

/**
 * @returns {bigint}
 */
export function pvac_min_fee_raw() {
    const ret = wasm.pvac_min_fee_raw();
    return ret;
}

/**
 * Pre-compute Bulletproofs generator table up to `n` entries.
 * @param {number} n
 */
export function pvac_pre_warm_generators(n) {
    wasm.pvac_pre_warm_generators(n);
}

/**
 * Derive the generator table proofs need. `PvacContext` creation no longer does this: call it
 * once per worker in the background after unlock so the first proof does not pay for it.
 * Later calls are no-ops.
 */
export function pvac_prewarm_generators() {
    wasm.pvac_prewarm_generators();
}

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
 * @param {number} bytes
 * @returns {boolean}
 */
export function pvac_prewarm_heap(bytes) {
    const ret = wasm.pvac_prewarm_heap(bytes);
    return ret !== 0;
}

/**
 * Lowercase hex of SHA-256 (webcli `octra::sha256_hex`). Migration payloads use it for
 * `source_cipher_hash`: the hash of the ENCODED "hfhe_v1|..." cipher STRING bytes.
 * @param {Uint8Array} data
 * @returns {string}
 */
export function sha256Hex(data) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        wasm.sha256Hex(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
    }
}

export class wbg_rayon_PoolBuilder {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(wbg_rayon_PoolBuilder.prototype);
        obj.__wbg_ptr = ptr;
        wbg_rayon_PoolBuilderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        wbg_rayon_PoolBuilderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wbg_rayon_poolbuilder_free(ptr, 0);
    }
    build() {
        wasm.wbg_rayon_poolbuilder_build(this.__wbg_ptr);
    }
    /**
     * @returns {string}
     */
    mainJS() {
        const ret = wasm.wbg_rayon_poolbuilder_mainJS(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @returns {number}
     */
    numThreads() {
        const ret = wasm.wbg_rayon_poolbuilder_numThreads(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    receiver() {
        const ret = wasm.wbg_rayon_poolbuilder_receiver(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) wbg_rayon_PoolBuilder.prototype[Symbol.dispose] = wbg_rayon_PoolBuilder.prototype.free;

/**
 * @param {number} receiver
 */
export function wbg_rayon_start_worker(receiver) {
    wasm.wbg_rayon_start_worker(receiver);
}

function __wbg_get_imports(memory) {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_function_0095a73b8b156f76: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_5ae8e5880f2c1fbd: function(arg0) {
            const val = getObject(arg0);
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_cd444516edc5b180: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_9e4d92534c42d778: function(arg0) {
            const ret = getObject(arg0) === undefined;
            return ret;
        },
        __wbg___wbindgen_memory_bd1fbcf21fbef3c8: function() {
            const ret = wasm.memory;
            return addHeapObject(ret);
        },
        __wbg___wbindgen_module_f6b8052d79c1cc16: function() {
            const ret = wasmModule;
            return addHeapObject(ret);
        },
        __wbg___wbindgen_throw_be289d5034ed271b: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_389efe28435a9388: function() { return handleError(function (arg0, arg1) {
            const ret = getObject(arg0).call(getObject(arg1));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_call_4708e0c13bdc8e95: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_call_812d25f1510c13c8: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = getObject(arg0).call(getObject(arg1), getObject(arg2), getObject(arg3));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_crypto_86f2631e91b51511: function(arg0) {
            const ret = getObject(arg0).crypto;
            return addHeapObject(ret);
        },
        __wbg_getRandomValues_b3f15fcbfabb0f8b: function() { return handleError(function (arg0, arg1) {
            getObject(arg0).getRandomValues(getObject(arg1));
        }, arguments); },
        __wbg_get_9b94d73e6221f75c: function(arg0, arg1) {
            const ret = getObject(arg0)[arg1 >>> 0];
            return addHeapObject(ret);
        },
        __wbg_instanceof_Uint8Array_9b9075935c74707c: function(arg0) {
            let result;
            try {
                result = getObject(arg0) instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Window_ed49b2db8df90359: function(arg0) {
            let result;
            try {
                result = getObject(arg0) instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_length_32ed9a279acd054c: function(arg0) {
            const ret = getObject(arg0).length;
            return ret;
        },
        __wbg_length_35a7bace40f36eac: function(arg0) {
            const ret = getObject(arg0).length;
            return ret;
        },
        __wbg_log_6b5ca2e6124b2808: function(arg0) {
            console.log(getObject(arg0));
        },
        __wbg_msCrypto_d562bbe83e0d4b91: function(arg0) {
            const ret = getObject(arg0).msCrypto;
            return addHeapObject(ret);
        },
        __wbg_new_no_args_1c7c842f08d00ebb: function(arg0, arg1) {
            const ret = new Function(getStringFromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_new_with_length_a2c39cbe88fd8ff1: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return addHeapObject(ret);
        },
        __wbg_node_e1f24f89a7336c2e: function(arg0) {
            const ret = getObject(arg0).node;
            return addHeapObject(ret);
        },
        __wbg_now_a3af9a2f4bbaa4d1: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_process_3975fd6c72f520aa: function(arg0) {
            const ret = getObject(arg0).process;
            return addHeapObject(ret);
        },
        __wbg_prototypesetcall_bdcdcc5842e4d77d: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
        },
        __wbg_randomFillSync_f8c153b79f285817: function() { return handleError(function (arg0, arg1) {
            getObject(arg0).randomFillSync(takeObject(arg1));
        }, arguments); },
        __wbg_require_b74f47fc2d022fd6: function() { return handleError(function () {
            const ret = module.require;
            return addHeapObject(ret);
        }, arguments); },
        __wbg_startWorkers_2329d931beb7bef4: function(arg0, arg1, arg2) {
            const ret = startWorkers(takeObject(arg0), takeObject(arg1), wbg_rayon_PoolBuilder.__wrap(arg2));
            return addHeapObject(ret);
        },
        __wbg_static_accessor_GLOBAL_12837167ad935116: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_e628e89ab3b1c95f: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_SELF_a621d3dfbb60d0ce: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_URL_151cb8815849ce83: function() {
            const ret = import.meta.url;
            return addHeapObject(ret);
        },
        __wbg_static_accessor_WINDOW_f8727f0cf888e0bd: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_subarray_a96e1fef17ed23cb: function(arg0, arg1, arg2) {
            const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);
            return addHeapObject(ret);
        },
        __wbg_versions_4e31226f5e8dc909: function(arg0) {
            const ret = getObject(arg0).versions;
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_object_clone_ref: function(arg0) {
            const ret = getObject(arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
        memory: memory || new WebAssembly.Memory({initial:12289,maximum:57344,shared:true}),
    };
    return {
        __proto__: null,
        "./pvac_rs_bg.js": import0,
    };
}

const PvacContextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pvaccontext_free(ptr >>> 0, 1));
const wbg_rayon_PoolBuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wbg_rayon_poolbuilder_free(ptr >>> 0, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function addBorrowedObject(obj) {
    if (stack_pointer == 1) throw new Error('out of js stack');
    heap[--stack_pointer] = obj;
    return stack_pointer;
}

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.buffer !== wasm.memory.buffer) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export(addHeapObject(e));
    }
}

let heap = new Array(128).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let stack_pointer = 128;

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : undefined);
if (cachedTextDecoder) cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().slice(ptr, ptr + len));
}

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined);

if (cachedTextEncoder) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module, thread_stack_size) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    if (typeof thread_stack_size !== 'undefined' && (typeof thread_stack_size !== 'number' || thread_stack_size === 0 || thread_stack_size % 65536 !== 0)) {
        throw 'invalid stack size';
    }
    wasm.__wbindgen_start(thread_stack_size);
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module, memory, thread_stack_size} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports(memory);
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module, thread_stack_size);
}

async function __wbg_init(module_or_path, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path, memory, thread_stack_size} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('pvac_rs_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports(memory);

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module, thread_stack_size);
}

export { initSync, __wbg_init as default };
