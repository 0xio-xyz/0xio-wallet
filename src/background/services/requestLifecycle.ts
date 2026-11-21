// Site requests by origin and request id. Nothing here signs: a repeat joins the request in
// flight or gets its stored answer, so no review runs twice.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { logger } from '../../utils/logger';
import { networkService } from 'src/services/network/NetworkService';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import { resolveNetworkPin, rpcUrlFor, type NetworkPin } from 'src/services/network/txScope';
import type { ReviewHooks } from './approvals';
import { getConnection } from './dappConnections';

export const WALLET_PROTOCOL = 2;
export const RID_PATTERN = /^[0-9a-f]{32}$/;

export const WALLET_CAPABILITIES = [
  'announce',
  'request_id',
  'request_status',
  'request_events',
  'idempotent',
  'wait_confirmed',
  'receipt',
  'can_sign',
  'kind',
] as const;

export function walletHello(version: string) {
  return {
    protocol: WALLET_PROTOCOL,
    kind: 'extension' as const,
    version,
    capabilities: [...WALLET_CAPABILITIES],
  };
}

export const REVIEW_METHODS = new Set([
  'connect',
  'switch_network',
  'send_transaction',
  'sendTransaction',
  'call_contract',
  'callContract',
  'deploy_contract',
  'deployContract',
  'signMessage',
  'sign_transaction',
  'signTransaction',
  'broadcast_only',
  'send_contract_transaction_sequence',
  'register_private_view_key',
  'send_private_transfer',
  'claim_private_transfer',
  'encrypt_balance',
  'decrypt_balance',
]);

const SUBMIT_METHODS = new Set([
  'send_transaction',
  'sendTransaction',
  'call_contract',
  'callContract',
  'deploy_contract',
  'deployContract',
  'broadcast_only',
  'send_contract_transaction_sequence',
  'register_private_view_key',
  'send_private_transfer',
  'claim_private_transfer',
  'encrypt_balance',
  'decrypt_balance',
]);

const RECEIPT_METHODS = new Set([
  'call_contract',
  'callContract',
  'deploy_contract',
  'deployContract',
  'send_contract_transaction_sequence',
]);

export type RequestState =
  | 'pending'
  | 'locked'
  | 'review_open'
  | 'signing'
  | 'submitted'
  | 'confirmed'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'expired';

export const FINAL_STATES: ReadonlySet<string> = new Set([
  'confirmed',
  'completed',
  'failed',
  'rejected',
  'expired',
]);

export const STATE_MOVES: Record<RequestState, readonly RequestState[]> = {
  pending: ['locked', 'review_open', 'submitted', 'completed', 'failed', 'rejected'],
  locked: ['review_open', 'rejected', 'expired', 'failed'],
  review_open: ['signing', 'completed', 'rejected', 'expired', 'failed'],
  signing: ['submitted', 'failed'],
  submitted: ['confirmed', 'failed'],
  confirmed: [],
  completed: [],
  failed: [],
  rejected: [],
  expired: [],
};

export interface ContractReceipt {
  contract?: unknown;
  method?: unknown;
  success?: unknown;
  effort?: unknown;
  events?: unknown;
  error?: unknown;
}

export interface RequestError {
  code: string;
  message: string;
  stage: 'review' | 'submit' | 'execution';
  type?: string;
}

export interface RequestStatus {
  requestId: string;
  status: RequestState | 'unknown';
  method?: string;
  network?: string;
  address?: string;
  hash?: string;
  epoch?: number;
  receipt?: ContractReceipt | null;
  receiptUnavailable?: 'not_contract' | 'refused' | 'error';
  result?: unknown;
  error?: RequestError;
  watching?: boolean;
  seq: number;
  createdAt: number;
  updatedAt: number;
}

interface Frame {
  tabId: number;
  frameId: number;
}

type Reply = { success: boolean; data?: unknown; error?: unknown };

interface LifecycleRecord {
  origin: string;
  rid: string;
  method: string;
  digest: string;
  status: RequestState;
  seq: number;
  createdAt: number;
  updatedAt: number;
  network: string;
  rpcUrl: string;
  address?: string;
  hash?: string;
  hashes?: string[];
  confirmed?: string[];
  opTypes?: string[];
  epoch?: number;
  receipt?: ContractReceipt | null;
  receiptUnavailable?: 'not_contract' | 'refused' | 'error';
  reply?: Reply;
  error?: RequestError;
  watching?: boolean;
  submittedAt?: number;
  checkedAt?: number;
  orphan?: boolean;
  confirmedResult?: unknown;
  frames: Frame[];
}

