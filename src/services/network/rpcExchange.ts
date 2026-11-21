import { logger } from 'src/utils/logger';

// One retry policy for every node call, matching webcli lib/rpc_retry.hpp, rpc_io.hpp and
// rpc_gate.hpp (test vectors in __tests__/fixtures/rpc-retry-vectors.json).

export type RpcLink = 'local' | 'unopened' | 'untrusted' | 'broken' | 'expired' | 'answered';
export type RpcFault = 'none' | 'capacity' | 'network' | 'busy' | 'deadline' | 'state';
export type RpcLane = 'user' | 'poll';

export interface RpcReply {
  link: RpcLink;
  status: number;
  body: string;
  retryAfter: number | null;
  headers?: Headers;
  cause?: unknown;
}

export interface RpcStep {
  fault: RpcFault;
  unsent: boolean;
  status: string;
}

export const RPC_RETRY_WINDOW_S = 25;
export const RPC_RETRY_AFTER_CAP_S = 5;
export const RPC_PAUSE_SPREAD = 0.2;
export const RPC_PAUSES_S = [0.25, 0.5, 1, 2, 4];
export const RPC_STATE_CHANGED_CODE = -32012;
export const RPC_SLOTS = 4;
export const RPC_POLL_SLOTS = 2;
export const RPC_GATE_MAX_MS = 60_000;

const WRITES = new Set([
  'octra_submit',
  'octra_submitBatch',
  'staging_remove',
  'octra_registerPublicKey',
  'octra_registerPvacPubkey',
  'octra_privateTransfer',
  'octra_circleComputeSubmit',
  'contract_verify',
  'octra_programVerify',
  'contract_saveAbi',
  'octra_programSaveAbi',
]);

export const rpcWrite = (method: string): boolean => WRITES.has(method);

const REPLY_ERROR_LIMIT = 4096;

function replyError(body: string): { id: unknown; error: Record<string, unknown> } | null {
  if (!body || body.length > REPLY_ERROR_LIMIT) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('id' in value)) return null;
  const { id, error } = value as { id: unknown; error?: unknown };
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  return { id, error: error as Record<string, unknown> };
}

function capacityReply(body: string): boolean {
  const reply = replyError(body);
  if (!reply || reply.id !== null) return false;
  const message = reply.error.message;
  return typeof message === 'string' && message.toLowerCase().includes('capacity');
}

function stateChangedReply(body: string): boolean {
  const reply = replyError(body);
  return !!reply && reply.id !== null && reply.error.code === RPC_STATE_CHANGED_CODE;
}

const gatewayStatus = (s: number) =>
  s === 408 || s === 425 || s === 502 || s === 504 || (s >= 520 && s <= 524);

export function rpcStep(reply: Pick<RpcReply, 'link' | 'status' | 'body'>): RpcStep {
  switch (reply.link) {
    case 'local':
    case 'untrusted':
      return { fault: 'none', unsent: true, status: '' };
    case 'unopened':
      return { fault: 'network', unsent: true, status: 'connect' };
    case 'broken':
      return { fault: 'network', unsent: false, status: 'reset' };
    case 'expired':
      return { fault: 'network', unsent: false, status: 'timeout' };
  }
  const capacity = capacityReply(reply.body);
  if (reply.status === 429 || reply.status === 503) {
    return {
      fault: 'capacity',
      unsent: capacity && reply.status === 429,
      status: `${reply.status}`,
    };
  }
  if (gatewayStatus(reply.status))
    return { fault: 'network', unsent: false, status: `${reply.status}` };
  if (capacity) return { fault: 'capacity', unsent: false, status: 'capacity' };
  if (reply.status === 200 && stateChangedReply(reply.body)) {
    return { fault: 'state', unsent: false, status: 'state_changed' };
  }
  return { fault: 'none', unsent: false, status: '' };
}

