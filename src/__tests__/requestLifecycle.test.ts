import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/network/NetworkService', () => ({
  networkService: {},
  privacyNetworkService: {},
}));
vi.mock('../services/crypto/PasswordManager', () => ({
  passwordManager: { getSessionKey: vi.fn(async () => 'k') },
}));

import {
  LIFECYCLE_LIMITS,
  RequestLifecycle,
  canonicalJson,
  requestDigest,
  type LifecycleDeps,
  type RequestStatus,
} from '../background/services/requestLifecycle';

const A = 'https://a.app';
const B = 'https://b.app';
const SIGNER = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const rid = (n: number) => n.toString(16).padStart(32, '0');
const sender = (origin: string, tabId = 7, frameId = 0) =>
  ({ origin, tab: { id: tabId }, frameId }) as chrome.runtime.MessageSender;
const msg = (method: string, params: unknown, r: string) => ({ method, params, v: 2, rid: r });

interface Harness {
  life: RequestLifecycle;
  deps: LifecycleDeps;
  store: Map<string, any>;
  delivered: { frame: { tabId: number; frameId: number }; origin: string; status: RequestStatus }[];
  conns: Map<string, { address?: string }>;
  chain: Map<string, any>;
  receipt: { value: any };
  state: { locked: boolean; unlock: Set<() => void> };
  read: ReturnType<typeof vi.fn>;
}

