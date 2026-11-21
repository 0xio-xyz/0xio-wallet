import { beforeAll, describe, expect, it, vi } from 'vitest';

let pagePort: MessagePort;
const replies = new Map<string, any>();
const sentToWorker: any[] = [];

beforeAll(async () => {
  (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (m: any) => {
    sentToWorker.push(m);
    return { success: true, data: null };
  });
  const post = vi.spyOn(window, 'postMessage').mockImplementation(((
    _msg: unknown,
    _origin: unknown,
    transfer?: Transferable[]
  ) => {
    if (transfer?.[0]) pagePort = transfer[0] as MessagePort;
  }) as typeof window.postMessage);
  const contentScript: string = '../content/index';
  await import(contentScript);
  post.mockRestore();
  pagePort.onmessage = (e) => replies.set(e.data.requestId, e.data.response);
});

describe('the content script relay for Octra requests', () => {
  it('passes the protocol 2 request id to the worker, and nothing for an old request', async () => {
    const rid = 'a'.repeat(32);
    pagePort.postMessage({ requestId: 'p1', method: 'signMessage', params: {}, v: 2, rid });
    pagePort.postMessage({ requestId: 'p2', method: 'getBalance', params: {} });
    await vi.waitFor(() => expect(replies.size).toBe(2));
    const [withId, old] = sentToWorker;
    expect(withId).toMatchObject({ type: 'DAPP_REQUEST', method: 'signMessage', v: 2, rid });
    expect(old).not.toHaveProperty('rid');
    expect(old).not.toHaveProperty('v');
  });

  it('sends wallet_hello to the worker as an Octra request', async () => {
    sentToWorker.length = 0;
    pagePort.postMessage({ requestId: 'h1', method: 'wallet_hello', params: {} });
    await vi.waitFor(() => expect(replies.has('h1')).toBe(true));
    expect(sentToWorker[0]).toMatchObject({ type: 'DAPP_REQUEST', method: 'wallet_hello' });
  });

  it('answers requests over 20 a second with RATE_LIMITED instead of dropping them', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    replies.clear();
    for (let i = 0; i < 30; i++) {
      pagePort.postMessage({ requestId: `f${i}`, method: 'getBalance', params: {} });
    }
    await vi.waitFor(() => expect(replies.size).toBe(30));
    const limited = [...replies.values()].filter((r) => r?.error?.code === 'RATE_LIMITED');
    expect(limited).toHaveLength(10);
    expect([...replies.values()].filter((r) => r?.success === true)).toHaveLength(20);
  });
});
