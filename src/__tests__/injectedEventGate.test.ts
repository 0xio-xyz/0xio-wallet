import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

type Sent = { requestId: string; method: string; params: unknown };

const answers = new Map<string, unknown>();
const port = {
  onmessage: null as null | ((e: { data: unknown }) => void),
  start() {},
  postMessage(msg: Sent) {
    const answer = answers.get(msg.method) ?? { success: true, data: null };
    queueMicrotask(() =>
      port.onmessage?.({ data: { requestId: msg.requestId, response: answer } })
    );
  },
};

const sdkEvents: any[] = [];
const heard: string[] = [];
const octra = () => (window as any).octra;
const api = () => (window as any).wallet0xio;
const push = (eventData: unknown) => port.onmessage?.({ data: { type: 'event', eventData } });
const flush = () => new Promise((r) => setTimeout(r, 10));

const sdkRequest = (id: string, method: string) =>
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      data: { source: '0xio-sdk-request', request: { id, method, params: {} } },
    })
  );

beforeAll(async () => {
  window.addEventListener('message', (e) => {
    if (e.data?.source === '0xio-sdk-bridge' && e.data.event) sdkEvents.push(e.data.event);
  });
  await import('../content/injected');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: '0xio-port-init', nonce: 'n' },
      ports: [port as any],
    })
  );
  for (const ev of ['balanceChanged', 'networkChanged', 'transactionChanged', 'disconnect'])
    octra().on(ev, () => heard.push(ev));
});

beforeEach(() => {
  sdkEvents.length = 0;
  heard.length = 0;
});

describe('wallet events in the page', () => {
  it('are dropped while the page is not connected', async () => {
    push({ type: 'balanceChanged', data: { balance: 1 } });
    push({ type: 'networkChanged', data: { networkInfo: { id: 'devnet' } } });
    push({ type: 'transactionConfirmed', data: { txHash: 'h' } });
    push({ type: 'accountChanged', data: { address: 'octX' } });
    await flush();
    expect(heard).toEqual([]);
    expect(sdkEvents).toEqual([]);
    expect(api().address).toBeNull();
  });

  it('still tell an unconnected page it was disconnected', async () => {
    push({ type: 'disconnect', data: {} });
    await flush();
    expect(heard).toEqual(['disconnect']);
    expect(sdkEvents.map((e) => e.type)).toEqual(['disconnect']);
  });

  it('flow once the page connected through window.octra, and stop after disconnect', async () => {
    answers.set('connect', { success: true, data: { address: 'octA' } });
    await octra().request({ method: 'octra_requestAccounts' });
    push({ type: 'balanceChanged', data: { balance: 2 } });
    await flush();
    expect(heard).toEqual(['balanceChanged']);
    expect(sdkEvents.map((e) => e.type)).toEqual(['balanceChanged']);

    push({ type: 'disconnect', data: {} });
    push({ type: 'balanceChanged', data: { balance: 3 } });
    await flush();
    expect(heard).toEqual(['balanceChanged', 'disconnect']);
  });

  it('flow once the page connected through the SDK bridge', async () => {
    answers.set('connect', { success: true, data: { address: 'octS' } });
    sdkRequest('r1', 'connect');
    await flush();
    push({ type: 'transactionConfirmed', data: { txHash: 'h2' } });
    await flush();
    expect(sdkEvents.map((e) => e.type)).toEqual(['transactionConfirmed']);

    answers.set('disconnect', { success: true, data: { disconnected: true } });
    sdkRequest('r2', 'disconnect');
    await flush();
    push({ type: 'transactionConfirmed', data: { txHash: 'h3' } });
    await flush();
    expect(sdkEvents.map((e) => e.type)).toEqual(['transactionConfirmed']);
  });

  it('follow the connection status the SDK reads after a reload', async () => {
    answers.set('getConnectionStatus', { success: true, data: { connected: true } });
    sdkRequest('r3', 'getConnectionStatus');
    await flush();
    push({ type: 'balanceChanged', data: { balance: 4 } });
    await flush();
    expect(heard).toEqual(['balanceChanged']);
  });
});