function harness(store = new Map<string, any>()): Harness {
  const removed: ((keys: string[]) => void)[] = [];
  const delivered: Harness['delivered'] = [];
  const conns = new Map<string, { address?: string }>();
  const chain = new Map<string, any>();
  const receipt = {
    value: { contract: 'octC', method: 'deposit', success: true, events: [] as unknown[] } as any,
  };
  const state = { locked: false, unlock: new Set<() => void>() };
  const read = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'octra_transaction')
      return chain.get(String(params[0])) ?? { status: 'pending' };
    if (method === 'contract_receipt') {
      if (receipt.value instanceof Error) throw receipt.value;
      return receipt.value;
    }
    throw new Error('unexpected read');
  });
  const deps: LifecycleDeps = {
    now: () => Date.now(),
    storage: {
      getAll: async () => Object.fromEntries(store),
      set: async (items) => {
        for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
      },
      remove: async (keys) => {
        for (const k of keys) store.delete(k);
        for (const l of removed) l(keys);
      },
      onRemoved: (l) => removed.push(l),
    },
    deliver: (frame, origin, status) => delivered.push({ frame, origin, status }),
    connection: async (o) => conns.get(o) ?? null,
    network: async () => ({ networkId: 'devnet' as any, rpcUrl: 'https://dev' }),
    rpcUrlFor: async (id) => (id === 'devnet' ? 'https://dev' : 'https://main'),
    read,
    locked: async () => state.locked,
    onUnlock: (l) => {
      state.unlock.add(l);
      return () => state.unlock.delete(l);
    },
  };
  return {
    life: new RequestLifecycle(deps),
    deps,
    store,
    delivered,
    conns,
    chain,
    receipt,
    state,
    read,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function start(h: Harness, method: string, params: unknown, r: string, s = sender(A)) {
  const entry = await h.life.begin(msg(method, params, r), s);
  if (entry.kind !== 'run') throw new Error(`expected a new request, got ${entry.kind}`);
  return entry.review;
}

async function statusOf(h: Harness, r: string, origin = A, tabId = 7) {
  const res = (await h.life.status(sender(origin, tabId), { rid: r })) as any;
  return res.data as RequestStatus;
}

const STATUS_PER_SECOND = LIFECYCLE_LIMITS.statusPerSecond;
beforeEach(() => {
  vi.useRealTimers();
  LIFECYCLE_LIMITS.statusPerSecond = 1000;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('request digest', () => {
  it('ignores key order and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,1]},"b":1}'
    );
    expect(requestDigest('call_contract', { a: 1, b: 2 }, null)).toBe(
      requestDigest('call_contract', { b: 2, a: 1 }, null)
    );
    expect(requestDigest('call_contract', { a: 1 }, 'devnet')).not.toBe(
      requestDigest('call_contract', { a: 1 }, 'mainnet')
    );
  });
});

describe('records', () => {
  it('refuses an id that is not 32 lowercase hex characters', async () => {
    const h = harness();
    for (const bad of ['ABC', rid(171).toUpperCase(), 'g'.repeat(32), 5]) {
      const entry = await h.life.begin(
        { method: 'signMessage', params: {}, v: 2, rid: bad },
        sender(A)
      );
      expect(entry).toMatchObject({
        kind: 'answer',
        response: { error: { code: 'INVALID_PARAMS' } },
      });
    }
    expect(h.store.size).toBe(0);
  });

  it('a request without v: 2 keeps protocol 1 and leaves no record', async () => {
    const h = harness();
    const entry = await h.life.begin({ method: 'signMessage', params: {}, rid: rid(1) }, sender(A));
    expect(entry.kind).toBe('run');
    expect(h.store.size).toBe(0);
    expect(await statusOf(h, rid(1))).toMatchObject({ status: 'unknown' });
  });

  it('walks a contract call from pending to confirmed with its receipt', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const review = await start(h, 'call_contract', { contract: 'octC', method: 'deposit' }, rid(1));
    expect((await statusOf(h, rid(1))).status).toBe('pending');
    await review.shown();
    expect((await statusOf(h, rid(1))).status).toBe('review_open');
    await review.answered(true);
    expect((await statusOf(h, rid(1))).status).toBe('signing');
    const out = review.settle({ success: true, data: { txHash: 'h1' } }) as any;
    expect(out).toMatchObject({ success: true, rid: rid(1), status: 'submitted' });
    expect(await statusOf(h, rid(1))).toMatchObject({
      status: 'submitted',
      hash: 'h1',
      watching: true,
      address: SIGNER,
      network: 'devnet',
    });

    h.chain.set('h1', { status: 'confirmed', epoch: 42, op_type: 'call' });
    await vi.advanceTimersByTimeAsync(LIFECYCLE_LIMITS.fastIntervalMs);
    const done = await statusOf(h, rid(1));
    expect(done).toMatchObject({ status: 'confirmed', epoch: 42, hash: 'h1' });
    expect(done.receipt).toMatchObject({ method: 'deposit', success: true });
    expect(h.read).toHaveBeenCalledWith('octra_transaction', ['h1'], {
      networkId: 'devnet',
      rpcUrl: 'https://dev',
    });
    const seen = h.delivered.map((d) => d.status.status);
    expect(seen).toEqual(['pending', 'review_open', 'signing', 'submitted', 'confirmed']);
    const seqs = h.delivered.map((d) => d.status.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('a chain rejection or drop ends as failed at the execution stage', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    for (const [n, tx] of [
      [1, { status: 'rejected', error: { type: 'revert', reason: 'no funds' } }],
      [2, { status: 'dropped' }],
    ] as const) {
      const review = await start(h, 'send_transaction', { to: 'x', n }, rid(n));
      await review.shown();
      await review.answered(true);
      review.settle({ success: true, data: { txHash: `h${n}` } });
      h.chain.set(`h${n}`, tx);
    }
    await vi.advanceTimersByTimeAsync(LIFECYCLE_LIMITS.fastIntervalMs);
    expect(await statusOf(h, rid(1))).toMatchObject({
      status: 'failed',
      error: { code: 'EXECUTION_FAILED', stage: 'execution', type: 'revert', message: 'no funds' },
    });
    expect(await statusOf(h, rid(2))).toMatchObject({
      status: 'failed',
      error: { code: 'EXECUTION_FAILED', stage: 'execution', type: 'dropped' },
    });
  });

  it('a plain transfer confirms without a receipt read; a refused receipt is named', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const send = await start(h, 'send_transaction', { to: 'x' }, rid(1));
    await send.shown();
    await send.answered(true);
    send.settle({ success: true, data: { txHash: 'h1' } });
    const call = await start(h, 'call_contract', { contract: 'c' }, rid(2));
    await call.shown();
    await call.answered(true);
    call.settle({ success: true, data: { txHash: 'h2' } });
    h.chain.set('h1', { status: 'confirmed', op_type: 'standard' });
    h.chain.set('h2', { status: 'confirmed', op_type: 'call' });
    h.receipt.value = new Error('single scanner read required');
    await vi.advanceTimersByTimeAsync(LIFECYCLE_LIMITS.fastIntervalMs);
    expect(await statusOf(h, rid(1))).toMatchObject({
      status: 'confirmed',
      receipt: null,
      receiptUnavailable: 'not_contract',
    });
    expect(await statusOf(h, rid(2))).toMatchObject({
      status: 'confirmed',
      receipt: null,
      receiptUnavailable: 'refused',
    });
    expect(h.read.mock.calls.filter((c) => c[0] === 'contract_receipt')).toHaveLength(1);
  });

  it('stops watching after ten minutes and then reads the chain on demand, cached 5 s', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const review = await start(h, 'send_transaction', { to: 'x' }, rid(1));
    await review.shown();
    await review.answered(true);
    review.settle({ success: true, data: { txHash: 'h1' } });
    await vi.advanceTimersByTimeAsync(LIFECYCLE_LIMITS.watchMs + 20_000);
    expect(await statusOf(h, rid(1))).toMatchObject({ status: 'submitted', watching: false });
    const reads = h.read.mock.calls.length;
    await statusOf(h, rid(1));
    expect(h.read.mock.calls.length).toBe(reads);
    await vi.advanceTimersByTimeAsync(LIFECYCLE_LIMITS.checkCacheMs);
    h.chain.set('h1', { status: 'confirmed', epoch: 9 });
    expect(await statusOf(h, rid(1))).toMatchObject({ status: 'confirmed', epoch: 9 });
  });

  it('watches at most 8 hashes per site; the rest are read on demand', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    for (let n = 1; n <= 9; n++) {
      const review = await start(h, 'send_transaction', { to: 'x', n }, rid(n));
      await review.shown();
      await review.answered(true);
      review.settle({ success: true, data: { txHash: `h${n}` } });
    }
    expect(await statusOf(h, rid(8))).toMatchObject({ watching: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await statusOf(h, rid(9))).toMatchObject({ status: 'submitted', watching: false });
  });

  it('a signature and a connect complete with their result', async () => {
    const h = harness();
    const connect = await start(h, 'connect', {}, rid(1));
    await connect.shown();
    await connect.answered(true);
    connect.settle({ success: true, data: { address: SIGNER, permissions: [] } });
    h.conns.set(A, { address: SIGNER });
    expect(await statusOf(h, rid(1))).toMatchObject({
      status: 'completed',
      address: SIGNER,
      result: { address: SIGNER },
    });
    const sign = await start(h, 'signMessage', { message: 'hi' }, rid(2));
    await sign.shown();
    await sign.answered(true);
    sign.settle({ success: true, data: { signature: 'sig' } });
    expect(await statusOf(h, rid(2))).toMatchObject({
      status: 'completed',
      result: { signature: 'sig' },
    });
  });

  it('a refusal after approval is a failed submit, a moved scope a failed review', async () => {
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const one = await start(h, 'call_contract', { c: 1 }, rid(1));
    await one.shown();
    await one.answered(true);
    one.settle({
      success: false,
      error: { code: 'CONTRACT_CALL_FAILED', message: 'node said no' },
    });
    expect(await statusOf(h, rid(1))).toMatchObject({
      status: 'failed',
      error: { code: 'CONTRACT_CALL_FAILED', stage: 'submit' },
    });
    const two = await start(h, 'call_contract', { c: 2 }, rid(2));
    await two.shown();
    await two.answered(true);
    two.settle({ success: false, error: { code: 'NETWORK_CHANGED', message: 'moved' } });
    expect(await statusOf(h, rid(2))).toMatchObject({
      status: 'failed',
      error: { code: 'NETWORK_CHANGED', stage: 'review' },
    });
  });
});

