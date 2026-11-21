// Port protocol: { id, method, args } -> { id, result } | { id, error } | { id, progress }
// Every args object carries `fp`, the fingerprint of the wallet seed the caller expects; requests
// for any other seed than the one the workers were built from are refused.

import { createSeedGuard } from './pvac-offscreen-guard.js';

/** @type {{ worker: Worker, callbacks: Map<number, {resolve: Function, reject: Function, onProgress?: Function}>, ready: boolean, threaded: boolean }[]} */
const workers = [];
let compiledModule = null;
let initialized = false;
const seedGuard = createSeedGuard();
let callId = 0;
/** @type {chrome.runtime.Port | null} */
let activePort = null;

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function log(msg) {
  const full = `[pvac-offscreen ${ts()}] ${msg}`;
  console.log(full);
  if (activePort) {
    try { activePort.postMessage({ id: 0, log: full }); } catch {}
  }
}

async function ensureCompiledModule() {
  if (compiledModule) return compiledModule;
  const wasmUrl = chrome.runtime.getURL('pvac_rs_bg.wasm');
  const t0 = performance.now();
  const response = await fetch(wasmUrl);
  compiledModule = await WebAssembly.compileStreaming(response);
  log(`WASM module compiled in ${(performance.now() - t0).toFixed(0)}ms`);
  return compiledModule;
}

function createWorker(idx) {
  const workerUrl = chrome.runtime.getURL('pvac-worker.js');
  const worker = new Worker(workerUrl, { type: 'module' });
  const pw = { worker, callbacks: new Map(), ready: false, threaded: false };

  worker.onmessage = (e) => {
    const { id, result, error, progress, log: logMsg } = e.data;
    if (logMsg) {
      const full = `[pvac-offscreen ${ts()}] W${idx}: ${logMsg}`;
      console.log(full);
      if (activePort) {
        try { activePort.postMessage({ id: 0, log: full }); } catch {}
      }
      return;
    }
    const cb = pw.callbacks.get(id);
    if (!cb) return;
    if (progress) {
      if (cb.onProgress) cb.onProgress(progress);
      return;
    }
    pw.callbacks.delete(id);
    if (error) cb.reject(new Error(error));
    else cb.resolve(result);
  };

  worker.onerror = (e) => {
    log(`Worker ${idx} error: ${e.message}`);
  };

  return pw;
}

function workerCall(pw, method, args, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++callId;
    const timer = setTimeout(() => {
      pw.callbacks.delete(id);
      reject(new Error(`Worker call ${method} timed out after 600s`));
    }, 600000);

    pw.callbacks.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      onProgress,
    });
    pw.worker.postMessage({ id, method, args });
  });
}

function workerStatus() {
  return { ready: true, threaded: workers[0].threaded, workerCount: workers.length };
}

function pickWorker() {
  let best = workers[0];
  for (const pw of workers) {
    if (pw.ready && pw.callbacks.size < best.callbacks.size) best = pw;
  }
  return best;
}

const PREWARM_WORKERS = 3;
function prewarmWorkers() {
  for (const pw of workers.slice(0, PREWARM_WORKERS)) {
    workerCall(pw, 'prewarmGenerators', {}).catch((e) => log(`prewarm failed: ${e.message}`));
  }
}

