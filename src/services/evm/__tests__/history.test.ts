import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evmNetworksFor } from '../networks';

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PEER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const SPAM = '0x6d36Dd7BAC03b886b607fA8128766621166609a5';
const tx = (n: number) => `0x${String(n).padStart(64, '0')}`;
const at = (s: string) => `2026-10-${s}T00:00:00.000000Z`;

const txs = {
  items: [
    {
      hash: tx(1),
      timestamp: at('10'),
      from: { hash: PEER },
      to: { hash: ME },
      value: '1500000000000000000',
      status: 'ok',
    },
    {
      hash: tx(2),
      timestamp: at('11'),
      from: { hash: PEER },
      to: { hash: ME },
      value: '0',
      status: 'ok',
    },
    {
      hash: tx(3),
      timestamp: at('12'),
      from: { hash: ME },
      to: { hash: USDC },
      value: '0',
      status: 'ok',
      method: 'transfer',
    },
    {
      hash: tx(4),
      timestamp: at('13'),
      from: { hash: ME },
      to: { hash: PEER },
      value: '0',
      status: 'error',
      method: 'approve',
    },
  ],
};
const transfers = {
  items: [
    {
      transaction_hash: tx(3),
      timestamp: at('12'),
      log_index: 1,
      from: { hash: ME },
      to: { hash: PEER },
      total: { value: '2500000', decimals: '6' },
      token: { address_hash: USDC },
    },
    {
      transaction_hash: tx(5),
      timestamp: at('14'),
      log_index: 2,
      from: { hash: PEER },
      to: { hash: ME },
      total: { value: '1', decimals: '0' },
      token: { address_hash: SPAM },
    },
    {
      transaction_hash: tx(6),
      timestamp: at('15'),
      log_index: 3,
      from: { hash: PEER },
      to: { hash: ME },
      total: { value: '0', decimals: '6' },
      token: { address_hash: USDC },
    },
  ],
};

type Fetch = (
  url: string,
  init?: RequestInit
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
const ok = (body: unknown) => ({ ok: true, json: async () => body });
const down = { ok: false, status: 503, json: async () => ({}) };

const load = async (fetchImpl: Fetch) => {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  return (await import('../history')).fetchEvmHistory;
};

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ETH = () => evmNetworksFor('mainnet').filter((n) => n.chainId === 1);

describe('fetchEvmHistory', () => {
  it('reads the oracle, keeps real activity and drops spam and zero sends', async () => {
    const fetchEvmHistory = await load(async (url) =>
      url.startsWith('https://oracle.0xio.xyz/api/evm/history?chain=1&')
        ? ok({ transactions: txs.items, token_transfers: transfers.items })
        : down
    );
    const { items, failedChains } = await fetchEvmHistory(ME, ETH());
    expect(failedChains).toEqual([]);
    expect(items.map((i) => i.hash)).toEqual([tx(4), tx(3), tx(1)]);
    const [call, usdc, eth1] = items;
    expect(call).toMatchObject({
      token: null,
      method: 'approve',
      failed: true,
      direction: 'outgoing',
    });
    expect(usdc).toMatchObject({ amount: '2.5', direction: 'outgoing', to: PEER });
    expect(usdc.token?.symbol).toBe('USDC');
    expect(eth1).toMatchObject({ amount: '1.5', direction: 'incoming' });
    expect(eth1.explorerUrl).toBe(`https://eth.blockscout.com/tx/${tx(1)}`);
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('falls back to keyless Blockscout when the oracle is down', async () => {
    const fetchEvmHistory = await load(async (url) =>
      url.startsWith('https://eth.blockscout.com')
        ? ok(url.includes('token-transfers') ? transfers : txs)
        : down
    );
    const { items, failedChains } = await fetchEvmHistory(ME, ETH());
    expect(failedChains).toEqual([]);
    expect(items).toHaveLength(3);
  });

  it('names every chain that fails, Robinhood included', async () => {
    const fetchEvmHistory = await load(async () => down);
    const { items, failedChains } = await fetchEvmHistory(ME, evmNetworksFor('mainnet'));
    expect(items).toEqual([]);
    expect(failedChains.sort()).toEqual([1, 4663]);
  });
});