describe('idempotency', () => {
  it('a repeat while the review is open joins it: one review, one answer for both', async () => {
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const review = await start(h, 'signMessage', { message: 'hi' }, rid(1));
    await review.shown();
    const again = await h.life.begin(msg('signMessage', { message: 'hi' }, rid(1)), sender(A));
    expect(again.kind).toBe('join');
    const first = review.settle({ success: true, data: { signature: 'sig' } });
    const joined = await (again as { response: Promise<unknown> }).response;
    expect(joined).toEqual(first);
    expect(joined).toMatchObject({
      success: true,
      data: { signature: 'sig' },
      status: 'completed',
    });
  });

  it('keys order does not make a different request', async () => {
    const h = harness();
    const review = await start(h, 'call_contract', { a: 1, b: 2 }, rid(1));
    const again = await h.life.begin(msg('call_contract', { b: 2, a: 1 }, rid(1)), sender(A));
    expect(again.kind).toBe('join');
    review.settle({ success: false, error: { code: 'USER_REJECTED', message: 'no' } });
  });

  it('another request under a known id is refused before any review', async () => {
    const h = harness();
    const review = await start(h, 'send_transaction', { to: 'x', amount: '1' }, rid(1));
    for (const [method, params] of [
      ['send_transaction', { to: 'x', amount: '2' }],
      ['call_contract', { to: 'x', amount: '1' }],
      ['send_transaction', { to: 'x', amount: '1', networkId: 'mainnet' }],
    ] as const) {
      const entry = await h.life.begin(msg(method, params, rid(1)), sender(A));
      expect(entry).toMatchObject({
        kind: 'answer',
        response: { success: false, error: { code: 'REQUEST_ID_REUSED' } },
      });
    }
    review.settle({ success: false, error: { code: 'USER_REJECTED', message: 'no' } });
    const after = await h.life.begin(msg('call_contract', {}, rid(1)), sender(A));
    expect(after).toMatchObject({ response: { error: { code: 'REQUEST_ID_REUSED' } } });
  });

  it('a rejected, failed or expired request is never run again', async () => {
    const h = harness();
    const cases = [
      [1, { success: false, error: { code: 'USER_REJECTED', message: 'no' } }, 'rejected'],
      [2, { success: false, error: { code: 'TRANSACTION_FAILED', message: 'x' } }, 'failed'],
      [3, { success: false, error: { code: 'USER_REJECTED', message: 'timed out' } }, 'expired'],
    ] as const;
    for (const [n, answer, status] of cases) {
      const review = await start(h, 'send_transaction', { to: 'x', n }, rid(n));
      await review.shown();
      if (status === 'expired') review.expire();
      review.settle(answer);
      const repeat = await h.life.begin(msg('send_transaction', { to: 'x', n }, rid(n)), sender(A));
      expect(repeat.kind).toBe('answer');
      expect(repeat).toMatchObject({
        response: { success: false, error: { code: answer.error.code }, status },
      });
    }
  });

  it('a repeated failure names the request and its state in the error details', async () => {
    const h = harness();
    const review = await start(h, 'signMessage', { m: 1 }, rid(1));
    await review.shown();
    const first = review.settle({
      success: false,
      error: { code: 'USER_REJECTED', message: 'no' },
    }) as any;
    expect(first.error.details).toEqual({ requestId: rid(1), status: 'rejected' });
    expect(first.error).not.toHaveProperty('status');
    const repeat = (await h.life.begin(msg('signMessage', { m: 1 }, rid(1)), sender(A))) as any;
    expect(repeat.response.error).toMatchObject({
      code: 'USER_REJECTED',
      details: { requestId: rid(1), status: 'rejected' },
    });
  });

  it('a connect repeated after the site disconnected is a new connect with its own review', async () => {
    const h = harness();
    const review = await start(h, 'connect', {}, rid(1));
    await review.shown();
    review.settle({ success: true, data: { address: SIGNER } });
    h.conns.set(A, { address: SIGNER });
    const connected = await h.life.begin(msg('connect', {}, rid(1)), sender(A));
    expect(connected).toMatchObject({ kind: 'answer', response: { data: { address: SIGNER } } });
    h.conns.delete(A);
    expect(await statusOf(h, rid(1))).not.toHaveProperty('result');
    const after = await h.life.begin(msg('connect', {}, rid(1)), sender(A));
    expect(after.kind).toBe('run');
  });

  it('a submitted request answers a repeat with its hash, never a second submit', async () => {
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const review = await start(h, 'call_contract', { c: 1 }, rid(1));
    await review.shown();
    await review.answered(true);
    review.settle({ success: true, data: { txId: 't', txHash: 'h1', success: true } });
    const repeat = await h.life.begin(msg('call_contract', { c: 1 }, rid(1)), sender(A, 9));
    expect(repeat).toMatchObject({
      kind: 'answer',
      response: { success: true, data: { txHash: 'h1' }, rid: rid(1), status: 'submitted' },
    });
  });
});

