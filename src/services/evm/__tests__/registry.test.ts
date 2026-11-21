import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chainLogoUrl } from '../chains';
import { detectContract } from '../detect';
import { NETWORK_PREFS_KEY, cleanPrefs, loadNetworkPrefs } from '../networkPrefs';
import { EVM_NETWORK_PRESETS } from '../presets';
import {
  CUSTOM_NETWORKS_KEY,
  EvmNetworkError,
  activeRpcUrl,
  addCustomNetwork,
  addNetworkRpc,
  allNetworks,
  allNetworksFor,
  enableNetwork,
  explorerTxUrl,
  findNetwork,
  isBuiltinChain,
  loadCustomNetworks,
  networkTxUrl,
  networksFor,
  removeCustomNetwork,
  removeNetworkRpc,
  resetNetwork,
  setActiveRpc,
  setNetworkEnabled,
  setNetworkExplorer,
  setNetworkSymbol,
} from '../registry';

let store: Record<string, unknown> = {};

function stubChrome() {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) =>
          Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
      },
    },
  });
}

function answerChainId(hex: string) {
  const fn = vi.fn(
    async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: hex }))
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  store = {};
  stubChrome();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = {
  chainId: 8453,
  name: 'Base',
  rpcUrl: 'https://base-rpc.publicnode.com',
  nativeSymbol: 'ETH',
  explorerUrl: 'https://base.blockscout.com/',
};

describe('addCustomNetwork', () => {
  it('probes eth_chainId and saves the network', async () => {
    const fn = answerChainId('0x2105');
    const net = await addCustomNetwork(BASE);
    expect(fn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.method).toBe('eth_chainId');
    expect(net).toMatchObject({ custom: true, chainId: 8453, testnet: false, nativeName: 'ETH' });
    expect(net.explorerUrl).toBe('https://base.blockscout.com');
    expect(store[CUSTOM_NETWORKS_KEY]).toEqual([net]);
    expect((await allNetworks()).map((n) => n.chainId)).toContain(8453);
  });

  it('refuses an RPC that serves another chain', async () => {
    answerChainId('0x1');
    const err = await addCustomNetwork(BASE).catch((e) => e);
    expect(err).toBeInstanceOf(EvmNetworkError);
    expect(err.problem).toBe('mismatch');
    expect(err.served).toBe(1);
    expect(err.message).toBe('This RPC serves chain 1, not 8453');
    expect(store[CUSTOM_NETWORKS_KEY]).toBeUndefined();
  });

  it('refuses built-in chain ids without calling the RPC', async () => {
    const fn = answerChainId('0x1');
    for (const chainId of [1, 4663, 11155111, 46630]) {
      const err = await addCustomNetwork({ ...BASE, chainId }).catch((e) => e);
      expect(err.problem).toBe('builtin');
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a plain http RPC and a missing name or symbol', async () => {
    const fn = answerChainId('0x2105');
    await expect(addCustomNetwork({ ...BASE, rpcUrl: 'http://base.test' })).rejects.toMatchObject({
      problem: 'rpc',
    });
    await expect(addCustomNetwork({ ...BASE, name: ' ' })).rejects.toMatchObject({
      problem: 'name',
    });
    await expect(addCustomNetwork({ ...BASE, nativeSymbol: '' })).rejects.toMatchObject({
      problem: 'symbol',
    });
    await expect(addCustomNetwork({ ...BASE, chainId: 0 })).rejects.toMatchObject({
      problem: 'chainId',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports an unreachable RPC as an rpc problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 }))
    );
    await expect(addCustomNetwork(BASE)).rejects.toMatchObject({ problem: 'rpc' });
  });

  it('refuses a chain that is already added and removes one', async () => {
    const fn = answerChainId('0x2105');
    await addCustomNetwork(BASE);
    const err = await addCustomNetwork({ ...BASE, name: 'Base 2' }).catch((e) => e);
    expect(err.problem).toBe('exists');
    expect(fn).toHaveBeenCalledTimes(1);
    expect((store[CUSTOM_NETWORKS_KEY] as { name: string }[]).map((n) => n.name)).toEqual(['Base']);
    await removeCustomNetwork(8453);
    expect(store[CUSTOM_NETWORKS_KEY]).toEqual([]);
    expect((store[NETWORK_PREFS_KEY] as Record<string, unknown>)['8453']).toBeUndefined();
  });

  it('starts a new network on and keeps the preset logo', async () => {
    answerChainId('0x14a34');
    const net = await addCustomNetwork({
      ...BASE,
      chainId: 84532,
      name: 'Base Sepolia',
      testnet: true,
      logoChainId: 8453,
    });
    expect(net.logoChainId).toBe(8453);
    expect((await loadNetworkPrefs())['84532']).toEqual({ enabled: true });
    expect((await networksFor('devnet')).map((n) => n.chainId)).toContain(84532);
  });
});