export const rpcRepeat = (step: Pick<RpcStep, 'fault' | 'unsent'>, write: boolean): boolean =>
  step.fault !== 'none' && (!write || step.unsent);

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function rpcPause(attempt: number, retryAfter: number | null, draw: number): number {
  const base =
    retryAfter != null
      ? Math.min(retryAfter, RPC_RETRY_AFTER_CAP_S)
      : RPC_PAUSES_S[clamp(Math.trunc(attempt), 1, RPC_PAUSES_S.length) - 1];
  return base * (1 + RPC_PAUSE_SPREAD * clamp(draw, 0, 1));
}

export function retryAfterSeconds(header: string | null | undefined): number | null {
  if (!header || !/^\d{1,5}$/.test(header)) return null;
  const n = Number(header);
  return n >= 1 && n <= 86400 ? n : null;
}

export const rpcWindow = (requestSeconds: number): number =>
  Math.min(RPC_RETRY_WINDOW_S, requestSeconds);

export const rpcRoom = (busy: number, polls: number, usersWaiting: number, lane: RpcLane) =>
  busy < RPC_SLOTS && (lane === 'user' || (polls < RPC_POLL_SLOTS && usersWaiting === 0));

export function rpcCondition(fault: RpcFault): string {
  switch (fault) {
    case 'capacity':
      return 'rpc capacity reached';
    case 'busy':
      return 'wallet rpc slots busy';
    case 'deadline':
      return 'request deadline reached';
    case 'state':
      return 'committed state changed during read; retry';
    default:
      return 'network unreachable';
  }
}

/** A write the exchange proves never left: safe to report as refused. */
export class RpcUnsentError extends Error {
  readonly fault: RpcFault;
  constructor(fault: RpcFault, detail?: string) {
    super(`${rpcCondition(fault)}${detail ? `: ${detail}` : ''}; nothing was sent`);
    this.name = 'RpcUnsentError';
    this.fault = fault;
  }
}

let timing = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  random: () => Math.random(),
};

export function setRpcTimingForTests(t: Partial<typeof timing>): void {
  timing = { ...timing, ...t };
}

export class RpcGate {
  private busy = 0;
  private polls = 0;
  private queue: Array<{ lane: RpcLane; grant: (held: boolean) => void }> = [];

  get inFlight(): number {
    return this.busy;
  }

  enter(lane: RpcLane, deadline: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = {
        lane,
        grant: (held: boolean) => {
          if (timer) clearTimeout(timer);
          resolve(held);
        },
      };
      this.queue.push(waiter);
      this.pump();
      if (!this.queue.includes(waiter)) return;
      timer = setTimeout(
        () => {
          const i = this.queue.indexOf(waiter);
          if (i < 0) return;
          this.queue.splice(i, 1);
          resolve(false);
          this.pump();
        },
        Math.max(0, deadline - timing.now())
      );
    });
  }

  leave(lane: RpcLane): void {
    this.busy -= 1;
    if (lane === 'poll') this.polls -= 1;
    this.pump();
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length; ) {
      const w = this.queue[i];
      const users = this.queue.filter((q) => q.lane === 'user').length;
      if (rpcRoom(this.busy, this.polls, users, w.lane)) {
        this.queue.splice(i, 1);
        this.busy += 1;
        if (w.lane === 'poll') this.polls += 1;
        w.grant(true);
      } else {
        i++;
      }
    }
  }
}

export const rpcGate = new RpcGate();

export interface RpcSent {
  reply: RpcReply;
  unsent: boolean;
  repeated: boolean;
  fault: RpcFault;
  gaveUp: boolean;
}

export interface RpcExchange {
  method: string;
  write?: boolean;
  timeoutMs: number;
  lane?: RpcLane;
  once?: boolean;
  firstAttemptMs?: number;
  stop?: () => boolean;
  onRetry?: (step: RpcStep) => void;
  send: (attemptMs: number) => Promise<RpcReply>;
}

const LOCAL: RpcReply = { link: 'local', status: 0, body: '', retryAfter: null };

