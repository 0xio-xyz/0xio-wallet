import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvmNetwork } from '../networks';

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PEER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const hash = (n: number) => `0x${String(n).padStart(64, '0')}`;

const net = (chainId: number, name: string, explorerUrl?: string, testnet = false) =>
  ({
    chainId,
    name,
    rpcUrl: `https://rpc.${chainId}.example`,
    testnet,
    nativeSymbol: 'ETH',
    nativeName: 'Ether',
    logoChainId: chainId,
    ...(explorerUrl ? { explorerUrl } : {}),
  }) as EvmNetwork;

const BASE = net(8453, 'Base', 'https://base.blockscout.com');
const BNB = net(56, 'BNB Smart Chain', 'https://bscscan.com');
const MINE = net(777001, 'My Chain', 'https://explorer.mychain.example');
const BARE = net(777002, 'Bare Chain');

const incoming = {
  items: [
    {
      hash: hash(1),
      timestamp: '2026-10-12T00:00:00.000000Z',
      from: { hash: PEER },
      to: { hash: ME },
      value: '2000000000000000000',
      status: 'ok',
    },
  ],
};

const local = new Map<string, unknown>();
const urls: string[] = [];
type Reply = { status: number; body?: unknown };
let reply: (url: string) => Reply;

beforeEach(() => {
  vi.resetModules();
  local.clear();
  urls.length = 0;
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter((k) => local.has(k)).map((k) => [k, local.get(k)])),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
        },
      },
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const { status, body } = reply(url);
      return new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), {
        status,
      });
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const load = async () => await import('../history');

const blockscout = (url: string): Reply =>
  url.endsWith('/api/v2/stats')
    ? { status: 200, body: { total_blocks: '100', total_transactions: '5' } }
    : url.includes('/token-transfers')
      ? { status: 200, body: { items: [] } }
      : { status: 200, body: incoming };

describe('history of added networks', () => {
  it('reads a Blockscout explorer keyless after one probe, and labels and links the rows', async () => {
    reply = blockscout;
    const { fetchEvmHistory } = await load();
    const res = await fetchEvmHistory(ME, [BASE]);
    expect(res.failedChains).toEqual([]);
    expect(res.unavailableChains).toEqual([]);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      chainId: 8453,
      chainName: 'Base',
      testnet: false,
      direction: 'incoming',
      amount: '2',
      explorerUrl: `https://base.blockscout.com/tx/${hash(1)}`,
    });
    expect(urls).toContain(`https://base.blockscout.com/api/v2/addresses/${ME}/transactions`);
    expect(urls.some((u) => u.includes('oracle.0xio.xyz'))).toBe(false);
    expect(local.get('evm_blockscout:8453')).toMatchObject({
      base: 'https://base.blockscout.com',
      ok: true,
    });

    await fetchEvmHistory(ME, [BASE]);
    expect(urls.filter((u) => u.endsWith('/api/v2/stats'))).toHaveLength(1);
  });

  it('keeps the probe answer in storage across windows until it expires', async () => {
    reply = blockscout;
    await (await load()).fetchEvmHistory(ME, [BASE]);
    vi.resetModules();
    await (await load()).fetchEvmHistory(ME, [BASE]);
    expect(urls.filter((u) => u.endsWith('/api/v2/stats'))).toHaveLength(1);

    const rec = local.get('evm_blockscout:8453') as { until: number };
    local.set('evm_blockscout:8453', { ...rec, until: Date.now() - 1 });
    vi.resetModules();
    await (await load()).fetchEvmHistory(ME, [BASE]);
    expect(urls.filter((u) => u.endsWith('/api/v2/stats'))).toHaveLength(2);
  });

  it('probes again when the user points the network at another explorer', async () => {
    reply = blockscout;
    const { fetchEvmHistory } = await load();
    await fetchEvmHistory(ME, [BASE]);
    await fetchEvmHistory(ME, [{ ...BASE, explorerUrl: 'https://base2.blockscout.com' } as never]);
    expect(urls.filter((u) => u.endsWith('/api/v2/stats'))).toEqual([
      'https://base.blockscout.com/api/v2/stats',
      'https://base2.blockscout.com/api/v2/stats',
    ]);
  });

  it('names networks without a source instead of hiding them, and never asks an Etherscan explorer', async () => {
    reply = (url) =>
      url.startsWith('https://explorer.mychain.example')
        ? { status: 404, body: '<html>Not found</html>' }
        : blockscout(url);
    const { fetchEvmHistory } = await load();
    const res = await fetchEvmHistory(ME, [BASE, BNB, MINE, BARE]);
    expect(res.unavailableChains.sort()).toEqual([56, 777001, 777002]);
    expect(res.failedChains).toEqual([]);
    expect(res.items.map((i) => i.chainId)).toEqual([8453]);
    expect(urls.some((u) => u.includes('bscscan.com'))).toBe(false);
    expect(urls.filter((u) => u.includes('mychain'))).toEqual([
      'https://explorer.mychain.example/api/v2/stats',
    ]);
    expect(local.get('evm_blockscout:777001')).toMatchObject({ ok: false });

    await fetchEvmHistory(ME, [MINE]);
    expect(urls.filter((u) => u.includes('mychain'))).toHaveLength(1);
  });

  it('reads a busy explorer as a failure to retry, not as no history', async () => {
    reply = (url) =>
      url.endsWith('/api/v2/stats') ? { status: 503, body: {} } : { status: 200, body: incoming };
    const { fetchEvmHistory } = await load();
    const res = await fetchEvmHistory(ME, [BASE]);
    expect(res.failedChains).toEqual([8453]);
    expect(res.unavailableChains).toEqual([]);
    expect(local.has('evm_blockscout:8453')).toBe(false);
  });

  it('reads at most three chains at a time', async () => {
    let open = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        open++;
        peak = Math.max(peak, open);
        await new Promise((r) => setTimeout(r, 5));
        open--;
        const { status, body } = blockscout(url);
        return new Response(JSON.stringify(body), { status });
      })
    );
    const nets = Array.from({ length: 8 }, (_, i) =>
      net(900 + i, `Chain ${i}`, `https://c${i}.blockscout.com`)
    );
    const { fetchEvmHistory } = await load();
    const res = await fetchEvmHistory(ME, nets);
    expect(res.items).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(6);
  });
});
