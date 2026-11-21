export interface RpcErrorObject {
  code: number | null;
  message: string;
}

const ERROR_SHAPE = /^RPC [\w.]+: ([\s\S]*) \((-?\d+|\?)\)$/;
const UNSUPPORTED =
  /method not found|not (found|supported|implemented)|unsupported|does not exist|london/i;
const ALREADY_KNOWN =
  /already known|known transaction|already imported|already in (the )?(mempool|pool)/i;
const REJECTED =
  /nonce too (low|high)|insufficient funds|underpriced|fee cap|max fee per gas less than|tip (is )?(higher|above)|priority fee .*(higher|above)|intrinsic gas|gas limit|exceeds (the )?(block|configured)|invalid (sender|signature|chain|transaction)|chain ?id|replay.?protected|oversized|rlp|decode|transaction type not supported|tx fee .*exceeds/i;

export function rpcErrorObject(e: unknown): RpcErrorObject | null {
  if (!(e instanceof Error)) return null;
  const m = ERROR_SHAPE.exec(e.message);
  if (!m) return null;
  return { code: m[2] === '?' ? null : Number(m[2]), message: m[1] };
}

export function isMethodUnsupported(e: unknown): boolean {
  const err = rpcErrorObject(e);
  return !!err && (err.code === -32601 || UNSUPPORTED.test(err.message));
}

/**
 * After a signed transaction was handed to the RPC: 'rejected' only when the node answered with
 * an error that says it refused this transaction. A lost reply, an HTTP error or an unknown error
 * means it may be on its way, so it must never be signed again.
 */
export function broadcastOutcome(e: unknown): 'rejected' | 'maybe-sent' {
  const err = rpcErrorObject(e);
  if (!err) return 'maybe-sent';
  if (ALREADY_KNOWN.test(err.message)) return 'maybe-sent';
  if (err.code === -32602 || REJECTED.test(err.message)) return 'rejected';
  return 'maybe-sent';
}

export async function retryOnce<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (signal?.aborted || rpcErrorObject(e)) throw e;
    return fn();
  }
}
