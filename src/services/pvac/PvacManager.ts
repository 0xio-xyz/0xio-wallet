import { base64ToBytes, bytesToBase64, strToBytes } from 'src/lib/encoding';
import { logger } from 'src/utils/logger';
import { ZeroXIOConfig, type NetworkId } from 'src/utils/config';
import { getPendingKeySwitch, pubkeyHashPrefix, recordPendingKeySwitch } from './keySwitchService';
import { pvacMasterSeed } from './pvacMasterSeed';
import {
  forgetPairing,
  getClientId,
  loadPairing,
  pairCodeChoices,
  savePairing,
} from '../desktop/desktopPairing';
import {
  CONNECT_TIMEOUT_MS,
  DESKTOP_URL,
  SocketLink,
  connectAndInit,
  openDesktopSocket,
  probeDesktop,
  runPairing,
  type DesktopStatus,
  type PairResult,
} from '../desktop/desktopLink';
import { pvacSeedFingerprint } from './pvacSeedFingerprint';
import { TxScopeError, captureTxScope, storedNetworkId } from '../network/txScope';
import { PROOF_WIDE } from './proofPolicy';

/** pvac-rs proof kinds (webcli PVAC_AMOUNT, PVAC_REFRESH, PVAC_RANGE, PVAC_HISTORY). */
const PROOF_KIND = { amount: 0, refresh: 1, range: 2, history: 3 } as const;
const OWN_KEY = new Uint8Array(0);

export interface KeyOwnerProof {
  owner_cipher: string;
  owner_proof: string;
}

/** The cipher_proof key_switch fields (webcli octra::cipher_migration). */
export interface CipherProofMigration {
  migration_mode: string;
  source_cipher_hash: string;
  new_cipher: string;
  old_zero_proof: string;
  new_range_proof: string;
  amount_commitment: string;
}

const PAIRED_SHEET_MS = 1300;

export type PairPhase =
  | 'connecting'
  | 'choosing'
  | 'waiting'
  | 'paired'
  | 'wrong'
  | 'refused'
  | 'timeout';

export interface PairSheet {
  phase: PairPhase;
  codes: string[] | null;
  picked: number | null;
}

const NETWORK_MOVED = 'The network changed during the encryption key check. Try again.';

interface PvacContextWasm {
  encrypt(value: bigint): Uint8Array;
  encrypt_seeded(value: bigint, seed: Uint8Array): Uint8Array;
  encrypt_zero(): Uint8Array;
  encrypt_zero_seeded(seed: Uint8Array): Uint8Array;
  decrypt(cipherBytes: Uint8Array): bigint;
  decryptLegacy?(cipherBytes: Uint8Array): bigint;
  commit(cipherBytes: Uint8Array): Uint8Array;
  ct_add(a: Uint8Array, b: Uint8Array): Uint8Array;
  ct_sub(a: Uint8Array, b: Uint8Array): Uint8Array;
  serialize_pubkey(): Uint8Array;
  serialize_seckey(): Uint8Array;
  make_range_proof(cipherBytes: Uint8Array, value: bigint): Uint8Array;
  proveAmount(
    pubkeyBytes: Uint8Array,
    cipherBytes: Uint8Array,
    amount: bigint,
    blinding: Uint8Array,
    kind: number,
    policy: number
  ): Uint8Array;
  verifyAmount(
    pubkeyBytes: Uint8Array,
    cipherBytes: Uint8Array,
    proofBytes: Uint8Array,
    commitment: Uint8Array,
    kind: number,
    policy: number
  ): boolean;
  makeKeyOwnerProof(address: string, policy: number): string;
  buildCipherProofMigration(
    pubkeyBytes: Uint8Array,
    source: string,
    amount: bigint,
    policy: number
  ): string;
  matchesSecretProfile(candidateBytes: Uint8Array): boolean;
  pedersen_commit(amount: bigint, blinding: Uint8Array): Uint8Array;
  verify_range_proof(cipherBytes: Uint8Array, proofBytes: Uint8Array): boolean;
  diagnose_cipher(cipherBytes: Uint8Array): string;
  diagnose_proof(proofBytes: Uint8Array): string;
  check_bound_provable(cipherBytes: Uint8Array): string;
  free(): void;
}

interface PvacWasmModule {
  default: (
    input?: RequestInfo | URL | BufferSource | { module_or_path: RequestInfo | URL }
  ) => Promise<void>;
  PvacContext: new (seed: Uint8Array) => PvacContextWasm;
  pvac_encode_range_proof(proofBytes: Uint8Array): string;
  pvac_encode_zero_proof(proofBytes: Uint8Array): string;
  pvac_encode_cipher(cipherBytes: Uint8Array): string;
  pvac_compute_aes_kat(): string;
}