export const LIFECYCLE_LIMITS = {
  lifeMs: 24 * 60 * 60 * 1000,
  perOrigin: 64,
  openPerOrigin: 8,
  total: 1024,
  replyBytes: 4096,
  framesPerRecord: 4,
  watchTotal: 32,
  watchPerOrigin: 8,
  watchMs: 10 * 60 * 1000,
  fastWatchMs: 60 * 1000,
  fastIntervalMs: 2500,
  slowIntervalMs: 10_000,
  checkCacheMs: 5000,
  statusPerSecond: 2,
  readTimeoutMs: 10_000,
};

const KEY_PREFIX = 'rlc_';
const SCOPE_CODES = new Set(['NETWORK_CHANGED', 'WALLET_CHANGED']);

export interface LifecycleDeps {
  now(): number;
  storage: {
    getAll(): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string[]): Promise<void>;
    onRemoved(listener: (keys: string[]) => void): void;
  };
  deliver(frame: Frame, origin: string, status: RequestStatus): void;
  connection(origin: string): Promise<{ address?: string } | null>;
  network(): Promise<NetworkPin>;
  rpcUrlFor(networkId: string): Promise<string>;
  read(method: string, params: unknown[], pin: NetworkPin): Promise<any>;
  locked(): Promise<boolean>;
  onUnlock(listener: () => void): () => void;
}

const byCodePoint = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
};

