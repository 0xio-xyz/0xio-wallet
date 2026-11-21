import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';
import { SELECTOR } from 'src/services/bridge/constants';

vi.mock('src/services/evm/registry', () => ({
  findNetwork: vi.fn(async () => ({ chainId: 1, rpcUrl: 'https://eth.test', name: 'Ethereum' })),
}));

vi.mock('src/services/network/txScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/services/network/txScope')>();
  return {
    ...actual,
    assertTxScope: vi.fn(async () => {}),
    captureTxScope: vi.fn(async (address: string, networkId = 'mainnet') => ({
      ...(await actual.resolveNetworkPin(networkId)),
      address,
    })),
  };
});

import {
  LockFeeRaisedError,
  VAULT_READ_MS,
  cachedBridgeHealth,
  cachedLockFee,
  forgetBridgeHealth,
  lockProgress,
  lockToEth,
} from 'src/services/bridge/bridge';
import { advance, type BridgeTransfer } from 'src/services/bridge/transfers';
import { networkService, setFeeRetrySleepForTests } from 'src/services/network/NetworkService';
import {
  RpcHttpError,
  RpcResponseError,
  TxOutcomeUnknownError,
} from 'src/services/network/txOutcome';

const OCTRA = `${ZeroXIOConfig.NETWORKS.mainnet.rpc_url}/rpc`;
const ETH = 'https://eth.test';
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

type OctraReply = (method: string, params: unknown[], init: RequestInit) => Promise<unknown>;

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => body,
});

let ethPaused = 0n;
let ethDown = false;
let octra: OctraReply;
const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  if (url === ETH) {
    if (ethDown) return reply(500, 'down');
    const data: string = body.params[0].data;
    const value =
      data === SELECTOR.paused
        ? ethPaused
        : data === SELECTOR.mintedToday
          ? 0n
          : data === SELECTOR.allowance
            ? 0n
            : 1_000_000_000_000n;
    return reply(200, { jsonrpc: '2.0', id: 1, result: word(value) });
  }
  if (url === OCTRA) return octra(body.method, body.params, init);
  throw new Error(`unexpected fetch ${url}`);
});

const octraCalls = (method?: string) =>
  fetchMock.mock.calls.filter(
    ([url, init]) => url === OCTRA && (!method || JSON.parse(String(init.body)).method === method)
  ).length;
const ethCalls = () => fetchMock.mock.calls.filter(([url]) => url === ETH).length;

const ok = (result: unknown) => Promise.resolve(reply(200, { jsonrpc: '2.0', id: 1, result }));
const hang = (init: RequestInit) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    );
  });

