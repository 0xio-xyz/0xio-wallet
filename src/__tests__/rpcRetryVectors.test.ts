import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  RPC_GATE_MAX_MS,
  RPC_PAUSES_S,
  RPC_PAUSE_SPREAD,
  RPC_POLL_SLOTS,
  RPC_RETRY_AFTER_CAP_S,
  RPC_RETRY_WINDOW_S,
  RPC_SLOTS,
  RPC_STATE_CHANGED_CODE,
  RpcGate,
  RpcUnsentError,
  retryAfterSeconds,
  rpcExchange,
  rpcFetch,
  rpcPause,
  rpcRepeat,
  rpcRoom,
  rpcStep,
  rpcWindow,
  rpcWrite,
  setRpcTimingForTests,
  type RpcLane,
  type RpcLink,
  type RpcReply,
} from '../services/network/rpcExchange';
import { claimOutputState } from '../services/privacy/claimLedger';

const VECTORS_SHA256 = '6ade7bdb13dffbb4144ba9944a77fcf291c50455826033cb09d1b9131f270a3e';
const copy = resolve(__dirname, 'fixtures/rpc-retry-vectors.json');
const v = JSON.parse(readFileSync(copy, 'utf8'));

describe('rpc retry vectors', () => {
  it('is the shared file', () => {
    expect(createHash('sha256').update(readFileSync(copy)).digest('hex')).toBe(VECTORS_SHA256);
  });

  it('uses the same constants', () => {
    expect(v.constants).toEqual({
      retryWindowSeconds: RPC_RETRY_WINDOW_S,
      retryAfterCapSeconds: RPC_RETRY_AFTER_CAP_S,
      pauseSpread: RPC_PAUSE_SPREAD,
      pausesSeconds: RPC_PAUSES_S,
      stateChangedCode: RPC_STATE_CHANGED_CODE,
      slots: RPC_SLOTS,
      pollSlots: RPC_POLL_SLOTS,
      gateMaxRequestSeconds: RPC_GATE_MAX_MS / 1000,
    });
    for (const m of v.writes) expect(rpcWrite(m), m).toBe(true);
    expect(rpcWrite('octra_balance')).toBe(false);
    expect(rpcWrite('octra_stealthOutputsById')).toBe(false);
  });

  it.each(v.classify as Array<Record<string, any>>)('classify: $name', (c) => {
    const step = rpcStep({ link: c.link as RpcLink, status: c.status ?? 0, body: c.body ?? '' });
    expect({ fault: step.fault, unsent: step.unsent }).toEqual({
      fault: c.fault,
      unsent: c.unsent,
    });
  });

  it.each(v.repeat as Array<Record<string, any>>)(
    'repeat: $fault unsent=$unsent write=$write',
    (c) => {
      expect(rpcRepeat({ fault: c.fault, unsent: c.unsent }, c.write)).toBe(c.repeat);
    }
  );

  it.each(v.pause as Array<Record<string, any>>)(
    'pause: attempt $attempt retryAfter $retryAfter draw $draw',
    (c) => {
      expect(rpcPause(c.attempt, c.retryAfter, c.draw)).toBeCloseTo(c.seconds, 9);
    }
  );

  it.each(v.retryAfterHeader as Array<Record<string, any>>)('Retry-After "$header"', (c) => {
    expect(retryAfterSeconds(c.header)).toBe(c.value);
  });

  it.each(v.window as Array<Record<string, any>>)('window for $requestSeconds s', (c) => {
    expect(rpcWindow(c.requestSeconds)).toBe(c.windowSeconds);
  });

  it.each(v.gateRoom as Array<Record<string, any>>)(
    'gate room: busy $busy polls $polls users $usersWaiting $lane',
    (c) => {
      expect(rpcRoom(c.busy, c.polls, c.usersWaiting, c.lane as RpcLane)).toBe(c.room);
    }
  );

  it.each(v.claimOutput as Array<Record<string, any>>)('claim output: $name', (c) => {
    expect(claimOutputState(c.reply)).toBe(c.state);
  });
});

