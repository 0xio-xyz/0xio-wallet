export function rateWindow(perSecond: number) {
  let count = 0;
  let start = Date.now();
  return {
    take(now = Date.now()): boolean {
      if (now - start > 1000) {
        count = 0;
        start = now;
      }
      return ++count <= perSecond;
    },
  };
}

export const OCTRA_PER_SECOND = 20;

export const RATE_LIMITED_RESPONSE = {
  success: false,
  error: { code: 'RATE_LIMITED', message: 'Too many requests from this page. Retry shortly.' },
};

const NETWORK = /^[a-z0-9_-]{1,32}$/;

export function dappRequestMessage(data: {
  requestId: string;
  method: unknown;
  params: unknown;
  v?: unknown;
  rid?: unknown;
  network?: unknown;
}) {
  const v2 = data.v === 2 && typeof data.rid === 'string';
  return {
    type: 'DAPP_REQUEST',
    requestId: data.requestId,
    method: data.method,
    params: data.params,
    ...(v2 ? { v: 2, rid: data.rid } : {}),
    ...(v2 && typeof data.network === 'string' && NETWORK.test(data.network)
      ? { network: data.network }
      : {}),
  };
}
