import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_PROXY,
  collectEvmNfts,
  fetchEvmNfts,
  loadImportedNfts,
  metadataUrl,
  nftImageSrc,
  parseNftHoldings,
  parseNftItem,
  saveImportedNft,
  type EvmNft,
} from '../nfts';
import { mergeNfts } from 'src/hooks/wallet/useEvmNfts';
import type { EvmNetwork } from '../networks';

const OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const CONTRACT = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const CHECKSUM = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';

const net = (chainId: number): EvmNetwork => ({
  chainId,
  name: `Chain ${chainId}`,
  rpcUrl: `https://rpc-${chainId}.test`,
  testnet: false,
  nativeSymbol: 'ETH',
  nativeName: 'Ether',
  logoChainId: chainId,
});

const item = (over: Record<string, unknown> = {}) => ({
  contract: CONTRACT,
  tokenId: '42',
  standard: 'ERC-721',
  amount: '1',
  name: 'Ape #42',
  collection: 'Bored Apes',
  image: 'ipfs://QmHash/42.png',
  ...over,
});

let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseNftItem', () => {
  it('keeps a good item with a checksummed contract', () => {
    expect(parseNftItem(item(), 1)).toEqual({
      chainId: 1,
      contract: CHECKSUM,
      tokenId: '42',
      standard: 'ERC-721',
      amount: '1',
      name: 'Ape #42',
      collection: 'Bored Apes',
      image: 'ipfs://QmHash/42.png',
    });
  });

  it('drops items with a bad contract, id, standard or amount', () => {
    expect(parseNftItem(item({ contract: '0x123' }), 1)).toBeNull();
    expect(parseNftItem(item({ contract: 42 }), 1)).toBeNull();
    expect(parseNftItem(item({ tokenId: '-1' }), 1)).toBeNull();
    expect(parseNftItem(item({ tokenId: '0x2a' }), 1)).toBeNull();
    expect(parseNftItem(item({ tokenId: (1n << 256n).toString() }), 1)).toBeNull();
    expect(parseNftItem(item({ standard: 'ERC-20' }), 1)).toBeNull();
    expect(parseNftItem(item({ standard: 'ERC-1155', amount: '0' }), 1)).toBeNull();
    expect(parseNftItem(item({ standard: 'ERC-1155', amount: '1.5' }), 1)).toBeNull();
    expect(parseNftItem(null, 1)).toBeNull();
    expect(parseNftItem([item()], 1)).toBeNull();
  });

  it('holds an ERC-721 at one and keeps an ERC-1155 count', () => {
    expect(parseNftItem(item({ amount: '9' }), 1)?.amount).toBe('1');
    expect(parseNftItem(item({ standard: 'ERC-1155', amount: '12' }), 1)?.amount).toBe('12');
    expect(parseNftItem(item({ standard: 'ERC-1155', amount: 3 }), 1)?.amount).toBe('3');
    expect(parseNftItem(item({ tokenId: 7 }), 1)?.tokenId).toBe('7');
  });

  it('strips hidden characters and caps the names', () => {
    const n = parseNftItem(item({ name: 'Ape‮ #42​', collection: 'x'.repeat(200) }), 1);
    expect(n?.name).toBe('Ape #42');
    expect(n?.collection?.length).toBe(60);
    expect(parseNftItem(item({ name: 42, collection: '   ' }), 1)).toMatchObject({
      name: null,
      collection: null,
    });
  });

  it('keeps only images the popup can load', () => {
    expect(parseNftItem(item({ image: 'http://plain.test/a.png' }), 1)?.image).toBeNull();
    expect(parseNftItem(item({ image: 'javascript:alert(1)' }), 1)?.image).toBeNull();
    expect(parseNftItem(item({ image: 'https://a.test/x.png' }), 1)?.image).toBe(
      'https://a.test/x.png'
    );
    expect(parseNftItem(item({ image: 'data:image/png;base64,AAAA' }), 1)?.image).toBe(
      'data:image/png;base64,AAAA'
    );
    expect(parseNftItem(item({ image: 'data:text/html,<b>x</b>' }), 1)?.image).toBeNull();
  });
});

describe('parseNftHoldings', () => {
  it('rejects a body of the wrong shape', () => {
    expect(parseNftHoldings(null, 1)).toBeNull();
    expect(parseNftHoldings({ items: 'x' }, 1)).toBeNull();
    expect(parseNftHoldings([], 1)).toBeNull();
  });

  it('keeps good items, drops bad ones and duplicates, reads complete', () => {
    const res = parseNftHoldings(
      {
        items: [
          item(),
          item({ contract: CHECKSUM }),
          item({ tokenId: 'abc' }),
          item({ tokenId: '43', standard: 'ERC-1155', amount: '2' }),
        ],
        complete: true,
      },
      8453
    );
    expect(res?.complete).toBe(true);
    expect(res?.items.map((n) => [n.chainId, n.tokenId, n.standard, n.amount])).toEqual([
      [8453, '42', 'ERC-721', '1'],
      [8453, '43', 'ERC-1155', '2'],
    ]);
    expect(parseNftHoldings({ items: [] }, 1)?.complete).toBe(false);
  });
});

