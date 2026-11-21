import { describe, it, expect, vi, beforeEach } from 'vitest';
import fx from './fixtures/livingChainState.fixture.json';
import { readsChainState } from '../features/wallet/nft/euint/chainState';

const { rpc, putCachedAsset } = vi.hoisted(() => ({ rpc: vi.fn(), putCachedAsset: vi.fn() }));
vi.mock('src/services/network/NetworkService', () => ({
  networkService: {
    getCurrentNetworkId: async () => 'devnet',
    jsonRpcCall: (method: string, params: unknown[]) => rpc(method, params),
    contractCallView: async (c: string, m: string, p: unknown, caller: string) => {
      const r = await rpc('contract_call', [c, m, p || '', caller]);
      return r?.result !== undefined ? r.result : r;
    },
    getTokensByAddressStrict: async () => [
      {
        contractAddress: 'oct2anqvVd5ciBGzqtVZK5pKZehbrQgPnDcw7pnWnCNSWkK',
        symbol: 'GDSC',
        name: 'Geodesics',
        decimals: 0,
        balance: '1',
      },
    ],
  },
}));
vi.mock('src/features/wallet/nft/circleAssetCache', () => ({
  getCachedAsset: async (): Promise<null> => null,
  putCachedAsset,
}));

import {
  DEVNET_RPC,
  MAINNET_RPC,
  bridgeFetchShim,
  busyRetry,
  isRevertError,
  livingQuery,
  livingRpcEndpoint,
  ownedIdsFromPage,
  parseInlineJsonUri,
} from 'src/features/wallet/nft/euint/chainState';
import {
  fetchGalleryCollections,
  fetchOwnedTokenIds,
  resolveNftMetadata,
} from 'src/features/wallet/nft/nftData';
import { clearAbiCache } from 'src/features/wallet/nft/abi';

const C = fx.contract;
const W = fx.wallet;
const uri30 = fx.rpc.token_uri_30.result!.result as string;
const uri40 = fx.rpc.token_uri_40.result!.result as string;
const revert = () => new Error(fx.rpc.token_uri_20_burned.error!.message);

function replay(abi: string[] = fx.abiMethods, over: Record<string, unknown> = {}) {
  rpc.mockImplementation(async (method: string, params: unknown[]) => {
    if (method === 'octra_contractAbi') return { methods: abi.map((name) => ({ name })) };
    if (method === 'circle_asset') return fx.rpc.circle_asset_meta_36.result;
    if (method !== 'contract_call') throw new Error(`unexpected ${method}`);
    const [, view, args] = params as [string, string, unknown[]];
    if (view in over) {
      const v = over[view];
      if (v instanceof Error) throw v;
      return v;
    }
    switch (view) {
      case 'get_name':
        return fx.rpc.get_name.result;
      case 'get_total_supply':
        return fx.rpc.get_total_supply.result;
      case 'balance_of':
        return fx.rpc.balance_of.result;
      case 'owners_page':
        return args[0] === 0
          ? fx.rpc.owners_page_0_50.result
          : { result: Array(50).fill('-').join(',') };
      case 'owner_of':
        if (args[0] === 30) return fx.rpc.owner_of_30.result;
        throw revert();
      default:
        throw revert();
    }
  });
}

beforeEach(() => {
  rpc.mockReset();
  putCachedAsset.mockReset();
  clearAbiCache();
  busyRetry.delaysMs = [0, 0, 0];
  replay();
});

describe('recorded devnet answers', () => {
  it('parses No. 40 inline JSON without decoding the escapes inside its URLs', () => {
    const m = parseInlineJsonUri(uri40) as Record<string, string>;
    expect(m.name).toBe('Colonies #40');
    expect(m.animation_url).toContain('seed=%28C-80a629c97c%2BC-9f083c0661%29%23d28c83f10647a548');
    const q = livingQuery(m.animation_url, DEVNET_RPC);
    expect(q).toBe(m.animation_url.slice(m.animation_url.indexOf('?')));
    expect(new URLSearchParams(q).get('rpc')).toBe(DEVNET_RPC);
  });

  it('tells a burned token from a busy node and reads owners_page', () => {
    expect(isRevertError(revert())).toBe(true);
    expect(isRevertError(new Error(fx.rpc.view_busy.error.message))).toBe(false);
    expect(ownedIdsFromPage(fx.rpc.owners_page_0_50.result!.result, 0, 50, W)).toEqual([
      '30',
      '40',
    ]);
  });

  it('allows only the network endpoint, never the proxy or another host', () => {
    expect(livingRpcEndpoint('https://devnet.octrascan.io')).toBe(DEVNET_RPC);
    expect(livingRpcEndpoint('https://rpc-proxy.0xio.xyz')).toBeNull();
    expect(
      livingQuery('oct://c/index.html?rpc=https%3A%2F%2Fevil.example%2Frpc', MAINNET_RPC)
    ).toBe('');
  });
});

describe('readsChainState', () => {
  it('grants the chain only with a contract and a token or art id', () => {
    const base = 'oct://circle/index.html?seed=1';
    expect(readsChainState(`${base}&contract=oct1&token=4`)).toBe(true);
    expect(readsChainState(`${base}&contract=oct1&art=4`)).toBe(true);
    expect(readsChainState(`${base}&contract=oct1`)).toBe(false);
    expect(readsChainState(`${base}&token=4`)).toBe(false);
    expect(readsChainState(base)).toBe(false);
  });
});

