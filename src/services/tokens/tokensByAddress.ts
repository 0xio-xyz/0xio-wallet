export const TOKENS_PAGE_SIZE = 100;
export const TOKENS_MAX_PAGES = 10;

interface TokensPage {
  tokens?: unknown;
  limited?: boolean;
  next_offset?: number | string;
}

type RpcRead = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * Every page of octra_tokensByAddress ([address, offset, limit]). The node sets `limited` while more
 * may remain, but devnet sets it on the last page too, so a short page or a cursor that does not move
 * also ends the read. A page that fails fails the whole read: part of the holdings must never pass
 * for all of them.
 */
export async function readAllTokensByAddress<T = any>(rpc: RpcRead, address: string): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (let page = 0; page < TOKENS_MAX_PAGES; page++) {
    const r = (await rpc('octra_tokensByAddress', [address, offset, TOKENS_PAGE_SIZE])) as
      | TokensPage
      | null
      | undefined;
    const tokens = Array.isArray(r?.tokens) ? (r.tokens as T[]) : [];
    out.push(...tokens);
    if (!r?.limited || tokens.length < TOKENS_PAGE_SIZE) break;
    const next = Number(r.next_offset);
    if (!Number.isFinite(next) || next <= offset) break;
    offset = next;
  }
  return out;
}
