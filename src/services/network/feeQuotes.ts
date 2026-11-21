import { RpcHttpError, RpcResponseError } from './txOutcome';
import type { NetworkPin } from './txScope';

export interface FeeQuote {
  minimum: string;
  recommended: string;
  fast?: string;
}

export const FEE_LIVE_MS = 30_000;
export const FEE_SIGN_MS = 60_000;
export const FEE_SHOW_MS = 5 * 60_000;
export const FEE_READ_MS = 8_000;
const BACKOFF_MS = [600, 1_500];

export type FeeRead =
  | { kind: 'quote'; quote: FeeQuote; at: number }
  | { kind: 'unsupported' }
  | { kind: 'failed'; kept: { quote: FeeQuote; at: number } | null };

export interface FeeQuotesDeps {
  call: (op: string, pin: NetworkPin, timeoutMs: number) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const UNSUPPORTED = /method not found|unknown method|not supported|unsupported|not implemented/i;

export const feeMethodMissing = (e: unknown): boolean =>
  e instanceof RpcResponseError && UNSUPPORTED.test(e.message);

export const feeReadBusy = (e: unknown): boolean => {
  if (e instanceof RpcHttpError) return [429, 502, 503, 504].includes(e.status);
  return !(e instanceof RpcResponseError);
};

/** Per-op fee floors in raw OU, the webcli's: the node refuses less. */
export const FEE_FLOORS: Readonly<Record<string, number>> = {
  key_switch: 5_000,
  encrypt: 5_000,
  decrypt: 5_000,
  stealth: 5_000,
  claim: 3_000,
};

export const MAX_FEE_RAW = 10_000_000;

const MAX = BigInt(MAX_FEE_RAW);

export const feeFloorFor = (op: string | undefined): number => (op && FEE_FLOORS[op]) || 0;

const quoteDigits = (v: unknown): bigint | null => {
  const text =
    typeof v === 'string' ? v : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : '';
  if (!/^[1-9]\d{0,7}$/.test(text)) return null;
  const n = BigInt(text);
  return n <= MAX ? n : null;
};

/**
 * The node's quote checked the webcli's way: the recommended fee is the first of recommended,
 * base_fee and minimum that is whole OU from 1 to 10,000,000, never below a valid minimum. fast is
 * kept only when valid and not below the recommended fee. Anything else is no quote.
 */
export function validFeeQuote(result: unknown): FeeQuote | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const recommended =
    quoteDigits(r.recommended) ?? quoteDigits(r.base_fee) ?? quoteDigits(r.minimum);
  if (recommended === null) return null;
  const minimum = quoteDigits(r.minimum);
  if (minimum !== null && minimum > recommended) return null;
  const fast = quoteDigits(r.fast);
  return {
    minimum: String(minimum ?? recommended),
    recommended: String(recommended),
    ...(fast !== null && fast >= recommended ? { fast: String(fast) } : {}),
  };
}

/**
 * The quote for `op` with its floor applied, or null when the node gave no valid quote. A
 * key_switch needs a valid recommended fee itself, as the webcli's pvac_key_switch_fee does.
 */
export function parseFeeQuote(result: unknown, op?: string): FeeQuote | null {
  const q = validFeeQuote(result);
  if (!q) return null;
  if (
    op === 'key_switch' &&
    quoteDigits((result as Record<string, unknown>).recommended) === null
  ) {
    return null;
  }
  const floor = BigInt(feeFloorFor(op));
  const lift = (v: string) => String(BigInt(v) < floor ? floor : BigInt(v));
  return {
    minimum: lift(q.minimum),
    recommended: lift(q.recommended),
    ...(q.fast ? { fast: lift(q.fast) } : {}),
  };
}

export function createFeeQuotes(deps: FeeQuotesDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const kept = new Map<string, { quote: FeeQuote; at: number }>();
  const unsupported = new Map<string, number>();
  const runs = new Map<string, Promise<FeeRead>>();

  const keyOf = (op: string, pin: NetworkPin) => `${pin.networkId}|${pin.rpcUrl}|${op}`;

  const keptFor = (key: string, maxAgeMs: number) => {
    const k = kept.get(key);
    return k && now() - k.at <= maxAgeMs ? k : null;
  };

  async function readOnce(key: string, op: string, pin: NetworkPin, timeoutMs: number) {
    for (let attempt = 0; ; attempt++) {
      try {
        const quote = parseFeeQuote(await deps.call(op, pin, timeoutMs), op);
        if (!quote) return { kind: 'failed', kept: keptFor(key, FEE_SHOW_MS) } as const;
        const fresh = { quote, at: now() };
        kept.set(key, fresh);
        unsupported.delete(key);
        return { kind: 'quote', ...fresh } as const;
      } catch (e) {
        if (feeMethodMissing(e)) {
          unsupported.set(key, now());
          return { kind: 'unsupported' } as const;
        }
        if (attempt >= BACKOFF_MS.length || !feeReadBusy(e)) {
          return { kind: 'failed', kept: keptFor(key, FEE_SHOW_MS) } as const;
        }
        await sleep(Math.round(BACKOFF_MS[attempt] * (0.75 + random() * 0.5)));
      }
    }
  }

  function read(
    op: string,
    pin: NetworkPin,
    opts: { maxAgeMs?: number; timeoutMs?: number } = {}
  ): Promise<FeeRead> {
    const key = keyOf(op, pin);
    const hit = keptFor(key, opts.maxAgeMs ?? FEE_LIVE_MS);
    if (hit) return Promise.resolve({ kind: 'quote', ...hit });
    const since = unsupported.get(key);
    if (since !== undefined && now() - since < FEE_SHOW_MS) {
      return Promise.resolve({ kind: 'unsupported' });
    }
    const running = runs.get(key);
    if (running) return running;
    const run = readOnce(key, op, pin, opts.timeoutMs ?? FEE_READ_MS);
    runs.set(key, run);
    const done = () => {
      if (runs.get(key) === run) runs.delete(key);
    };
    run.then(done, done);
    return run;
  }

  function last(op: string, pin: NetworkPin, maxAgeMs = FEE_SHOW_MS) {
    return keptFor(keyOf(op, pin), maxAgeMs);
  }

  function forget(): void {
    kept.clear();
    unsupported.clear();
    runs.clear();
  }

  return { read, last, forget };
}

export type FeeQuotes = ReturnType<typeof createFeeQuotes>;

export const signable = (at: number, now = Date.now()): boolean => now - at <= FEE_SIGN_MS;
