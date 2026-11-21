import init, {
  PvacContext,
  pvac_encode_range_proof,
  pvac_encode_zero_proof,
  pvac_prewarm_heap,
} from './pvac_rs.js';
import * as pvacWasm from './pvac_rs.js';

let ctx = null;
let workerIdx = -1;
let wasmExports = null;
let isThreaded = false;

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function log(msg) {
  self.postMessage({ id: 0, log: `[pvac-worker W${workerIdx} ${ts()}] ${msg}` });
}

// pvac-rs proof kinds and the network proof policy (bit 0 wide, bit 1 bind key).
const KIND_AMOUNT = 0;
const KIND_REFRESH = 1;
const KIND_RANGE = 2;
const OWN_KEY = new Uint8Array(0);
function policyArg(args) {
  const p = args.policy;
  if (!Number.isInteger(p) || p < 0 || p > 3) throw new Error('proof policy must be 0..3');
  return p;
}

function memMB() {
  try {
    const b = wasmExports && wasmExports.memory ? wasmExports.memory.buffer.byteLength : 0;
    return b ? (b / 1048576).toFixed(0) : '?';
  } catch (_) {
    return '?';
  }
}

// Before a parallel proof, advance dlmalloc's break past its ~200MB+ working set while the rayon
// sub-workers are still PARKED, then the proof reuses that heap instead of calling memory.grow during
// its parallel phase. A grow mid-parallel-phase detaches the SharedArrayBuffer under the live workers
// and traps 'unreachable' (wasm-bindgen#3290). Growing while parked is harmless (encryptRaw does it).
const PREWARM_TARGET_BYTES = 3623878656; // ~3.375GB
function prewarmHeap(tag) {
  try {
    if (typeof pvac_prewarm_heap !== 'function') return;
    const curBytes = wasmExports && wasmExports.memory ? wasmExports.memory.buffer.byteLength : 0;
    if (!curBytes) return;
    const bytes = PREWARM_TARGET_BYTES - curBytes;
    if (bytes < 32 * 1024 * 1024) {
      log(`prewarm(${tag}) skipped (mem=${memMB()}MB already >= target)`);
      return;
    }
    const before = memMB();
    const ok = pvac_prewarm_heap(bytes);
    log(
      `prewarm(${tag}) alloc+free ${(bytes / 1048576).toFixed(0)}MB -> ${ok ? 'OK' : 'FAILED (hit browser wasm-memory cap)'}: mem ${before}->${memMB()}MB (parked; proof reuses this heap, should not grow)`
    );
  } catch (e) {
    log(`prewarm(${tag}) error: ${e.message}`);
  }
}

// Surface failures that never reach the per-message try/catch: rayon sub-worker traps that bubble up
// as worker errors, and stray promise rejections. Without these they vanish (panic=abort strips the msg).
self.addEventListener('error', (ev) => {
  log(
    `UNCAUGHT error: "${ev.message || (ev.error && ev.error.message) || ev}" @ ${ev.filename || '?'}:${ev.lineno || '?'} (mem=${memMB()}MB, threaded=${isThreaded})`
  );
});
self.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  log(`UNHANDLED rejection: "${(r && r.message) || r}" (mem=${memMB()}MB, threaded=${isThreaded})`);
});

