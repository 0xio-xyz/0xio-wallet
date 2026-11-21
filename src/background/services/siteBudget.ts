// Per-site request budget. Most requests from a page reach the node from the user's IP, and the
// node rate-limits per IP, so one tab looping on reads could lock every client on the machine
// out. A burst covers a page load; the refill covers ordinary polling.
const BURST = 30;
const REFILL_PER_SEC = 8;

const budgets = new Map<string, { tokens: number; at: number }>();

export function takeSiteBudget(origin: string, now = Date.now()): boolean {
  const b = budgets.get(origin) ?? { tokens: BURST, at: now };
  b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * REFILL_PER_SEC);
  b.at = now;
  budgets.set(origin, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
