import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const posted: any[] = [];
const answers = new Map<string, unknown>();
const port = {
  onmessage: null as null | ((e: { data: unknown }) => void),
  start() {},
  postMessage(msg: any) {
    posted.push(msg);
    const answer = answers.get(msg.method);
    if (answer === undefined) return;
    queueMicrotask(() =>
      port.onmessage?.({ data: { requestId: msg.requestId, response: answer } })
    );
  },
};

const sdkMessages: any[] = [];
const announced: any[] = [];
const push = (eventData: unknown) => port.onmessage?.({ data: { type: 'event', eventData } });
const flush = () => new Promise((r) => setTimeout(r, 10));
const RID = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

const sdkRequest = (id: string, method: string, extra: Record<string, unknown> = {}) =>
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      data: { source: '0xio-sdk-request', request: { id, method, params: {}, ...extra } },
    })
  );
const updates = () =>
  sdkMessages.filter((m) => m.event?.type === 'requestUpdate').map((m) => m.event.data);

beforeAll(async () => {
  window.addEventListener('message', (e) => {
    if (e.data?.source === '0xio-sdk-bridge') sdkMessages.push(e.data);
  });
  window.addEventListener('0xio:announceWallet', (e) => announced.push((e as CustomEvent).detail));
  await import('../content/injected');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: '0xio-port-init', nonce: 'n' },
      ports: [port as any],
    })
  );
});

beforeEach(() => {
  sdkMessages.length = 0;
  posted.length = 0;
});

describe('presence announce', () => {
  it('announces at start and again on every request, with nothing about the user', () => {
    expect(announced).toHaveLength(1);
    window.dispatchEvent(new Event('0xio:requestWallet'));
    expect(announced).toHaveLength(2);
    const detail = announced[1];
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.keys(detail).sort()).toEqual(['kind', 'name', 'protocol', 'version']);
    expect(detail).toMatchObject({ protocol: 2, kind: 'extension', name: '0xio Wallet' });
    expect(typeof detail.version).toBe('string');
  });
});

describe('protocol 2 requests from the SDK', () => {
  it('carry v and rid to the wallet; an old request carries neither', () => {
    sdkRequest('r1', 'signMessage', { v: 2, rid: RID });
    sdkRequest('r2', 'getBalance', { v: 2 });
    sdkRequest('r3', 'signMessage');
    expect(posted[0]).toMatchObject({ requestId: 'r1', method: 'signMessage', v: 2, rid: RID });
    expect(posted[1]).not.toHaveProperty('rid');
    expect(posted[2]).not.toHaveProperty('rid');
    expect(posted[2]).not.toHaveProperty('v');
  });

  it("let the page hear its own request's updates before it is connected, and no one else's", async () => {
    sdkRequest('c1', 'connect', { v: 2, rid: RID });
    push({ type: 'requestUpdate', data: { requestId: RID, status: 'review_open', seq: 2 } });
    push({ type: 'requestUpdate', data: { requestId: OTHER, status: 'review_open', seq: 2 } });
    push({ type: 'balanceChanged', data: { balance: 1 } });
    await flush();
    expect(updates()).toEqual([{ requestId: RID, status: 'review_open', seq: 2 }]);
    expect(sdkMessages.filter((m) => m.event?.type === 'balanceChanged')).toEqual([]);
    expect(sdkMessages.every((m) => m.sessionNonce === 'n')).toBe(true);

    push({ type: 'requestUpdate', data: { requestId: RID, status: 'rejected', seq: 3 } });
    push({ type: 'requestUpdate', data: { requestId: RID, status: 'rejected', seq: 4 } });
    await flush();
    expect(updates().map((u) => u.seq)).toEqual([2, 3]);
  });

  it('pass the request id and status of the answer to the SDK', async () => {
    answers.set('signMessage', {
      success: false,
      error: { code: 'USER_REJECTED', message: 'no', details: { status: 'expired' } },
      rid: OTHER,
      status: 'expired',
    });
    sdkRequest('s1', 'signMessage', { v: 2, rid: OTHER });
    await flush();
    const res = sdkMessages.find((m) => m.response?.id === 's1').response;
    expect(res).toMatchObject({
      success: false,
      rid: OTHER,
      status: 'expired',
      error: { code: 'USER_REJECTED', details: { status: 'expired' } },
    });
  });
});