describe('explorer links', () => {
  it('prefers the built-in explorer, then the custom one', async () => {
    answerChainId('0x2105');
    const net = await addCustomNetwork(BASE);
    expect(networkTxUrl(net, '0xabc')).toBe('https://base.blockscout.com/tx/0xabc');
    expect(await explorerTxUrl(8453, '0xabc')).toBe('https://base.blockscout.com/tx/0xabc');
    expect(await explorerTxUrl(1, '0xabc')).toBe('https://eth.blockscout.com/tx/0xabc');
    expect(await explorerTxUrl(999, '0xabc')).toBeNull();
  });
});

describe('EVM_NETWORK_PRESETS', () => {
  it('are https, not built in, unique, and have a bundled logo', () => {
    const ids = EVM_NETWORK_PRESETS.map((p) => p.chainId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 4)).toEqual([8453, 42161, 10, 137]);
    for (const p of EVM_NETWORK_PRESETS) {
      expect(p.rpcUrl.startsWith('https://')).toBe(true);
      expect(p.explorerUrl.startsWith('https://')).toBe(true);
      expect(isBuiltinChain(p.chainId)).toBe(false);
      expect(chainLogoUrl(p.logoChainId)).not.toBeNull();
    }
    expect(EVM_NETWORK_PRESETS.some((p) => p.testnet)).toBe(true);
    expect(EVM_NETWORK_PRESETS.some((p) => !p.testnet)).toBe(true);
  });
});

describe('network prefs', () => {
  it('keeps only valid entries and fields', () => {
    const long = `https://x.test/${'a'.repeat(600)}`;
    expect(
      cleanPrefs({
        '8453': {
          enabled: false,
          rpcs: ['https://a.test', 'http://b.test', 'https://a.test', long, 7],
          activeRpc: 'https://a.test',
          explorer: 'javascript:alert(1)',
          addedBy: 'https://app.example.com',
        },
        '1': { enabled: 'yes', addedBy: 'not an origin' },
        '0': { enabled: false },
        abc: { enabled: false },
        '99999999999999999': { enabled: false },
        '10': 'nope',
      })
    ).toEqual({
      '8453': {
        enabled: false,
        rpcs: ['https://a.test'],
        activeRpc: 'https://a.test',
        addedBy: 'https://app.example.com',
      },
      '1': { enabled: true },
    });
    expect(cleanPrefs(['x'])).toEqual({});
    expect(cleanPrefs(null)).toEqual({});
  });

  it('reads a broken store as empty', async () => {
    store[NETWORK_PREFS_KEY] = 'garbage';
    expect(await loadNetworkPrefs()).toEqual({});
    expect((await networksFor('mainnet')).map((n) => n.chainId)).toEqual([1, 4663]);
  });

  it('serialises quick writes so none is lost', async () => {
    await Promise.all([setNetworkEnabled(1, false), setNetworkEnabled(4663, false)]);
    expect(await loadNetworkPrefs()).toEqual({
      '1': { enabled: false },
      '4663': { enabled: false },
    });
  });
});

describe('custom network migration', () => {
  it('brings old entries to the current shape and drops bad ones', async () => {
    store[CUSTOM_NETWORKS_KEY] = [
      { chainId: 8453, name: ' Base ', rpcUrl: 'https://base.test', nativeSymbol: 'ETH' },
      { ...BASE, chainId: 8453, name: 'Duplicate' },
      { ...BASE, chainId: 1, name: 'Fake Ethereum' },
      { ...BASE, chainId: 10, explorerUrl: 'http://plain.test', rpcUrl: 'https://op.test' },
      { ...BASE, chainId: 11, rpcUrl: `https://x.test/${'a'.repeat(600)}` },
      { ...BASE, chainId: 12, name: '' },
    ];
    const list = await loadCustomNetworks();
    expect(list).toEqual([
      {
        custom: true,
        chainId: 8453,
        name: 'Base',
        rpcUrl: 'https://base.test',
        testnet: false,
        nativeSymbol: 'ETH',
        nativeName: 'ETH',
        logoChainId: 8453,
      },
      {
        custom: true,
        chainId: 10,
        name: 'Base',
        rpcUrl: 'https://op.test',
        testnet: false,
        nativeSymbol: 'ETH',
        nativeName: 'ETH',
        logoChainId: 10,
      },
    ]);
    const all = await networksFor('mainnet');
    expect(all.map((n) => n.chainId)).toEqual([1, 4663, 8453, 10]);
    expect(all.every((n) => n.enabled)).toBe(true);
  });
});