export async function rpcExchange(p: RpcExchange): Promise<RpcSent> {
  const write = p.write ?? rpcWrite(p.method);
  const start = timing.now();
  const end = start + p.timeoutMs;
  const once = !!p.once;
  const gated = !once && p.timeoutMs >= 1000 && p.timeoutMs <= RPC_GATE_MAX_MS;
  const window = once ? start : Math.min(end, start + rpcWindow(p.timeoutMs / 1000) * 1000);
  const lane = p.lane ?? 'user';
  let unsent = true;
  for (let attempt = 1; ; attempt++) {
    if (gated && !(await rpcGate.enter(lane, window))) {
      return { reply: LOCAL, unsent, repeated: attempt > 1, fault: 'busy', gaveUp: true };
    }
    let reply: RpcReply;
    try {
      let ms = clamp(end - timing.now(), Math.min(p.timeoutMs, 1000), p.timeoutMs);
      if (attempt === 1 && p.firstAttemptMs) ms = Math.min(ms, p.firstAttemptMs);
      reply = await p.send(ms);
    } finally {
      if (gated) rpcGate.leave(lane);
    }
    const step = rpcStep(reply);
    unsent = unsent && step.unsent;
    const repeated = attempt > 1;
    if (!rpcRepeat(step, write) || p.stop?.()) {
      return { reply, unsent, repeated, fault: step.fault, gaveUp: false };
    }
    const wait = rpcPause(attempt, reply.retryAfter, timing.random()) * 1000;
    if (timing.now() + wait >= window) {
      return { reply, unsent, repeated, fault: step.fault, gaveUp: true };
    }
    logger.warn(
      `[rpc] event = rpc_retry method = ${p.method} attempt = ${attempt} status = ${step.status} wait = ${(wait / 1000).toFixed(2)}`
    );
    p.onRetry?.(step);
    await timing.sleep(wait);
  }
}

/** A browser cannot tell a connect failure from a reset: only our own timeout is "expired". */
export function linkOf(err: unknown): RpcLink {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError' ? 'expired' : 'broken';
}

function methodsOf(body: unknown): string[] {
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
  }
  const items = Array.isArray(data) ? data : [data];
  return items.map((i) => String((i as { method?: unknown } | null)?.method ?? ''));
}

const NULL_BODY = new Set([101, 204, 205, 304]);

export async function rpcFetch(
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; lane?: RpcLane; once?: boolean } = {}
): Promise<Response> {
  const methods = methodsOf(init.body);
  const write = methods.some(rpcWrite);
  const caller = init.signal ?? undefined;
  const sent = await rpcExchange({
    method: methods.length > 1 ? 'batch' : (methods[0] ?? ''),
    write,
    timeoutMs: opts.timeoutMs ?? 30_000,
    lane: opts.lane,
    once: opts.once,
    stop: () => !!caller?.aborted,
    send: async (ms) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      const forward = () => controller.abort();
      caller?.addEventListener?.('abort', forward);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const body = typeof res.text === 'function' ? await res.text() : '';
        return {
          link: 'answered',
          status: res.status,
          body,
          retryAfter: retryAfterSeconds(res.headers?.get?.('Retry-After')),
          headers: res.headers,
        };
      } catch (cause) {
        return { link: linkOf(cause), status: 0, body: '', retryAfter: null, cause };
      } finally {
        clearTimeout(timer);
        caller?.removeEventListener?.('abort', forward);
      }
    },
  });
  const { reply } = sent;
  if (reply.link === 'answered') {
    const status = reply.status >= 200 && reply.status <= 599 ? reply.status : 502;
    return new Response(NULL_BODY.has(status) ? null : reply.body, {
      status,
      headers: reply.headers,
    });
  }
  if (sent.fault === 'busy') {
    if (write) throw new RpcUnsentError('busy');
    throw new Error(rpcCondition('busy'));
  }
  throw reply.cause ?? new Error(rpcCondition(sent.fault));
}