async function initWorkers(seed, numThreads) {
  const t0 = performance.now();

  log(`Offscreen context: crossOriginIsolated=${!!self.crossOriginIsolated}, SharedArrayBuffer=${typeof SharedArrayBuffer}, Atomics=${typeof Atomics}`);
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.store(view, 0, 0);
    const waitResult = Atomics.wait(view, 0, 0, 1);
    log(`Atomics.wait test in offscreen: ${waitResult} (expected 'timed-out')`);
  } catch (e) {
    log(`Atomics.wait BLOCKED in offscreen: ${e.message} - rayon will NOT work!`);
  }

  const wasmModule = await ensureCompiledModule();

  log(`Phase 1: Creating 1 rayon worker with ${numThreads} threads...`);
  let rayonWorking = false;

  const pw0 = createWorker(0);
  workers.push(pw0);

  const result0 = await workerCall(pw0, 'init', {
    wasmModule, seed, workerIdx: 100, enableRayon: true, numThreads: numThreads,
  });

  pw0.ready = result0.ready;
  pw0.threaded = result0.threaded;
  log(`Worker 0 ready: rayon=${result0.threaded}, threads=${numThreads}`);

  rayonWorking = pw0.threaded;

  if (rayonWorking) {
    initialized = true;
    const elapsed = (performance.now() - t0).toFixed(0);
    log(`1 rayon worker initialized in ${elapsed}ms with ${numThreads} threads - using rayon strategy`);
    return { ready: true, threaded: true, workerCount: 1 };
  }

  const workerCount = Math.max(2, Math.min(numThreads, 16));
  const extraWorkers = workerCount - 1;

  if (extraWorkers > 0) {
    log(`Phase 2: Rayon failed, creating ${extraWorkers} additional workers for bit-batching...`);

    const initPromises = [];
    for (let i = 1; i < workerCount; i++) {
      const pw = createWorker(i);
      workers.push(pw);

      initPromises.push(
        workerCall(pw, 'init', {
          wasmModule,
          seed,
          workerIdx: 100 + i,
          enableRayon: false,
          numThreads: 0,
        }).then(result => {
          pw.ready = result.ready;
          pw.threaded = result.threaded;
          log(`Worker ${i} ready: rayon=false`);
        })
      );
    }

    await Promise.all(initPromises);
  }

  initialized = true;
  const elapsed = (performance.now() - t0).toFixed(0);
  log(`${workers.length} workers initialized in ${elapsed}ms - using bit-batch strategy`);
  return { ready: true, threaded: false, workerCount: workers.length };
}

function destroyWorkers() {
  for (const pw of workers) {
    pw.worker.terminate();
    for (const cb of pw.callbacks.values()) cb.reject(new Error('PVAC workers were torn down'));
    pw.callbacks.clear();
  }
  workers.length = 0;
  initialized = false;
  log('All workers destroyed');
}

async function makeRangeProof(args, progressCb) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  const pw = workers[0];

  if (pw.threaded) {
    const t0 = performance.now();
    log(`Rayon proof: dispatching makeRangeProofParallel (cipher=${args.cipherBytes?.length}B, value=${args.value})`);
    const estimatedMs = 120000;
    let timer = null;
    if (progressCb) {
      timer = setInterval(() => {
        const elapsed = performance.now() - t0;
        const fraction = Math.min(elapsed / estimatedMs, 0.99);
        const circuit = Math.floor(fraction * 65);
        progressCb({ current: circuit, total: 65 });
        log(`Rayon progress (synthetic): ~${circuit}/65, ${(elapsed / 1000).toFixed(0)}s elapsed`);
      }, 5000);
    }
    const result = await workerCall(pw, 'makeRangeProofParallel', {
      cipherBytes: args.cipherBytes,
      value: args.value,
    });
    if (timer) clearInterval(timer);
    const totalSec = ((performance.now() - t0) / 1000).toFixed(1);
    log(`Rayon proof DONE in ${totalSec}s (result type=${typeof result}, len=${result?.length || 0})`);
    if (progressCb) progressCb({ current: 65, total: 65 });
    return result;
  }

  if (workers.length > 1) {
    const BITS = 64;
    const totalCircuits = 65;
    const t0 = performance.now();
    const N = workers.length;
    const bpw = Math.ceil(BITS / N);
    const chunks = [];
    for (let i = 0; i < N; i++) {
      const start = i * bpw;
      const end = Math.min(start + bpw, BITS);
      if (start >= BITS) break;
      chunks.push({ workerIdx: i, startBit: start, endBit: end });
    }

    log(`Bit-batch single proof: ${chunks.length} workers (${chunks.map(c => `W${c.workerIdx}:${c.endBit-c.startBit}b`).join(',')})`);

    const workerProgress = new Map();
    const batchPromises = chunks.map(({ workerIdx, startBit, endBit }) =>
      workerCall(workers[workerIdx], 'makeBitProofsBatch', {
        value: args.value,
        startBit,
        endBit,
      }, (p) => {
        workerProgress.set(workerIdx, p.current);
        if (progressCb) {
          let sum = 0;
          for (const v of workerProgress.values()) sum += v;
          progressCb({ current: Math.min(sum, totalCircuits), total: totalCircuits });
        }
      })
    );

    const batchResults = await Promise.all(batchPromises);
    const batchTime = ((performance.now() - t0) / 1000).toFixed(1);
    log(`All ${chunks.length} bit-proof batches done in ${batchTime}s, assembling LC proof...`);

    const result = await workerCall(workers[0], 'assembleRangeProof', {
      cipherBytes: args.cipherBytes,
      batchParts: batchResults,
    });

    const totalTime = ((performance.now() - t0) / 1000).toFixed(1);
    log(`Bit-batch single proof done in ${totalTime}s (batches=${batchTime}s)`);
    if (progressCb) progressCb({ current: totalCircuits, total: totalCircuits });
    return result;
  }

  return workerCall(pw, 'makeRangeProof', {
    cipherBytes: args.cipherBytes,
    value: args.value,
  }, progressCb);
}