beforeEach(() => {
  forgetBridgeHealth();
  networkService.forgetFeeQuotes();
  setFeeRetrySleepForTests(async () => {});
  ethPaused = 0n;
  ethDown = false;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  octra = async (method) => {
    if (method === 'contract_call') return ok({ result: '0' });
    if (method === 'octra_recommendedFee')
      return ok({ minimum: '1000', recommended: '3000', fast: '5000' });
    throw new Error(`unexpected ${method}`);
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bridge health ahead of Review', () => {
  it('serves a kept read without new network calls', async () => {
    const first = await cachedBridgeHealth();
    expect(first).toMatchObject({ ethPaused: false, octraPaused: false });
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBe(5);
    const again = await cachedBridgeHealth();
    expect(again).toBe(first);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('shares one read between callers asking at once', async () => {
    const [a, b, c] = await Promise.all([
      cachedBridgeHealth(),
      cachedBridgeHealth(),
      cachedBridgeHealth(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(ethCalls()).toBe(4);
    expect(octraCalls('contract_call')).toBe(1);
  });

  it('reads again after 30 seconds and after a send', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await cachedBridgeHealth();
    vi.setSystemTime(Date.now() + 31_000);
    await cachedBridgeHealth();
    expect(octraCalls('contract_call')).toBe(2);
    forgetBridgeHealth();
    await cachedBridgeHealth();
    expect(octraCalls('contract_call')).toBe(3);
  });

  it('does not keep a failed read', async () => {
    ethDown = true;
    await expect(cachedBridgeHealth()).rejects.toThrow();
    ethDown = false;
    await expect(cachedBridgeHealth()).resolves.toMatchObject({ ethPaused: false });
  });

  it('asks a rate-limited Octra once and calls the pause unknown', async () => {
    octra = async () => reply(429, '<html>429 Too Many Requests</html>');
    const t0 = Date.now();
    const health = await cachedBridgeHealth();
    expect(Date.now() - t0).toBeLessThan(VAULT_READ_MS);
    expect(health.octraPaused).toBeNull();
    expect(octraCalls('contract_call')).toBe(1);
  });

  it('gives a slow Octra read its budget and no more', async () => {
    vi.useFakeTimers();
    octra = async (_m, _p, init) => hang(init);
    let health: Awaited<ReturnType<typeof cachedBridgeHealth>> | null = null;
    void cachedBridgeHealth().then((h) => {
      health = h;
    });
    await vi.advanceTimersByTimeAsync(VAULT_READ_MS - 100);
    expect(health).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(health).toMatchObject({ ethPaused: false, octraPaused: null });
    expect(octraCalls('contract_call')).toBe(1);
  });

  it('tries a rate limited fee read twice more, then keeps the live fee and not a failed read', async () => {
    octra = async () => reply(429, 'busy');
    await expect(cachedLockFee()).resolves.toBeNull();
    expect(octraCalls('octra_recommendedFee')).toBe(3);
    octra = async () => ok({ minimum: '2000', recommended: '4000', fast: '9000' });
    await expect(cachedLockFee()).resolves.toEqual({ minimum: 2000n, recommended: 4000n });
    await cachedLockFee();
    expect(octraCalls('octra_recommendedFee')).toBe(4);
  });

  it('a busy node that answers on the second try gives the fee', async () => {
    let calls = 0;
    octra = async () =>
      ++calls === 1
        ? reply(503, 'busy')
        : ok({ minimum: '3000', recommended: '3000', fast: '3000' });
    await expect(cachedLockFee()).resolves.toEqual({ minimum: 3000n, recommended: 3000n });
    expect(octraCalls('octra_recommendedFee')).toBe(2);
  });
});

describe('lockToEth', () => {
  const to = '0x4647e1fE715c9e23959022C2416C71867F5a6E80';
  const args = {
    from: 'octA',
    privateKey: 'k',
    amountRaw: 2_000_000n,
    ethRecipient: to,
    ouRaw: 3000n,
  };
  let release: ReturnType<typeof vi.spyOn>;
  let build: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(networkService, 'getNextNonce').mockResolvedValue(7);
    release = vi.spyOn(networkService, 'releaseNonce').mockImplementation(() => {});
    build = vi
      .spyOn(networkService, 'buildContractCallTransaction')
      .mockImplementation(async (p) => ({ signed: true, ou: p.ou }) as never);
  });

  const withSubmit = (submit: OctraReply) => {
    octra = async (method, params, init) => {
      if (method === 'octra_recommendedFee')
        return ok({ minimum: '1000', recommended: '3000', fast: '5000' });
      return submit(method, params, init);
    };
  };

  it('signs the reviewed fee', async () => {
    withSubmit(() => ok({ tx_hash: 'h1' }));
    await expect(lockToEth(args)).resolves.toBe('h1');
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ ou: '3000', nonce: 7 }));
  });

  it('asks again when the live minimum rose above the reviewed fee', async () => {
    octra = async () => ok({ minimum: '5000', recommended: '6000', fast: '9000' });
    const e = await lockToEth(args).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LockFeeRaisedError);
    expect((e as LockFeeRaisedError).ouRaw).toBe(6000n);
    expect(build).not.toHaveBeenCalled();
    expect(octraCalls('octra_submit')).toBe(0);
  });

  it('a rate-limited submit was not sent and frees its nonce', async () => {
    withSubmit(async () => reply(429, 'Too Many Requests'));
    const e = await lockToEth(args).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcHttpError);
    expect(release).toHaveBeenCalledWith('octA', 7, 'mainnet');
  });

  it('a node refusal frees its nonce', async () => {
    withSubmit(() =>
      Promise.resolve(reply(200, { jsonrpc: '2.0', id: 1, error: { message: 'bad nonce' } }))
    );
    await expect(lockToEth(args)).rejects.toBeInstanceOf(RpcResponseError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a lost answer may have gone through and keeps its nonce', async () => {
    withSubmit(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(lockToEth(args)).rejects.toBeInstanceOf(TxOutcomeUnknownError);
    expect(release).not.toHaveBeenCalled();
  });

  it('a gateway timeout may have gone through', async () => {
    withSubmit(async () => reply(504, 'Gateway Timeout'));
    await expect(lockToEth(args)).rejects.toBeInstanceOf(TxOutcomeUnknownError);
    expect(release).not.toHaveBeenCalled();
  });
});

describe('an unanswered lock', () => {
  const VAULT = 'oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq';
  const sentAt = 1_800_000_000_000;
  const transfer = (extra: Partial<BridgeTransfer> = {}): BridgeTransfer => ({
    id: 'o2e-1',
    direction: 'o2e',
    amountRaw: '2000000',
    octAddress: 'octA',
    evmAddress: '0xE',
    recipient: '0xE',
    createdAt: sentAt,
    updatedAt: sentAt,
    status: 'locking',
    note: 'unanswered',
    ...extra,
  });

  it('is found on Octra by address and amount', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(sentAt + 30_000);
    const rpc = vi.spyOn(networkService, 'jsonRpcCall').mockImplementation(async (method) => {
      if (method === 'octra_transactionsByAddress')
        return {
          transactions: [
            {
              hash: 'other',
              to_: VAULT,
              encrypted_data: 'lock_to_eth',
              amount: '9000000',
              timestamp: sentAt / 1000,
            },
            {
              hash: 'mine',
              to_: VAULT,
              encrypted_data: 'lock_to_eth',
              amount: '2000000',
              timestamp: sentAt / 1000 + 2,
              status: 'pending',
            },
          ],
        };
      return null;
    });
    await expect(advance(transfer())).resolves.toEqual({ lockHash: 'mine', note: undefined });
    expect(rpc).not.toHaveBeenCalledWith('octra_transaction', expect.anything(), true);
  });

  it('reads a history amount in whole OCT too', async () => {
    vi.spyOn(networkService, 'jsonRpcCall').mockImplementation(async (method: string) =>
      method === 'octra_transactionsByAddress'
        ? {
            transactions: [
              {
                hash: 'mine',
                to_: VAULT,
                encrypted_data: 'lock_to_eth',
                amount: '2.0',
                timestamp: 1,
              },
            ],
          }
        : null
    );
    await expect(lockProgress(null, 'octA', 1000, 2_000_000n)).resolves.toEqual({
      state: 'pending',
      hash: 'mine',
    });
  });

  it('stays followed for 15 minutes, then reads as not found', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({ transactions: [] });
    vi.setSystemTime(sentAt + 5 * 60_000);
    await expect(advance(transfer())).resolves.toBeNull();
    vi.setSystemTime(sentAt + 16 * 60_000);
    await expect(advance(transfer())).resolves.toEqual({ status: 'failed', note: 'not_found' });
  });
});