describe('isolation', () => {
  it('another origin never sees the record, and its own id is its own', async () => {
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    h.conns.set(B, { address: SIGNER });
    const review = await start(h, 'signMessage', { message: 'a' }, rid(1));
    expect(await statusOf(h, rid(1), B)).toMatchObject({ status: 'unknown', seq: 0 });
    const other = await h.life.begin(msg('signMessage', { message: 'b' }, rid(1)), sender(B, 11));
    expect(other.kind).toBe('run');
    review.settle({ success: false, error: { code: 'USER_REJECTED', message: 'no' } });
    expect((await statusOf(h, rid(1), A)).status).toBe('rejected');
    expect((await statusOf(h, rid(1), B)).status).toBe('pending');
  });

  it('events go to the requesting tab and frame only; another tab of the site may ask', async () => {
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const review = await start(h, 'signMessage', { m: 1 }, rid(1), sender(A, 7, 3));
    await review.shown();
    review.settle({ success: true, data: { signature: 's' } });
    await flush();
    expect(h.delivered.length).toBeGreaterThan(0);
    for (const d of h.delivered) {
      expect(d.frame).toEqual({ tabId: 7, frameId: 3 });
      expect(d.origin).toBe(A);
    }
    expect((await statusOf(h, rid(1), A, 12)).status).toBe('completed');
  });

  it('an unconnected site reads review_open behind the lock and nothing moves at unlock', async () => {
    const h = harness();
    h.state.locked = true;
    const review = await start(h, 'connect', {}, rid(1));
    await review.locked();
    await review.shown();
    const before = await statusOf(h, rid(1));
    expect(before.status).toBe('review_open');
    expect(before).not.toHaveProperty('network');
    expect(before).not.toHaveProperty('address');
    await flush();
    const events = h.delivered.length;
    expect(h.delivered.map((d) => d.status.status)).toEqual(['pending', 'review_open']);

    h.state.locked = false;
    for (const l of [...h.state.unlock]) l();
    await review.shown();
    await flush();
    const after = await statusOf(h, rid(1));
    expect(after).toMatchObject({ status: 'review_open', seq: before.seq });
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(h.delivered.length).toBe(events);
    review.settle({ success: false, error: { code: 'USER_REJECTED', message: 'no' } });
  });

  it('a connected site reads locked, then review_open once unlocked', async () => {
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    h.state.locked = true;
    const review = await start(h, 'signMessage', { m: 1 }, rid(1));
    await review.locked();
    expect((await statusOf(h, rid(1))).status).toBe('locked');
    h.state.locked = false;
    await review.shown();
    expect((await statusOf(h, rid(1))).status).toBe('review_open');
    review.settle({ success: false, error: { code: 'USER_REJECTED', message: 'no' } });
  });

  it('the signer shows only to a site connected to that signer', async () => {
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const review = await start(h, 'signMessage', {}, rid(1));
    review.settle({ success: true, data: { signature: 's' } });
    expect(await statusOf(h, rid(1))).toMatchObject({ address: SIGNER });
    h.conns.set(A, { address: 'octOther' });
    expect(await statusOf(h, rid(1))).not.toHaveProperty('address');
  });
});