async function makeBitBatchProofs(args, progressCb) {
  const BITS = 64;
  const totalCircuits = 128;
  const t0 = performance.now();
  const N = workers.length;
  const half = Math.max(1, Math.floor(N / 2));

  function buildChunks(numWorkers, workerOffset) {
    const bpw = Math.ceil(BITS / numWorkers);
    const chunks = [];
    for (let i = 0; i < numWorkers; i++) {
      const start = i * bpw;
      const end = Math.min(start + bpw, BITS);
      if (start >= BITS) break;
      chunks.push({ workerIdx: workerOffset + i, startBit: start, endBit: end });
    }
    return chunks;
  }

  const chunks1 = buildChunks(half, 0);
  const chunks2 = buildChunks(N - half, half);

  log(`Bit-batch: proof1 across ${chunks1.length} workers (${chunks1.map(c => `W${c.workerIdx}:${c.endBit-c.startBit}b`).join(',')}), proof2 across ${chunks2.length} workers (${chunks2.map(c => `W${c.workerIdx}:${c.endBit-c.startBit}b`).join(',')})`);

  const workerProgress = new Map();
  const reportProgress = () => {
    if (!progressCb) return;
    let sum = 0;
    for (const v of workerProgress.values()) sum += v;
    progressCb({ current: Math.min(sum, totalCircuits), total: totalCircuits });
  };

  const batch1Promises = chunks1.map(({ workerIdx, startBit, endBit }) =>
    workerCall(workers[workerIdx], 'makeBitProofsBatch', {
      value: args.value1,
      startBit,
      endBit,
    }, (p) => {
      workerProgress.set(`p1_${workerIdx}`, p.current);
      reportProgress();
    })
  );

  const batch2Promises = chunks2.map(({ workerIdx, startBit, endBit }) =>
    workerCall(workers[workerIdx], 'makeBitProofsBatch', {
      value: args.value2,
      startBit,
      endBit,
    }, (p) => {
      workerProgress.set(`p2_${workerIdx}`, p.current);
      reportProgress();
    })
  );

  const [batch1, batch2] = await Promise.all([
    Promise.all(batch1Promises),
    Promise.all(batch2Promises),
  ]);

  const batchTime = ((performance.now() - t0) / 1000).toFixed(1);
  log(`All ${totalCircuits} bit-proofs done in ${batchTime}s, assembling LC proofs...`);

  const [r1, r2] = await Promise.all([
    workerCall(workers[0], 'assembleRangeProof', {
      cipherBytes: args.cipher1,
      batchParts: batch1,
    }),
    workerCall(workers[half], 'assembleRangeProof', {
      cipherBytes: args.cipher2,
      batchParts: batch2,
    }),
  ]);

  const totalTime = ((performance.now() - t0) / 1000).toFixed(1);
  log(`Dual bit-batch proofs done in ${totalTime}s (batches=${batchTime}s)`);
  if (progressCb) progressCb({ current: totalCircuits, total: totalCircuits });
  return [r1, r2];
}