describe('enabled networks', () => {
  beforeEach(() => {
    store[CUSTOM_NETWORKS_KEY] = [
      { ...BASE, custom: true, testnet: false, nativeName: 'Ether', logoChainId: 8453 },
    ];
  });

  it('networksFor leaves out networks that are off', async () => {
    await setNetworkEnabled(4663, false);
    await setNetworkEnabled(8453, false);
    expect((await networksFor('mainnet')).map((n) => n.chainId)).toEqual([1]);
    const every = await allNetworksFor('mainnet', { includeDisabled: true });
    expect(every.map((n) => [n.chainId, n.enabled])).toEqual([
      [1, true],
      [4663, false],
      [8453, false],
    ]);
  });

  it('lookups and detection still see networks that are off', async () => {
    await setNetworkEnabled(1, false);
    await setNetworkEnabled(8453, false);
    const ids = (await allNetworks()).map((n) => n.chainId);
    expect(ids).toEqual(expect.arrayContaining([1, 4663, 8453, 11155111, 46630]));
    expect((await allNetworks({ includeDisabled: false })).map((n) => n.chainId)).not.toContain(1);
    expect((await findNetwork(8453))?.enabled).toBe(false);
  });

  it('detection asks networks that are off too', async () => {
    await setNetworkEnabled(8453, false);
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        asked.push(url);
        const calls = JSON.parse(String(init.body)) as { id: number }[];
        return new Response(
          JSON.stringify(calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: '0x' })))
        );
      })
    );
    const res = await detectContract(
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      await allNetworks(),
      { kind: 'token' }
    );
    expect(res.matches).toEqual([]);
    expect(asked).toContain('https://base-rpc.publicnode.com');
    expect(asked).toContain('https://ethereum-rpc.publicnode.com');
  });

  it('enableNetwork turns an off network on and leaves an on one alone', async () => {
    await setNetworkEnabled(8453, false);
    expect(await enableNetwork(8453)).toBe(true);
    expect((await findNetwork(8453))?.enabled).toBe(true);
    const set = vi.mocked(chrome.storage.local.set);
    set.mockClear();
    expect(await enableNetwork(1)).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });
});

describe('RPCs', () => {
  it('resolves the active RPC only while it is still listed', () => {
    const d = 'https://default.test';
    expect(activeRpcUrl(d, undefined)).toBe(d);
    expect(activeRpcUrl(d, { enabled: true, activeRpc: 'https://mine.test' })).toBe(d);
    expect(
      activeRpcUrl(d, {
        enabled: true,
        rpcs: ['https://mine.test'],
        activeRpc: 'https://mine.test',
      })
    ).toBe('https://mine.test');
  });

  it('adds a matching RPC, uses it, and every reader follows it', async () => {
    const fn = answerChainId('0x1');
    expect(await addNetworkRpc(1, ' https://my-eth.test ')).toBe('https://my-eth.test');
    expect(fn).toHaveBeenCalledWith('https://my-eth.test', expect.anything());
    const eth = (await networksFor('mainnet'))[0];
    expect(eth.rpcUrl).toBe('https://my-eth.test');
    expect(eth.defaultRpcUrl).toBe('https://ethereum-rpc.publicnode.com');
    expect(eth.userRpcs).toEqual(['https://my-eth.test']);
    expect((await findNetwork(1))?.rpcUrl).toBe('https://my-eth.test');

    await setActiveRpc(1, 'https://ethereum-rpc.publicnode.com');
    expect((await findNetwork(1))?.rpcUrl).toBe('https://ethereum-rpc.publicnode.com');
    await setActiveRpc(1, 'https://my-eth.test');
    await removeNetworkRpc(1, 'https://my-eth.test');
    const after = await findNetwork(1);
    expect(after?.rpcUrl).toBe('https://ethereum-rpc.publicnode.com');
    expect(after?.userRpcs).toEqual([]);
  });

  it('refuses an RPC that serves another chain and shows the served id', async () => {
    answerChainId('0x2105');
    const err = await addNetworkRpc(1, 'https://not-eth.test').catch((e) => e);
    expect(err).toBeInstanceOf(EvmNetworkError);
    expect(err.problem).toBe('mismatch');
    expect(err.served).toBe(8453);
    expect(err.message).toBe('This RPC serves chain 8453, not 1');
    expect(store[NETWORK_PREFS_KEY]).toBeUndefined();
  });

  it('refuses plain http, a listed RPC, and removing the default', async () => {
    const fn = answerChainId('0x1');
    await expect(addNetworkRpc(1, 'http://eth.test')).rejects.toMatchObject({ problem: 'rpc' });
    await expect(addNetworkRpc(1, 'https://ethereum-rpc.publicnode.com')).rejects.toMatchObject({
      problem: 'duplicate',
    });
    await expect(addNetworkRpc(999, 'https://eth.test')).rejects.toMatchObject({
      problem: 'chainId',
    });
    expect(fn).not.toHaveBeenCalled();
    await expect(removeNetworkRpc(1, 'https://ethereum-rpc.publicnode.com')).rejects.toMatchObject({
      problem: 'rpc',
    });
    await expect(setActiveRpc(1, 'https://other.test')).rejects.toMatchObject({ problem: 'rpc' });
  });
});