describe('rpc exchange', () => {
  let clock = 0;
  const waits: number[] = [];
  beforeEach(() => {
    clock = 0;
    waits.length = 0;
    setRpcTimingForTests({
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      random: () => 0,
    });
  });

  const answered = (status: number, body = ''): RpcReply => ({
    link: 'answered',
    status,
    body,
    retryAfter: null,
  });
  const failed = (link: RpcLink): RpcReply => ({ link, status: 0, body: '', retryAfter: null });

  it('retries a read through busy answers, then returns the answer', async () => {
    const replies = [answered(429), answered(502), answered(200, '{"id":1,"result":1}')];
    const sent = await rpcExchange({
      method: 'octra_balance',
      timeoutMs: 30_000,
      send: async () => replies.shift()!,
    });
    expect(sent.reply.status).toBe(200);
    expect(sent.repeated).toBe(true);
    expect(waits).toEqual([250, 500]);
  });

  it('never repeats a write that may have left', async () => {
    const send = vi.fn(async () => failed('broken'));
    const sent = await rpcExchange({ method: 'octra_submit', timeoutMs: 30_000, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent.unsent).toBe(false);
    expect(sent.gaveUp).toBe(false);
  });

  it('repeats a write only while the node says it was not taken', async () => {
    const capacity = '{"jsonrpc":"2.0","id":null,"error":{"code":-32005,"message":"capacity"}}';
    const replies = [answered(429, capacity), answered(200, '{"id":1,"result":{}}')];
    const send = vi.fn(async () => replies.shift()!);
    const sent = await rpcExchange({ method: 'octra_submit', timeoutMs: 30_000, send });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sent.reply.status).toBe(200);
  });

  it('stops at the window and reports the fault', async () => {
    const send = vi.fn(async () => answered(503));
    const sent = await rpcExchange({ method: 'octra_balance', timeoutMs: 120_000, send });
    expect(sent.gaveUp).toBe(true);
    expect(sent.fault).toBe('capacity');
    expect(send).toHaveBeenCalledTimes(10);
    expect(clock).toBe(23_750);
  });

  it('caps Retry-After at five seconds', async () => {
    const replies = [{ ...answered(429), retryAfter: 30 }, answered(200, '{"id":1,"result":1}')];
    await rpcExchange({
      method: 'octra_balance',
      timeoutMs: 30_000,
      send: async () => replies.shift()!,
    });
    expect(waits).toEqual([5000]);
  });

  it('retries a read the node answered mid-change (-32012)', async () => {
    const changed = '{"jsonrpc":"2.0","id":7,"error":{"code":-32012,"message":"changed"}}';
    const replies = [answered(200, changed), answered(200, '{"id":7,"result":1}')];
    const sent = await rpcExchange({
      method: 'octra_encryptedBalance',
      timeoutMs: 30_000,
      send: async () => replies.shift()!,
    });
    expect(sent.reply.body).toContain('"result"');
  });

  it('makes once a single try', async () => {
    const send = vi.fn(async () => answered(429));
    await rpcExchange({ method: 'octra_balance', timeoutMs: 5000, once: true, send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives a read the remaining time after a short first try', async () => {
    const asked: number[] = [];
    const replies = [failed('expired'), answered(200, '{"id":1,"result":1}')];
    await rpcExchange({
      method: 'octra_balance',
      timeoutMs: 60_000,
      firstAttemptMs: 12_000,
      send: async (ms) => {
        asked.push(ms);
        clock += ms;
        return replies.shift()!;
      },
    });
    expect(asked[0]).toBe(12_000);
    expect(asked[1]).toBe(60_000 - 12_000 - 250);
  });
});

describe('rpc gate', () => {
  afterEach(() => {
    vi.useRealTimers();
    setRpcTimingForTests({ now: () => Date.now() });
  });

  it('holds four calls and lets a waiting user go before a poll', async () => {
    const gate = new RpcGate();
    const far = Date.now() + 60_000;
    for (let i = 0; i < 4; i++) expect(await gate.enter('user', far)).toBe(true);
    const order: RpcLane[] = [];
    const poll = gate.enter('poll', far).then((ok) => ok && order.push('poll'));
    const user = gate.enter('user', far).then((ok) => ok && order.push('user'));
    gate.leave('user');
    await user;
    expect(order).toEqual(['user']);
    gate.leave('user');
    await poll;
    expect(order).toEqual(['user', 'poll']);
  });

  it('gives polls at most two slots', async () => {
    const gate = new RpcGate();
    const far = Date.now() + 60_000;
    expect(await gate.enter('poll', far)).toBe(true);
    expect(await gate.enter('poll', far)).toBe(true);
    let third = false;
    void gate.enter('poll', far).then((ok) => (third = ok));
    expect(await gate.enter('user', far)).toBe(true);
    await Promise.resolve();
    expect(third).toBe(false);
    expect(gate.inFlight).toBe(3);
  });

  it('turns a user away when no slot frees in time', async () => {
    vi.useFakeTimers();
    setRpcTimingForTests({ now: () => Date.now() });
    const gate = new RpcGate();
    const far = Date.now() + 60_000;
    for (let i = 0; i < 4; i++) await gate.enter('user', far);
    const late = gate.enter('user', Date.now() + 25_000);
    vi.advanceTimersByTime(25_000);
    expect(await late).toBe(false);
  });
});

describe('rpcFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('treats a fetch TypeError as possibly sent and never repeats a submit', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'octra_submit', params: [{}] });
    await expect(rpcFetch('https://node/rpc', { method: 'POST', body })).rejects.toThrow(
      'Failed to fetch'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a read after a TypeError and hands back the answer', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (n++ === 0) throw new TypeError('Failed to fetch');
        return new Response('{"jsonrpc":"2.0","id":1,"result":5}', { status: 200 });
      })
    );
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'octra_balance', params: [] });
    const res = await rpcFetch('https://node/rpc', { method: 'POST', body });
    expect((await res.json()).result).toBe(5);
  });

  it('reports an unsent write with nothing sent', () => {
    expect(new RpcUnsentError('busy').message).toBe('wallet rpc slots busy; nothing was sent');
  });
});
