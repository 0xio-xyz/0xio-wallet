import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetSentReportsForTests,
  reportBody,
  reportBridge,
  type BridgeReport,
} from 'src/services/bridge/track';

const OCT = 'oct' + 'A'.repeat(44);
const ETH = '0x4647e1fE715c9e23959022C2416C71867F5a6E80';
const EVM_HASH = '0x' + 'ab'.repeat(32);
const OCT_HASH = 'cd'.repeat(32);

const burn: BridgeReport = {
  kind: 'burn',
  txHash: EVM_HASH,
  amountRaw: 2_500_000n,
  octraAddr: OCT,
  ethAddr: ETH,
};

const realFetch = globalThis.fetch;
let store: Record<string, unknown> = {};
const fetchMock = vi.fn(async () => new Response('{"status":"ok"}'));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store = {};
  forgetSentReportsForTests();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(chrome.storage.local.get).mockImplementation((async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, store[k]]))) as never);
  vi.mocked(chrome.storage.local.set).mockImplementation((async (v: Record<string, unknown>) => {
    Object.assign(store, v);
  }) as never);
});

afterEach(() => {
  vi.stubGlobal('fetch', realFetch);
});

describe('bridge stats report body', () => {
  it('sends what the bridge site sends plus the source, nothing else', () => {
    expect(reportBody(burn)).toEqual({
      event_type: 'burn',
      direction: 'e2o',
      octra_addr: OCT,
      eth_addr: ETH.toLowerCase(),
      amount_raw: '2500000',
      amount_display: '2.5',
      tx_hash: EVM_HASH,
      source: 'extension',
    });
  });

  it('maps every kind to its direction and hash format', () => {
    expect(
      reportBody({
        kind: 'lock',
        txHash: OCT_HASH,
        amountRaw: 1_000_000n,
        octraAddr: OCT,
        ethAddr: ETH,
      })
    ).toMatchObject({ direction: 'o2e', tx_hash: OCT_HASH, amount_display: '1' });
    expect(
      reportBody({ kind: 'lock', txHash: EVM_HASH, amountRaw: 1n, octraAddr: OCT, ethAddr: ETH })
    ).toBeNull();
    expect(
      reportBody({ kind: 'claim', txHash: EVM_HASH, amountRaw: 1n, ethAddr: ETH })
    ).toMatchObject({
      direction: 'o2e',
    });
    expect(
      reportBody({ kind: 'claim', txHash: EVM_HASH, amountRaw: 1n, ethAddr: ETH })
    ).not.toHaveProperty('octra_addr');
    expect(reportBody({ ...burn, kind: 'any_swap' })).toMatchObject({ direction: 'a2o' });
  });

  it('refuses anything outside the oracle formats', () => {
    expect(reportBody({ ...burn, amountRaw: 0n })).toBeNull();
    expect(reportBody({ ...burn, amountRaw: 10n ** 16n })).toBeNull();
    expect(reportBody({ ...burn, txHash: '0x1234' })).toBeNull();
    expect(reportBody({ ...burn, ethAddr: 'octX' })).toBeNull();
    expect(reportBody({ ...burn, octraAddr: 'oct0' })).toBeNull();
    expect(reportBody({ ...burn, octraAddr: undefined })).toBeNull();
  });
});

describe('bridge stats report', () => {
  it('posts once per transfer, without a key, on mainnet only', async () => {
    reportBridge(burn, 'devnet');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    reportBridge(burn, 'mainnet');
    reportBridge(burn, 'mainnet');
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oracle.0xio.xyz/api/bridge/event');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toMatchObject({ source: 'extension', tx_hash: EVM_HASH });

    forgetSentReportsForTests();
    reportBridge(burn, 'mainnet');
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when the oracle is down', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(() => reportBridge(burn, 'mainnet')).not.toThrow();
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