/** Byte for byte the SDK's canonical JSON: keys by code point, undefined dropped. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('Request params are nested too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new Error('Request params hold a number that is not finite');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((v) =>
            v === undefined || typeof v === 'function' ? 'null' : canonicalJson(v, depth + 1)
          )
          .join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function')
        .sort(byCodePoint);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], depth + 1)}`).join(',')}}`;
    }
    default:
      throw new Error('Request params are not JSON');
  }
}

export function requestDigest(method: string, params: unknown, network: string | null): string {
  const text = canonicalJson({
    method,
    network: network ?? null,
    params: params === undefined ? {} : params,
  });
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

export function askedNetwork(message: { network?: unknown }): string | null {
  return typeof message.network === 'string' ? message.network : null;
}

export function originOfSender(sender: { origin?: string; url?: string }): string | null {
  const raw = sender.origin || sender.url;
  if (!raw) return null;
  try {
    const origin = new URL(raw).origin;
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

const isFinal = (s: string) => FINAL_STATES.has(s);
const recordKey = (origin: string, rid: string) => `${origin} ${rid}`;
const storageKey = (r: LifecycleRecord) =>
  `${KEY_PREFIX}${r.address || 'none'}_${r.rid}_${r.origin}`;

const sizeOf = (v: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(v) ?? '').length;
  } catch {
    return Infinity;
  }
};

function errorOf(raw: unknown): { code: string; message: string; details?: unknown } {
  if (raw && typeof raw === 'object') {
    const e = raw as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof e.code === 'string' ? e.code : 'UNKNOWN_ERROR',
      message: typeof e.message === 'string' ? e.message : 'Request failed',
      ...(e.details !== undefined ? { details: e.details } : {}),
    };
  }
  return { code: 'UNKNOWN_ERROR', message: typeof raw === 'string' ? raw : 'Request failed' };
}

function hashesOf(data: unknown): string[] {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return [];
  const one = d.txHash ?? d.hash ?? d.tx_hash;
  if (typeof one === 'string' && one) return [one];
  if (Array.isArray(d.tx_hashes)) {
    return d.tx_hashes.filter((h): h is string => typeof h === 'string' && !!h);
  }
  if (Array.isArray(d.results)) {
    return d.results
      .map((r) => (r as { txHash?: unknown } | null)?.txHash)
      .filter((h): h is string => typeof h === 'string' && !!h);
  }
  return [];
}

function withStatus(
  res: Record<string, unknown>,
  rec: { rid: string; status: RequestState }
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...res, rid: rec.rid, status: rec.status };
  if (res.success !== true) {
    const err = errorOf(res.error);
    const details = (err.details && typeof err.details === 'object' ? err.details : {}) as {
      reason?: unknown;
    };
    out.error =
      details.reason === 'review_pending'
        ? { ...err, details }
        : { ...err, details: { ...details, requestId: rec.rid, status: rec.status } };
  }
  return out;
}

type BeginResult =
  | { kind: 'answer'; response: Record<string, unknown> }
  | { kind: 'join'; response: Promise<Record<string, unknown>> }
  | { kind: 'run'; review: RequestReview };

export class RequestReview implements ReviewHooks {
  ended: 'expired' | 'page_gone' | 'cancelled' | null = null;
  gone = false;
  // A broadcast has no review to approve: it runs from arrival and nothing may drop it.
  private running: boolean;
  private closers = new Set<() => void>();
  private settled = false;
  private dropUnlock: (() => void) | null = null;
  private markDone: () => void = () => {};
  readonly done = new Promise<void>((resolve) => (this.markDone = resolve));

  constructor(
    private readonly life: RequestLifecycle,
    readonly origin: string,
    readonly frame: Frame | null,
    readonly method: string,
    readonly key: string | null
  ) {
    this.running = method === 'broadcast_only';
  }

  // A stranger's request reads review_open from the start, so nothing about it moves at unlock.
  private async stranger(): Promise<boolean> {
    return !(await this.life.deps.connection(this.origin).catch((): null => null));
  }

  async locked(): Promise<void> {
    if (!this.key) return;
    await this.life.move(this.key, (await this.stranger()) ? 'review_open' : 'locked');
  }

  async shown(): Promise<void> {
    if (!this.key) return;
    if ((await this.life.deps.locked()) && !(await this.stranger())) {
      await this.life.move(this.key, 'locked');
      this.dropUnlock?.();
      this.dropUnlock = this.life.deps.onUnlock(() => {
        this.dropUnlock?.();
        this.dropUnlock = null;
        void this.life.move(this.key!, 'review_open');
      });
      return;
    }
    await this.life.move(this.key, 'review_open');
  }

  async answered(approved: boolean): Promise<void> {
    this.dropUnlock?.();
    this.dropUnlock = null;
    if (approved) this.running = true;
    if (!this.key || !approved || !SUBMIT_METHODS.has(this.method)) return;
    await this.life.signing(this.key);
  }

  expire(): void {
    if (!this.ended) this.ended = 'expired';
  }

  onPageGone(close: () => void): () => void {
    if (this.gone) {
      queueMicrotask(close);
      return () => {};
    }
    this.closers.add(close);
    return () => this.closers.delete(close);
  }

  pageGone(): void {
    this.close('page_gone');
  }

  close(reason: 'page_gone' | 'cancelled'): boolean {
    if (this.gone || this.settled || this.running) return false;
    this.gone = true;
    if (!this.ended) this.ended = reason;
    for (const close of [...this.closers]) {
      try {
        close();
      } catch {}
    }
    this.closers.clear();
    return true;
  }

  chooser(): ReviewHooks {
    const review = this;
    return {
      get gone() {
        return review.gone;
      },
      shown: () => this.shown(),
      answered: async () => {},
      expire: () => this.expire(),
      onPageGone: (close) => this.onPageGone(close),
    };
  }

  settle(response: unknown): unknown {
    if (this.settled) return response;
    this.settled = true;
    this.dropUnlock?.();
    this.dropUnlock = null;
    this.closers.clear();
    try {
      return this.life.settle(this, response);
    } finally {
      this.markDone();
    }
  }
}

export class RequestLifecycle {
  private records = new Map<string, LifecycleRecord>();
  private waiters = new Map<string, ((r: Record<string, unknown>) => void)[]>();
  private reviews = new Set<RequestReview>();
  private live = new Set<string>();
  private watches = new Map<string, ReturnType<typeof setTimeout> | null>();
  private statusBudget = new Map<string, { at: number; count: number }>();
  private loading: Promise<void> | null = null;
  private storedAs = new Map<string, string>();

  constructor(readonly deps: LifecycleDeps) {}

  private ready(): Promise<void> {
    if (!this.loading) this.loading = this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    let all: Record<string, unknown> = {};
    try {
      all = await this.deps.storage.getAll();
    } catch {}
    const now = this.deps.now();
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      const rec = value as LifecycleRecord;
      if (!rec || typeof rec.rid !== 'string' || typeof rec.origin !== 'string') continue;
      const id = recordKey(rec.origin, rec.rid);
      if (this.records.has(id)) continue;
      rec.frames = Array.isArray(rec.frames) ? rec.frames : [];
      this.records.set(id, rec);
      this.storedAs.set(id, key);
      if (now - rec.updatedAt > LIFECYCLE_LIMITS.lifeMs) continue;
      if (rec.status === 'pending' || rec.status === 'locked' || rec.status === 'review_open') {
        // The review died with the worker; its approval can no longer reach anything.
        this.apply(rec, 'failed', {
          error: {
            code: 'UNKNOWN_ERROR',
            message: 'The wallet restarted before this review was answered.',
            stage: 'review',
          },
        });
      } else if (rec.status === 'signing') {
        rec.orphan = true;
        this.persist(rec);
      } else if (rec.status === 'submitted' && rec.watching) {
        this.watch(id);
      }
    }
    this.purge();
    this.deps.storage.onRemoved((keys) => {
      for (const key of keys) {
        if (!key.startsWith(KEY_PREFIX)) continue;
        for (const [id, stored] of this.storedAs) {
          if (stored === key && !this.live.has(id)) this.forget(id);
        }
      }
    });
  }

  private forget(id: string) {
    const t = this.watches.get(id);
    if (t) clearTimeout(t);
    this.watches.delete(id);
    this.records.delete(id);
    this.storedAs.delete(id);
  }

  private drop(id: string) {
    const key = this.storedAs.get(id);
    this.forget(id);
    if (key) void this.deps.storage.remove([key]).catch(() => {});
  }

  private purge() {
    const now = this.deps.now();
    for (const [id, rec] of this.records) {
      if (this.live.has(id)) continue;
      if (now - rec.updatedAt > LIFECYCLE_LIMITS.lifeMs) this.drop(id);
    }
  }

  private persist(rec: LifecycleRecord): Promise<void> {
    const id = recordKey(rec.origin, rec.rid);
    const key = storageKey(rec);
    const old = this.storedAs.get(id);
    this.storedAs.set(id, key);
    const work = this.deps.storage.set({ [key]: rec }).then(async () => {
      if (old && old !== key) await this.deps.storage.remove([old]);
    });
    return work.catch((e) => logger.warn('[lifecycle] could not store a record', e));
  }

  private openCount(origin: string): number {
    let n = 0;
    for (const rec of this.records.values()) {
      if (rec.origin !== origin || rec.orphan) continue;
      if (['pending', 'locked', 'review_open', 'signing'].includes(rec.status)) n++;
    }
    return n;
  }

  private evictable(rec: LifecycleRecord, id: string): boolean {
    if (this.live.has(id)) return false;
    return isFinal(rec.status) || (rec.status === 'submitted' && !this.watches.has(id));
  }

  private makeRoom(origin: string): boolean {
    const mine = [...this.records].filter(([, r]) => r.origin === origin);
    if (mine.length >= LIFECYCLE_LIMITS.perOrigin) {
      const victim = mine
        .filter(([id, r]) => this.evictable(r, id))
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!victim) return false;
      this.drop(victim[0]);
    }
    if (this.records.size >= LIFECYCLE_LIMITS.total) {
      const byAge = (list: [string, LifecycleRecord][]) =>
        list
          .filter(([id, r]) => this.evictable(r, id))
          .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      const victim =
        byAge([...this.records].filter(([, r]) => r.origin === origin)) ?? byAge([...this.records]);
      if (!victim) return false;
      this.drop(victim[0]);
    }
    return true;
  }

  private takeStatusBudget(origin: string): boolean {
    const now = this.deps.now();
    const b = this.statusBudget.get(origin);
    if (!b || now - b.at >= 1000) {
      this.statusBudget.set(origin, { at: now, count: 1 });
      if (this.statusBudget.size > 512) {
        for (const [o, v] of this.statusBudget) if (now - v.at >= 1000) this.statusBudget.delete(o);
      }
      return true;
    }
    if (b.count >= LIFECYCLE_LIMITS.statusPerSecond) return false;
    b.count++;
    return true;
  }

  async begin(
    message: { method: string; params?: unknown; v?: unknown; rid?: unknown; network?: unknown },
    sender: chrome.runtime.MessageSender
  ): Promise<BeginResult> {
    const origin = originOfSender(sender);
    const frame =
      typeof sender.tab?.id === 'number'
        ? { tabId: sender.tab.id, frameId: sender.frameId ?? 0 }
        : null;
    const withId = message.v === WALLET_PROTOCOL && message.rid !== undefined;
    if (withId && (typeof message.rid !== 'string' || !RID_PATTERN.test(message.rid))) {
      return {
        kind: 'answer',
        response: {
          success: false,
          error: { code: 'INVALID_PARAMS', message: 'rid must be 32 lowercase hex characters.' },
        },
      };
    }
    if (!withId || !origin) {
      const review = new RequestReview(this, origin ?? '', frame, message.method, null);
      this.reviews.add(review);
      return { kind: 'run', review };
    }
    const rid = message.rid as string;
    await this.ready();
    const [pin, conn] = await Promise.all([
      this.deps.network().catch(() => ({ networkId: 'mainnet', rpcUrl: '' })),
      this.deps.connection(origin).catch((): null => null),
    ]);
    this.purge();

    const id = recordKey(origin, rid);
    let digest: string;
    try {
      digest = requestDigest(message.method, message.params, askedNetwork(message));
    } catch (e) {
      return {
        kind: 'answer',
        response: {
          success: false,
          error: { code: 'INVALID_PARAMS', message: (e as Error).message },
          rid,
        },
      };
    }
    let existing = this.records.get(id);
    if (existing && existing.method === 'connect' && existing.status === 'completed' && !conn) {
      // The site disconnected since: a repeat is a new connect with its own review.
      this.drop(id);
      existing = undefined;
    }
    if (existing) {
      if (existing.digest !== digest) {
        return {
          kind: 'answer',
          response: {
            success: false,
            error: {
              code: 'REQUEST_ID_REUSED',
              message: 'This request id belongs to another request. Make a new id.',
            },
            rid,
          },
        };
      }
      if (
        frame &&
        !existing.frames.some((f) => f.tabId === frame.tabId && f.frameId === frame.frameId)
      ) {
        existing.frames = [...existing.frames, frame].slice(-LIFECYCLE_LIMITS.framesPerRecord);
        this.persist(existing);
      }
      if (existing.status === 'submitted' || isFinal(existing.status)) {
        return { kind: 'answer', response: this.replay(existing) };
      }
      if (existing.orphan || !this.live.has(id)) {
        return {
          kind: 'answer',
          response: {
            success: false,
            error: {
              code: 'STATUS_UNKNOWN',
              message: 'The wallet restarted while this request was signing. Check its status.',
            },
            rid,
            status: existing.status,
          },
        };
      }
      return {
        kind: 'join',
        response: new Promise((resolve) => {
          this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
        }),
      };
    }

    if (this.openCount(origin) >= LIFECYCLE_LIMITS.openPerOrigin || !this.makeRoom(origin)) {
      return {
        kind: 'answer',
        response: {
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many open requests from this site. Finish one first.',
          },
          rid,
        },
      };
    }

    const now = this.deps.now();
    const rec: LifecycleRecord = {
      origin,
      rid,
      method: message.method,
      digest,
      status: 'pending',
      seq: 1,
      createdAt: now,
      updatedAt: now,
      network: pin.networkId,
      rpcUrl: pin.rpcUrl,
      ...(conn?.address ? { address: conn.address } : {}),
      frames: frame ? [frame] : [],
    };
    this.records.set(id, rec);
    this.live.add(id);
    this.persist(rec);
    this.emit(rec);
    const review = new RequestReview(this, origin, frame, message.method, id);
    this.reviews.add(review);
    return { kind: 'run', review };
  }

  private replay(rec: LifecycleRecord): Record<string, unknown> {
    if (rec.error && rec.status === 'failed' && rec.error.stage === 'execution') {
      return withStatus(
        { success: false, error: { code: rec.error.code, message: rec.error.message } },
        rec
      );
    }
    if (rec.reply) return withStatus({ ...rec.reply }, rec);
    if (rec.hash) return withStatus({ success: true, data: { txHash: rec.hash } }, rec);
    return withStatus(
      {
        success: false,
        error: { code: rec.error?.code ?? 'UNKNOWN_ERROR', message: rec.error?.message ?? '' },
      },
      rec
    );
  }

  move(
    id: string,
    to: RequestState,
    extra: Partial<LifecycleRecord> = {}
  ): Promise<void> | undefined {
    const rec = this.records.get(id);
    if (!rec) return;
    if (!STATE_MOVES[rec.status].includes(to)) return;
    return this.apply(rec, to, extra);
  }

  private apply(rec: LifecycleRecord, to: RequestState, extra: Partial<LifecycleRecord> = {}) {
    Object.assign(rec, extra);
    rec.status = to;
    rec.seq += 1;
    rec.updatedAt = this.deps.now();
    if (isFinal(to)) delete rec.watching;
    const stored = this.persist(rec);
    this.emit(rec);
    return stored;
  }

  /** Approved: the record notes the wallet and network that will sign before anything is signed. */
  async signing(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec || (rec.status !== 'review_open' && rec.status !== 'locked')) return;
    const [pin, conn] = await Promise.all([
      this.deps.network().catch((): null => null),
      this.deps.connection(rec.origin).catch((): null => null),
    ]);
    if (rec.status === 'locked') this.apply(rec, 'review_open');
    await this.move(id, 'signing', {
      ...(pin ? { network: pin.networkId, rpcUrl: pin.rpcUrl } : {}),
      ...(conn?.address ? { address: conn.address } : {}),
    });
  }

  settle(review: RequestReview, response: unknown): unknown {
    this.reviews.delete(review);
    const res = (response ?? {}) as Record<string, unknown>;
    let out: Record<string, unknown> = res;
    const expired = !res.success && review.ended === 'expired';
    if (expired) {
      const err = errorOf(res.error);
      const details = err.details && typeof err.details === 'object' ? (err.details as object) : {};
      out = { ...res, error: { ...err, details: { ...details, status: 'expired' } } };
    }
    const id = review.key;
    if (!id) return out;
    const rec = this.records.get(id);
    this.live.delete(id);
    if (!rec) return out;

    if (res.success === true) this.succeeded(rec, id, res.data);
    else this.failed(rec, out.error, expired);

    out = withStatus(out, rec);
    const waiting = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const resolve of waiting) resolve(out);
    return out;
  }

  private keepReply(reply: Reply): Reply | undefined {
    return sizeOf(reply) <= LIFECYCLE_LIMITS.replyBytes ? reply : undefined;
  }

  private succeeded(rec: LifecycleRecord, id: string, data: unknown) {
    const d = data as Record<string, unknown> | null;
    if (d && typeof d === 'object' && (d.ok === false || d.status === 'failed')) {
      this.settleFailed(rec, {
        code: 'TRANSACTION_FAILED',
        message: 'The wallet could not finish this request.',
        stage: rec.status === 'signing' ? 'submit' : 'review',
      });
      return;
    }
    if (SUBMIT_METHODS.has(rec.method)) {
      const hashes = hashesOf(d);
      if (hashes.length) {
        // The node took it: whatever the record missed on the way, it is submitted now.
        if (isFinal(rec.status) || rec.status === 'submitted') return;
        if (rec.status === 'locked') this.apply(rec, 'review_open');
        if (rec.status === 'review_open') this.apply(rec, 'signing');
        this.apply(rec, 'submitted', {
          reply: this.keepReply({ success: true, data }),
          hash: hashes[hashes.length - 1],
          hashes,
          confirmed: [],
          watching: true,
          submittedAt: this.deps.now(),
        });
        this.watch(id);
        return;
      }
    }
    const extra: Partial<LifecycleRecord> = { reply: this.keepReply({ success: true, data }) };
    if (rec.method === 'connect' && d && typeof d.address === 'string') extra.address = d.address;
    if (isFinal(rec.status) || rec.status === 'submitted') return;
    if (rec.status === 'locked') this.apply(rec, 'review_open');
    this.apply(rec, 'completed', extra);
  }

  private failed(rec: LifecycleRecord, rawError: unknown, expired: boolean) {
    const err = errorOf(rawError);
    const reply = this.keepReply({ success: false, error: rawError });
    if (expired && STATE_MOVES[rec.status].includes('expired')) {
      this.apply(rec, 'expired', { reply });
      return;
    }
    if (err.code === 'USER_REJECTED' && STATE_MOVES[rec.status].includes('rejected')) {
      this.apply(rec, 'rejected', { reply });
      return;
    }
    const stage: RequestError['stage'] =
      rec.status === 'signing' && !SCOPE_CODES.has(err.code) ? 'submit' : 'review';
    this.settleFailed(rec, { code: err.code, message: err.message, stage }, reply);
  }

  private settleFailed(rec: LifecycleRecord, error: RequestError, reply?: Reply) {
    if (!STATE_MOVES[rec.status].includes('failed')) return;
    this.apply(rec, 'failed', { error, ...(reply ? { reply } : {}) });
  }

  /** Masked for the site: an unconnected one never learns the lock state, network or signer. */
  private async view(rec: LifecycleRecord): Promise<RequestStatus> {
    const conn = await this.deps.connection(rec.origin).catch((): null => null);
    const out: RequestStatus = {
      requestId: rec.rid,
      status: rec.status === 'locked' && !conn ? 'review_open' : rec.status,
      method: rec.method,
      seq: rec.seq,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
    if (conn) out.network = rec.network;
    if (conn && rec.address && conn.address === rec.address) out.address = rec.address;
    if (rec.hash) out.hash = rec.hash;
    if (rec.status === 'submitted') out.watching = !!rec.watching;
    if (rec.status === 'confirmed') {
      if (rec.epoch !== undefined) out.epoch = rec.epoch;
      if (rec.receipt !== undefined) out.receipt = rec.receipt;
      if (rec.receiptUnavailable) out.receiptUnavailable = rec.receiptUnavailable;
      if (conn && rec.confirmedResult !== undefined) out.result = rec.confirmedResult;
    }
    if (conn && rec.status === 'completed' && rec.reply?.success) out.result = rec.reply.data;
    if (rec.status === 'failed' && rec.error) out.error = rec.error;
    return out;
  }

  private emit(rec: LifecycleRecord) {
    if (!rec.frames.length) return;
    const frames = [...rec.frames];
    void this.view({ ...rec }).then((status) => {
      for (const frame of frames) this.deps.deliver(frame, rec.origin, status);
    });
  }

  async status(
    sender: chrome.runtime.MessageSender,
    params: unknown
  ): Promise<Record<string, unknown>> {
    const origin = originOfSender(sender);
    const rid = (params as { rid?: unknown } | null)?.rid;
    if (typeof rid !== 'string' || !RID_PATTERN.test(rid)) {
      return {
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'rid must be 32 lowercase hex characters.' },
      };
    }
    if (!origin) return { success: true, data: this.unknown(rid) };
    const mayReadChain = this.takeStatusBudget(origin);
    await this.ready();
    this.purge();
    const id = recordKey(origin, rid);
    const rec = this.records.get(id);
    if (!rec) return { success: true, data: this.unknown(rid) };
    if (mayReadChain && rec.status === 'submitted' && !this.watches.has(id)) {
      const now = this.deps.now();
      if (!rec.checkedAt || now - rec.checkedAt >= LIFECYCLE_LIMITS.checkCacheMs) {
        rec.checkedAt = now;
        await this.check(id).catch(() => {});
      }
    }
    return { success: true, data: await this.view(rec) };
  }

  private unknown(rid: string): RequestStatus {
    return { requestId: rid, status: 'unknown', seq: 0, createdAt: 0, updatedAt: 0 };
  }

  openRequest(
    origin: string,
    except?: unknown
  ): { requestId: string; status: RequestState } | null {
    let best: LifecycleRecord | null = null;
    for (const rec of this.records.values()) {
      if (rec.origin !== origin || isFinal(rec.status) || rec.status === 'submitted') continue;
      if (rec.rid === except) continue;
      if (!best || rec.createdAt > best.createdAt) best = rec;
    }
    return best ? { requestId: best.rid, status: best.status } : null;
  }

  private watchCount(origin?: string): number {
    let n = 0;
    for (const id of this.watches.keys()) {
      if (origin === undefined || this.records.get(id)?.origin === origin) n++;
    }
    return n;
  }

  private watch(id: string) {
    const rec = this.records.get(id);
    if (!rec || rec.status !== 'submitted' || this.watches.has(id)) return;
    if (
      this.watchCount() >= LIFECYCLE_LIMITS.watchTotal ||
      this.watchCount(rec.origin) >= LIFECYCLE_LIMITS.watchPerOrigin ||
      this.deps.now() - (rec.submittedAt ?? 0) >= LIFECYCLE_LIMITS.watchMs
    ) {
      this.stopWatching(id);
      return;
    }
    this.watches.set(id, null);
    this.schedule(id);
  }

  private schedule(id: string) {
    const rec = this.records.get(id);
    if (!rec || !this.watches.has(id)) return;
    const age = this.deps.now() - (rec.submittedAt ?? 0);
    const delay =
      age < LIFECYCLE_LIMITS.fastWatchMs
        ? LIFECYCLE_LIMITS.fastIntervalMs
        : LIFECYCLE_LIMITS.slowIntervalMs;
    this.watches.set(
      id,
      setTimeout(async () => {
        if (!this.watches.has(id)) return;
        await this.check(id).catch(() => {});
        const now = this.records.get(id);
        if (!now || now.status !== 'submitted' || !this.watches.has(id)) {
          this.watches.delete(id);
          return;
        }
        if (this.deps.now() - (now.submittedAt ?? 0) >= LIFECYCLE_LIMITS.watchMs) {
          this.stopWatching(id);
          return;
        }
        this.schedule(id);
      }, delay)
    );
  }

  private stopWatching(id: string) {
    const t = this.watches.get(id);
    if (t) clearTimeout(t);
    this.watches.delete(id);
    const rec = this.records.get(id);
    if (!rec || rec.status !== 'submitted' || rec.watching === false) return;
    rec.watching = false;
    rec.seq += 1;
    rec.updatedAt = this.deps.now();
    this.persist(rec);
    this.emit(rec);
  }

  private async check(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec || rec.status !== 'submitted' || !rec.hashes?.length) return;
    if ((await this.deps.rpcUrlFor(rec.network)) !== rec.rpcUrl) {
      // The network's endpoint changed: a read elsewhere could tell another chain's story.
      this.stopWatching(id);
      return;
    }
    const pin = { networkId: rec.network, rpcUrl: rec.rpcUrl } as NetworkPin;
    const confirmed = new Set(rec.confirmed ?? []);
    const opTypes = new Set(rec.opTypes ?? []);
    let epoch = rec.epoch;
    for (const hash of rec.hashes) {
      if (confirmed.has(hash)) continue;
      let tx: any;
      try {
        tx = await this.deps.read('octra_transaction', [hash], pin);
      } catch {
        return;
      }
      if (this.records.get(id) !== rec || rec.status !== 'submitted') return;
      const status = typeof tx?.status === 'string' ? tx.status : 'pending';
      if (status === 'confirmed') {
        confirmed.add(hash);
        if (typeof tx.op_type === 'string') opTypes.add(tx.op_type);
        if (typeof tx.epoch === 'number') epoch = tx.epoch;
        continue;
      }
      if (status === 'rejected' || status === 'dropped') {
        const reason =
          (typeof tx?.error?.reason === 'string' && tx.error.reason) ||
          (typeof tx?.reject_reason === 'string' && tx.reject_reason) ||
          (status === 'dropped' ? 'The network dropped this transaction.' : 'Rejected');
        const type =
          typeof tx?.error?.type === 'string'
            ? tx.error.type
            : status === 'dropped'
              ? 'dropped'
              : undefined;
        this.watches.delete(id);
        this.apply(rec, 'failed', {
          confirmed: [...confirmed],
          error: {
            code: 'EXECUTION_FAILED',
            message: reason,
            stage: 'execution',
            ...(type ? { type } : {}),
          },
        });
        return;
      }
      rec.confirmed = [...confirmed];
      rec.opTypes = [...opTypes];
      return;
    }
    rec.confirmed = [...confirmed];
    rec.opTypes = [...opTypes];
    const contract =
      RECEIPT_METHODS.has(rec.method) || [...opTypes].some((t) => t === 'call' || t === 'deploy');
    const extra: Partial<LifecycleRecord> = { ...(epoch !== undefined ? { epoch } : {}) };
    if (!contract) {
      extra.receipt = null;
      extra.receiptUnavailable = 'not_contract';
    } else {
      try {
        const raw = await this.deps.read('contract_receipt', [rec.hash], pin);
        const receipt: ContractReceipt = {
          contract: raw?.contract,
          method: raw?.method,
          success: raw?.success,
          effort: raw?.effort,
          events: raw?.events,
          error: raw?.error ?? null,
        };
        if (sizeOf(receipt) <= LIFECYCLE_LIMITS.replyBytes) extra.receipt = receipt;
        else {
          extra.receipt = null;
          extra.receiptUnavailable = 'error';
        }
      } catch (e) {
        extra.receipt = null;
        extra.receiptUnavailable =
          /scanner|not allowed|refused|forbidden|not found|unknown method/i.test(
            String((e as Error)?.message ?? e)
          )
            ? 'refused'
            : 'error';
      }
    }
    if (rec.method === 'register_private_view_key' && rec.address) {
      const view = await this.deps
        .read('octra_viewPubkey', [rec.address], pin)
        .catch((): null => null);
      if (typeof view?.view_pubkey === 'string' && view.view_pubkey) {
        extra.confirmedResult = { status: 'registered', view_pubkey: view.view_pubkey, pvac: true };
      }
    }
    if (this.records.get(id) !== rec || rec.status !== 'submitted') return;
    this.watches.delete(id);
    this.apply(rec, 'confirmed', extra);
  }

  /** Closes only an unanswered review; an approved request finishes. */
  async cancel(
    sender: chrome.runtime.MessageSender,
    params: unknown
  ): Promise<Record<string, unknown>> {
    const origin = originOfSender(sender);
    const rid = (params as { rid?: unknown } | null)?.rid;
    if (typeof rid !== 'string' || !RID_PATTERN.test(rid)) {
      return {
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'rid must be 32 lowercase hex characters.' },
      };
    }
    if (!origin) return { success: true, data: this.unknown(rid) };
    await this.ready();
    const id = recordKey(origin, rid);
    const rec = this.records.get(id);
    if (!rec) return { success: true, data: this.unknown(rid) };
    const review = [...this.reviews].find((r) => r.key === id);
    if (
      review &&
      ['pending', 'locked', 'review_open'].includes(rec.status) &&
      review.close('cancelled')
    ) {
      await Promise.race([review.done, new Promise((r) => setTimeout(r, 1000))]);
    }
    return { success: true, data: await this.view(rec) };
  }

  pageGone(tabId: number, frameId?: number): void {
    for (const review of [...this.reviews]) {
      if (!review.frame || review.frame.tabId !== tabId) continue;
      if (frameId !== undefined && review.frame.frameId !== frameId) continue;
      review.pageGone();
    }
  }

  async dropOrigin(origin: string): Promise<void> {
    const o = originOfSender({ origin });
    if (!o) return;
    await this.ready();
    for (const [id, rec] of [...this.records]) {
      if (rec.origin !== o || this.live.has(id)) continue;
      if (rec.status === 'submitted' && this.watches.has(id)) continue;
      this.drop(id);
    }
  }
}

