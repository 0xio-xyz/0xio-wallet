import { describe, expect, it } from 'vitest';
import { orderByHeld, searchChains, searchTokens } from 'src/features/bridge/anyChainSearch';
import type { AnyChain } from 'src/services/bridge/relay/anyChain';

const tok = (
  symbol: string,
  name: string,
  address = `0x${symbol.toLowerCase().padEnd(40, '0')}`
) => ({
  address,
  symbol,
  name,
  decimals: 6,
  logo: null as string | null,
});
const chain = (id: number, name: string, tokens = [tok('ETH', 'Ether')]): AnyChain => ({
  id,
  name,
  icon: null,
  explorer: null,
  rpc: 'https://rpc.example',
  tokens,
});

const base = chain(8453, 'Base', [tok('ETH', 'Ether'), tok('USDC', 'USD Coin')]);
const arb = chain(42161, 'Arbitrum One', [
  tok('ETH', 'Ether'),
  tok('USDC', 'USD Coin'),
  tok('ARB', 'Arbitrum'),
]);
const op = chain(10, 'OP Mainnet', [tok('ETH', 'Ether'), tok('OP', 'Optimism')]);
const all = [base, arb, op];

describe('any chain search', () => {
  it('finds chains by name, best match first, and by id', () => {
    expect(searchChains(all, 'arb').map((c) => c.id)).toEqual([42161]);
    expect(searchChains(all, '10').map((c) => c.id)).toEqual([10]);
    expect(searchChains(all, ' ').length).toBe(3);
  });

  it('finds tokens on the open chain, then the same token on other chains', () => {
    const r = searchTokens(all, base, 'usdc');
    expect(r.here.map((t) => t.symbol)).toEqual(['USDC']);
    expect(r.elsewhere.map((h) => h.chain.name)).toEqual(['Arbitrum One']);
  });

  it('matches by name and exact contract address', () => {
    expect(searchTokens(all, arb, 'optimism').elsewhere.map((h) => h.token.symbol)).toEqual(['OP']);
    const addr = arb.tokens[2].address;
    expect(searchTokens(all, base, addr).elsewhere.map((h) => h.token.symbol)).toEqual(['ARB']);
  });

  it('shows the whole open chain and nothing else for an empty query', () => {
    const r = searchTokens(all, base, '');
    expect(r.here.length).toBe(2);
    expect(r.elsewhere).toEqual([]);
  });

  it('lists the chains the wallet holds value on first, most value first', () => {
    expect(orderByHeld(all, { 10: 5, 42161: 40 }).map((c) => c.id)).toEqual([42161, 10, 8453]);
    expect(orderByHeld(all, {}).map((c) => c.id)).toEqual([8453, 42161, 10]);
  });
});