self.onmessage = async (e) => {
  const { id, method, args } = e.data;

  try {
    let result;

    switch (method) {
      case 'init': {
        const t0 = performance.now();
        workerIdx = args.workerIdx ?? -1;

        const moduleOrPath = args.wasmModule || args.wasmUrl;
        log(`init start (module=${moduleOrPath ? 'precompiled' : 'url'})`);

        const t1 = performance.now();
        wasmExports = await init({ module_or_path: moduleOrPath });
        log(
          `WASM instantiated in ${(performance.now() - t1).toFixed(0)}ms (linear memory=${memMB()}MB initial; expect ~768MB on the threaded build so proofs never grow it)`
        );

        try {
          const sab = new SharedArrayBuffer(4);
          const view = new Int32Array(sab);
          Atomics.store(view, 0, 0);
          const waitResult = Atomics.wait(view, 0, 0, 1);
          log(`Atomics.wait test: ${waitResult} (expected 'timed-out') - rayon sub-workers should work`);
        } catch (e) {
          log(`Atomics.wait BLOCKED: ${e.message} - rayon sub-workers will fail`);
        }

        // Rayon only works from OffscreenDocument (popup workers lack Atomics.wait)
        let threaded = false;
        const isCOI = !!self.crossOriginIsolated;
        log(`crossOriginIsolated=${isCOI}, enableRayon=${!!args.enableRayon}`);

        if (args.enableRayon) {
          // initThreadPool only exists in threaded WASM builds - load dynamically
          let initThreadPool = null;
          try {
            log(`Importing pvac_rs.js to check for initThreadPool...`);
            const mod = await import('./pvac_rs.js');
            const exports = Object.keys(mod).filter(k => k.toLowerCase().includes('thread') || k.toLowerCase().includes('rayon') || k.toLowerCase().includes('pool'));
            log(`Module thread/rayon-related exports: [${exports.join(', ')}]`);
            initThreadPool = mod.initThreadPool || null;
            log(`initThreadPool: ${typeof initThreadPool}`);
          } catch (importErr) {
            log(`Import failed: ${importErr.message}`);
          }

          if (typeof initThreadPool === 'function') {
            try {
              const threads = args.numThreads || (navigator.hardwareConcurrency || 4);
              log(`Calling initThreadPool(${threads})... (memory.buffer instanceof SharedArrayBuffer: ${typeof WebAssembly !== 'undefined' ? 'checking...' : 'N/A'})`);
              const tRayon = performance.now();
              await initThreadPool(threads);
              const rayonMs = (performance.now() - tRayon).toFixed(0);
              log(`Rayon thread pool ready: ${threads} threads in ${rayonMs}ms`);

              // Sub-workers may crash silently if Atomics.wait() is blocked
              log(`Waiting 500ms for sub-worker health check...`);
              await new Promise(r => setTimeout(r, 500));
              const crashed = self.__rayonSubWorkersCrashed || 0;
              const total = self.__rayonSubWorkersTotal || threads;
              if (crashed > 0) {
                log(`RAYON DEAD: ${crashed}/${total} sub-workers crashed - Atomics.wait blocked in nested workers`);
                threaded = false;
              } else {
                threaded = true;
                log(`Rayon ALIVE: all ${total} sub-workers healthy, thread pool active`);
              }
            } catch (e) {
              log(`Rayon init FAILED: ${e.message}`);
              log(`  Stack: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : 'N/A'}`);
            }
          } else {
            log(`initThreadPool not available in this build - rayon disabled`);
          }
        } else {
          log(`Rayon skipped (enableRayon=false, crossOriginIsolated=${isCOI})`);
        }

        isThreaded = threaded;
        const t2 = performance.now();
        ctx = new PvacContext(new Uint8Array(args.seed));
        log(`PvacContext created in ${(performance.now() - t2).toFixed(0)}ms, total init ${(performance.now() - t0).toFixed(0)}ms (mem=${memMB()}MB, threaded=${threaded})`);

        result = { ready: true, threaded };
        break;
      }

      // Builds the generator table proofs need, once, in the background after unlock. Its ~250MB
      // peak fits the threaded build's 768MB initial memory, so the rayon pool never sees a grow.
      case 'prewarmGenerators': {
        if (typeof pvacWasm.pvac_prewarm_generators !== 'function') {
          result = false;
          break;
        }
        const t0 = performance.now();
        pvacWasm.pvac_prewarm_generators();
        log(`prewarmGenerators done in ${((performance.now() - t0) / 1000).toFixed(1)}s (mem=${memMB()}MB)`);
        result = true;
        break;
      }

      case 'destroy': {
        if (ctx) {
          ctx.free();
          ctx = null;
        }
        result = true;
        break;
      }

      case 'makeRangeProof': {
        if (!ctx) throw new Error('Worker not initialized');
        const rpCipher = new Uint8Array(args.cipherBytes);
        log(`makeRangeProof start (cipher=${rpCipher.length}B, value=${args.value})`);
        const t0 = performance.now();

        const rpProgress = (current, total) => {
          self.postMessage({ id, progress: { current: Number(current), total: Number(total) } });
          if (Number(current) % 8 === 0 || Number(current) === Number(total)) {
            log(`makeRangeProof circuit ${current}/${total} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
          }
        };
        const rpBytes = ctx.make_range_proof_with_progress(rpCipher, BigInt(args.value), rpProgress);
        result = pvac_encode_range_proof(rpBytes);
        log(`makeRangeProof done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        break;
      }

      case 'makeRangeProofParallel': {
        if (!ctx) throw new Error('Worker not initialized');
        const rppCipher = new Uint8Array(args.cipherBytes);
        const rppThreads = typeof ctx.rayon_thread_count === 'function' ? ctx.rayon_thread_count() : '?';
        const rppMem0 = memMB();
        log(`makeRangeProofParallel start (cipher=${rppCipher.length}B, value=${args.value}, rayon_threads=${rppThreads}, mem=${rppMem0}MB)`);
        log(`  64 bit proofs will run in parallel across ${rppThreads} rayon threads`);
        const rppT0 = performance.now();
        const rppBytes = ctx.make_range_proof_parallel(rppCipher, BigInt(args.value));
        const rppElapsed = ((performance.now() - rppT0) / 1000).toFixed(1);
        const rppPerBit = (parseFloat(rppElapsed) / 64).toFixed(2);
        const rppEffective = (parseFloat(rppElapsed) / 64 * rppThreads).toFixed(1);
        result = pvac_encode_range_proof(rppBytes);
        const rppMem1 = memMB();
        const rppGrew = rppMem0 !== '?' && rppMem1 !== '?' && Number(rppMem1) > Number(rppMem0);
        log(`makeRangeProofParallel done in ${rppElapsed}s (${rppPerBit}s/bit wall, ${rppEffective}s/bit effective, ${rppThreads} threads, proof=${rppBytes.length}B, mem ${rppMem0}->${rppMem1}MB${rppGrew ? ' GREW' : ''})`);
        break;
      }

      case 'makeBitProofsBatch': {
        if (!ctx) throw new Error('Worker not initialized');
        const bits = args.endBit - args.startBit;
        log(`makeBitProofsBatch start bits[${args.startBit}..${args.endBit}) = ${bits} circuits`);
        const t0 = performance.now();

        const bpbProgress = (current, total) => {
          self.postMessage({ id, progress: { current: Number(current), total: Number(total) } });
          log(`bit ${args.startBit + Number(current)}/${args.endBit} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
        };
        const batchBytes = ctx.make_bit_proofs_batch(
          BigInt(args.value), args.startBit, args.endBit, bpbProgress
        );
        result = batchBytes;
        log(`makeBitProofsBatch done: ${bits} circuits in ${((performance.now() - t0) / 1000).toFixed(1)}s (${((performance.now() - t0) / 1000 / bits).toFixed(2)}s/circuit)`);
        break;
      }

      case 'assembleRangeProof': {
        if (!ctx) throw new Error('Worker not initialized');
        const arpCipher = new Uint8Array(args.cipherBytes);
        log(`assembleRangeProof start (cipher=${arpCipher.length}B, ${args.batchParts.length} batches)`);
        const t0 = performance.now();

        const batchArr = args.batchParts.map(part => new Uint8Array(part));
        const rpBytes = ctx.assemble_range_proof(arpCipher, batchArr);
        result = pvac_encode_range_proof(rpBytes);
        log(`assembleRangeProof done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        break;
      }

      case 'decrypt': {
        if (!ctx) throw new Error('Worker not initialized');
        const decCipher = new Uint8Array(args.cipherBytes);
        log(`decrypt start: ${decCipher.length}B cipher (${(decCipher.length / 1024).toFixed(0)}KB)`);
        const t0 = performance.now();
        try {
          const decValue = ctx.decrypt(decCipher);
          result = Number(decValue);
        } catch (e) {
          // Canonical keys rejected the value. Ciphers written by pre-canonical-parity builds
          // used a different H matrix - retry read-only with the legacy keys so the balance
          // stays readable. Result becomes {value, legacy:true} so callers can mark it.
          if (typeof ctx.decryptLegacy !== 'function') throw e;
          const legacyValue = Number(ctx.decryptLegacy(decCipher));
          log(`decrypt: canonical keys rejected (${e && e.message ? e.message : e}); legacy keys read ${legacyValue}`);
          result = { value: legacyValue, legacy: true };
        }
        const decMs = performance.now() - t0;
        const shown = typeof result === 'object' ? `${result.value} (legacy)` : result;
        log(`decrypt done: ${decCipher.length}B -> ${shown} in ${(decMs / 1000).toFixed(1)}s (${(decMs).toFixed(0)}ms, mem=${memMB()}MB)`);
        break;
      }

      case 'getPublicKey': {
        if (!ctx) throw new Error('Worker not initialized');
        const pkBytes = ctx.serialize_pubkey();
        result = Array.from(pkBytes);
        break;
      }

      case 'encryptRaw': {
        if (!ctx) throw new Error('Worker not initialized');
        const t0 = performance.now();
        const erSeed = crypto.getRandomValues(new Uint8Array(32));
        const erCipher = ctx.encrypt_seeded(BigInt(args.value), erSeed);
        const erCommit = ctx.commit(erCipher);
        result = { cipherBytes: Array.from(erCipher), commitmentBytes: Array.from(erCommit) };
        log(`encryptRaw value=${args.value} -> ${erCipher.length}B in ${((performance.now() - t0) / 1000).toFixed(1)}s (mem=${memMB()}MB)`);
        break;
      }

      case 'encryptSeeded': {
        if (!ctx) throw new Error('Worker not initialized');
        const esSeed = new Uint8Array(args.seed);
        const esCipher = ctx.encrypt_seeded(BigInt(args.value), esSeed);
        const esCommit = ctx.commit(esCipher);
        result = { cipherBytes: Array.from(esCipher), commitmentBytes: Array.from(esCommit) };
        break;
      }

      case 'makeBoundProof': {
        if (!ctx) throw new Error('Worker not initialized');
        prewarmHeap('boundProof');
        const bpCipher = new Uint8Array(args.cipherBytes);
        const bpBlinding = new Uint8Array(args.blinding);
        const bpThreads = isThreaded && typeof ctx.rayon_thread_count === 'function' ? ctx.rayon_thread_count() : 1;
        const bpMem0 = memMB();
        log(`makeBoundProof start (cipher=${bpCipher.length}B, amount=${args.amount}, threads=${bpThreads}, mem=${bpMem0}MB)`);
        const t0 = performance.now();
        const bpBytes = ctx.proveAmount(OWN_KEY, bpCipher, BigInt(args.amount), bpBlinding, KIND_AMOUNT, policyArg(args));
        result = pvac_encode_zero_proof(bpBytes);
        const bpMem1 = memMB();
        const bpGrew = bpMem0 !== '?' && bpMem1 !== '?' && Number(bpMem1) > Number(bpMem0);
        log(
          `makeBoundProof done in ${((performance.now() - t0) / 1000).toFixed(1)}s (proof=${bpBytes.length}B, mem ${bpMem0}->${bpMem1}MB${bpGrew ? ' GREW <- growth under live rayon workers can trap unreachable' : ''})`
        );
        break;
      }

      case 'makeBoundKeySwitchProof': {
        if (!ctx) throw new Error('Worker not initialized');
        prewarmHeap('keySwitchProof');
        const ksCipher = new Uint8Array(args.cipherBytes);
        const ksBlinding = new Uint8Array(args.blinding);
        const ksThreads =
          isThreaded && typeof ctx.rayon_thread_count === 'function' ? ctx.rayon_thread_count() : 1;
        const ksMem0 = memMB();
        log(
          `makeBoundKeySwitchProof start (cipher=${ksCipher.length}B, amount=${args.amount}, threads=${ksThreads}, mem=${ksMem0}MB) <- KeySwitchRefresh proof over the DEEP cipher; heaviest circuit`
        );
        const t0 = performance.now();
        const ksBytes = ctx.proveAmount(OWN_KEY, ksCipher, BigInt(args.amount), ksBlinding, KIND_REFRESH, policyArg(args));
        result = pvac_encode_zero_proof(ksBytes);
        const ksMem1 = memMB();
        const ksGrew = ksMem0 !== '?' && ksMem1 !== '?' && Number(ksMem1) > Number(ksMem0);
        log(
          `makeBoundKeySwitchProof done in ${((performance.now() - t0) / 1000).toFixed(1)}s (proof=${ksBytes.length}B, mem ${ksMem0}->${ksMem1}MB${ksGrew ? ' GREW <- bigger circuit; may need a higher prewarm' : ''})`
        );
        break;
      }

      // v3 bound migration (webcli build_pvac_migration_payload, key_bound case): builds the whole
      // equality-proof payload in one round-trip and SELF-VERIFIES both proofs. Keeps every byte
      // inside the worker so there is no encode/decode juggling. old_zp is the heaviest proof (over
      // the deep on-chain cipher, under the OLD registered pubkey - the _with_pubkey variant).
      case 'buildKeyBoundMigration': {
        if (!ctx) throw new Error('Worker not initialized');
        prewarmHeap('keySwitchProof');
        const t0 = performance.now();
        const mgPolicy = policyArg(args);
        const mgAmount = BigInt(args.amount);
        const mgBlinding = new Uint8Array(args.blinding);
        const mgOldCipher = new Uint8Array(args.oldCipherBytes);
        const mgOldPubkey = new Uint8Array(args.oldPubkey);
        // amount_commitment (Pedersen) - shared by both proofs = the equality link
        const mgCommit = ctx.pedersen_commit(mgAmount, mgBlinding);
        const mgSeed = crypto.getRandomValues(new Uint8Array(32));
        const mgNewCipher = ctx.encrypt_seeded(mgAmount, mgSeed);
        const mgNewZp = ctx.proveAmount(OWN_KEY, mgNewCipher, mgAmount, mgBlinding, KIND_AMOUNT, mgPolicy);
        log(`buildKeyBoundMigration: old_zp over deep cipher (${mgOldCipher.length}B) - heaviest proof`);
        const mgOldZp = ctx.proveAmount(
          mgOldPubkey,
          mgOldCipher,
          mgAmount,
          mgBlinding,
          KIND_REFRESH,
          mgPolicy
        );
        // webcli self-checks BOTH proofs against the shared commitment before submitting.
        const mgNewOk = ctx.verifyAmount(OWN_KEY, mgNewCipher, mgNewZp, mgCommit, KIND_AMOUNT, mgPolicy);
        const mgOldOk = ctx.verifyAmount(
          mgOldPubkey,
          mgOldCipher,
          mgOldZp,
          mgCommit,
          KIND_REFRESH,
          mgPolicy
        );
        result = {
          ok: mgNewOk && mgOldOk,
          newValid: mgNewOk,
          oldValid: mgOldOk,
          newCipherBytes: Array.from(mgNewCipher),
          newZeroProof: pvac_encode_zero_proof(mgNewZp),
          oldZeroProof: pvac_encode_zero_proof(mgOldZp),
          commitmentBytes: Array.from(mgCommit),
        };
        log(
          `buildKeyBoundMigration done in ${((performance.now() - t0) / 1000).toFixed(1)}s (new=${mgNewOk}, old=${mgOldOk})`
        );
        break;
      }

      case 'makeBoundRangeProof': {
        if (!ctx) throw new Error('Worker not initialized');
        prewarmHeap('boundRangeProof');
        const brCipher = new Uint8Array(args.cipherBytes);
        const brThreads = isThreaded && typeof ctx.rayon_thread_count === 'function' ? ctx.rayon_thread_count() : 1;
        const brMem0 = memMB();
        log(
          `makeBoundRangeProof start (cipher=${brCipher.length}B, value=${args.value}, threads=${brThreads}, mem=${brMem0}MB) <- bigger circuit than bound proof; historically traps here if memory grows`
        );
        const t0 = performance.now();
        const brBlinding = crypto.getRandomValues(new Uint8Array(32));
        const brBytes = ctx.proveAmount(OWN_KEY, brCipher, BigInt(args.value), brBlinding, KIND_RANGE, policyArg(args));
        result = pvac_encode_range_proof(brBytes);
        const brMem1 = memMB();
        const brGrew = brMem0 !== '?' && brMem1 !== '?' && Number(brMem1) > Number(brMem0);
        log(
          `makeBoundRangeProof done in ${((performance.now() - t0) / 1000).toFixed(1)}s (proof=${brBytes.length}B, mem ${brMem0}->${brMem1}MB${brGrew ? ' GREW <- this is the crash trigger; raise --initial-memory' : ''})`
        );
        break;
      }

      case 'matchesSecretProfile': {
        if (!ctx) throw new Error('Worker not initialized');
        result = ctx.matchesSecretProfile(new Uint8Array(args.candidate));
        break;
      }

      case 'verifyRangeProof': {
        if (!ctx) throw new Error('Worker not initialized');
        const vrCipher = new Uint8Array(args.cipherBytes);
        const vrProof = new Uint8Array(args.proofBytes);
        result = ctx.verify_range_proof(vrCipher, vrProof);
        break;
      }

      case 'verifyBoundProof': {
        if (!ctx) throw new Error('Worker not initialized');
        const vbCipher = new Uint8Array(args.cipherBytes);
        const vbProof = new Uint8Array(args.proofBytes);
        const vbCommit = new Uint8Array(args.commitment);
        result = ctx.verifyAmount(OWN_KEY, vbCipher, vbProof, vbCommit, KIND_AMOUNT, policyArg(args));
        break;
      }

      case 'makeKeyOwnerProof': {
        if (!ctx) throw new Error('Worker not initialized');
        result = JSON.parse(ctx.makeKeyOwnerProof(String(args.address), policyArg(args)));
        break;
      }

      // webcli cipher_migration: history proof under the old key, range proof under ours, both
      // self-verified inside pvac-rs before the fields come back.
      case 'buildCipherProofMigration': {
        if (!ctx) throw new Error('Worker not initialized');
        prewarmHeap('boundRangeProof');
        const t0 = performance.now();
        result = JSON.parse(
          ctx.buildCipherProofMigration(
            new Uint8Array(args.oldPubkey),
            String(args.source),
            BigInt(args.amount),
            policyArg(args)
          )
        );
        log(`buildCipherProofMigration done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        break;
      }

      case 'diagnoseProof': {
        if (!ctx) throw new Error('Worker not initialized');
        const dpProof = new Uint8Array(args.proofBytes);
        result = ctx.diagnose_proof(dpProof);
        break;
      }

      case 'diagnoseCipher': {
        if (!ctx) throw new Error('Worker not initialized');
        const dcCipher = new Uint8Array(args.cipherBytes);
        result = ctx.diagnose_cipher(dcCipher);
        break;
      }

      case 'checkBoundProvable': {
        if (!ctx) throw new Error('Worker not initialized');
        // Runs the private-spend readiness check IN THE WORKER - lazily building a
        // main-thread WASM context for this froze the popup ~7s (keygen on the UI thread).
        if (typeof ctx.check_bound_provable !== 'function') {
          result = null; // pre-rebuild WASM lacks the binding - caller falls back
          break;
        }
        const cbpCipher = new Uint8Array(args.cipherBytes);
        result = ctx.check_bound_provable(cbpCipher);
        break;
      }

      case 'pedersenCommit': {
        if (!ctx) throw new Error('Worker not initialized');
        result = Array.from(ctx.pedersen_commit(BigInt(args.amount), new Uint8Array(args.blinding)));
        break;
      }

      case 'ctSub': {
        if (!ctx) throw new Error('Worker not initialized');
        const csA = new Uint8Array(args.cipherA);
        const csB = new Uint8Array(args.cipherB);
        result = ctx.ct_sub(csA, csB);
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    self.postMessage({ id, result });
  } catch (err) {
    const name = (err && err.name) || '?';
    const msg = (err && err.message) || String(err) || '(empty)';
    const isTrap = typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError;
    const stack = err && err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : 'N/A';
    log(`ERROR ${method}: name=${name}${isTrap ? ' (WASM trap)' : ''} msg="${msg}" mem=${memMB()}MB threaded=${isThreaded}`);
    log(`  stack: ${stack}`);
    self.postMessage({ id, error: err.message || String(err) });
  }
};