describe('images and metadata URLs', () => {
  it('loads https and ipfs through the proxy, inline images as they are', () => {
    expect(nftImageSrc('https://a.test/x.png?y=1&z=2')).toBe(
      `${IMAGE_PROXY}?u=${encodeURIComponent('https://a.test/x.png?y=1&z=2')}`
    );
    expect(nftImageSrc('ipfs://QmHash/1.png')).toBe(
      `${IMAGE_PROXY}?u=${encodeURIComponent('ipfs://QmHash/1.png')}`
    );
    expect(nftImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBe(
      'data:image/svg+xml;base64,PHN2Zz4='
    );
    expect(nftImageSrc('http://a.test/x.png')).toBeNull();
    expect(nftImageSrc('ar://abc')).toBeNull();
    expect(nftImageSrc(null)).toBeNull();
  });

  it('fills an ERC-1155 {id} and maps ipfs to a gateway', () => {
    expect(metadataUrl('https://m.test/{id}.json', 0x2an)).toBe(
      `https://m.test/${'0'.repeat(62)}2a.json`
    );
    expect(metadataUrl('ipfs://ipfs/QmHash/1', 1n)).toBe('https://ipfs.io/ipfs/QmHash/1');
    expect(metadataUrl('ipfs://QmHash/1', 1n)).toBe('https://ipfs.io/ipfs/QmHash/1');
    expect(metadataUrl('http://m.test/1', 1n)).toBeNull();
  });
});

describe('fetchEvmNfts', () => {
  it('keeps failed chains named and skips chains the index does not cover', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const chain = Number(new URL(url).searchParams.get('chain'));
        if (chain === 1) {
          return new Response(JSON.stringify({ items: [item()], complete: true }), { status: 200 });
        }
        if (chain === 8453) return new Response('unsupported', { status: 400 });
        if (chain === 10) return new Response(JSON.stringify({ nope: 1 }), { status: 200 });
        return new Response('down', { status: 502 });
      })
    );
    const res = await fetchEvmNfts(OWNER, [net(1), net(8453), net(10), net(42161)]);
    expect(res.items.map((n) => n.chainId)).toEqual([1]);
    expect(res.failedChains).toEqual([10, 42161]);
  });
});

describe('imports', () => {
  const imported: EvmNft = {
    chainId: 1,
    contract: CHECKSUM,
    tokenId: '7',
    standard: 'ERC-721',
    amount: '1',
    name: 'Imported',
    collection: 'Apes',
    image: null,
  };

  it('are kept per network and 0x address', async () => {
    await saveImportedNft(imported, OWNER);
    expect(Object.keys(store)).toEqual([`evm_nft_imports_1_${OWNER.toLowerCase()}`]);
    expect(await loadImportedNfts(1, OWNER)).toEqual([imported]);
    expect(await loadImportedNfts(8453, OWNER)).toEqual([]);
    expect(await loadImportedNfts(1, '0x1111111111111111111111111111111111111111')).toEqual([]);
  });

  it('show even when the index misses them, unless the chain says they left', async () => {
    await saveImportedNft(imported, OWNER);
    await saveImportedNft({ ...imported, tokenId: '8' }, OWNER);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith('https://oracle')) return new Response('down', { status: 502 });
        const calls = JSON.parse(String(init?.body)) as {
          id: number;
          params: [{ data: string }];
        }[];
        return new Response(
          JSON.stringify(
            calls.map((c) => {
              const id = BigInt('0x' + c.params[0].data.slice(10));
              const owner = id === 7n ? OWNER : '0x1111111111111111111111111111111111111111';
              return {
                jsonrpc: '2.0',
                id: c.id,
                result: '0x' + owner.slice(2).toLowerCase().padStart(64, '0'),
              };
            })
          )
        );
      })
    );
    const res = await collectEvmNfts(OWNER, [net(1)]);
    expect(res.items.map((n) => n.tokenId)).toEqual(['7']);
    expect(res.failedChains).toEqual([1]);
  });
});

describe('mergeNfts', () => {
  it('keeps the last pieces of a chain that failed this time', () => {
    const a = parseNftItem(item(), 1)!;
    const b = parseNftItem(item({ tokenId: '1' }), 8453)!;
    const merged = mergeNfts(
      { items: [a, b], failedChains: [] },
      { items: [a], failedChains: [8453] }
    );
    expect(merged.items).toEqual([a, b]);
    const clean = mergeNfts({ items: [a, b], failedChains: [] }, { items: [a], failedChains: [] });
    expect(clean.items).toEqual([a]);
  });
});
