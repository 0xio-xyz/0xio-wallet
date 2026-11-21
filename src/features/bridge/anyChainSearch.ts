import type { AnyChain, AnyToken } from 'src/services/bridge/relay/anyChain';

const MAX_OTHER = 30;

const norm = (s: string) => s.trim().toLowerCase();

export function searchChains(chains: readonly AnyChain[], query: string): AnyChain[] {
  const q = norm(query);
  if (!q) return [...chains];
  const hits = chains.filter((c) => c.name.toLowerCase().includes(q) || String(c.id) === q);
  return hits.sort((a, b) => rank(a.name, q) - rank(b.name, q));
}

const tokenMatches = (t: AnyToken, q: string) =>
  t.symbol.toLowerCase().includes(q) ||
  t.name.toLowerCase().includes(q) ||
  (q.startsWith('0x') && t.address.toLowerCase() === q);

const rank = (text: string, q: string) => {
  const s = text.toLowerCase();
  return s === q ? 0 : s.startsWith(q) ? 1 : 2;
};

export interface TokenHit {
  chain: AnyChain;
  token: AnyToken;
}

export function searchTokens(
  chains: readonly AnyChain[],
  current: AnyChain | null,
  query: string
): { here: AnyToken[]; elsewhere: TokenHit[] } {
  const q = norm(query);
  const here = (current?.tokens ?? []).filter((t) => !q || tokenMatches(t, q));
  here.sort((a, b) => (q ? rank(a.symbol, q) - rank(b.symbol, q) : 0));
  if (!q) return { here, elsewhere: [] };
  const elsewhere: TokenHit[] = [];
  for (const chain of chains) {
    if (chain.id === current?.id) continue;
    for (const token of chain.tokens) {
      if (tokenMatches(token, q)) elsewhere.push({ chain, token });
    }
  }
  elsewhere.sort((a, b) => rank(a.token.symbol, q) - rank(b.token.symbol, q));
  return { here, elsewhere: elsewhere.slice(0, MAX_OTHER) };
}

export function orderByHeld(
  chains: readonly AnyChain[],
  held: Readonly<Record<number, number>>
): AnyChain[] {
  const value = (c: AnyChain) => held[c.id] ?? 0;
  return chains
    .map((c, i) => ({ c, i }))
    .sort((a, b) => value(b.c) - value(a.c) || a.i - b.i)
    .map((x) => x.c);
}