describe('built-in networks', () => {
  it('cannot be removed', async () => {
    const err = await removeCustomNetwork(1).catch((e) => e);
    expect(err.problem).toBe('builtin');
    expect((await networksFor('mainnet')).map((n) => n.chainId)).toContain(1);
  });

  it('reset brings back the built-in RPC, explorer and on state', async () => {
    answerChainId('0x1');
    await addNetworkRpc(1, 'https://my-eth.test');
    await setNetworkExplorer(1, 'https://etherscan.io/');
    await setNetworkEnabled(1, false);
    let eth = await findNetwork(1);
    expect(eth).toMatchObject({
      enabled: false,
      rpcUrl: 'https://my-eth.test',
      explorerUrl: 'https://etherscan.io',
    });
    expect(networkTxUrl(eth!, '0xabc')).toBe('https://etherscan.io/tx/0xabc');
    await resetNetwork(1);
    eth = await findNetwork(1);
    expect(eth).toMatchObject({
      enabled: true,
      rpcUrl: 'https://ethereum-rpc.publicnode.com',
      explorerUrl: 'https://eth.blockscout.com',
      userRpcs: [],
    });
    expect((await networksFor('mainnet')).map((n) => n.chainId)).toEqual([1, 4663]);
  });

  it('keep their symbol and refuse a plain http explorer', async () => {
    await expect(setNetworkSymbol(1, 'XYZ')).rejects.toMatchObject({ problem: 'builtin' });
    await expect(setNetworkExplorer(1, 'http://plain.test')).rejects.toMatchObject({
      problem: 'explorer',
    });
  });

  it('a custom network can change its symbol and be reset only by removal', async () => {
    answerChainId('0x2105');
    await addCustomNetwork(BASE);
    await setNetworkSymbol(8453, 'BETH');
    expect((await findNetwork(8453))?.nativeSymbol).toBe('BETH');
    await expect(resetNetwork(8453)).rejects.toBeInstanceOf(EvmNetworkError);
  });
});

describe('networks added by a site', () => {
  it('record the site and start on', async () => {
    answerChainId('0x2105');
    await addCustomNetwork({ ...BASE, addedBy: 'https://app.example.com' });
    expect(await findNetwork(8453)).toMatchObject({
      enabled: true,
      addedBy: 'https://app.example.com',
      builtin: false,
    });
  });

  it('never overwrite an existing chain', async () => {
    const fn = answerChainId('0x2105');
    await addCustomNetwork(BASE);
    answerChainId('0x2105');
    await addNetworkRpc(8453, 'https://mine.test');
    const before = JSON.stringify(store);
    const fromSite = {
      ...BASE,
      name: 'Evil Base',
      rpcUrl: 'https://evil.test',
      nativeSymbol: 'EVL',
      addedBy: 'https://evil.example',
    };
    await expect(addCustomNetwork(fromSite)).rejects.toMatchObject({ problem: 'exists' });
    await expect(addCustomNetwork({ ...fromSite, chainId: 1 })).rejects.toMatchObject({
      problem: 'builtin',
    });
    expect(JSON.stringify(store)).toBe(before);
    expect(await findNetwork(8453)).toMatchObject({
      name: 'Base',
      nativeSymbol: 'ETH',
      rpcUrl: 'https://mine.test',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