async function makeParallelRangeProofs(args, progressCb) {
  if (workers.length === 0) throw new Error('No workers available');

  const pw1 = workers[0];
  const pw2 = workers.length > 1 ? workers[1] : null;
  const t0 = performance.now();
  const totalCircuits = 130;

  if (pw1.threaded && !pw2) {
    log(`Single rayon worker: running dual proofs sequentially (cipher1=${args.cipher1?.length}B, cipher2=${args.cipher2?.length}B)`);
    const estimatedTotalMs = 300000;
    let progressTimer = null;
    if (progressCb) {
      progressTimer = setInterval(() => {
        const fraction = Math.min((performance.now() - t0) / estimatedTotalMs, 0.99);
        progressCb({ current: Math.floor(fraction * totalCircuits), total: totalCircuits });
      }, 2000);
    }
    const r1 = await workerCall(pw1, 'makeRangeProofParallel', { cipherBytes: args.cipher1, value: args.value1 });
    log(`Single rayon: proof1 done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    const r2 = await workerCall(pw1, 'makeRangeProofParallel', { cipherBytes: args.cipher2, value: args.value2 });
    if (progressTimer) clearInterval(progressTimer);
    log(`Single rayon: both proofs done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    if (progressCb) progressCb({ current: totalCircuits, total: totalCircuits });
    return [r1, r2];
  }

  if (workers.length < 2) throw new Error('Need at least 2 workers');

  if (pw1.threaded && pw2.threaded) {
    log(`Dual rayon proofs: Worker 0 handles proof1 (cipher=${args.cipher1?.length}B, val=${args.value1}), Worker 1 handles proof2 (cipher=${args.cipher2?.length}B, val=${args.value2})`);

    const estimatedTotalMs = 300000;
    let progressTimer = null;
    if (progressCb) {
      progressTimer = setInterval(() => {
        const elapsed = performance.now() - t0;
        const fraction = Math.min(elapsed / estimatedTotalMs, 0.99);
        const current = Math.floor(fraction * totalCircuits);
        progressCb({ current, total: totalCircuits });
      }, 2000);
    }

    const [r1, r2] = await Promise.all([
      workerCall(pw1, 'makeRangeProofParallel', {
        cipherBytes: args.cipher1,
        value: args.value1,
      }).then(r => { log(`Worker 0 proof1 done (${typeof r}, len=${r?.length || 0})`); return r; }),
      workerCall(pw2, 'makeRangeProofParallel', {
        cipherBytes: args.cipher2,
        value: args.value2,
      }).then(r => { log(`Worker 1 proof2 done (${typeof r}, len=${r?.length || 0})`); return r; }),
    ]);

    if (progressTimer) clearInterval(progressTimer);
    log(`Dual rayon proofs done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    if (progressCb) progressCb({ current: totalCircuits, total: totalCircuits });
    return [r1, r2];
  }

  if (workers.length > 2) {
    log(`Rayon unavailable, falling back to bit-batch with ${workers.length} workers`);
    return makeBitBatchProofs(args, progressCb);
  }

  let progress1 = 0, progress2 = 0;
  const reportProgress = () => {
    if (progressCb) progressCb({ current: progress1 + progress2, total: totalCircuits });
  };

  log(`Sequential proofs (rayon not available, only 2 workers)`);
  const r1 = await workerCall(pw1, 'makeRangeProof', {
    cipherBytes: args.cipher1,
    value: args.value1,
  }, (p) => { progress1 = p.current; reportProgress(); });

  const r2 = await workerCall(pw1, 'makeRangeProof', {
    cipherBytes: args.cipher2,
    value: args.value2,
  }, (p) => { progress2 = p.current; reportProgress(); });

  log(`Sequential proofs done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return [r1, r2];
}

async function makeBoundRangeProof(args) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(pickWorker(), 'makeBoundRangeProof', {
    cipherBytes: args.cipherBytes,
    value: args.value,
    policy: args.policy,
  });
}

async function matchesSecretProfile(args) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(workers[0], 'matchesSecretProfile', { candidate: args.candidate });
}

async function makeBoundProof(args) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(pickWorker(), 'makeBoundProof', {
    cipherBytes: args.cipherBytes,
    amount: args.amount,
    blinding: args.blinding,
    policy: args.policy,
  });
}

async function makeBoundKeySwitchProof(args) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(pickWorker(), 'makeBoundKeySwitchProof', {
    cipherBytes: args.cipherBytes,
    amount: args.amount,
    blinding: args.blinding,
    policy: args.policy,
  });
}

async function makeKeyOwnerProof(args) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(pickWorker(), 'makeKeyOwnerProof', {
    address: args.address,
    policy: args.policy,
  });
}

async function buildCipherProofMigration(args) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(pickWorker(), 'buildCipherProofMigration', {
    oldPubkey: args.oldPubkey,
    source: args.source,
    amount: args.amount,
    policy: args.policy,
  });
}

// Return-primitive ops (cheap, single-worker) - let the background drive PVAC headlessly
// for dapp FHE methods (encrypt/decrypt/pedersenCommit), since an MV3 service worker cannot
// host workers or main-thread WASM itself.
async function encryptRaw(args) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(workers[0], 'encryptRaw', { value: args.value });
}

