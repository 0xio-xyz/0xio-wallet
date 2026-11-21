export class RpcResponseError extends Error {
  readonly errorType?: string;
  readonly code?: number;
  constructor(message: string, rpcError: unknown, fallbackType?: string) {
    super(message);
    this.name = 'RpcResponseError';
    const err = rpcError as { code?: unknown; data?: { type?: unknown } } | null;
    this.errorType = typeof err?.data?.type === 'string' ? err.data.type : fallbackType;
    this.code = Number.isInteger(err?.code) ? (err?.code as number) : undefined;
  }
}

export class RpcHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RpcHttpError';
    this.status = status;
  }
}

/** A signed transaction left for the node and no verdict came back: it may still land. */
export class TxOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxOutcomeUnknownError';
  }
}

export const mayHaveBroadcast = (error: unknown): boolean => error instanceof TxOutcomeUnknownError;

export type SubmitRefusal = 'nonce_used' | 'resend' | 'rejected' | 'too_large';

export const NONCE_USED_CODE = 112;
const RESEND_CODES = new Set([107, 110, 117, -32005]);
const REJECTED_CODES = new Set([
  100, 101, 102, 103, 104, 105, 108, 109, 111, 113, 114, 115, 116, 118, -32600, -32602,
]);

export const SUBMIT_ATTEMPTS = 3;
export const RESEND_BACKOFF_MS = [1_000, 2_000];

export function submitRefusal(code: unknown, httpStatus?: number): SubmitRefusal | null {
  if (httpStatus === 413) return 'too_large';
  if (typeof code !== 'number') return null;
  if (code === NONCE_USED_CODE) return 'nonce_used';
  if (RESEND_CODES.has(code)) return 'resend';
  if (REJECTED_CODES.has(code)) return 'rejected';
  return null;
}

export function submitRefusalOf(e: unknown): SubmitRefusal | null {
  if (e instanceof RpcHttpError) return submitRefusal(undefined, e.status);
  if (e instanceof RpcResponseError) return submitRefusal(e.code);
  return null;
}

/** A verdict proves nothing entered the mempool; any other submit failure may have landed. */
export function isSubmitVerdict(e: unknown): boolean {
  if (e instanceof RpcResponseError) return true;
  if (e instanceof RpcHttpError) return submitRefusalOf(e) !== null;
  return (e as { name?: unknown } | null)?.name === 'TxScopeError';
}

export const SUBMIT_REFUSAL_TEXT = {
  nonce_used: 'Nonce already used',
  not_accepted: 'Transaction not accepted by the network',
  rejected: 'Transaction rejected by the network',
  too_large: 'Transaction too large',
} as const;

export type SubmitVerdict = keyof typeof SUBMIT_REFUSAL_TEXT;

export class TxSubmitError extends RpcResponseError {
  readonly verdict: SubmitVerdict;
  readonly fault?: string;
  constructor(verdict: SubmitVerdict, detail?: string, rpcError?: unknown, fault?: string) {
    const text = SUBMIT_REFUSAL_TEXT[verdict];
    super(
      verdict === 'rejected' && detail ? `${text}: ${detail}` : text,
      rpcError ?? null,
      verdict
    );
    this.name = 'TxSubmitError';
    this.verdict = verdict;
    if (fault) this.fault = fault;
  }
}
