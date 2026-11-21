import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';
import { TransactionQueue } from 'src/background/services/txQueue';

const NET = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;
const ACTIVE = ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET;
const A = 'oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB';
const SIGNED = {
  from: A,
  to_: 'oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F',
  amount: '1000000',
  nonce: 7,
  ou: '1000',
  timestamp: 1762300000.123,
  op_type: 'standard',
  public_key: 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=',
  signature:
    'VBORX2a2r6uAlv2W0EPFqTp4sNf2+QL0CzPyAaqTrjYbe8qczkMrpqXMqMLFmEA02yiUIe26DqdmWcs2LQNCCw==',
};
const HASH = 'f802c9eed1384aa62879c871ab3ccba84f536866dfa5373dd09f549a77aed8d9';

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const fetchMock = vi.fn();

const store = (m: Map<string, unknown>) => ({
  get: async (keys?: string | string[] | null) => {
    if (keys == null) return Object.fromEntries(m);
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => m.has(k)).map((k) => [k, m.get(k)]));
  },
  set: async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) m.set(k, structuredClone(v));
  },
  remove: async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k);
  },
});

const reply = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

beforeEach(() => {
  local.clear();
  session.clear();
  local.set(NET, 'mainnet');
  local.set(ACTIVE, A);
  (chrome.storage as any).local = store(local);
  (chrome.storage as any).session = store(session);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

const send = async (q: TransactionQueue) => {
  q.sleep = async () => undefined;
  const { broadcastResult } = await q.add({
    txId: 't1',
    type: 'broadcast_only',
    opType: 'transfer',
    signedTransaction: { ...SIGNED },
    from: A,
  });
  return broadcastResult;
};

describe('queued submit verdicts', () => {
  it('resends the same signed bytes while the node allows it, then stops', async () => {
    fetchMock.mockImplementation(async () =>
      reply(200, { jsonrpc: '2.0', id: 1, error: { code: 117, message: 'busy' } })
    );
    const result = await send(new TransactionQueue());
    expect(result).toMatchObject({ success: false, errorType: 'not_accepted' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).params[0]);
    expect(bodies.every((b) => JSON.stringify(b) === JSON.stringify(SIGNED))).toBe(true);
  });

  it('stops at a used nonce and notes it for every context', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { jsonrpc: '2.0', id: 1, error: { code: 112, message: 'nonce used' } })
    );
    const result = await send(new TransactionQueue());
    expect(result).toMatchObject({
      success: false,
      errorType: 'nonce_used',
      error: 'Nonce already used',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.get(`nonce_used_mainnet:${A}`)).toMatchObject({ nonce: 7 });
  });

  it('says a transaction is too large on HTTP 413 without retrying', async () => {
    fetchMock.mockResolvedValue(reply(413, '<html>413</html>'));
    const result = await send(new TransactionQueue());
    expect(result).toMatchObject({ success: false, errorType: 'too_large' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown outcome, never a failure, when no verdict comes back', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await send(new TransactionQueue());
    expect(result).toMatchObject({ success: false, outcomeUnknown: true });
    expect(result?.errorType).toBeUndefined();
    const pending = [...local.entries()].find(([k]) => k.startsWith('pending_tx_'))?.[1] as any;
    expect(pending?.status).not.toBe('failed');
  });

  it('a verdict is a failure with no unknown outcome', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { jsonrpc: '2.0', id: 1, error: { code: 105, message: 'bad signature' } })
    );
    const result = await send(new TransactionQueue());
    expect(result).toMatchObject({ success: false, errorType: 'rejected' });
    expect(result).not.toHaveProperty('outcomeUnknown');
  });

  it("tracks the node's hash, else the local one", async () => {
    fetchMock.mockResolvedValue(
      reply(200, { jsonrpc: '2.0', id: 1, result: { status: 'accepted' } })
    );
    expect(await send(new TransactionQueue())).toMatchObject({ success: true, txHash: HASH });
  });
});
