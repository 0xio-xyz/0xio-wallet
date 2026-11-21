import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const rpc = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
vi.mock('../features/wallet/nft/knownCollections', () => ({ fetchJson: list }));
vi.mock('../services/network/NetworkService', () => ({
  networkService: { jsonRpcCall: rpc },
  privacyNetworkService: {},
}));

import {
  ONS_BUSY_CODE,
  ONS_NAME_MAX,
  ONS_PAGE_SIZE,
  ONS_YEARS_MAX,
  ONS_YEARS_MIN,
  emptyTargetReason,
  isNameInput,
  isNameService,
  normalizeName,
  onsErrorCode,
  onsListNetwork,
  parseCount,
  parseFeed,
  parseKind,
  parseName,
  parseNameInfo,
  parseNameList,
  parseNames,
  parsePrice,
  parseResolve,
  parseStatus,
  parseTarget,
} from '../utils/octra/ons';
import {
  ONS_FORWARD_TTL_MS,
  ONS_LAST_GOOD_KEY,
  ONS_LIST_TTL_MS,
  ONS_LIST_URL,
  ONS_PRIMARY_TTL_MS,
  ONS_RETRY_MS,
  clearOnsCache,
  forgetOnsContracts,
  loadOnsContract,
  namesOf,
  onsBusyRetry,
  onsContract,
  primaryName,
  priceOf,
  resolveCircle,
  resolveWallet,
  subscribeOnsContract,
} from '../services/names/ons';
import { RpcResponseError } from '../services/network/txOutcome';
import { clearSessionCaches } from '../utils/sessionCaches';
import type { NetworkPin } from '../services/network/txScope';

const VECTORS_SHA256 = '6c4058f9e9c4b9e578c4c5997fe204841136b014ef73079b09a2798054bed4ff';

const copy = resolve(__dirname, 'fixtures/ons-vectors.json');
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const vectors = JSON.parse(readFileSync(copy, 'utf8'));

const DEVNET: NetworkPin = { networkId: 'devnet', rpcUrl: 'https://devnet.octrascan.io' };
const MAINNET: NetworkPin = { networkId: 'mainnet', rpcUrl: 'https://octra.network' };
const CONTRACT = vectors.contracts.devnet as string;
const BUSY = { code: ONS_BUSY_CODE, message: 'Program view busy' };
const INFO = vectors.parse.nameService[0].raw as string;
const listing = (address: string, network = 'devnet') => ({
  services: [{ network, address, name: 'Octra Name System', symbol: 'ONS', suffix: '.oct' }],
});
const kept = vi.mocked(chrome.storage.local.get);
const keep = vi.mocked(chrome.storage.local.set);
const keptGood = (value: Record<string, unknown>) =>
  kept.mockResolvedValue({ [ONS_LAST_GOOD_KEY]: value } as never);

interface Reply {
  method: string;
  params: string[];
  result?: string;
  error?: { code?: number; message: string };
}

function script(replies: Reply[]): Reply[] {
  const queue = [...replies];
  rpc.mockImplementation(async () => {
    const next = queue.shift();
    if (!next) throw new Error('no reply scripted');
    if (next.error) throw new RpcResponseError(next.error.message, next.error);
    return { result: next.result };
  });
  return queue;
}

const calls = () => rpc.mock.calls.map(([, params]) => ({ method: params[1], params: params[2] }));

const run = (call: string, args: unknown[], at: NetworkPin): Promise<unknown> => {
  const [first, second] = args as [string, number];
  switch (call) {
    case 'resolveWallet':
      return resolveWallet(first, { at });
    case 'resolveCircle':
      return resolveCircle(first, { at });
    case 'primaryName':
      return primaryName(first, { at });
    case 'priceOf':
      return priceOf(first, second, { at });
    case 'namesOf':
      return namesOf(first, { at });
    default:
      throw new Error(`unknown call ${call}`);
  }
};

const savedDelays = onsBusyRetry.delaysMs;