async function makeSeed(txHash: string, epochId: number, purpose: string): Promise<Uint8Array> {
  const input = `OCTRA_FHE_SEED_V1|${txHash}|${epochId}|${purpose}`;
  const data = strToBytes(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
  return new Uint8Array(hashBuffer);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

interface PoolWorker {
  worker: Worker;
  callbacks: Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      onProgress?: (current: number, total: number) => void;
    }
  >;
  lastTimeoutAt: number;
  ready: boolean;
  warm?: boolean;
}

// Policy constants (from webcli pvac_upgrade_policy.hpp, pvac-rs::policy)

export const MAX_BALANCE_RAW = 1_000_000_000_000_000;

export const MIN_BALANCE_RAW = 0;

export function isValidBalance(balance: number): boolean {
  return balance >= MIN_BALANCE_RAW && balance <= MAX_BALANCE_RAW;
}

export class PvacManager {
  private ctx: PvacContextWasm | null = null;
  private wasmModule: PvacWasmModule | null = null;
  private initialized = false;
  private loading: Promise<void> | null = null;
  private mainCtxPromise: Promise<void> | null = null;
  private currentKeyB64: string | null = null;

  private workers: PoolWorker[] = [];
  private _decryptInflight: Map<string, Promise<number>> = new Map();
  private workerCallId = 0;
  private walletSeed: Uint8Array | null = null;
  private _initGen = 0;
  private compiledWasmModule: WebAssembly.Module | null = null;

  proofGenerationActive = false;

  pvacForeign = false;

  lastDecryptCorrupted = false;

  // Set when the last decrypt only succeeded via the legacy (pre-canonical-parity) keys:
  // the cipher was written by an older build. Readable, NOT corruption - but canonical
  // private ops must not touch it (layering onto it would corrupt it beyond either keyset).
  lastDecryptLegacy = false;

  private pvacRegistrationCache = new Map<
    string,
    {
      verified: boolean;
      timestamp: number;
    }
  >();
  private PVAC_CACHE_TTL = 15 * 60 * 1000;
  private static CACHE_TTL_STORAGE_KEY = '0xio_pvac_cache_ttl_minutes';

  private pvacVerificationInFlight = new Map<string, Promise<boolean>>();

  private _desktopReadyResolve: (() => void) | null = null;

  private ws: WebSocket | null = null;
  private wsAvailable = false;
  private wsSeed: Uint8Array | null = null;
  private _desktopOutdated = false;
  // Keygen-consistency handshake: desktop returns its pubkey fingerprint on init; we refuse to
  // offload to a desktop on a divergent keygen (its proofs would be node-rejected). Verified lazily
  // against our local pubkey before the first offloaded proof; null = unchecked.
  private desktopPubkeyFp: string | null = null;
  private _desktopKeygenOk: boolean | null = null;
  private wsCallId = 0;
  private _desktopStatus: DesktopStatus = 'unknown';
  private _desktopListeners = new Set<() => void>();
  private _pairing: {
    abort: AbortController;
    real: number | null;
    pick: (ok: boolean) => void;
  } | null = null;
  private _pairSheet: PairSheet | null = null;
  private _pairSheetTimer: ReturnType<typeof setTimeout> | null = null;
  private wsCallbacks: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }> =
    new Map();

  private offscreenReady = false;
  private offscreenThreaded = false;
  private offscreenProofFailed = false;
  private offscreenPort: chrome.runtime.Port | null = null;
  private offscreenCallId = 0;
  private offscreenCallbacks: Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      onProgress?: (current: number, total: number) => void;
    }
  > = new Map();

  async initialize(privateKeyB64: string): Promise<void> {
    await this._loadCacheTTL();
    if (this.initialized && this.currentKeyB64 === privateKeyB64) return;
    if (this.initialized && this.currentKeyB64 !== privateKeyB64) {
      logger.debug(`[PvacManager ${ts()}] Wallet key changed, re-initializing...`);
      this.destroy();
    }
    if (this.loading) return this.loading;
    const loading = this._init(privateKeyB64);
    this.loading = loading;
    try {
      await loading;
    } catch (e) {
      if (this.loading === loading) this.loading = null;
      throw e;
    }
  }

  /**
   * Background / service-worker-safe initialization. An MV3 service worker cannot spawn
   * Web Workers or run the main-thread WASM context, so {@link initialize} (which races
   * those paths) is not usable there.
   */
  async ensureOffscreenReady(privateKeyB64: string): Promise<void> {
    const seed = base64ToBytes(privateKeyB64).slice(0, 32);
    if (this.offscreenReady && this.offscreenPort && this.currentKeyB64 === privateKeyB64) return;
    if (this.currentKeyB64 && this.currentKeyB64 !== privateKeyB64) {
      this.destroy();
    }
    this.walletSeed = seed;
    this.currentKeyB64 = privateKeyB64;
    await this._ensureOffscreen();
  }

  private async _init(privateKeyB64: string): Promise<void> {
    const gen = this._initGen;
    try {
      const initT0 = Date.now();
      logger.debug(`[PvacManager ${ts()}] _init starting...`);
      const rawKey = base64ToBytes(privateKeyB64);
      const seed = rawKey.slice(0, 32);
      this.walletSeed = seed;

      const desktopReady = new Promise<void>((resolve) => {
        this._desktopReadyResolve = resolve;
      });

      this._initProofWorker(seed, gen).catch((e) => {
        if (this._initGen !== gen) return;
        logger.warn(`[PvacManager ${ts()}] Proof worker init failed:`, e);
      });

      const workerReady = this._initSingleWorker(seed, gen);

      await Promise.race([desktopReady, workerReady]);
      if (this._initGen !== gen) throw new Error('PVAC stopped (wallet locked or switched)');
      this._desktopReadyResolve = null;

      if (this.workers.length === 0 && !this.wsAvailable) {
        logger.debug(
          `[PvacManager ${ts()}] No workers/0xio Desktop available, loading main-thread WASM as fallback`
        );
        await this._loadMainCtx(seed);
      }

      if (this._initGen !== gen) throw new Error('PVAC stopped (wallet locked or switched)');
      this.initialized = true;
      this.currentKeyB64 = privateKeyB64;
      logger.debug(
        `[PvacManager ${ts()}] Initialized in ${((Date.now() - initT0) / 1000).toFixed(1)}s (0xioDesktop=${this.wsAvailable}, workers=${this.workers.length}, mainCtx=${!!this.ctx})`
      );
    } catch (e) {
      if (this._initGen !== gen) throw e;
      logger.error(`[PvacManager ${ts()}] Initialization failed:`, e);
      this.initialized = false;
      this.ctx = null;
      this.loading = null;
      this._desktopReadyResolve = null;
      throw e;
    }
  }

  private async _tryDesktopApp(): Promise<boolean> {
    if (!this.walletSeed) return false;
    if (this.wsAvailable && this.ws) {
      if (this.wsSeed && bytesEqual(this.wsSeed, this.walletSeed)) {
        this._desktopReadyResolve?.();
        this._desktopReadyResolve = null;
        return true;
      }
      logger.debug(
        `[PvacManager ${ts()}] 0xio Desktop was set up for another wallet, reconnecting`
      );
      this._disconnectWs();
    }
    this._desktopOutdated = false;
    try {
      if (!(await probeDesktop())) {
        logger.debug(
          `[PvacManager ${ts()}] 0xio Desktop not found (port 19345) - using local PVAC`
        );
        this._setDesktopStatus('absent');
        return false;
      }
      const ws = await openDesktopSocket(DESKTOP_URL, CONNECT_TIMEOUT_MS);
      if (!ws) {
        logger.debug(`[PvacManager ${ts()}] 0xio Desktop WebSocket failed to open`);
        this._setDesktopStatus('absent');
        return false;
      }
      const link = new SocketLink(ws);
      const seed = this.walletSeed.slice();
      const [clientId, pairing] = await Promise.all([getClientId(), loadPairing()]);
      let session: Awaited<ReturnType<typeof connectAndInit>>;
      try {
        // Both sides prove the pairing secret first; the master seed is derived and sent only to
        // a desktop that proved it.
        session = await connectAndInit(link, {
          clientId,
          pairing,
          master: () => pvacMasterSeed(seed),
        });
      } catch (e) {
        ws.close();
        seed.fill(0);
        logger.debug(`[PvacManager ${ts()}] 0xio Desktop did not answer: ${(e as Error).message}`);
        this._setDesktopStatus('absent');
        return false;
      }
      if (session.status !== 'verified') {
        ws.close();
        seed.fill(0);
        // A not_paired answer proves nothing (anyone on the port can send one), so the secret
        // stays until the person unpairs; the pair again state covers a desktop that forgot us.
        this._desktopOutdated = session.status === 'outdated';
        logger.debug(
          `[PvacManager ${ts()}] 0xio Desktop ${session.status} - nothing sent, using local PVAC`
        );
        this._setDesktopStatus(session.status);
        return false;
      }
      const msg = session.init;
      if (!msg || msg.error) {
        ws.close();
        seed.fill(0);
        this._desktopOutdated = typeof msg?.error === 'string' && msg.error.startsWith('seed ');
        logger.debug(
          `[PvacManager ${ts()}] 0xio Desktop refused init (${msg?.error ?? 'no answer'}) - using local PVAC`
        );
        this._setDesktopStatus(this._desktopOutdated ? 'outdated' : 'absent');
        return false;
      }
      this.ws = ws;
      this._setupWsHandlers(ws);
      this.wsAvailable = true;
      this.wsSeed = seed;
      this.desktopPubkeyFp = typeof msg.pubkey_fp === 'string' ? msg.pubkey_fp : null;
      this._desktopKeygenOk = null;
      logger.debug(
        `[PvacManager ${ts()}] 0xio Desktop verified and connected: init=${msg.init_ms}ms threads=${msg.threads} fp=${msg.pubkey_fp ?? 'n/a'}`
      );
      this._setDesktopStatus('verified');
      if (this._desktopReadyResolve) {
        this._desktopReadyResolve();
        this._desktopReadyResolve = null;
      }
      return true;
    } catch {
      return false;
    }
  }

  get desktopStatus(): DesktopStatus {
    return this._desktopStatus;
  }

  get desktopPairSheet(): PairSheet | null {
    return this._pairSheet;
  }

  get desktopPairingActive(): boolean {
    return this._pairing !== null;
  }

  private _setPairSheet(sheet: PairSheet | null): void {
    if (this._pairSheetTimer) clearTimeout(this._pairSheetTimer);
    this._pairSheetTimer = null;
    this._pairSheet = sheet;
    this._emitDesktop();
  }

  pickDesktopPairCode(index: number): void {
    const sheet = this._pairSheet;
    if (sheet?.phase !== 'choosing' || !sheet.codes || !(index in sheet.codes)) return;
    this._setPairSheet({ ...sheet, picked: index });
  }

  submitDesktopPairPick(): void {
    const sheet = this._pairSheet;
    const pairing = this._pairing;
    if (sheet?.phase !== 'choosing' || sheet.picked == null || !pairing) return;
    const ok = sheet.picked === pairing.real;
    this._setPairSheet({ ...sheet, phase: ok ? 'waiting' : 'wrong' });
    pairing.pick(ok);
  }

  closeDesktopPairSheet(): void {
    if (this._pairSheet?.phase === 'paired') return;
    this._pairing?.abort.abort();
    this._setPairSheet(null);
  }

  onDesktopChange(cb: () => void): () => void {
    this._desktopListeners.add(cb);
    return () => this._desktopListeners.delete(cb);
  }

  private _setDesktopStatus(status: DesktopStatus): void {
    this._desktopStatus = status;
    this._emitDesktop();
  }

  private _emitDesktop(): void {
    this._desktopListeners.forEach((cb) => cb());
  }

  /**
   * Pairs this install with 0xio Desktop: the user picks the desktop's code among three and both
   * approve. The pairing is saved, and the seed may reach the desktop, only once the pick was
   * right and the desktop said paired.
   */
  async pairDesktop(): Promise<PairResult['status'] | 'absent'> {
    if (this._pairing) return 'failed';
    const abort = new AbortController();
    let pick: (ok: boolean) => void = () => {};
    const picked = new Promise<boolean>((resolve) => (pick = resolve));
    this._pairing = { abort, real: null, pick };
    this._setPairSheet({ phase: 'connecting', codes: null, picked: null });
    const ended = (phase: 'refused' | 'timeout' | null) => {
      if (abort.signal.aborted) return;
      this._setPairSheet(phase && this._pairSheet ? { ...this._pairSheet, phase } : null);
    };
    let ws: WebSocket | null = null;
    try {
      if (!(await probeDesktop()) || abort.signal.aborted) {
        ended(null);
        return abort.signal.aborted ? 'cancelled' : 'absent';
      }
      ws = await openDesktopSocket(DESKTOP_URL, CONNECT_TIMEOUT_MS);
      if (!ws) {
        ended(null);
        return 'absent';
      }
      const link = new SocketLink(ws);
      const result = await runPairing(link, await getClientId(), {
        signal: abort.signal,
        picked,
        onCode: (code) => {
          if (abort.signal.aborted || !this._pairing) return;
          const { codes, index } = pairCodeChoices(code);
          this._pairing.real = index;
          this._setPairSheet({ phase: 'choosing', codes, picked: null });
        },
      });
      ws.close();
      ws = null;
      if (result.status === 'paired') {
        await savePairing(result.pairing);
        logger.debug(`[PvacManager ${ts()}] Paired with 0xio Desktop`);
        const sheet = {
          ...(this._pairSheet ?? { codes: null, picked: null }),
          phase: 'paired' as const,
        };
        this._setPairSheet(sheet);
        this._pairSheetTimer = setTimeout(() => {
          if (this._pairSheet === sheet) this._setPairSheet(null);
        }, PAIRED_SHEET_MS);
        this._disconnectWs();
        this._setDesktopStatus('unknown');
        if (this.walletSeed) await this._tryDesktopApp();
      } else if (result.status === 'refused' || result.status === 'timeout') {
        ended(result.status);
      } else if (result.status !== 'wrong') {
        ended(null);
        if (result.status === 'outdated') this._setDesktopStatus('outdated');
      }
      return result.status;
    } catch (e) {
      logger.debug(
        `[PvacManager ${ts()}] Pairing with 0xio Desktop failed: ${(e as Error).message}`
      );
      ended(null);
      return abort.signal.aborted ? 'cancelled' : 'failed';
    } finally {
      ws?.close();
      this._pairing = null;
      this._emitDesktop();
    }
  }

  async unpairDesktop(): Promise<void> {
    await forgetPairing();
    this._disconnectWs();
    this._setDesktopStatus('not_paired');
  }

  private _setupWsHandlers(ws: WebSocket): void {
    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        const cb = this.wsCallbacks.get(msg._id);
        if (cb) {
          this.wsCallbacks.delete(msg._id);
          if (msg.error) cb.reject(new Error(msg.error));
          else cb.resolve(msg);
        }
      } catch (e) {
        logger.warn(`[PvacManager ${ts()}] WS message parse error:`, e);
      }
    };
    ws.onclose = () => {
      logger.warn(`[PvacManager ${ts()}] 0xio Desktop disconnected`);
      this._disconnectWs();
    };
    ws.onerror = () => {};
  }

  private _wsCall(method: string, args: Record<string, any>, timeoutMs = 300000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.wsAvailable) {
        reject(new Error('0xio Desktop not available'));
        return;
      }
      const id = ++this.wsCallId;
      const t0 = Date.now();
      const payload = JSON.stringify({ _id: id, method, ...args });
      logger.debug(
        `[PvacManager ${ts()}] WS -> ${method} (id=${id}, ${payload.length}B, timeout=${timeoutMs / 1000}s)`
      );

      const heartbeat =
        timeoutMs > 30000
          ? setInterval(() => {
              const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
              logger.debug(
                `[PvacManager ${ts()}] WS ⏳ ${method} (id=${id}) still waiting... ${elapsed}s elapsed`
              );
            }, 15000)
          : null;

      const timer = setTimeout(() => {
        if (heartbeat) clearInterval(heartbeat);
        this.wsCallbacks.delete(id);
        reject(new Error(`WS call ${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      this.wsCallbacks.set(id, {
        resolve: (v: any) => {
          clearTimeout(timer);
          if (heartbeat) clearInterval(heartbeat);
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          logger.debug(`[PvacManager ${ts()}] WS <- ${method} (id=${id}) response in ${elapsed}s`);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          if (heartbeat) clearInterval(heartbeat);
          reject(e);
        },
      });

      this.ws.send(payload);
    });
  }

  private _disconnectWs(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    const wasOn = this.wsAvailable;
    this.wsAvailable = false;
    this.wsSeed = null;
    if (wasOn && this._desktopStatus === 'verified') this._setDesktopStatus('unknown');
    // Snapshot and clear BEFORE rejecting - prevents re-entrant infinite recursion
    // (reject callbacks from _try0xioDesktop call _disconnectWs again)
    const pending = [...this.wsCallbacks.values()];
    this.wsCallbacks.clear();
    for (const cb of pending) {
      cb.reject(new Error('0xio Desktop disconnected'));
    }
  }

  get hasDesktopApp(): boolean {
    return this.wsAvailable;
  }

  get desktopKeygenMismatch(): boolean {
    return this._desktopKeygenOk === false;
  }

  get desktopOutdated(): boolean {
    return this._desktopOutdated;
  }

  async reconnectDesktop(privateKeyB64?: string): Promise<boolean> {
    if (!this.walletSeed && privateKeyB64) {
      this.walletSeed = base64ToBytes(privateKeyB64).slice(0, 32);
    }
    if (!this.walletSeed) {
      logger.debug(`[PvacManager ${ts()}] 0xio Desktop reconnect skipped: no wallet key loaded`);
      return false;
    }
    logger.debug(`[PvacManager ${ts()}] Reconnecting to 0xio Desktop...`);
    return this._tryDesktopApp();
  }

  get cacheTTLMinutes(): number {
    return this.PVAC_CACHE_TTL / 60_000;
  }

  async setCacheTTLMinutes(minutes: number): Promise<void> {
    const oldMin = this.PVAC_CACHE_TTL / 60_000;
    this.PVAC_CACHE_TTL = minutes * 60_000;
    logger.debug(
      `[PvacManager ${ts()}] [CacheSettings] PVAC cache TTL changed: ${oldMin}min -> ${minutes}min - saving to storage`
    );
    await chrome.storage.local.set({
      [PvacManager.CACHE_TTL_STORAGE_KEY]: minutes,
    });
    logger.debug(
      `[PvacManager ${ts()}] [CacheSettings] PVAC cache TTL saved to storage: ${minutes}min (key=${PvacManager.CACHE_TTL_STORAGE_KEY})`
    );
    if (this.pvacRegistrationCache.size > 0) {
      this.pvacRegistrationCache.clear();
      logger.debug(
        `[PvacManager ${ts()}] [CacheSettings] Cleared all ${this.pvacRegistrationCache.size} cache entries due to TTL change`
      );
    }
  }

  private async _loadCacheTTL(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(PvacManager.CACHE_TTL_STORAGE_KEY);
      const stored = result[PvacManager.CACHE_TTL_STORAGE_KEY];
      if (typeof stored === 'number' && stored > 0) {
        this.PVAC_CACHE_TTL = stored * 60_000;
        logger.debug(
          `[PvacManager ${ts()}] [CacheSettings] Loaded PVAC cache TTL from storage: ${stored}min`
        );
      } else {
        logger.debug(
          `[PvacManager ${ts()}] [CacheSettings] No stored PVAC cache TTL - using default: ${this.PVAC_CACHE_TTL / 60_000}min`
        );
      }
    } catch {
      logger.warn(
        `[PvacManager ${ts()}] [CacheSettings] Failed to load PVAC cache TTL from storage - using default: ${this.PVAC_CACHE_TTL / 60_000}min`
      );
    }
  }

  private get _hasRemoteEngine(): boolean {
    return this.wsAvailable;
  }

  private async _ensureDesktopKeygenOk(): Promise<boolean> {
    if (this._desktopKeygenOk !== null) return this._desktopKeygenOk;
    if (!this.desktopPubkeyFp) return (this._desktopKeygenOk = true);
    let localPubB64: string | null = null;
    try {
      if (this.ctx) {
        localPubB64 = bytesToBase64(this.ctx.serialize_pubkey());
      } else if (this.workers.length > 0) {
        const pkBytes: number[] = await this._workerCall('getPublicKey', {}, 30000);
        localPubB64 = bytesToBase64(new Uint8Array(pkBytes));
      }
    } catch {}
    if (!localPubB64) return (this._desktopKeygenOk = true);
    try {
      const localFp = await pubkeyHashPrefix(localPubB64);
      const ok = localFp === this.desktopPubkeyFp;
      this._desktopKeygenOk = ok;
      if (!ok) {
        logger.warn(
          `[PvacManager ${ts()}] 0xio Desktop keygen mismatch (desktop=${this.desktopPubkeyFp} local=${localFp}) - disabling offload, using local PVAC`
        );
        this.wsAvailable = false;
      }
      return ok;
    } catch {
      return (this._desktopKeygenOk = true);
    }
  }

  private async _remoteCall(
    method: string,
    args: Record<string, any>,
    timeoutMs = 300000
  ): Promise<any> {
    if (method !== 'init' && method !== 'ping' && method !== 'serializePubkey') {
      if (!(await this._ensureDesktopKeygenOk())) {
        throw new Error('0xio Desktop keygen mismatch - falling back to local PVAC');
      }
    }
    return this._wsCall(method, args, timeoutMs);
  }

  /**
   * A desktop that predates the proof policy ignores `policy` and proves under the default
   * (wide), so any other policy goes to the policy-only methods: an older desktop refuses them
   * and the proof falls back to the local engine instead of coming out under the wrong rules.
   */
  private _remoteProof(
    method: string,
    kind: number,
    args: Record<string, any>,
    policy: number,
    timeoutMs?: number
  ): Promise<any> {
    if (policy === PROOF_WIDE) return this._remoteCall(method, { ...args, policy }, timeoutMs);
    const verify = method.startsWith('verify');
    return this._remoteCall(
      verify ? 'verifyAmount' : 'proveAmount',
      { ...args, kind, policy },
      timeoutMs
    );
  }

  private async _loadMainCtx(seed: Uint8Array): Promise<void> {
    try {
      const ctxT0 = Date.now();
      // Unbundled ES module - rayon workers need to import() the same chrome-extension:// URL
      const wasmJsUrl = chrome.runtime.getURL('pvac_rs.js');
      logger.debug(`[PvacManager ${ts()}] _loadMainCtx: importing JS glue...`);
      const wasm = (await import(/* @vite-ignore */ wasmJsUrl)) as unknown as PvacWasmModule;
      logger.debug(
        `[PvacManager ${ts()}] _loadMainCtx: JS glue imported in ${Date.now() - ctxT0}ms`
      );

      await new Promise<void>((r) => setTimeout(r, 0));

      const wasmUrl = chrome.runtime.getURL('pvac_rs_bg.wasm');
      const wasmT0 = Date.now();
      logger.debug(`[PvacManager ${ts()}] _loadMainCtx: fetching+compiling WASM...`);
      await wasm.default({ module_or_path: wasmUrl });
      logger.debug(`[PvacManager ${ts()}] _loadMainCtx: WASM loaded in ${Date.now() - wasmT0}ms`);

      // Guard: destroy() or a key change during loading leaves this seed behind, abort.
      if (this.walletSeed !== seed) return;

      await new Promise<void>((r) => setTimeout(r, 0));

      const keyT0 = Date.now();
      this.wasmModule = wasm;
      this.ctx = new wasm.PvacContext(seed);
      logger.debug(
        `[PvacManager ${ts()}] Main-thread WASM context ready (keygen=${Date.now() - keyT0}ms, total=${Date.now() - ctxT0}ms)`
      );
    } catch (e) {
      logger.error(`[PvacManager ${ts()}] Main-thread WASM load failed:`, e);
    }
  }

  async ensureMainCtx(): Promise<void> {
    if (this.ctx) return;
    if (!this.mainCtxPromise && this.walletSeed) {
      logger.debug(`[PvacManager ${ts()}] Lazy-loading main-thread WASM context...`);
      this.mainCtxPromise = this._loadMainCtx(this.walletSeed);
    }
    if (this.mainCtxPromise) await this.mainCtxPromise;
    if (!this.ctx) throw new Error('PvacManager: main-thread WASM context not available');
  }

  private async _ensureCompiledModule(): Promise<WebAssembly.Module> {
    if (this.compiledWasmModule) {
      logger.debug(`[PvacManager ${ts()}] _ensureCompiledModule: using cached module`);
      return this.compiledWasmModule;
    }
    const wasmUrl = chrome.runtime.getURL('pvac_rs_bg.wasm');
    const t0 = Date.now();
    logger.debug(`[PvacManager ${ts()}] _ensureCompiledModule: fetching WASM...`);
    const response = await fetch(wasmUrl);
    const fetchMs = Date.now() - t0;
    logger.debug(
      `[PvacManager ${ts()}] _ensureCompiledModule: fetch done in ${fetchMs}ms, compiling...`
    );
    this.compiledWasmModule = await WebAssembly.compileStreaming(response);
    logger.debug(
      `[PvacManager ${ts()}] _ensureCompiledModule: compiled in ${Date.now() - t0}ms (fetch=${fetchMs}ms, compile=${Date.now() - t0 - fetchMs}ms)`
    );
    return this.compiledWasmModule;
  }

  private async _initSingleWorker(seed: Uint8Array, gen: number): Promise<void> {
    this._terminateAllWorkers();

    try {
      const swT0 = Date.now();
      logger.debug(`[PvacManager ${ts()}] _initSingleWorker: starting...`);
      const wasmModule = await this._ensureCompiledModule();
      if (this._initGen !== gen) return;
      logger.debug(
        `[PvacManager ${ts()}] _initSingleWorker: WASM module ready in ${Date.now() - swT0}ms, spawning 2 workers...`
      );

      const pw0 = this._createWorker(0);
      const pw1 = this._createWorker(1);
      this.workers.push(pw0, pw1);

      const seedArr = Array.from(seed);
      const initT0 = Date.now();
      await Promise.all([
        this._poolWorkerCall(0, 'init', {
          wasmModule,
          seed: seedArr,
          workerIdx: 0,
          enableRayon: true,
        }).then(() => {
          pw0.ready = true;
        }),
        this._poolWorkerCall(1, 'init', {
          wasmModule,
          seed: seedArr,
          workerIdx: 1,
          enableRayon: false,
        }).then(() => {
          pw1.ready = true;
        }),
      ]);
      logger.debug(
        `[PvacManager ${ts()}] Workers 0+1 ready in ${Date.now() - initT0}ms (total _initSingleWorker: ${Date.now() - swT0}ms)`
      );
    } catch (e) {
      logger.warn(`[PvacManager ${ts()}] Worker init failed, proofs will run on main thread:`, e);
      this._terminateAllWorkers();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async _initProofWorker(_seed: Uint8Array, gen: number): Promise<void> {
    if (this._initGen !== gen) return;
    try {
      const t0ws = Date.now();
      logger.debug(`[PvacManager ${ts()}] Attempting 0xio Desktop connection...`);
      const wsOk = await this._tryDesktopApp();
      if (this._initGen !== gen) return;
      if (wsOk) {
        logger.debug(
          `[PvacManager ${ts()}] 0xio Desktop connected in ${Date.now() - t0ws}ms - proofs via 0xio Desktop WebSocket`
        );
        return;
      }
      logger.debug(`[PvacManager ${ts()}] 0xio Desktop not running, trying WASM strategies`);
    } catch (e: any) {
      if (this._initGen !== gen) return;
      logger.debug(`[PvacManager ${ts()}] 0xio Desktop not available: ${e.message}`);
    }

    if (this._initGen !== gen) return;
    try {
      const t0off = Date.now();
      logger.debug(`[PvacManager ${ts()}] Attempting offscreen + rayon setup...`);
      await this._ensureOffscreen();
      if (this._initGen !== gen) return;
      logger.debug(
        `[PvacManager ${ts()}] Offscreen ready in ${Date.now() - t0off}ms (rayon=${this.offscreenThreaded})`
      );
      return;
    } catch (e: any) {
      if (this._initGen !== gen) return;
      logger.warn(
        `[PvacManager ${ts()}] Offscreen setup failed (${e.message}), falling back to multi-worker pool`
      );
    }

    if (this._initGen !== gen) return;
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const targetPool = Math.max(5, Math.min(cores + 1, 17));

    const t0 = Date.now();
    logger.debug(`[PvacManager ${ts()}] Pre-warming ${targetPool} workers (cores=${cores})...`);
    try {
      await this._scaleUpWorkers(targetPool, gen);
      if (this._initGen !== gen) return;
      logger.debug(
        `[PvacManager ${ts()}] ${this.workers.length} workers ready in ${Date.now() - t0}ms`
      );
      void this._prewarmPoolGenerators(gen);
    } catch (e: any) {
      logger.warn(
        `[PvacManager ${ts()}] Worker pool pre-warm failed, cleaning up dead workers: ${e.message}`
      );
      this._terminateAllWorkers();
    }
  }

  private static readonly PREWARM_WORKERS = 3;

  private async _prewarmPoolGenerators(gen: number): Promise<void> {
    await Promise.allSettled([...this._decryptInflight.values()]);
    if (this._initGen !== gen) return;
    const ready = this.workers.filter((w) => w.ready);
    const picks = (ready.length > 2 ? ready.slice(2) : ready).slice(0, PvacManager.PREWARM_WORKERS);
    const t0 = Date.now();
    await Promise.allSettled(
      picks.map(async (pw) => {
        const idx = this.workers.indexOf(pw);
        if (idx < 0) return;
        if (await this._poolWorkerCall(idx, 'prewarmGenerators', {})) pw.warm = true;
      })
    );
    if (this._initGen !== gen) return;
    logger.debug(
      `[PvacManager ${ts()}] Generator tables ready on ${picks.filter((w) => w.warm).length} workers in ${Date.now() - t0}ms`
    );
  }

  private _createWorker(idx: number): PoolWorker {
    const workerUrl = chrome.runtime.getURL('pvac-worker.js');
    const worker = new Worker(workerUrl, { type: 'module' });
    const pw: PoolWorker = { worker, callbacks: new Map(), lastTimeoutAt: 0, ready: false };

    worker.onmessage = (e: MessageEvent) => {
      const { id, result, error, progress, log } = e.data;
      if (log) {
        logger.debug(log);
        return;
      }
      const cb = pw.callbacks.get(id);
      if (!cb) return;
      if (progress) {
        if (cb.onProgress) cb.onProgress(progress.current, progress.total);
        return;
      }
      pw.callbacks.delete(id);
      if (error) cb.reject(new Error(error));
      else cb.resolve(result);
    };

    worker.onerror = (e: ErrorEvent) => {
      logger.error(`[PvacManager ${ts()}] Worker ${idx} error:`, e.message);
      for (const [, cb] of pw.callbacks) {
        cb.reject(new Error(`Worker ${idx} load error: ${e.message}`));
      }
      pw.callbacks.clear();
    };

    return pw;
  }

  private _terminateAllWorkers(): void {
    for (const pw of this.workers) {
      pw.worker.terminate();
      pw.callbacks.clear();
    }
    this.workers = [];
  }

  private async _ensureOffscreen(): Promise<void> {
    if (this.offscreenReady && this.offscreenPort) return;

    if (typeof chrome === 'undefined' || !(chrome as any).offscreen) {
      throw new Error('chrome.offscreen API not available');
    }

    // Create offscreen document directly (don't sendMessage to self - causes "Receiving end does not exist")
    try {
      const existing = await (chrome as any).offscreen.hasDocument?.();
      if (!existing) {
        await (chrome as any).offscreen.createDocument({
          url: chrome.runtime.getURL('pvac-offscreen.html'),
          reasons: ['WORKERS'],
          justification: 'PVAC WASM proof generation requires Web Workers',
        });
      }
    } catch (e: any) {
      if (!e.message?.includes('already exists')) {
        throw new Error(`Offscreen creation failed: ${e.message}`);
      }
    }

    // Wait for module script to register onConnect - port connected before that is lost
    await new Promise<void>((resolve) => {
      const listener = (msg: any) => {
        if (msg?.type === 'PVAC_OFFSCREEN_READY') {
          chrome.runtime.onMessage.removeListener(listener);
          resolve();
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }, 3000);
    });

    const port = chrome.runtime.connect({ name: 'pvac-proof' });
    this.offscreenPort = port;

    port.onMessage.addListener((msg: any) => {
      if (msg.log) {
        logger.debug(msg.log);
        return;
      }
      const cb = this.offscreenCallbacks.get(msg.id);
      if (!cb) return;
      if (msg.progress) {
        if (cb.onProgress) cb.onProgress(msg.progress.current, msg.progress.total);
        return;
      }
      this.offscreenCallbacks.delete(msg.id);
      if (msg.error) cb.reject(new Error(msg.error));
      else cb.resolve(msg.result);
    });

    port.onDisconnect.addListener(() => {
      logger.debug(`[PvacManager ${ts()}] Offscreen port disconnected`);
      this.offscreenPort = null;
      this.offscreenReady = false;
      for (const [id, cb] of this.offscreenCallbacks) {
        cb.reject(new Error('Offscreen port disconnected'));
        this.offscreenCallbacks.delete(id);
      }
    });

    if (!this.walletSeed) throw new Error('No wallet seed for offscreen init');
    const result = await this._offscreenCall('init', {
      seed: Array.from(this.walletSeed),
      numThreads: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 8 : 8,
    });

    this.offscreenReady = result.ready;
    this.offscreenThreaded = result.threaded;
    logger.debug(
      `[PvacManager ${ts()}] Offscreen ready: rayon=${result.threaded}, workers=${result.workerCount}`
    );
    if (!result.threaded) {
      logger.warn(
        `[PvacManager ${ts()}] Offscreen rayon not functional - will use sequential fallback in offscreen`
      );
    }
  }

  private _seedFpFor: Uint8Array | null = null;
  private _seedFp: Promise<string> | null = null;

  /** Fingerprint of the current wallet seed, sent with every offscreen request so the offscreen
   *  workers refuse to serve it from another wallet's key. */
  private _walletSeedFp(): Promise<string> {
    const seed = this.walletSeed;
    if (!seed) return Promise.reject(new Error('No wallet seed for offscreen call'));
    if (this._seedFpFor !== seed || !this._seedFp) {
      this._seedFpFor = seed;
      this._seedFp = pvacSeedFingerprint(seed);
    }
    return this._seedFp;
  }

  private async _offscreenCall(
    method: string,
    args: any,
    onProgress?: (current: number, total: number) => void
  ): Promise<any> {
    const fp = await this._walletSeedFp();
    return new Promise((resolve, reject) => {
      if (!this.offscreenPort) {
        reject(new Error('Offscreen not connected'));
        return;
      }
      const id = ++this.offscreenCallId;

      const timeoutMs = method === 'init' ? 60000 : 1800000;
      const timer = setTimeout(() => {
        this.offscreenCallbacks.delete(id);
        reject(new Error(`Offscreen call ${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      this.offscreenCallbacks.set(id, {
        resolve: (v: any) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
        onProgress,
      });

      this.offscreenPort.postMessage({ id, method, args: { ...args, fp } });
    });
  }

  private _disconnectOffscreen(): void {
    if (this.offscreenPort) {
      this.offscreenPort.disconnect();
      this.offscreenPort = null;
      this.offscreenThreaded = false;
    }
    this.offscreenReady = false;
    for (const [_id, cb] of this.offscreenCallbacks) {
      cb.reject(new Error('Offscreen disconnected'));
    }
    this.offscreenCallbacks.clear();

    // Close the offscreen document to stop orphaned workers. The service worker closes it
    // itself: a runtime message from the worker never reaches its own listener.
    try {
      const offscreen = (chrome as any).offscreen;
      if (typeof document === 'undefined' && offscreen?.closeDocument) {
        offscreen.closeDocument().catch(() => {});
      } else {
        chrome.runtime.sendMessage({ type: 'CLOSE_PVAC_OFFSCREEN' }).catch(() => {});
      }
    } catch {}
  }

  private async _scaleUpWorkers(targetCount: number, gen?: number): Promise<number> {
    if (!this.walletSeed) throw new Error('No wallet seed');
    const current = this.workers.length;
    if (current >= targetCount) return current;

    const wasmModule = await this._ensureCompiledModule();
    if (gen !== undefined && this._initGen !== gen) return this.workers.length;

    const t0 = Date.now();
    const BATCH_SIZE = 3;

    for (let batchStart = current; batchStart < targetCount; batchStart += BATCH_SIZE) {
      if (gen !== undefined && this._initGen !== gen) {
        logger.debug(`[PvacManager ${ts()}] _scaleUpWorkers cancelled (stale gen)`);
        return this.workers.length;
      }

      const batchEnd = Math.min(batchStart + BATCH_SIZE, targetCount);
      const batch: Promise<void>[] = [];

      for (let i = batchStart; i < batchEnd; i++) {
        const pw = this._createWorker(i);
        // Use the ACTUAL array position (push returns the new length), not the loop counter:
        // _initSingleWorker pushes W0/W1 concurrently, so `i` can drift from the real index and
        // send init to the wrong worker. Mark this exact pw ready only when ITS init resolves.
        const idx = this.workers.push(pw) - 1;
        batch.push(
          this._poolWorkerCall(idx, 'init', {
            wasmModule,
            seed: Array.from(this.walletSeed!),
            workerIdx: idx,
            enableRayon: true,
          }).then(() => {
            pw.ready = true;
          })
        );
      }

      await Promise.all(batch);
    }

    logger.debug(
      `[PvacManager ${ts()}] Scaled up to ${this.workers.length} workers in ${Date.now() - t0}ms`
    );
    return this.workers.length;
  }

  private _poolWorkerCall(
    workerIdx: number,
    method: string,
    args: any,
    timeoutMs = 600000,
    onProgress?: (current: number, total: number) => void
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const pw = this.workers[workerIdx];
      if (!pw) {
        reject(new Error(`Worker ${workerIdx} not available`));
        return;
      }
      const id = ++this.workerCallId;
      const start = Date.now();
      const queueDepth = pw.callbacks.size;
      if (queueDepth > 0) {
        logger.warn(
          `[PvacManager ${ts()}] W${workerIdx} #${id} (${method}) queued behind ${queueDepth} pending call(s) - may wait`
        );
      }

      const timer = setTimeout(() => {
        pw.callbacks.delete(id);
        pw.lastTimeoutAt = Date.now();
        logger.warn(
          `[PvacManager ${ts()}] W${workerIdx} #${id} (${method}) timed out after ${timeoutMs / 1000}s - worker still running`
        );
        reject(
          new Error(`Worker ${workerIdx} call ${method} timed out after ${timeoutMs / 1000}s`)
        );
      }, timeoutMs);

      pw.callbacks.set(id, {
        resolve: (v: any) => {
          clearTimeout(timer);
          logger.debug(
            `[PvacManager ${ts()}] Worker ${workerIdx} #${id} (${method}) done in ${((Date.now() - start) / 1000).toFixed(1)}s`
          );
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          logger.error(
            `[PvacManager ${ts()}] Worker ${workerIdx} #${id} (${method}) failed:`,
            e.message
          );
          reject(e);
        },
        onProgress,
      });
      pw.worker.postMessage({ id, method, args });
    });
  }

  private _workerCall(
    method: string,
    args: any,
    timeoutMs = 600000,
    onProgress?: (current: number, total: number) => void,
    preferWarm = false
  ): Promise<any> {
    if (this.workers.length === 0) return Promise.reject(new Error('No workers available'));

    // Only dispatch to workers that have finished init. A freshly-created worker sits in
    // this.workers with 0 pending calls, so the least-busy pick below would route to it and fail
    // "Worker not initialized" - which is exactly what happens on Firefox, where init takes seconds
    // (e.g. verifyRegistration's getPublicKey landing on a half-spun-up W3). Init calls themselves
    // go through _poolWorkerCall directly, not here, so gating this path is safe.
    const readyIdx: number[] = [];
    for (let i = 0; i < this.workers.length; i++) if (this.workers[i].ready) readyIdx.push(i);
    if (readyIdx.length === 0) {
      return Promise.reject(new Error('No initialized workers available yet'));
    }

    // After a timeout, callbacks.size drops to 0 but the worker is still physically
    // running WASM (e.g. mid-decrypt). Treat such workers as having 1 virtual pending
    // call for RUNAWAY_GRACE_MS to avoid routing new calls behind the stalled worker.
    const RUNAWAY_GRACE_MS = 600_000;
    const now = Date.now();
    const effective = (w: PoolWorker) =>
      w.callbacks.size + (now - w.lastTimeoutAt < RUNAWAY_GRACE_MS ? 1 : 0);

    const cold = (w: PoolWorker) => (preferWarm && !w.warm ? 1 : 0);
    let idx = readyIdx[0];
    let minPending = effective(this.workers[idx]);
    for (const i of readyIdx) {
      const p = effective(this.workers[i]);
      if (p < minPending || (p === minPending && cold(this.workers[i]) < cold(this.workers[idx]))) {
        minPending = p;
        idx = i;
      }
    }
    logger.debug(
      `[PvacManager ${ts()}] dispatch ${method} -> W${idx} (effective: ${this.workers.map((w, i) => `W${i}=${effective(w)}`).join(' ')})`
    );
    return this._poolWorkerCall(idx, method, args, timeoutMs, onProgress);
  }

  get initPromise(): Promise<void> | null {
    return this.loading;
  }

  get isReady(): boolean {
    return this.initialized && (this.workers.length > 0 || this.wsAvailable || this.ctx !== null);
  }

  get isFullyReady(): boolean {
    return this.initialized && this.ctx !== null;
  }

  get currentKey(): string | null {
    return this.currentKeyB64;
  }

  async computeAesKat(): Promise<string> {
    if (this.wasmModule) {
      return this.wasmModule.pvac_compute_aes_kat();
    }
    const wasmJsUrl = chrome.runtime.getURL('pvac_rs.js');
    const wasm = (await import(/* @vite-ignore */ wasmJsUrl)) as unknown as PvacWasmModule;
    const wasmUrl = chrome.runtime.getURL('pvac_rs_bg.wasm');
    await wasm.default({ module_or_path: wasmUrl });
    this.wasmModule = wasm;
    return wasm.pvac_compute_aes_kat();
  }

  async encrypt(
    amountRaw: number,
    txHash: string,
    epochId: number,
    purpose = 'deposit'
  ): Promise<{ cipher: string; commitment: string }> {
    await this.ensureMainCtx();

    const seed = await makeSeed(txHash, epochId, purpose);
    const cipherBytes = this.ctx.encrypt_seeded(BigInt(amountRaw), seed);
    const commitBytes = this.ctx.commit(cipherBytes);

    return {
      cipher: 'hfhe_v1|' + bytesToBase64(cipherBytes),
      commitment: bytesToBase64(commitBytes),
    };
  }

  encryptRaw(amountRaw: number): { cipherBytes: Uint8Array; commitmentBytes: Uint8Array } {
    if (!this.ctx) throw new Error('PvacManager not initialized');
    const t0 = Date.now();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const cipherBytes = this.ctx.encrypt_seeded(BigInt(amountRaw), seed);
    const commitmentBytes = this.ctx.commit(cipherBytes);
    logger.debug(
      `[PvacManager ${ts()}] encryptRaw amount=${amountRaw} cipher=${cipherBytes.length}B commit=${commitmentBytes.length}B in ${Date.now() - t0}ms`
    );
    return { cipherBytes, commitmentBytes };
  }

  async encryptAsync(
    amountRaw: number,
    txHash: string,
    epochId: number,
    purpose = 'deposit'
  ): Promise<{ cipher: string; commitment: string }> {
    const t0 = Date.now();
    logger.debug(
      `[PvacManager ${ts()}] encryptAsync amount=${amountRaw} purpose=${purpose} mode=${this.workers.length > 0 ? 'worker' : 'main'}`
    );
    const seed = await makeSeed(txHash, epochId, purpose);
    if (this.workers.length > 0) {
      const result = await this._workerCall(
        'encryptSeeded',
        {
          value: amountRaw.toString(),
          seed: Array.from(seed),
        },
        60000
      );
      const commitHash = new Uint8Array(result.commitmentBytes);
      logger.debug(
        `[PvacManager ${ts()}] encryptAsync done via worker in ${((Date.now() - t0) / 1000).toFixed(1)}s cipher=${result.cipherBytes.length}B`
      );
      return {
        cipher: 'hfhe_v1|' + bytesToBase64(new Uint8Array(result.cipherBytes)),
        commitment: bytesToBase64(commitHash),
      };
    }

    await this.ensureMainCtx();
    const cipherBytes = this.ctx.encrypt_seeded(BigInt(amountRaw), seed);
    const commitBytes = this.ctx.commit(cipherBytes);
    logger.debug(
      `[PvacManager ${ts()}] encryptAsync done via main-thread in ${((Date.now() - t0) / 1000).toFixed(1)}s cipher=${cipherBytes.length}B`
    );
    return {
      cipher: 'hfhe_v1|' + bytesToBase64(cipherBytes),
      commitment: bytesToBase64(commitBytes),
    };
  }

  async encryptRawAsync(
    amountRaw: number
  ): Promise<{ cipherBytes: Uint8Array; commitmentBytes: Uint8Array }> {
    const t0 = Date.now();
    const mode = this.wsAvailable ? '0xioDesktop' : this.workers.length > 0 ? 'worker' : 'main';
    logger.debug(`[PvacManager ${ts()}] encryptRawAsync amount=${amountRaw} mode=${mode}`);

    if (this._hasRemoteEngine) {
      try {
        const result = await this._remoteCall('encrypt', { value: amountRaw }, 30000);
        logger.debug(
          `[PvacManager ${ts()}] encryptRawAsync done via 0xio Desktop in ${result.ms}ms (cipher=${result.cipher_len}B)`
        );
        return {
          cipherBytes: this.getCipherBytes(result.cipher),
          commitmentBytes: base64ToBytes(result.commitment),
        };
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] 0xio Desktop encrypt failed, falling back: ${e.message}`
        );
        this.wsAvailable = false;
      }
    }

    if (this.workers.length > 0) {
      const result = await this._workerCall('encryptRaw', { value: amountRaw.toString() }, 60000);
      logger.debug(
        `[PvacManager ${ts()}] encryptRawAsync done via worker in ${((Date.now() - t0) / 1000).toFixed(1)}s`
      );
      return {
        cipherBytes: new Uint8Array(result.cipherBytes),
        commitmentBytes: new Uint8Array(result.commitmentBytes),
      };
    }

    if (typeof chrome !== 'undefined' && (chrome as any).offscreen) {
      try {
        await this._ensureOffscreen();
        const result = await this._offscreenCall('encryptRaw', { value: amountRaw.toString() });
        logger.debug(
          `[PvacManager ${ts()}] encryptRawAsync done via offscreen in ${((Date.now() - t0) / 1000).toFixed(1)}s`
        );
        return {
          cipherBytes: new Uint8Array(result.cipherBytes),
          commitmentBytes: new Uint8Array(result.commitmentBytes),
        };
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] encryptRawAsync offscreen failed, falling back to main ctx: ${e.message}`
        );
      }
    }

    await this.ensureMainCtx();
    const res = this.encryptRaw(amountRaw);
    logger.debug(
      `[PvacManager ${ts()}] encryptRawAsync done via main-thread in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    return res;
  }

  getCipherBytes(cipherStr: string): Uint8Array {
    let raw = cipherStr;
    if (raw.startsWith('hfhe_v1|')) raw = raw.slice(8);
    return base64ToBytes(raw);
  }

  private _sanitizeDecryptResult(value: number): number {
    if (value < 0 || !Number.isFinite(value)) {
      logger.warn(`[PvacManager ${ts()}] Decrypt sanity check failed: ${value} - returning 0`);
      this.lastDecryptCorrupted = true;
      return 0;
    }
    this.lastDecryptCorrupted = false;
    return value;
  }

  decrypt(cipherStr: string): number {
    if (!this.ctx) throw new Error('PvacManager not initialized');

    let raw = cipherStr;
    if (raw.startsWith('hfhe_v1|')) {
      raw = raw.slice(8);
    }
    const cipherBytes = base64ToBytes(raw);
    const t0 = Date.now();
    logger.debug(
      `[PvacManager ${ts()}] [Decrypt Sync] Starting main-thread decrypt | Cipher: ${cipherBytes.length} bytes`
    );
    let value: number;
    let legacy = false;
    try {
      value = Number(this.ctx.decrypt(cipherBytes));
    } catch (e: any) {
      // Canonical keys rejected the value - retry read-only with the legacy keys (ciphers
      // written by pre-canonical-parity builds used a different H matrix).
      if (typeof this.ctx.decryptLegacy !== 'function') throw e;
      value = Number(this.ctx.decryptLegacy(cipherBytes));
      legacy = true;
      logger.warn(
        `[PvacManager ${ts()}] [Decrypt Sync] canonical keys rejected (${e?.message ?? e}); legacy keys read ${value}`
      );
    }
    logger.debug(
      `[PvacManager ${ts()}] [Decrypt Sync] Result: ${value}${legacy ? ' (legacy)' : ''} | Time: ${Date.now() - t0}ms`
    );
    const sanitized = this._sanitizeDecryptResult(value);
    this.lastDecryptLegacy = legacy && !this.lastDecryptCorrupted;
    return sanitized;
  }

  async decryptAsync(cipherStr: string): Promise<number> {
    const existing = this._decryptInflight.get(cipherStr);
    if (existing) {
      logger.debug(`[PvacManager ${ts()}] decryptAsync dedup - reusing in-flight promise`);
      return existing;
    }

    const promise = this._decryptAsyncInner(cipherStr);
    this._decryptInflight.set(cipherStr, promise);
    try {
      return await promise;
    } finally {
      this._decryptInflight.delete(cipherStr);
    }
  }

  private async _decryptAsyncInner(cipherStr: string): Promise<number> {
    const t0 = Date.now();
    this.lastDecryptLegacy = false;
    let raw = cipherStr;
    if (raw.startsWith('hfhe_v1|')) {
      raw = raw.slice(8);
    }
    const cipherBytes = base64ToBytes(raw);
    const mode = this._hasRemoteEngine
      ? '0xioDesktop'
      : this.workers.length > 0
        ? 'Worker'
        : 'Main';
    logger.debug(
      `[PvacManager ${ts()}] [Decrypt Async] Starting | Length: ${cipherBytes.length} bytes | Mode: ${mode}`
    );

    if (this._hasRemoteEngine) {
      try {
        const result = await this._remoteCall(
          'decrypt',
          { cipher: bytesToBase64(cipherBytes) },
          120000
        );
        logger.debug(
          `[PvacManager ${ts()}] [Decrypt Async] Desktop Result: ${result.value}${result.corrupted ? ' (CORRUPTED)' : ''}${result.legacy ? ' (LEGACY)' : ''} | Time: ${result.ms}ms`
        );
        if (result.corrupted) {
          logger.warn(`[PvacManager ${ts()}] Desktop reports cipher corrupted - flagging`);
          this.lastDecryptCorrupted = true;
          return 0;
        }
        const sanitized = this._sanitizeDecryptResult(result.value);
        this.lastDecryptLegacy = result.legacy === true && !this.lastDecryptCorrupted;
        return sanitized;
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] [Decrypt Async] 0xio Desktop failed, falling back to WASM: ${e.message}`
        );
        this.wsAvailable = false;
      }
    }

    if (this.workers.length > 0) {
      const r = await this._workerCall('decrypt', { cipherBytes });
      const { value, legacy } =
        typeof r === 'object' && r !== null ? r : { value: r, legacy: false };
      logger.debug(
        `[PvacManager ${ts()}] [Decrypt Async] Worker Result: ${value}${legacy ? ' (legacy)' : ''} | Time: ${((Date.now() - t0) / 1000).toFixed(1)}s`
      );
      const sanitized = this._sanitizeDecryptResult(value);
      this.lastDecryptLegacy = legacy === true && !this.lastDecryptCorrupted;
      return sanitized;
    }

    if (typeof chrome !== 'undefined' && (chrome as any).offscreen) {
      try {
        await this._ensureOffscreen();
        const r = await this._offscreenCall('decrypt', {
          cipherBytes: Array.from(cipherBytes),
        });
        const { value, legacy } =
          typeof r === 'object' && r !== null ? r : { value: r, legacy: false };
        logger.debug(
          `[PvacManager ${ts()}] [Decrypt Async] Offscreen Result: ${value}${legacy ? ' (legacy)' : ''} | Time: ${((Date.now() - t0) / 1000).toFixed(1)}s`
        );
        const sanitized = this._sanitizeDecryptResult(value);
        this.lastDecryptLegacy = legacy === true && !this.lastDecryptCorrupted;
        return sanitized;
      } catch (e: any) {
        logger.warn(`[PvacManager ${ts()}] [Decrypt Async] Offscreen decrypt failed: ${e.message}`);
      }
    }

    // No worker or remote engine available - refuse to run on main thread
    // (sync WASM decrypt takes 20-60s, freezing the entire UI and blocking LCP).
    // Caller catches this and shows public balance only.
    logger.warn(
      `[PvacManager ${ts()}] [Decrypt Async] No worker/remote engine - skipping decrypt to avoid UI freeze`
    );
    throw new Error('No worker or remote engine available for decrypt');
  }

  commit(cipherStr: string): string {
    if (!this.ctx) throw new Error('PvacManager not initialized');

    let raw = cipherStr;
    if (raw.startsWith('hfhe_v1|')) {
      raw = raw.slice(8);
    }
    const cipherBytes = base64ToBytes(raw);
    const commitBytes = this.ctx.commit(cipherBytes);
    return bytesToBase64(commitBytes);
  }

  ctAdd(cipherA: string, cipherB: string): string {
    if (!this.ctx) throw new Error('PvacManager not initialized');

    const a = base64ToBytes(cipherA.startsWith('hfhe_v1|') ? cipherA.slice(8) : cipherA);
    const b = base64ToBytes(cipherB.startsWith('hfhe_v1|') ? cipherB.slice(8) : cipherB);
    const result = this.ctx.ct_add(a, b);
    return 'hfhe_v1|' + bytesToBase64(result);
  }

  ctSub(cipherA: string, cipherB: string): string {
    if (!this.ctx) throw new Error('PvacManager not initialized');
    const t0 = Date.now();
    const a = base64ToBytes(cipherA.startsWith('hfhe_v1|') ? cipherA.slice(8) : cipherA);
    const b = base64ToBytes(cipherB.startsWith('hfhe_v1|') ? cipherB.slice(8) : cipherB);
    const result = this.ctx.ct_sub(a, b);
    logger.debug(
      `[PvacManager ${ts()}] ctSub ${a.length}B - ${b.length}B = ${result.length}B in ${Date.now() - t0}ms`
    );
    return 'hfhe_v1|' + bytesToBase64(result);
  }

  async makeRangeProof(
    cipherBytes: Uint8Array,
    value: number,
    onProgress?: (current: number, total: number) => void
  ): Promise<string> {
    const t0overall = Date.now();
    this.proofGenerationActive = true;
    try {
      logger.debug(
        `[PvacManager ${ts()}] [Range Proof] [${t0overall}] Starting makeRangeProof | Value: ${value} | Cipher: ${cipherBytes.length} bytes | Remote: ${this._hasRemoteEngine} | Workers: ${this.workers.length}`
      );

      if (this._hasRemoteEngine) {
        const totalCircuitsDesktop = 65;
        const estimatedMs = 60_000;
        const t0desktop = performance.now();
        let desktopProgressTimer: ReturnType<typeof setInterval> | null = null;
        if (onProgress) {
          desktopProgressTimer = setInterval(() => {
            const fraction = Math.min((performance.now() - t0desktop) / estimatedMs, 0.95);
            onProgress(Math.floor(fraction * totalCircuitsDesktop), totalCircuitsDesktop);
          }, 1000);
        }
        try {
          logger.debug(
            `[PvacManager ${ts()}] [Range Proof] [${Date.now()}] Delegating to 0xio Desktop...`
          );
          const result = await this._remoteCall('makeRangeProof', {
            cipher: bytesToBase64(cipherBytes),
            value,
          });
          if (desktopProgressTimer) clearInterval(desktopProgressTimer);
          if (onProgress) onProgress(totalCircuitsDesktop, totalCircuitsDesktop);
          logger.debug(
            `[PvacManager ${ts()}] [Range Proof] [${Date.now()}] Desktop Execution Done | Time: ${result.ms}ms | Proof Length: ${result.proof_len} chars`
          );
          return result.proof;
        } catch (e: any) {
          if (desktopProgressTimer) clearInterval(desktopProgressTimer);
          logger.warn(
            `[PvacManager ${ts()}] 0xio Desktop range proof failed, falling back: ${e.message}`
          );
          this.wsAvailable = false;
        }
      }

      if (!this.offscreenProofFailed) {
        try {
          await this._ensureOffscreen();
          logger.debug(
            `[PvacManager ${ts()}] [Range Proof] Delegating to Offscreen (rayon=${this.offscreenThreaded})...`
          );
          const result = await this._offscreenCall(
            'makeRangeProof',
            { cipherBytes: Array.from(cipherBytes), value: value.toString() },
            onProgress
          );
          logger.debug(
            `[PvacManager ${ts()}] [Range Proof] Offscreen done in ${((Date.now() - t0overall) / 1000).toFixed(1)}s (rayon=${this.offscreenThreaded})`
          );
          return result;
        } catch (e: any) {
          this.offscreenProofFailed = true;
          this._disconnectOffscreen();
          logger.warn(
            `[PvacManager ${ts()}] Offscreen proof failed, skipping offscreen for rest of session:`,
            e.message
          );
        }
      }

      const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
      const targetPool = Math.max(2, cores - 1);

      try {
        if (this.workers.length >= 1 && this.walletSeed) {
          const N = await this._scaleUpWorkers(targetPool);
          const proofWorkers = N - 1;
          if (proofWorkers < 1) throw new Error('Need at least 2 workers for parallel range proof');
          const BITS = 64;
          const bitsPerWorker = Math.ceil(BITS / proofWorkers);
          const chunks: { workerIdx: number; startBit: number; endBit: number }[] = [];
          for (let i = 0; i < proofWorkers; i++) {
            const start = i * bitsPerWorker;
            const end = Math.min(start + bitsPerWorker, BITS);
            if (start >= BITS) break;
            chunks.push({ workerIdx: i + 1, startBit: start, endBit: end });
          }

          logger.debug(
            `[PvacManager ${ts()}] [Range Proof] [${Date.now()}] Distributing ${BITS} bits across ${proofWorkers} workers (${chunks.length} chunks)...`
          );

          const workerProgress = new Map<number, number>();
          let totalCompleted = 0;
          const totalCircuits = 65;

          const batchPromises = chunks.map(({ workerIdx, startBit, endBit }) => {
            return this._poolWorkerCall(
              workerIdx,
              'makeBitProofsBatch',
              { value: value.toString(), startBit, endBit },
              1200000,
              (current: number) => {
                workerProgress.set(workerIdx, current);
                let sum = 0;
                for (const v of workerProgress.values()) sum += v;
                if (sum !== totalCompleted) {
                  totalCompleted = sum;
                  logger.debug(
                    `[PvacManager ${ts()}] [Range Proof] [${Date.now()}] Circuit ${totalCompleted}/${totalCircuits}`
                  );
                  if (onProgress) onProgress(totalCompleted, totalCircuits);
                }
              }
            );
          });

          const batchResults = await Promise.all(batchPromises);
          const batchTime = ((Date.now() - t0overall) / 1000).toFixed(1);
          logger.debug(
            `[PvacManager ${ts()}] [Range Proof] [${Date.now()}] All ${chunks.length} batches completed. Batch Time: ${batchTime}s. Triggering LC assembly...`
          );

          const result = await this._poolWorkerCall(
            1,
            'assembleRangeProof',
            { cipherBytes, batchParts: batchResults },
            600000
          );

          logger.debug(
            `[PvacManager ${ts()}] [Range Proof] [${Date.now()}] Assembly Complete. Total Execution Time: ${((Date.now() - t0overall) / 1000).toFixed(1)}s`
          );
          if (onProgress) onProgress(totalCircuits, totalCircuits);
          return result;
        }
      } catch (e) {
        logger.error(`[PvacManager ${ts()}] Multi-worker range proof failed, falling back:`, e);
      }

      if (this.workers.length >= 1) {
        return this._workerCall(
          'makeRangeProof',
          { cipherBytes, value: value.toString() },
          1800000,
          onProgress
        );
      }

      logger.warn(
        `[PvacManager ${ts()}] [Range Proof] [${Date.now()}] WARNING: Running strictly on MAIN THREAD - UI WILL FREEZE`
      );
      if (!this.ctx || !this.wasmModule) throw new Error('PvacManager not initialized');
      const proofBytes = this.ctx.make_range_proof(cipherBytes, BigInt(value));
      logger.debug(
        `[PvacManager ${ts()}] [Range Proof] [${Date.now()}] Main Thread Execution Done | Time: ${((Date.now() - t0overall) / 1000).toFixed(1)}s`
      );
      return this.wasmModule.pvac_encode_range_proof(proofBytes);
    } finally {
      this.proofGenerationActive = false;
    }
  }

  async makeParallelRangeProofs(
    cipher1: Uint8Array,
    value1: number,
    cipher2: Uint8Array,
    value2: number,
    onProgress?: (current: number, total: number) => void
  ): Promise<[string, string]> {
    this.proofGenerationActive = true;
    try {
      const t0 = Date.now();
      const totalCircuits = 130;
      logger.debug(
        `[PvacManager ${ts()}] [Parallel Range Proofs] [${t0}] Starting | Values: ${value1}, ${value2} | Ciphers: ${cipher1.length}B, ${cipher2.length}B | Remote: ${this._hasRemoteEngine} | Workers: ${this.workers.length}`
      );

      if (this._hasRemoteEngine) {
        const estimatedMsDual = 60_000;
        const t0desktop = performance.now();
        let desktopProgressTimer: ReturnType<typeof setInterval> | null = null;
        if (onProgress) {
          desktopProgressTimer = setInterval(() => {
            const fraction = Math.min((performance.now() - t0desktop) / estimatedMsDual, 0.95);
            onProgress(Math.floor(fraction * totalCircuits), totalCircuits);
          }, 1000);
        }
        try {
          logger.debug(
            `[PvacManager ${ts()}] Delegating dual range proofs to 0xio Desktop (rayon::join)`
          );
          const result = await this._remoteCall('makeParallelRangeProofs', {
            cipher1: bytesToBase64(cipher1),
            value1,
            cipher2: bytesToBase64(cipher2),
            value2: value2.toString(),
          });
          if (desktopProgressTimer) clearInterval(desktopProgressTimer);
          logger.debug(`[PvacManager ${ts()}] Dual proofs via 0xio Desktop in ${result.ms}ms`);
          if (onProgress) onProgress(totalCircuits, totalCircuits);
          return [result.proof1, result.proof2] as [string, string];
        } catch (e: any) {
          if (desktopProgressTimer) clearInterval(desktopProgressTimer);
          logger.warn(
            `[PvacManager ${ts()}] 0xio Desktop dual proofs failed, falling back: ${e.message}`
          );
          this.wsAvailable = false;
        }
      }

      if (!this.offscreenProofFailed) {
        try {
          await this._ensureOffscreen();
          logger.debug(`[PvacManager ${ts()}] Delegating dual range proofs to offscreen + rayon`);
          const result = await this._offscreenCall(
            'makeParallelRangeProofs',
            {
              cipher1: Array.from(cipher1),
              value1: value1.toString(),
              cipher2: Array.from(cipher2),
              value2: value2.toString(),
            },
            onProgress
          );
          logger.debug(
            `[PvacManager ${ts()}] Dual proofs via offscreen in ${((Date.now() - t0) / 1000).toFixed(1)}s`
          );
          return result as [string, string];
        } catch (e: any) {
          this.offscreenProofFailed = true;
          this._disconnectOffscreen();
          logger.warn(
            `[PvacManager ${ts()}] Offscreen dual proofs failed, skipping offscreen for rest of session:`,
            e.message
          );
        }
      }

      const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
      const targetPool = Math.max(3, cores - 1);

      try {
        if (this.workers.length >= 1 && this.walletSeed) {
          const N = await this._scaleUpWorkers(targetPool);
          const proofWorkers = N - 1;
          if (proofWorkers < 2) throw new Error('Need at least 3 workers for parallel dual proofs');
          const half = Math.max(1, Math.floor(proofWorkers / 2));
          logger.debug(
            `[PvacManager ${ts()}] Multi-worker dual proofs: ${half} workers for proof1, ${proofWorkers - half} for proof2 (${proofWorkers} total)`
          );

          const BITS = 64;
          const buildChunks = (numWorkers: number, baseIdx: number) => {
            const bpw = Math.ceil(BITS / numWorkers);
            const chunks: { workerIdx: number; startBit: number; endBit: number }[] = [];
            for (let i = 0; i < numWorkers; i++) {
              const start = i * bpw;
              const end = Math.min(start + bpw, BITS);
              if (start >= BITS) break;
              chunks.push({ workerIdx: baseIdx + i, startBit: start, endBit: end });
            }
            return chunks;
          };

          const chunks1 = buildChunks(half, 1);
          const chunks2 = buildChunks(proofWorkers - half, half + 1);
          logger.debug(
            `[PvacManager ${ts()}] Proof1: ${chunks1.length} chunks (${chunks1.map((c) => `W${c.workerIdx}:${c.endBit - c.startBit}bits`).join(',')})`
          );
          logger.debug(
            `[PvacManager ${ts()}] Proof2: ${chunks2.length} chunks (${chunks2.map((c) => `W${c.workerIdx}:${c.endBit - c.startBit}bits`).join(',')})`
          );

          const wp1 = new Map<number, number>();
          const wp2 = new Map<number, number>();
          let total1 = 0,
            total2 = 0;

          let lastLoggedCombined = 0;
          const makeProgressCb =
            (wp: Map<number, number>, setTotal: (n: number) => void) =>
            (workerIdx: number) =>
            (current: number) => {
              wp.set(workerIdx, current);
              let sum = 0;
              for (const v of wp.values()) sum += v;
              setTotal(sum);
              const combined = total1 + total2;
              if (combined !== lastLoggedCombined) {
                lastLoggedCombined = combined;
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                logger.debug(
                  `[PvacManager ${ts()}] Circuit ${combined}/${totalCircuits} @ ${elapsed}s (proof1: ${total1}/64, proof2: ${total2}/64)`
                );
              }
              if (onProgress) onProgress(combined, totalCircuits);
            };

          const bits1 = chunks1.map(({ workerIdx, startBit, endBit }) =>
            this._poolWorkerCall(
              workerIdx,
              'makeBitProofsBatch',
              { value: value1.toString(), startBit, endBit },
              600000,
              makeProgressCb(wp1, (n) => {
                total1 = n;
              })(workerIdx)
            )
          );
          const bits2 = chunks2.map(({ workerIdx, startBit, endBit }) =>
            this._poolWorkerCall(
              workerIdx,
              'makeBitProofsBatch',
              { value: value2.toString(), startBit, endBit },
              600000,
              makeProgressCb(wp2, (n) => {
                total2 = n;
              })(workerIdx)
            )
          );

          const [batch1, batch2] = await Promise.all([Promise.all(bits1), Promise.all(bits2)]);
          const batchTime = ((Date.now() - t0) / 1000).toFixed(1);
          logger.debug(
            `[PvacManager ${ts()}] All 128 bit proofs done in ${batchTime}s, assembling both LC proofs...`
          );

          const [result1, result2] = await Promise.all([
            this._poolWorkerCall(
              1,
              'assembleRangeProof',
              { cipherBytes: cipher1, batchParts: batch1 },
              600000
            ),
            this._poolWorkerCall(
              half + 1,
              'assembleRangeProof',
              { cipherBytes: cipher2, batchParts: batch2 },
              600000
            ),
          ]);

          logger.debug(
            `[PvacManager ${ts()}] DUAL PROOFS TOTAL: ${((Date.now() - t0) / 1000).toFixed(1)}s (batches=${batchTime}s)`
          );
          if (onProgress) onProgress(totalCircuits, totalCircuits);
          return [result1, result2];
        }
      } catch (e) {
        logger.error(
          `[PvacManager ${ts()}] Multi-worker proofs failed, falling back to sequential:`,
          e
        );
      }

      const r1 = await this.makeRangeProof(cipher1, value1, (c, t) => onProgress?.(c, t + 65));
      const r2 = await this.makeRangeProof(cipher2, value2, (c, t) => onProgress?.(c + 65, t + 65));
      return [r1, r2];
    } finally {
      this.proofGenerationActive = false;
    }
  }

  async makeBoundProof(
    cipherBytes: Uint8Array,
    amount: number,
    blinding: Uint8Array,
    policy: number
  ): Promise<string> {
    logger.debug(
      `[PvacManager ${ts()}] makeBoundProof amount=${amount} remote=${this._hasRemoteEngine} workers=${this.workers.length}`
    );
    if (this._hasRemoteEngine) {
      try {
        const result = await this._remoteProof(
          'makeBoundProof',
          PROOF_KIND.amount,
          { cipher: bytesToBase64(cipherBytes), amount, blinding: bytesToBase64(blinding) },
          policy
        );
        logger.debug(
          `[PvacManager ${ts()}] makeBoundProof via 0xio Desktop in ${result.ms}ms (${result.proof_len} chars)`
        );
        return result.proof;
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] 0xio Desktop bound proof failed, falling back: ${e.message}`
        );
        this.wsAvailable = false;
      }
    }
    // The parallelized prover (pvac-rs wasm-parallel) needs a real rayon host. The popup worker pool
    // (W0) is itself a Web Worker, and its nested rayon sub-worker spawn traps 'unreachable' in
    // wbg_rayon_start_worker (crashes makeBoundRangeProof). The offscreen DOCUMENT hosts rayon
    // reliably (it's where makeRangeProofParallel runs), so send the heavy proof there.
    if (!this.offscreenProofFailed) {
      try {
        await this._ensureOffscreen();
        const t0 = Date.now();
        const result = await this._offscreenCall('makeBoundProof', {
          cipherBytes: Array.from(cipherBytes),
          amount: amount.toString(),
          blinding: Array.from(blinding),
          policy,
        });
        logger.debug(
          `[PvacManager ${ts()}] makeBoundProof via offscreen rayon in ${((Date.now() - t0) / 1000).toFixed(1)}s (rayon=${this.offscreenThreaded})`
        );
        return result;
      } catch (e: any) {
        this.offscreenProofFailed = true;
        this._disconnectOffscreen();
        logger.warn(
          `[PvacManager ${ts()}] Offscreen bound proof failed, using worker pool: ${e.message}`
        );
      }
    }
    if (this.workers.length > 0) {
      return this._workerCall(
        'makeBoundProof',
        {
          cipherBytes,
          amount: amount.toString(),
          blinding,
          policy,
        },
        600000,
        undefined,
        true
      );
    }
    logger.warn(`[PvacManager ${ts()}] Running bound proof on MAIN THREAD (will freeze UI)`);
    if (!this.ctx || !this.wasmModule) throw new Error('PvacManager not initialized');
    const proofBytes = this.ctx.proveAmount(
      OWN_KEY,
      cipherBytes,
      BigInt(amount),
      blinding,
      PROOF_KIND.amount,
      policy
    );
    return this.wasmModule.pvac_encode_zero_proof(proofBytes);
  }

  async makeKeySwitchProof(
    cipherBytes: Uint8Array,
    amount: number,
    blinding: Uint8Array,
    policy: number
  ): Promise<string> {
    logger.debug(
      `[PvacManager ${ts()}] makeKeySwitchProof amount=${amount} remote=${this._hasRemoteEngine} workers=${this.workers.length}`
    );
    if (this._hasRemoteEngine) {
      try {
        const result = await this._remoteProof(
          'makeBoundKeySwitchProof',
          PROOF_KIND.refresh,
          { cipher: bytesToBase64(cipherBytes), amount, blinding: bytesToBase64(blinding) },
          policy
        );
        logger.debug(
          `[PvacManager ${ts()}] makeKeySwitchProof via 0xio Desktop in ${result.ms}ms (${result.proof_len} chars)`
        );
        return result.proof;
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] 0xio Desktop key-switch proof failed, falling back: ${e.message}`
        );
        this.wsAvailable = false;
      }
    }
    if (!this.offscreenProofFailed) {
      try {
        await this._ensureOffscreen();
        const t0 = Date.now();
        const result = await this._offscreenCall('makeBoundKeySwitchProof', {
          cipherBytes: Array.from(cipherBytes),
          amount: amount.toString(),
          blinding: Array.from(blinding),
          policy,
        });
        logger.debug(
          `[PvacManager ${ts()}] makeKeySwitchProof via offscreen rayon in ${((Date.now() - t0) / 1000).toFixed(1)}s (rayon=${this.offscreenThreaded})`
        );
        return result;
      } catch (e: any) {
        this.offscreenProofFailed = true;
        this._disconnectOffscreen();
        logger.warn(
          `[PvacManager ${ts()}] Offscreen key-switch proof failed, using worker pool: ${e.message}`
        );
      }
    }
    if (this.workers.length > 0) {
      return this._workerCall(
        'makeBoundKeySwitchProof',
        {
          cipherBytes,
          amount: amount.toString(),
          blinding,
          policy,
        },
        600000,
        undefined,
        true
      );
    }
    logger.warn(`[PvacManager ${ts()}] Running key-switch proof on MAIN THREAD (will freeze UI)`);
    if (!this.ctx || !this.wasmModule) throw new Error('PvacManager not initialized');
    const proofBytes = this.ctx.proveAmount(
      OWN_KEY,
      cipherBytes,
      BigInt(amount),
      blinding,
      PROOF_KIND.refresh,
      policy
    );
    return this.wasmModule.pvac_encode_zero_proof(proofBytes);
  }

  /**
   * Build the v3 bound-migration payload (webcli key_bound_migration) and SELF-VERIFY both proofs,
   * in one worker round-trip. `ok` means both the new bound proof and the old bound-key-switch proof
   * (under the OLD registered pubkey) verify against the shared commitment - the pre-submit sanity
   * gate. Nothing is broadcast here. Worker-only (the heavy old_zp must not freeze the popup).
   */
  async buildKeyBoundMigration(
    oldCipherBytes: Uint8Array,
    amount: number,
    oldPubkeyBytes: Uint8Array,
    policy: number
  ): Promise<{
    ok: boolean;
    newValid: boolean;
    oldValid: boolean;
    new_cipher: string;
    new_zero_proof: string;
    old_zero_proof: string;
    amount_commitment: string;
  }> {
    const blinding = crypto.getRandomValues(new Uint8Array(32));
    logger.info(
      `[PvacManager ${ts()}] buildKeyBoundMigration amount=${amount} oldCipher=${oldCipherBytes.length}B remote=${this._hasRemoteEngine}`
    );
    if (this._hasRemoteEngine) {
      try {
        const t0 = Date.now();
        const enc = await this._remoteCall('encrypt', { value: amount }, 60000);
        const newCipherStr: string = enc.cipher.startsWith('hfhe_v1|')
          ? enc.cipher
          : 'hfhe_v1|' + enc.cipher;
        const newCipherB64 = newCipherStr.slice(8);
        const commit = await this._remoteCall(
          'pedersenCommit',
          { amount, blinding: bytesToBase64(blinding) },
          30000
        );
        const newZp = await this._remoteProof(
          'makeBoundProof',
          PROOF_KIND.amount,
          { cipher: newCipherB64, amount, blinding: bytesToBase64(blinding) },
          policy,
          600000
        );
        const oldZp = await this._remoteProof(
          'makeBoundKeySwitchProofWithPubkey',
          PROOF_KIND.refresh,
          {
            pubkey: bytesToBase64(oldPubkeyBytes),
            cipher: bytesToBase64(oldCipherBytes),
            amount,
            blinding: bytesToBase64(blinding),
          },
          policy,
          600000
        );
        const newOk = await this._remoteProof(
          'verifyBoundProof',
          PROOF_KIND.amount,
          { cipher: newCipherB64, proof: newZp.proof, commitment: commit.commitment },
          policy,
          120000
        );
        const oldOk = await this._remoteProof(
          'verifyBoundKeySwitchProofWithPubkey',
          PROOF_KIND.refresh,
          {
            pubkey: bytesToBase64(oldPubkeyBytes),
            cipher: bytesToBase64(oldCipherBytes),
            proof: oldZp.proof,
            commitment: commit.commitment,
          },
          policy,
          120000
        );
        const newValid = newOk.valid === true;
        const oldValid = oldOk.valid === true;
        logger.info(
          `[PvacManager ${ts()}] buildKeyBoundMigration via 0xio Desktop in ${((Date.now() - t0) / 1000).toFixed(1)}s (new=${newValid}, old=${oldValid})`
        );
        return {
          ok: newValid && oldValid,
          newValid,
          oldValid,
          new_cipher: newCipherStr,
          new_zero_proof: newZp.proof,
          old_zero_proof: oldZp.proof,
          amount_commitment: commit.commitment,
        };
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] 0xio Desktop migration build failed, falling back to WASM: ${e.message}`
        );
        this.wsAvailable = false;
      }
    }
    if (this.workers.length === 0) {
      throw new Error('Migration proofs need the worker pool - reload the extension and try again');
    }
    const r = await this._workerCall(
      'buildKeyBoundMigration',
      {
        oldCipherBytes: Array.from(oldCipherBytes),
        amount: amount.toString(),
        blinding: Array.from(blinding),
        oldPubkey: Array.from(oldPubkeyBytes),
        policy,
      },
      600000
    );
    return {
      ok: r.ok,
      newValid: r.newValid,
      oldValid: r.oldValid,
      new_cipher: 'hfhe_v1|' + bytesToBase64(new Uint8Array(r.newCipherBytes)),
      new_zero_proof: r.newZeroProof,
      old_zero_proof: r.oldZeroProof,
      amount_commitment: bytesToBase64(new Uint8Array(r.commitmentBytes)),
    };
  }

  /** Key-bound range proof (webcli make_bound_range_proof): blinding drawn inside the engine,
   *  amount commitment self-carried in the proof. Returns the rp_v1| encoded string. */
  async makeBoundRangeProof(
    cipherBytes: Uint8Array,
    value: number,
    policy: number
  ): Promise<string> {
    logger.debug(
      `[PvacManager ${ts()}] makeBoundRangeProof value=${value} remote=${this._hasRemoteEngine} workers=${this.workers.length}`
    );
    if (this._hasRemoteEngine) {
      try {
        const cipher = bytesToBase64(cipherBytes);
        const result =
          policy === PROOF_WIDE
            ? await this._remoteCall('makeBoundRangeProof', { cipher, value, policy })
            : await this._remoteCall('proveAmount', {
                cipher,
                amount: value,
                blinding: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
                kind: PROOF_KIND.range,
                policy,
              });
        logger.debug(
          `[PvacManager ${ts()}] makeBoundRangeProof via 0xio Desktop in ${result.ms}ms (${result.proof_len} chars)`
        );
        return result.proof;
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] 0xio Desktop bound range proof failed, falling back: ${e.message}`
        );
        this.wsAvailable = false;
      }
    }
    if (!this.offscreenProofFailed) {
      try {
        await this._ensureOffscreen();
        const t0 = Date.now();
        const result = await this._offscreenCall('makeBoundRangeProof', {
          cipherBytes: Array.from(cipherBytes),
          value: value.toString(),
          policy,
        });
        logger.debug(
          `[PvacManager ${ts()}] makeBoundRangeProof via offscreen rayon in ${((Date.now() - t0) / 1000).toFixed(1)}s (rayon=${this.offscreenThreaded})`
        );
        return result;
      } catch (e: any) {
        this.offscreenProofFailed = true;
        this._disconnectOffscreen();
        logger.warn(
          `[PvacManager ${ts()}] Offscreen bound range proof failed, using worker pool: ${e.message}`
        );
      }
    }
    if (this.workers.length > 0) {
      return this._workerCall(
        'makeBoundRangeProof',
        {
          cipherBytes,
          value: value.toString(),
          policy,
        },
        600000,
        undefined,
        true
      );
    }
    logger.warn(`[PvacManager ${ts()}] Running bound range proof on MAIN THREAD (will freeze UI)`);
    if (!this.ctx || !this.wasmModule) throw new Error('PvacManager not initialized');
    const proofBytes = this.ctx.proveAmount(
      OWN_KEY,
      cipherBytes,
      BigInt(value),
      crypto.getRandomValues(new Uint8Array(32)),
      PROOF_KIND.range,
      policy
    );
    return this.wasmModule.pvac_encode_range_proof(proofBytes);
  }

  async makeKeyOwnerProof(address: string, policy: number): Promise<KeyOwnerProof> {
    return this._policyJob<KeyOwnerProof>(
      'makeKeyOwnerProof',
      { address, policy },
      { address, policy },
      () => JSON.parse(this.ctx!.makeKeyOwnerProof(address, policy))
    );
  }

  async buildCipherProofMigration(
    oldPubkeyBytes: Uint8Array,
    source: string,
    amount: number,
    policy: number
  ): Promise<CipherProofMigration> {
    const m = await this._policyJob<CipherProofMigration>(
      'buildCipherProofMigration',
      { pubkey: bytesToBase64(oldPubkeyBytes), source, amount, policy },
      { oldPubkey: Array.from(oldPubkeyBytes), source, amount: amount.toString(), policy },
      () =>
        JSON.parse(
          this.ctx!.buildCipherProofMigration(oldPubkeyBytes, source, BigInt(amount), policy)
        )
    );
    if (m.migration_mode !== 'cipher_proof') throw new Error('Cipher proof migration failed');
    return m;
  }

  private async _policyJob<T>(
    method: string,
    remoteArgs: Record<string, any>,
    localArgs: Record<string, any>,
    onMain: () => T
  ): Promise<T> {
    if (this._hasRemoteEngine) {
      try {
        const { ms: _ms, ...result } = await this._remoteCall(method, remoteArgs, 600000);
        return result as T;
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] 0xio Desktop ${method} failed, falling back: ${e.message}`
        );
        this.wsAvailable = false;
      }
    }
    if (!this.offscreenProofFailed) {
      try {
        await this._ensureOffscreen();
        return await this._offscreenCall(method, localArgs);
      } catch (e: any) {
        this.offscreenProofFailed = true;
        this._disconnectOffscreen();
        logger.warn(
          `[PvacManager ${ts()}] Offscreen ${method} failed, using worker pool: ${e.message}`
        );
      }
    }
    if (this.workers.length > 0)
      return this._workerCall(method, localArgs, 600000, undefined, true);
    await this.ensureMainCtx();
    return onMain();
  }

  /** webcli pvac_pubkey_matches_secret_profile: was this serialized pubkey derived from our
   *  secret, regardless of wire/container version. Byte or fingerprint comparison cannot
   *  answer this - the same logical key can serialize differently (registration-era
   *  material/profile vs the current V5 writer output). */
  async matchesSecretProfile(candidateB64: string): Promise<boolean> {
    const candidate = base64ToBytes(candidateB64);
    if (this.workers.length > 0) {
      return this._workerCall('matchesSecretProfile', { candidate });
    }
    if (!this.ctx) throw new Error('PvacManager not initialized');
    return this.ctx.matchesSecretProfile(candidate);
  }

  pedersenCommit(amount: number, blinding: Uint8Array): string {
    if (!this.ctx) throw new Error('PvacManager not initialized');
    const t0 = Date.now();
    const pointBytes = this.ctx.pedersen_commit(BigInt(amount), blinding);
    logger.debug(`[PvacManager ${ts()}] pedersenCommit amount=${amount} in ${Date.now() - t0}ms`);
    return bytesToBase64(pointBytes);
  }

  async pedersenCommitAsync(amount: number, blinding: Uint8Array): Promise<string> {
    const t0 = Date.now();
    logger.debug(
      `[PvacManager ${ts()}] pedersenCommitAsync amount=${amount}, remote=${this._hasRemoteEngine}`
    );
    if (this._hasRemoteEngine) {
      try {
        const result = await this._remoteCall(
          'pedersenCommit',
          {
            amount,
            blinding: bytesToBase64(blinding),
          },
          30000
        );
        logger.debug(
          `[PvacManager ${ts()}] pedersenCommitAsync done via 0xio Desktop in ${result.ms}ms (round-trip ${Date.now() - t0}ms)`
        );
        return result.commitment;
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] 0xio Desktop pedersenCommit failed, falling back: ${e.message}`
        );
        this.wsAvailable = false;
      }
    }
    if (this.workers.length > 0) {
      const result = await this._workerCall(
        'pedersenCommit',
        {
          amount: amount.toString(),
          blinding: Array.from(blinding),
        },
        30000
      );
      return bytesToBase64(new Uint8Array(result));
    }
    if (this.workers.length === 0 && typeof chrome !== 'undefined' && (chrome as any).offscreen) {
      try {
        await this._ensureOffscreen();
        const result = await this._offscreenCall('pedersenCommit', {
          amount: amount.toString(),
          blinding: Array.from(blinding),
        });
        return bytesToBase64(new Uint8Array(result));
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] pedersenCommit offscreen failed, falling back to main ctx: ${e.message}`
        );
      }
    }
    await this.ensureMainCtx();
    return this.pedersenCommit(amount, blinding);
  }

  async pedersenCommitRawAsync(amount: number, blinding: Uint8Array): Promise<Uint8Array> {
    if (this._hasRemoteEngine) {
      try {
        const result = await this._remoteCall(
          'pedersenCommit',
          {
            amount,
            blinding: bytesToBase64(blinding),
          },
          30000
        );
        return base64ToBytes(result.commitment);
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] 0xio Desktop pedersenCommitRaw failed, falling back: ${e.message}`
        );
        this.wsAvailable = false;
      }
    }
    if (this.workers.length > 0) {
      const result = await this._workerCall(
        'pedersenCommit',
        {
          amount: amount.toString(),
          blinding: Array.from(blinding),
        },
        30000
      );
      return new Uint8Array(result);
    }
    if (this.workers.length === 0 && typeof chrome !== 'undefined' && (chrome as any).offscreen) {
      try {
        await this._ensureOffscreen();
        const result = await this._offscreenCall('pedersenCommit', {
          amount: amount.toString(),
          blinding: Array.from(blinding),
        });
        return new Uint8Array(result);
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] pedersenCommitRaw offscreen failed, falling back to main ctx: ${e.message}`
        );
      }
    }
    await this.ensureMainCtx();
    return this.pedersenCommitRaw(amount, blinding);
  }

  getProofBytes(proofStr: string): Uint8Array {
    let raw = proofStr;
    if (raw.startsWith('rp_v1|')) raw = raw.slice(6);
    return base64ToBytes(raw);
  }

  getZeroProofBytes(proofStr: string): Uint8Array {
    let raw = proofStr;
    if (raw.startsWith('zkzp_v2|')) raw = raw.slice(8);
    return base64ToBytes(raw);
  }

  pedersenCommitRaw(amount: number, blinding: Uint8Array): Uint8Array {
    if (!this.ctx) throw new Error('PvacManager not initialized');
    return this.ctx.pedersen_commit(BigInt(amount), blinding);
  }

  encodeCipher(cipherBytes: Uint8Array): string {
    return 'hfhe_v1|' + bytesToBase64(cipherBytes);
  }

  ctSubRaw(cipherA: Uint8Array, cipherB: Uint8Array): Uint8Array {
    if (!this.ctx) throw new Error('PvacManager not initialized');
    const t0 = Date.now();
    const result = this.ctx.ct_sub(cipherA, cipherB);
    logger.debug(
      `[PvacManager ${ts()}] ctSubRaw ${cipherA.length}B - ${cipherB.length}B = ${result.length}B in ${Date.now() - t0}ms`
    );
    return result;
  }

  async ctSubRawAsync(cipherA: Uint8Array, cipherB: Uint8Array): Promise<Uint8Array> {
    const t0 = Date.now();
    logger.debug(
      `[PvacManager ${ts()}] ctSubRawAsync: ${cipherA.length}B - ${cipherB.length}B, remote=${this._hasRemoteEngine}`
    );
    if (this._hasRemoteEngine) {
      try {
        const result = await this._remoteCall(
          'ctSub',
          {
            a: bytesToBase64(cipherA),
            b: bytesToBase64(cipherB),
          },
          30000
        );
        const resultBytes = base64ToBytes(result.result);
        logger.debug(
          `[PvacManager ${ts()}] ctSubRawAsync done via 0xio Desktop: ${resultBytes.length}B in ${result.ms}ms (round-trip ${Date.now() - t0}ms)`
        );
        return resultBytes;
      } catch (e: any) {
        logger.warn(`[PvacManager ${ts()}] 0xio Desktop ctSub failed, falling back: ${e.message}`);
        this.wsAvailable = false;
      }
    }
    if (this.workers.length > 0) {
      const result = await this._workerCall('ctSub', { cipherA, cipherB }, 30000);
      return new Uint8Array(result);
    }
    await this.ensureMainCtx();
    return this.ctSubRaw(cipherA, cipherB);
  }

  async verifyRangeProof(cipherBytes: Uint8Array, proofBytes: Uint8Array): Promise<boolean> {
    logger.debug(
      `[PvacManager ${ts()}] verifyRangeProof cipher=${cipherBytes.length}B proof=${proofBytes.length}B`
    );
    const t0 = Date.now();
    let result: boolean;
    if (this.workers.length > 0) {
      result = await this._workerCall(
        'verifyRangeProof',
        {
          cipherBytes,
          proofBytes,
        },
        120000
      );
    } else {
      await this.ensureMainCtx();
      result = this.ctx!.verify_range_proof(cipherBytes, proofBytes);
    }
    logger.debug(`[PvacManager ${ts()}] verifyRangeProof result=${result} in ${Date.now() - t0}ms`);
    return result;
  }

  async verifyParallelRangeProofs(
    cipher1: Uint8Array,
    proof1: Uint8Array,
    cipher2: Uint8Array,
    proof2: Uint8Array
  ): Promise<[boolean, boolean]> {
    const t0 = Date.now();
    logger.debug(
      `[PvacManager ${ts()}] verifyParallelRangeProofs cipher1=${cipher1.length}B proof1=${proof1.length}B cipher2=${cipher2.length}B proof2=${proof2.length}B`
    );

    if (this.offscreenReady && this.offscreenPort && !this.offscreenProofFailed) {
      try {
        const result = await this._offscreenCall('verifyParallelRangeProofs', {
          cipher1: Array.from(cipher1),
          proof1: Array.from(proof1),
          cipher2: Array.from(cipher2),
          proof2: Array.from(proof2),
        });
        logger.debug(
          `[PvacManager ${ts()}] verifyParallelRangeProofs via offscreen: [${result[0]}, ${result[1]}] in ${((Date.now() - t0) / 1000).toFixed(1)}s`
        );
        return result as [boolean, boolean];
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] Offscreen verification failed, falling back:`,
          e.message
        );
      }
    }

    if (this.workers.length >= 2) {
      const [v1, v2] = await Promise.all([
        this._poolWorkerCall(
          0,
          'verifyRangeProof',
          { cipherBytes: cipher1, proofBytes: proof1 },
          120000
        ),
        this._poolWorkerCall(
          1,
          'verifyRangeProof',
          { cipherBytes: cipher2, proofBytes: proof2 },
          120000
        ),
      ]);
      logger.debug(
        `[PvacManager ${ts()}] verifyParallelRangeProofs via 2 popup workers: [${v1}, ${v2}] in ${((Date.now() - t0) / 1000).toFixed(1)}s`
      );
      return [v1, v2];
    }

    const v1 = await this.verifyRangeProof(cipher1, proof1);
    const v2 = await this.verifyRangeProof(cipher2, proof2);
    return [v1, v2];
  }

  async verifyBoundProof(
    cipherBytes: Uint8Array,
    proofBytes: Uint8Array,
    commitment: Uint8Array,
    policy: number
  ): Promise<boolean> {
    logger.debug(
      `[PvacManager ${ts()}] verifyBoundProof cipher=${cipherBytes.length}B proof=${proofBytes.length}B commit=${commitment.length}B`
    );
    const t0 = Date.now();
    let result: boolean;
    if (this.workers.length > 0) {
      result = await this._workerCall(
        'verifyBoundProof',
        { cipherBytes, proofBytes, commitment, policy },
        120000
      );
    } else {
      await this.ensureMainCtx();
      result = this.ctx!.verifyAmount(
        OWN_KEY,
        cipherBytes,
        proofBytes,
        commitment,
        PROOF_KIND.amount,
        policy
      );
    }
    logger.debug(`[PvacManager ${ts()}] verifyBoundProof result=${result} in ${Date.now() - t0}ms`);
    return result;
  }

  async diagnoseProof(proofBytes: Uint8Array): Promise<string> {
    if (this.workers.length > 0) {
      return this._workerCall('diagnoseProof', { proofBytes }, 30000);
    }
    await this.ensureMainCtx();
    return this.ctx!.diagnose_proof(proofBytes);
  }

  async diagnoseCipher(cipherBytes: Uint8Array): Promise<string> {
    if (this.workers.length > 0) {
      return this._workerCall('diagnoseCipher', { cipherBytes }, 30000);
    }
    await this.ensureMainCtx();
    return this.ctx!.diagnose_cipher(cipherBytes);
  }

  // Count RRule::Base layers in a cipher. webcli's private-spend compact-refresh triggers at >= 4
  // (pvac_upgrade_policy::private_spend_refresh_base_layers). diagnose_cipher emits per-layer is_base.
  async baseLayerCount(cipherBytes: Uint8Array): Promise<number> {
    const diag = await this.diagnoseCipher(cipherBytes);
    const matches = diag.match(/"is_base":true/g);
    return matches ? matches.length : 0;
  }

  // Private-spend readiness (webcli's compact-refresh gate): key-bound-provable?, base-layer count,
  // and canonical R_com. Prefers 0xio Desktop when connected (its native pvac-handler always has the
  // check), else the local WASM binding, and returns null when neither is available (caller then
  // uses the layers-only heuristic). Shares pvac-rs core check_bound_provable with the desktop + app.
  async checkBoundProvable(
    cipherBytes: Uint8Array
  ): Promise<{ provable: boolean; baseLayers: number; canonical: boolean } | null> {
    try {
      if (this._hasRemoteEngine) {
        const r = await this._remoteCall('checkBoundProvable', {
          cipher: bytesToBase64(cipherBytes),
        });
        return {
          provable: !!r.provable,
          baseLayers: Number(r.base_layers) || 0,
          canonical: !!r.canonical_r_com,
        };
      }
      // Workers first: the check is cheap there, and the old main-ctx path lazily built a
      // full WASM context with a ~7s keygen ON THE MAIN THREAD - it froze every input in
      // the popup (6.6s INP) the first time any screen ran the layer check.
      if (this.workers.length > 0) {
        const raw = await this._workerCall('checkBoundProvable', {
          cipherBytes: Array.from(cipherBytes),
        });
        if (raw === null || raw === undefined) return null;
        const parsed = JSON.parse(raw);
        return {
          provable: !!parsed.provable,
          baseLayers: Number(parsed.base_layers) || 0,
          canonical: !!parsed.canonical_r_com,
        };
      }
      await this.ensureMainCtx();
      const ctx = this.ctx as unknown as {
        check_bound_provable?: (c: Uint8Array) => string;
      };
      if (typeof ctx.check_bound_provable !== 'function') return null;
      const parsed = JSON.parse(ctx.check_bound_provable(cipherBytes));
      return {
        provable: !!parsed.provable,
        baseLayers: Number(parsed.base_layers) || 0,
        canonical: !!parsed.canonical_r_com,
      };
    } catch (e) {
      logger.warn(`[PvacManager ${ts()}] checkBoundProvable failed: ${e}`);
      return null;
    }
  }

  getPublicKey(): string {
    if (!this.ctx) throw new Error('PvacManager not initialized');
    return bytesToBase64(this.ctx.serialize_pubkey());
  }

  async getPublicKeyAsync(): Promise<string> {
    if (this._hasRemoteEngine) {
      try {
        const result = await this._remoteCall('serializePubkey', {}, 30000);
        return result.pubkey;
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] 0xio Desktop getPublicKey failed, falling back: ${e.message}`
        );
        this.wsAvailable = false;
      }
    }
    if (this.workers.length > 0) {
      const pkBytes: number[] = await this._workerCall('getPublicKey', {}, 30000);
      return bytesToBase64(new Uint8Array(pkBytes));
    }

    if (typeof chrome !== 'undefined' && (chrome as any).offscreen) {
      try {
        await this._ensureOffscreen();
        const pkBytes: number[] = await this._offscreenCall('getPublicKey', {});
        return bytesToBase64(new Uint8Array(pkBytes));
      } catch (e: any) {
        logger.warn(
          `[PvacManager ${ts()}] getPublicKeyAsync offscreen failed, falling back to main ctx: ${e.message}`
        );
      }
    }

    await this.ensureMainCtx();
    return bytesToBase64(this.ctx!.serialize_pubkey());
  }

  async verifyRegistration(
    address: string,
    privateKey: string,
    publicKey: string | undefined,
    privacyNetworkService: any,
    allowRegister = false,
    networkId?: NetworkId,
    registerFeeRaw?: string
  ): Promise<boolean> {
    const t0 = Date.now();
    const active = await storedNetworkId();
    if (networkId && networkId !== active) throw new TxScopeError(NETWORK_MOVED);
    const net = networkId ?? active;
    const regKey = `${net}:${address}`;
    // The answer is for `net` only: a switch mid-check must not apply it to the other network.
    const assertStillOn = async () => {
      if ((await storedNetworkId()) !== net) throw new TxScopeError(NETWORK_MOVED);
    };
    const cached = this.pvacRegistrationCache.get(regKey);
    const now = Date.now();

    if (cached?.verified && now - cached.timestamp < this.PVAC_CACHE_TTL) {
      const ageMs = now - cached.timestamp;
      const remainMs = this.PVAC_CACHE_TTL - ageMs;
      const remainMin = (remainMs / 60_000).toFixed(1);
      const expiresAt = new Date(cached.timestamp + this.PVAC_CACHE_TTL).toLocaleTimeString();
      logger.debug(
        `[PvacManager ${ts()}] [RegCache] HIT for ${address.slice(0, 8)}... - age=${Math.round(ageMs / 1000)}s, ${remainMin}min remaining (expires ${expiresAt})`
      );
      return true;
    }

    const inFlight = this.pvacVerificationInFlight.get(regKey);
    if (inFlight) {
      logger.debug(
        `[PvacManager ${ts()}] PVAC verification IN-FLIGHT for ${address.slice(0, 8)}... - waiting for existing call...`
      );
      try {
        const result = await inFlight;
        logger.debug(
          `[PvacManager ${ts()}] PVAC verification IN-FLIGHT completed for ${address.slice(0, 8)}... in ${Date.now() - t0}ms (result: ${result})`
        );
        return result;
      } catch (_error) {
        logger.warn(
          `[PvacManager ${ts()}] PVAC verification IN-FLIGHT failed for ${address.slice(0, 8)}..., will retry`
        );
      }
    }

    const missReason = cached
      ? `STALE (age=${Math.round((now - cached.timestamp) / 1000)}s, TTL=${this.PVAC_CACHE_TTL / 1000}s)`
      : 'FIRST-TIME (no cache entry)';
    logger.debug(
      `[PvacManager ${ts()}] [RegCache] MISS for ${address.slice(0, 8)}... - ${missReason} - running full verification`
    );

    const verificationPromise = (async () => {
      try {
        // Wait for any in-flight init to complete (prevents StrictMode race where
        // a re-init produces a different PVAC context than the one that registered)
        if (this.initPromise) {
          logger.debug(`[PvacManager ${ts()}] verifyRegistration waiting for init to settle...`);
          const initWaitT0 = Date.now();
          await this.initPromise;
          logger.debug(
            `[PvacManager ${ts()}] verifyRegistration init settled in ${Date.now() - initWaitT0}ms (workers=${this.workers.length}, pending=${this.workers.map((w, i) => `W${i}=${w.callbacks.size}`).join(' ')})`
          );
        }

        const localPubT0 = Date.now();
        logger.debug(
          `[PvacManager ${ts()}] verifyRegistration calling getPublicKey (workers=${this.workers.length}, pending=${this.workers.map((w, i) => `W${i}=${w.callbacks.size}`).join(' ')})`
        );
        const localPub = await this.getPublicKeyAsync();
        const localPubTime = Date.now() - localPubT0;
        logger.debug(
          `[PvacManager ${ts()}] getPublicKey done in ${localPubTime}ms for ${address.slice(0, 8)}...`
        );

        const remotePubT0 = Date.now();
        const scope = await captureTxScope(address, net);
        let remotePub: string | null;
        try {
          remotePub = await privacyNetworkService.getPvacPubkey(address, scope);
        } catch {
          // Node unreachable (e.g. proxy 503). Don't misread as "no key on-chain" and register
          // a duplicate - fail soft so the caller shows a network hint, not "registration failed".
          throw new Error('Network busy, could not verify encryption key. Please try again.');
        }
        const remotePubTime = Date.now() - remotePubT0;
        logger.debug(
          `[PvacManager ${ts()}] RPC getPvacPubkey done in ${remotePubTime}ms - match: ${remotePub === localPub}`
        );

        await assertStillOn();
        if (remotePub !== localPub) {
          if (remotePub !== null) {
            this.pvacForeign = true;
            logger.warn(
              `[PvacManager ${ts()}] PVAC key MISMATCH for ${address.slice(0, 8)}... - key switch required`
            );
          } else {
            // No remote key on-chain. The node requires the pubkey to be registered via a canonical
            // key_switch tx (the bare octra_registerPvacPubkey RPC is rejected). Only a user-initiated
            // privacy op registers - a passive/background check must never spend the key_switch fee.
            if (!allowRegister) {
              logger.debug(
                `[PvacManager ${ts()}] No PVAC key on-chain for ${address.slice(0, 8)}... - check-only, not registering`
              );
              return false;
            }
            // A submitted registration is pending until it confirms - don't submit (and pay) twice.
            if (await getPendingKeySwitch(scope)) {
              const pendingErr = new Error(
                'Private balance setup is pending confirmation. Try again in a moment.'
              );
              pendingErr.name = 'PvacSetupPending';
              throw pendingErr;
            }
            logger.debug(
              `[PvacManager ${ts()}] No PVAC key on-chain - submitting key_switch registration for ${address.slice(0, 8)}...`
            );
            const txId = await privacyNetworkService.registerPvacViaKeySwitch(
              address,
              localPub,
              privateKey,
              publicKey,
              undefined,
              'recommended',
              registerFeeRaw,
              scope
            );
            await recordPendingKeySwitch(scope, txId);
            logger.debug(`[PvacManager ${ts()}] PVAC key_switch registration submitted (${txId})`);
            // The key isn't applied until the tx confirms; stop here so the caller doesn't run a
            // privacy op against an unregistered key (the node would reject it).
            const setupErr = new Error(
              'Setting up private balance. This takes a moment - try again shortly.'
            );
            setupErr.name = 'PvacSetupPending';
            throw setupErr;
          }
        } else {
          if (!this.lastDecryptCorrupted) {
            this.pvacForeign = false;
          } else {
            logger.warn(
              `[PvacManager ${ts()}] Keys match but cipher corrupted for ${address.slice(0, 8)}... - keeping pvacForeign`
            );
          }
        }

        const expiresAt = new Date(now + this.PVAC_CACHE_TTL).toLocaleTimeString();
        await assertStillOn();
        this.pvacRegistrationCache.set(regKey, {
          verified: true,
          timestamp: now,
        });

        const totalTime = Date.now() - t0;
        logger.debug(
          `[PvacManager ${ts()}] [RegCache] SAVED for ${address.slice(0, 8)}... - verified in ${totalTime}ms, cached until ${expiresAt} (TTL=${this.PVAC_CACHE_TTL / 60_000}min, total entries=${this.pvacRegistrationCache.size})`
        );
        return true;
      } catch (error) {
        const totalTime = Date.now() - t0;
        const name = error instanceof Error ? error.name : '';
        if (name === 'PvacSetupPending' || name === 'PvacForeign') {
          logger.debug(
            `[PvacManager ${ts()}] PVAC ${name === 'PvacSetupPending' ? 'registration submitted - pending on-chain confirmation' : 'key needs attention'} for ${address.slice(0, 8)}... (${totalTime}ms)`
          );
        } else {
          logger.error(
            `[PvacManager ${ts()}] PVAC verification FAILED for ${address.slice(0, 8)}... after ${totalTime}ms:`,
            error
          );
        }
        throw error;
      } finally {
        this.pvacVerificationInFlight.delete(regKey);
      }
    })();

    this.pvacVerificationInFlight.set(regKey, verificationPromise);

    return verificationPromise;
  }

  clearRegistrationCache(address?: string): void {
    if (address) {
      const mine = (k: string) => k.endsWith(`:${address}`);
      const had = [...this.pvacRegistrationCache.keys()].some(mine);
      for (const k of [...this.pvacRegistrationCache.keys()]) {
        if (mine(k)) this.pvacRegistrationCache.delete(k);
      }
      for (const k of [...this.pvacVerificationInFlight.keys()]) {
        if (mine(k)) this.pvacVerificationInFlight.delete(k);
      }
      logger.debug(
        `[PvacManager ${ts()}] Cleared PVAC cache for ${address.slice(0, 8)}... (existed: ${had})`
      );
    } else {
      const count = this.pvacRegistrationCache.size;
      const inFlightCount = this.pvacVerificationInFlight.size;
      this.pvacRegistrationCache.clear();
      this.pvacVerificationInFlight.clear();
      this.pvacForeign = false;
      logger.debug(
        `[PvacManager ${ts()}] Cleared ALL PVAC cache (${count} entries, ${inFlightCount} in-flight)`
      );
    }
  }

  destroy(): void {
    this._initGen++;
    if (this.ctx) {
      this.ctx.free();
      this.ctx = null;
    }
    for (const pw of this.workers) {
      pw.worker.terminate();
      pw.callbacks.clear();
    }
    this.workers = [];
    this._disconnectWs();
    this._disconnectOffscreen();
    const wakeInit = this._desktopReadyResolve;
    this._desktopReadyResolve = null;
    wakeInit?.();
    this.offscreenProofFailed = false;
    this.walletSeed = null;
    this._seedFpFor = null;
    this._seedFp = null;
    this.desktopPubkeyFp = null;
    this._desktopKeygenOk = null;
    this.initialized = false;
    this.loading = null;
    this.mainCtxPromise = null;
    this.wasmModule = null;
    this.compiledWasmModule = null;
    this.currentKeyB64 = null;
    this._decryptInflight.clear();
    this.clearRegistrationCache();
  }
}

export const pvacManager = new PvacManager();

// A registration verdict and the foreign-key flag speak for one network: drop both on a switch.
try {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK in changes) {
      pvacManager.clearRegistrationCache();
    }
  });
} catch {}
