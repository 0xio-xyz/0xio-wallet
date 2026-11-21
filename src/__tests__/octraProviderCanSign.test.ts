import { beforeAll, describe, expect, it, vi } from 'vitest';

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
const octra = () => (window as any).octra;
const api = () => (window as any).wallet0xio;
const push = (eventData: unknown) => port.onmessage?.({ data: { type: 'event', eventData } });

beforeAll(async () => {
  window.addEventListener('message', (e) => {
    if (e.data?.source === '0xio-sdk-bridge' && e.data.event) sdkEvents.push(e.data);
  });
  await import('../content/injected');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: '0xio-port-init', nonce: 'n' },
      ports: [port as any],
    })
  );
});

describe('canSign in the page', () => {
  it('reads null before any connect and from the connect answer after', async () => {
    expect(octra().canSign).toBeNull();
    expect(api().canSign).toBeNull();
    answers.set('connect', {
      success: true,
      data: { address: 'octW', canSign: false, networkInfo: { id: 'mainnet' } },
    });
    const connected: unknown[] = [];
    octra().on('connect', (info: unknown) => connected.push(info));
    expect(await octra().request({ method: 'octra_requestAccounts' })).toEqual(['octW']);
    expect(octra().canSign).toBe(false);
    expect(connected[0]).toEqual({ chainId: 'mainnet', canSign: false });
    expect(await api().connect()).toEqual({ address: 'octW', balance: undefined, canSign: false });
  });

  it('reads null from an answer without the field', async () => {
    answers.set('connect', { success: true, data: { address: 'octA' } });
    expect((await api().connect()).canSign).toBeNull();
  });

  it('follows the accountChanged event and hands it to SDK pages with the nonce', async () => {
    push({ type: 'accountChanged', data: { address: 'octB', publicKey: 'pkB', canSign: true } });
    expect(api().canSign).toBe(true);
    expect(octra().canSign).toBe(true);
    await vi.waitFor(() => expect(sdkEvents).toHaveLength(1));
    const last = sdkEvents[0];
    expect(last.sessionNonce).toBe('n');
    expect(last.event).toMatchObject({
      type: 'accountChanged',
      data: { address: 'octB', publicKey: 'pkB', canSign: true },
    });
  });

  it('clears on disconnect', () => {
    push({ type: 'disconnect', data: {} });
    expect(api().canSign).toBeNull();
    expect(octra().canSign).toBeNull();
  });

  it('maps WATCH_ONLY to 4100 and keeps the wallet code in data', async () => {
    answers.set('signMessage', {
      success: false,
      error: { code: 'WATCH_ONLY', message: 'This wallet is watch-only and cannot sign.' },
    });
    await expect(
      octra().request({ method: 'octra_signMessage', params: [{ message: 'hi' }] })
    ).rejects.toMatchObject({
      code: 4100,
      message: 'This wallet is watch-only and cannot sign.',
      data: { code: 'WATCH_ONLY' },
    });
  });
});
