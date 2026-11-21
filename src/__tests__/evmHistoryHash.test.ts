import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEvmHistory } from 'src/services/evm/history';
import { evmNetworksFor } from 'src/services/evm/networks';

const ME = '0x' + '1'.repeat(40);
const OTHER = '0x' + '2'.repeat(40);

const tx = (hash: unknown) => ({
  hash,
  from: { hash: OTHER },
  to: { hash: ME },
  timestamp: '2026-10-01T00:00:00Z',
  value: '1000000000000000000',
  status: 'ok',
});

function stubHistory(transactions: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('oracle.0xio.xyz')
        ? { transactions, token_transfers: [] as unknown[] }
        : { items: url.includes('token-transfers') ? ([] as unknown[]) : transactions };
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
}

describe('EVM history hash', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps only 32-byte hex hashes, lowercased', async () => {
    const good = '0x' + 'AB'.repeat(32);
    stubHistory([
      tx(good),
      tx('javascript:alert(1)'),
      tx('0x' + 'a'.repeat(63)),
      tx('0x' + 'g'.repeat(64)),
      tx(42),
    ]);
    const ethereum = evmNetworksFor('mainnet').find((n) => n.chainId === 1)!;
    const { items, failedChains } = await fetchEvmHistory(ME, [ethereum]);
    expect(failedChains).toEqual([]);
    expect(items.map((i) => i.hash)).toEqual([good.toLowerCase()]);
    expect(items[0].key).toBe(`1:${good.toLowerCase()}`);
    expect(items[0].explorerUrl.endsWith(`/tx/${good.toLowerCase()}`)).toBe(true);
  });
});