async function prime(): Promise<void> {
  list.mockResolvedValue(listing(CONTRACT));
  rpc.mockResolvedValue({ result: INFO });
  await loadOnsContract(DEVNET);
  rpc.mockReset();
  keep.mockClear();
}

beforeEach(async () => {
  rpc.mockReset();
  list.mockReset();
  kept.mockReset().mockResolvedValue({} as never);
  keep.mockReset().mockResolvedValue(undefined as never);
  clearOnsCache();
  forgetOnsContracts();
  onsBusyRetry.delaysMs = savedDelays.map(() => 0);
  await prime();
});

afterEach(() => {
  onsBusyRetry.delaysMs = savedDelays;
  vi.useRealTimers();
});

describe('ONS shared vectors', () => {
  it('is the same file every client runs', () => {
    expect(sha256(copy)).toBe(VECTORS_SHA256);
  });

  it('carries the contract table and the limits', () => {
    for (const [network, contract] of Object.entries(vectors.contracts))
      expect(onsContract(network), network).toBe(contract);
    expect(onsContract('custom_1')).toBeNull();
    expect(onsContract('constructor')).toBeNull();
    expect(ONS_LIST_URL).toBe(vectors.nameList.url);
    for (const [network, listedAs] of Object.entries(vectors.nameList.listedAs))
      expect(onsListNetwork(network), network).toBe(listedAs);
    expect(ONS_NAME_MAX).toBe(vectors.limits.nameMax);
    expect(ONS_PAGE_SIZE).toBe(vectors.limits.pageSize);
    expect(ONS_YEARS_MIN).toBe(vectors.limits.yearsMin);
    expect(ONS_YEARS_MAX).toBe(vectors.limits.yearsMax);
    expect(ONS_YEARS_MAX).toBe(5);
    expect(ONS_BUSY_CODE).toBe(vectors.limits.busyCode);
    expect(ONS_FORWARD_TTL_MS).toBe(vectors.limits.forwardTtlMs);
    expect(ONS_PRIMARY_TTL_MS).toBe(vectors.limits.primaryTtlMs);
    expect(savedDelays).toEqual(vectors.limits.busyRetryDelaysMs);
  });

  it('reads the name list strictly', () => {
    for (const v of vectors.nameList.parse)
      expect(parseNameList(v.list), JSON.stringify(v.list)).toEqual(v.expect);
  });

  it('normalises names', () => {
    for (const v of vectors.normalize) {
      const expected = 'name' in v ? { ok: true, name: v.name } : { ok: false, invalid: v.invalid };
      expect(normalizeName(v.input), JSON.stringify(v.input)).toEqual(expected);
    }
  });

  it('tells name input from other text', () => {
    for (const v of vectors.isNameInput)
      expect(isNameInput(v.input), JSON.stringify(v.input)).toBe(v.expect);
  });

  it('parses each reply', () => {
    const parsers: Record<string, (raw: string) => unknown> = {
      status: parseStatus,
      kind: parseKind,
      target: parseTarget,
      name: parseName,
      nameInfo: parseNameInfo,
      names: parseNames,
      nameService: isNameService,
      resolve: parseResolve,
      count: parseCount,
      price: parsePrice,
      feed: parseFeed,
    };
    expect(Object.keys(vectors.parse).sort()).toEqual(Object.keys(parsers).sort());
    for (const [kind, cases] of Object.entries<{ raw: string; expect: unknown }[]>(vectors.parse))
      for (const v of cases)
        expect(parsers[kind](v.raw), `${kind} ${JSON.stringify(v.raw)}`).toEqual(v.expect);
  });

  it('explains an empty target', () => {
    for (const v of vectors.emptyTargetReason)
      expect(emptyTargetReason(v.target, v.status, v.kind), JSON.stringify(v)).toBe(v.expect);
  });

  it('maps node and contract errors', () => {
    for (const v of vectors.errors)
      expect(onsErrorCode(v.message, v.code), JSON.stringify(v)).toBe(v.expect);
  });

  for (const s of vectors.scenarios) {
    it(`scenario: ${s.name}`, async () => {
      const left = script(s.replies);
      const at = s.network === 'devnet' ? DEVNET : MAINNET;
      expect(await run(s.call, s.args, at)).toEqual(s.expect);
      expect(calls()).toEqual(
        s.replies.map((r: Reply) => ({ method: r.method, params: r.params }))
      );
      expect(left).toEqual([]);
      for (const [method, params, quiet, pin] of rpc.mock.calls) {
        expect(method).toBe('contract_call');
        expect([params[0], params[3]]).toEqual([CONTRACT, CONTRACT]);
        expect(quiet).toBe(true);
        expect(pin).toBe(at);
      }
    });
  }
});