describe('limits', () => {
  it('refuses a ninth open request from one site with RATE_LIMIT_EXCEEDED', async () => {
    const h = harness();
    const open = [];
    for (let n = 1; n <= LIFECYCLE_LIMITS.openPerOrigin; n++) {
      open.push(await start(h, 'signMessage', { n }, rid(n)));
    }
    const ninth = await h.life.begin(msg('signMessage', { n: 9 }, rid(9)), sender(A));
    expect(ninth).toMatchObject({ response: { error: { code: 'RATE_LIMIT_EXCEEDED' } } });
    const elsewhere = await h.life.begin(msg('signMessage', { n: 9 }, rid(9)), sender(B));
    expect(elsewhere.kind).toBe('run');
    open[0].settle({ success: false, error: { code: 'USER_REJECTED', message: 'no' } });
    const now = await h.life.begin(msg('signMessage', { n: 9 }, rid(9)), sender(A));
    expect(now.kind).toBe('run');
  });

  it('keeps 64 records per site by dropping its oldest final one', async () => {
    const h = harness();
    for (let n = 1; n <= LIFECYCLE_LIMITS.perOrigin + 1; n++) {
      const review = await start(h, 'signMessage', { n }, rid(n));
      review.settle({ success: false, error: { code: 'USER_REJECTED', message: 'no' } });
    }
    expect((await statusOf(h, rid(1))).status).toBe('unknown');
    expect((await statusOf(h, rid(2))).status).toBe('rejected');
    expect(h.store.size).toBe(LIFECYCLE_LIMITS.perOrigin);
  });

  it('answers every status read but reads the chain for at most 2 a second per site', async () => {
    vi.useFakeTimers();
    LIFECYCLE_LIMITS.statusPerSecond = STATUS_PER_SECOND;
    expect(STATUS_PER_SECOND).toBe(2);
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    for (let n = 1; n <= 3; n++) {
      const review = await start(h, 'send_transaction', { to: 'x', n }, rid(n));
      await review.shown();
      await review.answered(true);
      review.settle({ success: true, data: { txHash: `h${n}` } });
    }
    await vi.advanceTimersByTimeAsync(LIFECYCLE_LIMITS.watchMs + 20_000);
    h.read.mockClear();
    const reads = await Promise.all(
      [1, 2, 3].map((n) => h.life.status(sender(A), { rid: rid(n) }))
    );
    expect(reads.map((r: any) => r.data.status)).toEqual(['submitted', 'submitted', 'submitted']);
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('forgets records after 24 hours', async () => {
    vi.useFakeTimers();
    const h = harness();
    const review = await start(h, 'signMessage', {}, rid(1));
    review.settle({ success: false, error: { code: 'USER_REJECTED', message: 'no' } });
    vi.setSystemTime(Date.now() + LIFECYCLE_LIMITS.lifeMs + 1);
    expect((await statusOf(h, rid(1))).status).toBe('unknown');
    expect(h.store.size).toBe(0);
  });

  it('keeps the stored answer within 4 KB', async () => {
    const h = harness();
    const review = await start(h, 'signMessage', {}, rid(1));
    review.settle({ success: true, data: { signature: 'x'.repeat(5000) } });
    const status = await statusOf(h, rid(1));
    expect(status.status).toBe('completed');
    expect(status).not.toHaveProperty('result');
  });
});

describe('expiry and page close', () => {
  it('a review window that ran out reads expired; the code stays USER_REJECTED', async () => {
    const h = harness();
    const review = await start(h, 'send_transaction', { to: 'x' }, rid(1));
    await review.shown();
    review.expire();
    const out = review.settle({
      success: false,
      error: { code: 'USER_REJECTED', message: 'User rejected the transaction.' },
    }) as any;
    expect(out.error).toMatchObject({ code: 'USER_REJECTED', details: { status: 'expired' } });
    expect(out.status).toBe('expired');
    expect((await statusOf(h, rid(1))).status).toBe('expired');
  });

  it('an old site without an id also hears details.status expired', async () => {
    const h = harness();
    const entry = await h.life.begin({ method: 'send_transaction', params: {} }, sender(A));
    if (entry.kind !== 'run') throw new Error('expected run');
    entry.review.expire();
    expect(
      entry.review.settle({ success: false, error: { code: 'USER_REJECTED', message: 'x' } })
    ).toEqual({
      success: false,
      error: { code: 'USER_REJECTED', message: 'x', details: { status: 'expired' } },
    });
  });

  it('the page going away closes the unanswered review of that frame only', async () => {
    const h = harness();
    const mine = await start(h, 'send_transaction', { n: 1 }, rid(1), sender(A, 7, 0));
    const sibling = await start(h, 'send_transaction', { n: 2 }, rid(2), sender(A, 7, 2));
    const otherTab = await start(h, 'send_transaction', { n: 3 }, rid(3), sender(A, 8, 0));
    const closed: string[] = [];
    mine.onPageGone(() => closed.push('mine'));
    sibling.onPageGone(() => closed.push('sibling'));
    otherTab.onPageGone(() => closed.push('other'));
    h.life.pageGone(7, 0);
    expect(closed).toEqual(['mine']);
    expect(mine.gone).toBe(true);
    h.life.pageGone(8);
    expect(closed).toEqual(['mine', 'other']);
    mine.settle({ success: false, error: { code: 'USER_REJECTED', message: 'closed' } });
    expect((await statusOf(h, rid(1))).status).toBe('rejected');
  });

  it('a broadcast runs from arrival: page close and cancel never drop it', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const review = await start(h, 'broadcast_only', { signedTx: { from: SIGNER } }, rid(1));
    let closed = false;
    review.onPageGone(() => (closed = true));
    h.life.pageGone(7, 0);
    const cancelled = (await h.life.cancel(sender(A), { rid: rid(1) })) as any;
    expect(cancelled.data.status).toBe('pending');
    expect(closed).toBe(false);
    expect(review.gone).toBe(false);
    review.settle({ success: true, data: { txHash: 'h1' } });
    expect(await statusOf(h, rid(1), A, 21)).toMatchObject({ status: 'submitted', hash: 'h1' });
    h.chain.set('h1', { status: 'confirmed', epoch: 3 });
    await vi.advanceTimersByTimeAsync(LIFECYCLE_LIMITS.fastIntervalMs);
    expect((await statusOf(h, rid(1))).status).toBe('confirmed');
  });

  it('an approved request keeps going after its page closed and keeps its outcome', async () => {
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const review = await start(h, 'call_contract', { c: 1 }, rid(1));
    let closed = false;
    const leave = review.onPageGone(() => (closed = true));
    await review.shown();
    await review.answered(true);
    leave();
    h.life.pageGone(7, 0);
    expect(closed).toBe(false);
    review.settle({ success: true, data: { txHash: 'h1' } });
    expect(await statusOf(h, rid(1), A, 21)).toMatchObject({ status: 'submitted', hash: 'h1' });
  });

  it('a review that has not shown yet when its page left is closed as it opens', async () => {
    const h = harness();
    const review = await start(h, 'signMessage', {}, rid(1));
    h.life.pageGone(7);
    let closed = false;
    review.onPageGone(() => (closed = true));
    await flush();
    expect(closed).toBe(true);
  });
});

describe('cancel', () => {
  it("closes the site's own unanswered review and reads rejected", async () => {
    const h = harness();
    const review = await start(h, 'signMessage', {}, rid(1));
    await review.shown();
    review.onPageGone(() =>
      review.settle({ success: false, error: { code: 'USER_REJECTED', message: 'closed' } })
    );
    const res = (await h.life.cancel(sender(A), { rid: rid(1) })) as any;
    expect(res.data.status).toBe('rejected');
  });

  it("cannot touch another site's request or an approved one", async () => {
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const review = await start(h, 'call_contract', { c: 1 }, rid(1));
    let closed = false;
    review.onPageGone(() => (closed = true));
    await review.shown();
    const other = (await h.life.cancel(sender(B), { rid: rid(1) })) as any;
    expect(other.data.status).toBe('unknown');
    expect(closed).toBe(false);
    await review.answered(true);
    const late = (await h.life.cancel(sender(A), { rid: rid(1) })) as any;
    expect(late.data.status).toBe('signing');
    expect(closed).toBe(false);
  });
});

describe('worker restart', () => {
  it('keeps final records, fails dead reviews and resumes watching submitted txs', async () => {
    vi.useFakeTimers();
    const first = harness();
    first.conns.set(A, { address: SIGNER });
    const done = await start(first, 'signMessage', {}, rid(1));
    done.settle({ success: true, data: { signature: 's' } });
    const dead = await start(first, 'signMessage', { n: 2 }, rid(2));
    await dead.shown();
    const signing = await start(first, 'call_contract', { n: 3 }, rid(3));
    await signing.shown();
    await signing.answered(true);
    const sent = await start(first, 'call_contract', { n: 4 }, rid(4));
    await sent.shown();
    await sent.answered(true);
    sent.settle({ success: true, data: { txHash: 'h4' } });
    await vi.advanceTimersByTimeAsync(0);

    const second = harness(first.store);
    second.conns.set(A, { address: SIGNER });
    second.chain.set('h4', { status: 'confirmed', op_type: 'call' });
    expect((await statusOf(second, rid(1))).status).toBe('completed');
    expect(await statusOf(second, rid(2))).toMatchObject({
      status: 'failed',
      error: { stage: 'review' },
    });
    expect((await statusOf(second, rid(3))).status).toBe('signing');
    const repeat = await second.life.begin(msg('call_contract', { n: 3 }, rid(3)), sender(A));
    expect(repeat).toMatchObject({ response: { error: { code: 'STATUS_UNKNOWN' } } });
    await vi.advanceTimersByTimeAsync(LIFECYCLE_LIMITS.fastIntervalMs);
    expect((await statusOf(second, rid(4))).status).toBe('confirmed');
  });

  it('drops a record whose wallet was swept from session storage', async () => {
    const h = harness();
    h.conns.set(A, { address: SIGNER });
    const review = await start(h, 'signMessage', {}, rid(1));
    review.settle({ success: true, data: { signature: 's' } });
    await flush();
    const keys = [...h.store.keys()].filter((k) => k.includes(SIGNER));
    expect(keys).toHaveLength(1);
    await h.deps.storage.remove(keys);
    expect((await statusOf(h, rid(1))).status).toBe('unknown');
  });

  it('drops a site record on disconnect', async () => {
    const h = harness();
    const review = await start(h, 'signMessage', {}, rid(1));
    review.settle({ success: true, data: { signature: 's' } });
    await h.life.dropOrigin(A);
    expect((await statusOf(h, rid(1))).status).toBe('unknown');
  });
});