async function encryptSeeded(args) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(workers[0], 'encryptSeeded', { value: args.value, seed: args.seed });
}

async function decrypt(args) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(workers[0], 'decrypt', { cipherBytes: args.cipherBytes });
}

async function pedersenCommit(args) {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(workers[0], 'pedersenCommit', { amount: args.amount, blinding: args.blinding });
}

async function getPublicKey() {
  if (workers.length === 0) throw new Error('Offscreen not initialized');
  return workerCall(workers[0], 'getPublicKey', {});
}

async function verifyParallelRangeProofs(args) {
  if (workers.length < 2) throw new Error('Need at least 2 workers');
  const t0 = performance.now();

  log(`Parallel verification: W0 handles proof1 (${args.cipher1?.length}B cipher, ${args.proof1?.length}B proof), W1 handles proof2 (${args.cipher2?.length}B cipher, ${args.proof2?.length}B proof)`);

  const [v1, v2] = await Promise.all([
    workerCall(workers[0], 'verifyRangeProof', {
      cipherBytes: args.cipher1,
      proofBytes: args.proof1,
    }),
    workerCall(workers[1], 'verifyRangeProof', {
      cipherBytes: args.cipher2,
      proofBytes: args.proof2,
    }),
  ]);

  log(`Parallel verification done in ${((performance.now() - t0) / 1000).toFixed(1)}s: [${v1}, ${v2}]`);
  return [v1, v2];
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pvac-proof') return;

  activePort = port;
  log(`Port connected from ${port.sender?.id || 'unknown'}`);

  port.onMessage.addListener(async (msg) => {
    const { id, method, args } = msg;

    try {
      let result;

      const sendProgress = (progress) => {
        try { port.postMessage({ id, progress }); } catch {}
      };

      if (method !== 'init' && method !== 'destroy') seedGuard.check(args && args.fp);

      switch (method) {
        case 'init': {
          const r = await seedGuard.init(
            args.seed,
            args.fp,
            () => initWorkers(args.seed, args.numThreads),
            destroyWorkers,
            () => initialized && workers.length > 0
          );
          if (r.rebuilt) prewarmWorkers();
          result = r.rebuilt ? r.result : workerStatus();
          break;
        }

        case 'destroy':
          destroyWorkers();
          seedGuard.reset();
          result = true;
          break;

        case 'makeRangeProof':
          result = await makeRangeProof(args, sendProgress);
          break;

        case 'makeParallelRangeProofs':
          result = await makeParallelRangeProofs(args, sendProgress);
          break;

        case 'makeBoundRangeProof':
          result = await makeBoundRangeProof(args);
          break;
        case 'matchesSecretProfile':
          result = await matchesSecretProfile(args);
          break;
        case 'makeBoundProof':
          result = await makeBoundProof(args);
          break;

        case 'makeBoundKeySwitchProof':
          result = await makeBoundKeySwitchProof(args);
          break;

        case 'makeKeyOwnerProof':
          result = await makeKeyOwnerProof(args);
          break;

        case 'buildCipherProofMigration':
          result = await buildCipherProofMigration(args);
          break;

        case 'encryptRaw':
          result = await encryptRaw(args);
          break;

        case 'encryptSeeded':
          result = await encryptSeeded(args);
          break;

        case 'decrypt':
          result = await decrypt(args);
          break;

        case 'pedersenCommit':
          result = await pedersenCommit(args);
          break;

        case 'getPublicKey':
          result = await getPublicKey();
          break;

        case 'verifyParallelRangeProofs':
          result = await verifyParallelRangeProofs(args);
          break;

        default:
          throw new Error(`Unknown method: ${method}`);
      }

      try { port.postMessage({ id, result }); } catch {}
    } catch (err) {
      log(`ERROR ${method}: ${err.message}`);
      try { port.postMessage({ id, error: err.message || String(err) }); } catch {}
    }
  });

  port.onDisconnect.addListener(() => {
    log('Port disconnected');
    if (activePort === port) activePort = null;
  });
});

log('OffscreenDocument ready');

// Signal to PvacManager that onConnect listener is registered and ready for port connections
chrome.runtime.sendMessage({ type: 'PVAC_OFFSCREEN_READY' }).catch(() => {});