describe('ONS reads', () => {
  const A = vectors.scenarios[0].expect.address as string;
  const B = vectors.parse.nameInfo[0].expect.wallet as string;
  const walletOf = (address: string): Reply => ({
    method: 'resolve',
    params: ['0xio'],
    result: address ? `2|${address}` : '0|',
  });

  it('reads the stored network when none is given, and mainnet has no contract', async () => {
    script([]);
    expect(await resolveWallet('0xio.oct')).toEqual({ ok: false, reason: 'not_available' });
    expect(await resolveCircle('0xio.oct')).toEqual({ ok: false, reason: 'not_available' });
    expect(await primaryName(A)).toEqual({ ok: false, reason: 'not_available' });
    expect(await namesOf(A)).toEqual({ ok: false, reason: 'not_available' });
    expect(await priceOf('0xio.oct', 1)).toEqual({ ok: false, reason: 'not_available' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps a resolution for 60 seconds and no longer', async () => {
    vi.useFakeTimers();
    script([walletOf(A), walletOf(B)]);
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toMatchObject({ address: A });
    vi.advanceTimersByTime(ONS_FORWARD_TTL_MS - 1);
    expect(await resolveWallet('0XIO.oct', { at: DEVNET })).toMatchObject({ address: A });
    expect(rpc).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toMatchObject({ address: B });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('asks the node again at confirm and keeps the new answer', async () => {
    script([walletOf(A), walletOf(B)]);
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toMatchObject({ address: A });
    expect(await resolveWallet('0xio.oct', { at: DEVNET, fresh: true })).toMatchObject({
      address: B,
    });
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toMatchObject({ address: B });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('a fresh read that fails does not fall back to the kept answer', async () => {
    script([walletOf(A), { method: 'resolve', params: ['0xio'], error: { message: 'down' } }]);
    await resolveWallet('0xio.oct', { at: DEVNET });
    expect(await resolveWallet('0xio.oct', { at: DEVNET, fresh: true })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('keeps wallet and Circle lookups of one name apart', async () => {
    script([walletOf(A), { method: 'resolve', params: ['0xio'], result: `1|${B}` }]);
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toMatchObject({ address: A });
    expect(await resolveCircle('0xio.oct', { at: DEVNET })).toMatchObject({ circleId: B });
  });

  it('keeps a contract answer of "not registered" but never a busy or failed read', async () => {
    script([
      walletOf(''),
      { method: 'status_of', params: ['0xio'], result: '0' },
      { method: 'resolve', params: ['0xio-labs'], error: BUSY },
      { method: 'resolve', params: ['0xio-labs'], error: BUSY },
      { method: 'resolve', params: ['0xio-labs'], error: BUSY },
      { method: 'resolve', params: ['0xio-labs'], result: `2|${A}` },
    ]);
    const missing = { ok: false, reason: 'not_registered' };
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toEqual(missing);
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toEqual(missing);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(await resolveWallet('0xio-labs.oct', { at: DEVNET })).toEqual({
      ok: false,
      reason: 'busy',
    });
    expect(await resolveWallet('0xio-labs.oct', { at: DEVNET })).toMatchObject({ address: A });
  });

  it('shares one request between identical reads in flight', async () => {
    script([walletOf(A)]);
    const [one, two] = await Promise.all([
      resolveWallet('0xio.oct', { at: DEVNET }),
      resolveWallet('0xio.oct', { at: DEVNET }),
    ]);
    expect(one).toEqual(two);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('waits one then two seconds before asking a busy node again', async () => {
    vi.useFakeTimers();
    onsBusyRetry.delaysMs = savedDelays;
    script([
      { method: 'resolve', params: ['0xio'], error: BUSY },
      { method: 'resolve', params: ['0xio'], error: BUSY },
      walletOf(A),
    ]);
    const pending = resolveWallet('0xio.oct', { at: DEVNET });
    await vi.advanceTimersByTimeAsync(999);
    expect(rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(rpc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ address: A });
  });

  it('refuses a reply that is not text', async () => {
    rpc.mockResolvedValue({ result: 7 });
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toEqual({
      ok: false,
      reason: 'bad_reply',
    });
  });

  it('keeps a primary name, or the lack of one, for ten minutes', async () => {
    vi.useFakeTimers();
    const primaryOf = (address: string, result: string): Reply => ({
      method: 'primary_of',
      params: [address],
      result,
    });
    script([primaryOf(A, '0xio'), primaryOf(B, ''), primaryOf(A, '')]);
    expect(await primaryName(A, { at: DEVNET })).toEqual({ ok: true, name: '0xio' });
    expect(await primaryName(B, { at: DEVNET })).toEqual({ ok: true, name: null });
    vi.advanceTimersByTime(ONS_PRIMARY_TTL_MS - 1);
    expect(await primaryName(A, { at: DEVNET })).toEqual({ ok: true, name: '0xio' });
    expect(await primaryName(B, { at: DEVNET })).toEqual({ ok: true, name: null });
    expect(rpc).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(await primaryName(A, { at: DEVNET })).toEqual({ ok: true, name: null });
  });

  it('empties with the session caches', async () => {
    script([walletOf(A), walletOf(B)]);
    await resolveWallet('0xio.oct', { at: DEVNET });
    clearSessionCaches();
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toMatchObject({ address: B });
  });

  it('takes a wallet only from a resolve reply of kind 2', async () => {
    for (const result of ['0|', `1|${A}`, '1|', '2|']) {
      clearOnsCache();
      script([
        { method: 'resolve', params: ['0xio'], result },
        { method: 'status_of', params: ['0xio'], result: '1' },
      ]);
      expect((await resolveWallet('0xio.oct', { at: DEVNET })).ok, result).toBe(false);
    }
    for (const result of ['', '2', A, `2|${A}|`, `2|${A} `, `4|${A}`, `0|${A}`, '2|0xio']) {
      clearOnsCache();
      rpc.mockReset();
      script([{ method: 'resolve', params: ['0xio'], result }]);
      expect(await resolveWallet('0xio.oct', { at: DEVNET }), result).toEqual({
        ok: false,
        reason: 'bad_reply',
      });
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  });

  it('never asks the contract for a price beyond five years', async () => {
    script([{ method: 'price_of', params: ['0xio', '5'], result: '1208000000' }]);
    expect(await priceOf('0xio.oct', 5, { at: DEVNET })).toMatchObject({ ok: true });
    for (const years of [0, 6, 10])
      expect(await priceOf('0xio.oct', years, { at: DEVNET })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, []],
    [1, ['0']],
    [50, ['0']],
    [51, ['0', '50']],
    [100, ['0', '50']],
    [101, ['0', '50', '100']],
  ])('pages %i names 50 at a time', async (count, offsets) => {
    const held = Array.from({ length: count }, (_, i) => `n${i + 1}`);
    script([
      { method: 'balance_of', params: [A], result: String(count) },
      ...offsets.map(
        (offset): Reply => ({
          method: 'names_of',
          params: [A, offset, '50'],
          result: held.slice(Number(offset), Number(offset) + 50).join(','),
        })
      ),
      ...held.flatMap((name, i): Reply[] => [
        { method: 'get_name_info', params: [name], result: `${i}|${name}|${A}|1825920325|0|||0` },
        { method: 'status_of', params: [name], result: '1' },
      ]),
    ]);
    const result = await namesOf(A, { at: DEVNET });
    expect(result.ok && result.names.map((n) => n.name)).toEqual(held);
    expect(result.ok && result.names.map((n) => n.tokenId)).toEqual(held.map((_, i) => String(i)));
    expect(calls().filter((c) => c.method === 'names_of')).toEqual(
      offsets.map((offset) => ({ method: 'names_of', params: [A, offset, '50'] }))
    );
    expect(calls().some((c) => c.method === 'name_of_token' || c.method === 'tokens_of')).toBe(
      false
    );
  });

  it('stops paging at an empty or short page, whatever the count says', async () => {
    script([
      { method: 'balance_of', params: [A], result: '3' },
      { method: 'names_of', params: [A, '0', '50'], result: '' },
    ]);
    expect(await namesOf(A, { at: DEVNET })).toEqual({ ok: true, names: [] });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe('ONS contract', () => {
  const OTHER = vectors.parse.nameInfo[0].expect.wallet as string;
  const info = (result: string): Reply => ({ method: 'get_contract_info', params: [], result });

  beforeEach(() => {
    forgetOnsContracts();
    list.mockReset();
  });

  it('takes the address from the list, checks it on chain once and keeps it', async () => {
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO)]);
    expect(onsContract('devnet')).toBeNull();
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'on', address: CONTRACT });
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'on', address: CONTRACT });
    expect(onsContract('devnet')).toBe(CONTRACT);
    expect(keep).toHaveBeenCalledWith({ [ONS_LAST_GOOD_KEY]: { devnet: CONTRACT } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(ONS_LIST_URL);
    expect(calls()).toEqual([{ method: 'get_contract_info', params: [] }]);
    expect(rpc.mock.calls[0][1][0]).toBe(CONTRACT);
  });

  it.each([
    ['no entry for the network', listing(CONTRACT, 'mainnet')],
    [
      'two entries for the network',
      { services: [...listing(CONTRACT).services, ...listing(OTHER).services] },
    ],
    ['a bad address', listing('oct123')],
    ['another suffix', { services: [{ network: 'devnet', address: CONTRACT, suffix: '.eth' }] }],
  ])('has no names with %s, whatever was kept before', async (_, body) => {
    keptGood({ devnet: CONTRACT });
    list.mockResolvedValue(body);
    script([]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'off' });
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toEqual({
      ok: false,
      reason: 'not_available',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['another name', 'Other Name System|ONS|2||6'],
    ['another interface', 'Octra Name System|ONS|2||7'],
    ['four fields', 'Octra Name System|ONS|2|6'],
    ['nothing', ''],
  ])('has no names when the contract answers %s', async (_, reply) => {
    list.mockResolvedValue(listing(CONTRACT));
    script([info(reply)]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'off' });
    expect(onsContract('devnet')).toBeNull();
    expect(keep).not.toHaveBeenCalled();
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'off' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('has no names when the contract refuses the check', async () => {
    list.mockResolvedValue(listing(CONTRACT));
    script([
      {
        method: 'get_contract_info',
        params: [],
        error: { code: -32000, message: 'execution reverted' },
      },
    ]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'off' });
  });

  it.each([
    ['busy', BUSY, 3],
    ['down', { message: 'RPC HTTP error: 502' }, 1],
  ])('does not know yet when the node is %s, and asks again later', async (_, error, asks) => {
    vi.useFakeTimers();
    list.mockResolvedValue(listing(CONTRACT));
    rpc.mockRejectedValue(new RpcResponseError(error.message, error));
    const first = loadOnsContract(DEVNET);
    await vi.runAllTimersAsync();
    expect(await first).toEqual({ state: 'unknown' });
    expect(onsContract('devnet')).toBeNull();
    expect(keep).not.toHaveBeenCalled();
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(rpc).toHaveBeenCalledTimes(asks);
    script([info(INFO)]);
    vi.advanceTimersByTime(ONS_RETRY_MS - 1);
    expect((await loadOnsContract(DEVNET)).state).toBe('unknown');
    vi.advanceTimersByTime(1);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'on', address: CONTRACT });
  });

  it('uses the last good address when the list cannot be reached, after checking it', async () => {
    keptGood({ devnet: CONTRACT });
    list.mockRejectedValue(new Error('offline'));
    script([info(INFO)]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'on', address: CONTRACT });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not pass a last good address that fails the check', async () => {
    keptGood({ devnet: CONTRACT });
    list.mockRejectedValue(new Error('offline'));
    script([info('Octra Name System|ONS|0||5')]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'off' });
  });

  it.each([
    ['the list cannot be reached', () => list.mockRejectedValue(new Error('offline'))],
    ['the list is not a list', () => list.mockResolvedValue('not json')],
    [
      'the kept address is not an address',
      () => {
        keptGood({ devnet: '0xio' });
        list.mockRejectedValue(new Error('offline'));
      },
    ],
    [
      'the kept address is of another network',
      () => {
        keptGood({ mainnet: CONTRACT });
        list.mockRejectedValue(new Error('offline'));
      },
    ],
  ])('has no names when %s and nothing good was kept', async (_, arrange) => {
    arrange();
    script([]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'off' });
    expect(await primaryName(OTHER, { at: DEVNET })).toEqual({
      ok: false,
      reason: 'not_available',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reads the list once per thirty minutes, and sooner after a failed read', async () => {
    vi.useFakeTimers();
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO)]);
    await loadOnsContract(DEVNET);
    vi.advanceTimersByTime(ONS_LIST_TTL_MS - 1);
    await loadOnsContract(DEVNET);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockRejectedValue(new Error('offline'));
    vi.advanceTimersByTime(1);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'on', address: CONTRACT });
    expect(list).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(ONS_RETRY_MS);
    await loadOnsContract(DEVNET);
    expect(list).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('drops the old contract when the list names another, and checks the new one', async () => {
    vi.useFakeTimers();
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO), info('Other Name System|ONS|0||6'), info(INFO)]);
    await loadOnsContract(DEVNET);
    keep.mockClear();
    list.mockResolvedValue(listing(OTHER));
    vi.advanceTimersByTime(ONS_LIST_TTL_MS);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'off' });
    expect(onsContract('devnet')).toBeNull();
    expect(keep).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ONS_LIST_TTL_MS);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: 'on', address: OTHER });
    expect(keep).toHaveBeenCalledWith({ [ONS_LAST_GOOD_KEY]: { devnet: OTHER } });
    expect(rpc.mock.calls.map(([, params]) => params[0])).toEqual([CONTRACT, OTHER, OTHER]);
  });

  it('stops a send at confirm when the listed contract changed since the name was typed', async () => {
    vi.useFakeTimers();
    const A = vectors.scenarios[0].expect.address as string;
    const resolved = (): Reply => ({ method: 'resolve', params: ['0xio'], result: `2|${A}` });
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO), resolved(), info(INFO), resolved(), resolved()]);
    expect(await resolveWallet('0xio.oct', { at: DEVNET })).toMatchObject({
      address: A,
      contract: CONTRACT,
    });
    list.mockResolvedValue(listing(OTHER));
    vi.advanceTimersByTime(ONS_LIST_TTL_MS);
    expect(await resolveWallet('0xio.oct', { at: DEVNET, fresh: true })).toEqual({
      ok: false,
      reason: 'service_changed',
    });
    expect(await resolveWallet('0xio.oct', { at: DEVNET, fresh: true })).toMatchObject({
      address: A,
      contract: OTHER,
    });
    expect(rpc.mock.calls.map(([, params]) => params[0])).toEqual([
      CONTRACT,
      CONTRACT,
      OTHER,
      OTHER,
      OTHER,
    ]);
  });

  it('tells every listener when the contract of a network becomes known or is dropped', async () => {
    const heard = vi.fn();
    const stop = subscribeOnsContract(heard);
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO)]);
    await loadOnsContract(DEVNET);
    expect(heard).toHaveBeenCalledTimes(1);
    forgetOnsContracts();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});
