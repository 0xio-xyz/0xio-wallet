export interface RpcOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RpcRequest {
  method: string;
  params: unknown[];
}

interface RpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const HEX = /^0x[0-9a-fA-F]*$/;

export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

function requestSignal({ timeoutMs = 10_000, signal }: RpcOptions): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function post(url: string, body: unknown, opts: RpcOptions): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: requestSignal(opts),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  return res.json();
}

function unwrap<T>(res: RpcResponse | undefined, method: string): T {
  if (!res || typeof res !== 'object') throw new Error(`RPC ${method}: empty response`);
  if (res.error)
    throw new Error(`RPC ${method}: ${res.error.message ?? 'error'} (${res.error.code ?? '?'})`);
  if (!('result' in res)) throw new Error(`RPC ${method}: no result`);
  return res.result as T;
}

export async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown[],
  opts: RpcOptions = {}
): Promise<T> {
  const body = await post(url, { jsonrpc: '2.0', id: 1, method, params }, opts);
  return unwrap<T>(body as RpcResponse, method);
}

export async function rpcBatch(
  url: string,
  calls: RpcRequest[],
  opts: RpcOptions = {}
): Promise<(unknown | Error)[]> {
  if (calls.length === 0) return [];
  const body = await post(
    url,
    calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params })),
    opts
  );
  if (!Array.isArray(body)) {
    const out: (unknown | Error)[] = [];
    for (const c of calls) {
      try {
        out.push(await rpcCall<unknown>(url, c.method, c.params, opts));
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        out.push(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return out;
  }
  const byId = new Map<number, RpcResponse>();
  for (const r of body as RpcResponse[]) {
    if (r && typeof r === 'object' && typeof r.id === 'number') byId.set(r.id, r);
  }
  return calls.map((c, i) => {
    try {
      return unwrap<unknown>(byId.get(i + 1), c.method);
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
}