function chromeDeps(): LifecycleDeps {
  return {
    now: () => Date.now(),
    storage: {
      getAll: async () =>
        ((await chrome.storage.session.get(null)) as unknown as Record<string, unknown>) ?? {},
      set: (items) => chrome.storage.session.set(items),
      remove: (keys) => chrome.storage.session.remove(keys),
      onRemoved: (listener) => {
        chrome.storage.onChanged?.addListener((changes, area) => {
          if (area !== 'session') return;
          const removed = Object.keys(changes).filter(
            (k) => k.startsWith(KEY_PREFIX) && changes[k].newValue === undefined
          );
          if (removed.length) listener(removed);
        });
      },
    },
    deliver: (frame, origin, status) => {
      try {
        chrome.tabs
          .sendMessage(
            frame.tabId,
            { type: 'WALLET_EVENT', origin, eventData: { type: 'requestUpdate', data: status } },
            { frameId: frame.frameId }
          )
          ?.catch?.(() => {});
      } catch {}
    },
    connection: (origin) => getConnection(origin),
    network: () => resolveNetworkPin(),
    rpcUrlFor: (id) => rpcUrlFor(id),
    read: (method, params, pin) =>
      networkService.jsonRpcCall(method, params, true, pin, {
        timeoutMs: LIFECYCLE_LIMITS.readTimeoutMs,
      }),
    locked: async () => !(await passwordManager.getSessionKey()),
    onUnlock: (listener) => {
      const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === 'session' && changes.wallet_unlocked?.newValue) listener();
      };
      chrome.storage.onChanged?.addListener(onChange);
      return () => chrome.storage.onChanged?.removeListener(onChange);
    },
  };
}

export const requestLifecycle = new RequestLifecycle(chromeDeps());
