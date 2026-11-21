import { beforeAll, describe, expect, it, vi } from 'vitest';

let pagePort: MessagePort;
const replies = new Map<string, any>();

beforeAll(async () => {
  (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
    success: true,
    data: '0x1',
  }));
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

describe('the content script relay', () => {
  it('passes a load burst of EVM reads from one page', async () => {
    for (let i = 0; i < 150; i++) {
      pagePort.postMessage({ requestId: `r${i}`, method: 'eth_chainId', params: [] });
    }
    await vi.waitFor(() => expect(replies.size).toBe(150));
    expect([...replies.values()].filter((r) => r?.success !== true)).toEqual([]);
  });

  it('answers a flood with -32005 instead of dropping it', async () => {
    replies.clear();
    for (let i = 0; i < 300; i++) {
      pagePort.postMessage({ requestId: `f${i}`, method: 'eth_blockNumber', params: [] });
    }
    await vi.waitFor(() => expect(replies.size).toBe(300));
    expect([...replies.values()].some((r) => r?.error?.code === -32005)).toBe(true);
  });
});
