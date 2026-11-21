import { describe, expect, it } from 'vitest';
import { sortEvmHoldings, type EvmHolding } from 'src/features/wallet/home/pricedHoldings';
import { tokensForNetwork, type ListedToken } from 'src/services/tokens/octraTokens';

const row = (symbol: string, usd: number | null, name = symbol, chainId = 1): EvmHolding => ({
  chainId,
  chainName: 'Ethereum',
  testnet: false,
  token: { chainId, address: `0x${symbol}`, symbol, name, decimals: 18, logo: null },
  raw: '1',
  amount: '1',
  usd,
});

describe('Home token order', () => {
  it('pins OCT then encrypted OCT, whatever order the list holds them in', () => {
    const list: ListedToken[] = [
      { network: 'octra-mainnet', address: 'octTOKEN', symbol: 'TKN', name: 'Token', decimals: 6 },
      {
        network: 'octra-mainnet',
        address: 'native',
        symbol: 'OCT',
        name: 'Octra',
        tags: ['native'],
      },
    ];
    expect(tokensForNetwork(list, 'octra-mainnet', true).map((t) => t.address)).toEqual([
      'native',
      'native-private',
      'octTOKEN',
    ]);
    const listed: ListedToken[] = [
      {
        network: 'octra-mainnet',
        address: 'pOCT',
        symbol: 'OCT',
        name: 'Octra',
        tags: ['native', 'private'],
        extensions: { isPrivate: true },
      },
      ...list,
    ];
    expect(tokensForNetwork(listed, 'octra-mainnet', true).map((t) => t.address)).toEqual([
      'native',
      'pOCT',
      'octTOKEN',
    ]);
    expect(tokensForNetwork(listed, 'octra-mainnet', false).map((t) => t.address)).toEqual([
      'native',
      'octTOKEN',
    ]);
  });

  it('sorts EVM rows by USD value, then rows without a price by name', () => {
    const rows = [
      row('ZRX', null, 'Zero X'),
      row('USDC', 12),
      row('ETH', 840.5),
      row('AAVE', null, 'Aave'),
      row('DUST', 0),
      row('WOCT', 12, 'Wrapped OCT'),
    ];
    expect(sortEvmHoldings(rows).map((r) => r.token.symbol)).toEqual([
      'ETH',
      'USDC',
      'WOCT',
      'DUST',
      'AAVE',
      'ZRX',
    ]);
    expect(rows[0].token.symbol).toBe('ZRX');
  });

  it('keeps equal rows in the order they came in', () => {
    const a = row('ETH', 5, 'Ether', 1);
    const b = row('ETH', 5, 'Ether', 8453);
    expect(sortEvmHoldings([b, a])).toEqual([b, a]);
    expect(sortEvmHoldings([a, b])).toEqual([a, b]);
  });
});