describe('resolveNftMetadata', () => {
  it('No. 40: inline JSON, never fetched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const m = await resolveNftMetadata(uri40);
    expect(m.name).toBe('Colonies #40');
    expect(m.image).toBeNull();
    expect(m.animationUrl).toContain(
      '&token=40&rpc=https%3A%2F%2Fdevnet.octrascan.io%2Frpc&st=gen:1,'
    );
    expect(m.attributes).toEqual([{ trait_type: 'Generation', value: 1 }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('No. 30: oct://<meta>/<n>.json from the circle, and the JSON is not kept on disk', async () => {
    const m = await resolveNftMetadata(uri30);
    expect(m.name).toBe('Colonies No. 37');
    expect(m.animationUrl).toContain(`contract=${C}&art=36&rpc=`);
    expect(m.rarity).toEqual({ grade: 'common', one_in: 725 });
    expect(rpc).toHaveBeenCalledWith('circle_asset', [fx.metadataCircle, '/36.json']);
    expect(putCachedAsset).not.toHaveBeenCalled();
  });
});

describe('fetchOwnedTokenIds', () => {
  it('pages owners_page once instead of scanning owner_of', async () => {
    expect(await fetchOwnedTokenIds(C, W, '4', 2)).toEqual({ ids: ['30', '40'], complete: true });
    const views = rpc.mock.calls
      .filter(([m]) => m === 'contract_call')
      .map(([, p]) => (p as unknown[])[1]);
    expect(views.filter((v) => v === 'owners_page')).toHaveLength(1);
    expect(views).not.toContain('owner_of');
  });

  it('scans past the live supply and steps over burned ids that revert', async () => {
    replay(['owner_of', 'balance_of', 'token_uri']);
    expect((await fetchOwnedTokenIds(C, W, '4', 1)).ids).toEqual(['30']);
  });

  it('comes back incomplete, not empty, when the node stays busy mid-scan', async () => {
    replay(['owner_of'], { owner_of: new Error(fx.rpc.view_busy.error.message) });
    expect(await fetchOwnedTokenIds(C, W, '4', 1)).toEqual({ ids: [], complete: false });
  });
});

describe('fetchGalleryCollections', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    );
    vi.mocked(chrome.storage.local.get).mockImplementation((async (key: unknown) =>
      key === `imported_nfts_devnet_${W}` ? { [key as string]: [C] } : {}) as never);
  });

  it('asks balance_of for a contract the registry does not list', async () => {
    const collections = await fetchGalleryCollections('devnet', W);
    expect(collections.find((c) => c.contractAddress === C)).toMatchObject({
      contractAddress: C,
      name: 'Colonies',
      ownedCount: 2,
      countKnown: true,
      totalSupply: '4',
      imported: true,
    });
  });

  it('keeps the last known count when balance_of does not answer', async () => {
    replay(fx.abiMethods, { balance_of: new Error(fx.rpc.view_busy.error.message) });
    const prev = new Map([
      [
        C,
        {
          contractAddress: C,
          name: 'Colonies',
          symbol: '',
          totalSupply: null,
          ownedCount: 2,
          ownedTokenIds: [],
        },
      ],
    ]);
    const collections = await fetchGalleryCollections('devnet', W, prev);
    expect(collections.find((c) => c.contractAddress === C)).toMatchObject({
      ownedCount: 2,
      countKnown: false,
    });
  });
});

describe('renderer shell', () => {
  const geodeDoc = () =>
    (document.getElementById('geode') as HTMLIFrameElement | null)?.srcdoc ?? '';
  const render = (payload: Record<string, unknown>) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { source: 'octra-living', type: 'render', payload },
      })
    );

  it('puts a policy naming the token network endpoint ahead of everything', async () => {
    await import('src/renderer/index');
    render({
      html: '<script>go()</script>',
      inputs: { _search: '?st=a:1,b:2' },
      connect: DEVNET_RPC,
    });
    const doc = geodeDoc();
    expect(
      doc.startsWith(
        `<meta http-equiv="Content-Security-Policy" content="connect-src ${DEVNET_RPC}">`
      )
    ).toBe(true);
    expect(doc).toContain('"?st=a:1,b:2"');
    expect(doc.endsWith('<script>go()</script>')).toBe(true);
    expect(doc).not.toContain('window.fetch = function');
  });

  it("falls back to connect-src 'none' for anything that is not a plain endpoint", async () => {
    await import('src/renderer/index');
    render({ html: '', inputs: {}, connect: `${DEVNET_RPC}; script-src *` });
    expect(geodeDoc()).toContain(`content="connect-src 'none'"`);
    render({ html: '', inputs: {}, connect: null });
    expect(geodeDoc()).toContain(`content="connect-src 'none'"`);
  });

  it('routes a custom node through the bridge, with no direct network', async () => {
    await import('src/renderer/index');
    const custom = 'http://10.0.0.5:8080/rpc';
    render({ html: '', inputs: {}, connect: null, bridgeRpc: custom });
    const doc = geodeDoc();
    expect(doc).toContain(`content="connect-src 'none'"`);
    expect(doc).toContain(bridgeFetchShim(custom));
  });
});
