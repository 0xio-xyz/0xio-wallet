import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INTERFACE_IDS,
  SELECTORS,
  detectContract,
  ownedFrom,
  parseTokenId,
  readNftOwned,
} from '../detect';
import type { EvmNetwork } from '../networks';

const CONTRACT = '0x5Af0D9827E0c53E4799BB226655A1de152A425a5';
const OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const OTHER = '0x1111111111111111111111111111111111111111';

const net = (chainId: number, name: string): EvmNetwork => ({
  chainId,
  name,
  rpcUrl: `https://rpc-${chainId}.test`,
  testnet: false,
  nativeSymbol: 'ETH',
  nativeName: 'Ether',
  logoChainId: chainId,
});

const ETH = net(1, 'Ethereum');
const BASE = net(8453, 'Base');
const ARB = net(42161, 'Arbitrum One');

type Call = { id: number; method: string; params: unknown[] };
type Answer = { result?: unknown; error?: { code: number; message: string } };

const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const TRUE = word(1n);
const FALSE = word(0n);
const abiString = (s: string) => {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return (
    '0x' +
    (32).toString(16).padStart(64, '0') +
    s.length.toString(16).padStart(64, '0') +
    hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, '0')
  );
};
const REVERT = { error: { code: 3, message: 'execution reverted' } };

type Chain = (call: Call) => Answer;

function mockChains(chains: Record<string, Chain | 'hang' | 'down'>) {
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const chain = chains[url];
    if (chain === 'down') return new Response('nope', { status: 503 });
    if (chain === 'hang' || !chain) {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const body = JSON.parse(String(init.body)) as Call | Call[];
    const list = Array.isArray(body) ? body : [body];
    const out = list.map((c) => ({ jsonrpc: '2.0', id: c.id, ...chain(c) }));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const dataOf = (c: Call) => (c.params[0] as { data?: string })?.data ?? '';

function nftChain(opts: {
  standard: 'ERC-721' | 'ERC-1155' | null;
  code?: string;
  ownerOf?: string;
  balance?: bigint;
}): Chain {
  return (c) => {
    if (c.method === 'eth_getCode') return { result: opts.code ?? '0x6080604052' };
    const data = dataOf(c);
    if (data.startsWith(SELECTORS.supportsInterface)) {
      const id = data.slice(10, 18);
      return { result: opts.standard && INTERFACE_IDS[opts.standard] === id ? TRUE : FALSE };
    }
    if (data.startsWith(SELECTORS.ownerOf)) {
      return opts.ownerOf ? { result: '0x' + opts.ownerOf.slice(2).padStart(64, '0') } : REVERT;
    }
    if (data.startsWith(SELECTORS.balanceOf1155)) {
      return opts.balance !== undefined ? { result: word(opts.balance) } : REVERT;
    }
    return REVERT;
  };
}

function tokenChain(symbol: string, decimals: number): Chain {
  return (c) => {
    if (c.method === 'eth_getCode') return { result: '0x6080' };
    const data = dataOf(c);
    if (data === SELECTORS.decimals) return { result: word(BigInt(decimals)) };
    if (data === SELECTORS.symbol) return { result: abiString(symbol) };
    if (data === SELECTORS.name) return { result: abiString(`${symbol} Token`) };
    return REVERT;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectContract', () => {
  it('finds nothing where there is no code', async () => {
    mockChains({
      [ETH.rpcUrl]: nftChain({ standard: 'ERC-721', code: '0x' }),
      [BASE.rpcUrl]: nftChain({ standard: null, code: '0x0000' }),
    });
    const res = await detectContract(CONTRACT, [ETH, BASE], { kind: 'nft' });
    expect(res.matches).toEqual([]);
    expect(res.unreachable).toEqual([]);
  });

  it('finds an ERC-721 on the one network that has it', async () => {
    mockChains({
      [ETH.rpcUrl]: nftChain({ standard: null, code: '0x' }),
      [BASE.rpcUrl]: nftChain({ standard: 'ERC-721' }),
    });
    const res = await detectContract(CONTRACT, [ETH, BASE], { kind: 'nft' });
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].network.chainId).toBe(8453);
    expect(res.matches[0].standard).toBe('ERC-721');
    expect(res.matches[0].owned).toBeUndefined();
  });

  it('finds an ERC-1155 and reads the held count once a token id is given', async () => {
    mockChains({ [ETH.rpcUrl]: nftChain({ standard: 'ERC-1155', balance: 7n }) });
    const res = await detectContract(CONTRACT, [ETH], { kind: 'nft', owner: OWNER, tokenId: '3' });
    expect(res.matches[0].standard).toBe('ERC-1155');
    expect(res.matches[0].owned).toBe(7n);
  });

  it('checks ERC-721 ownership against the wallet address', async () => {
    mockChains({
      [ETH.rpcUrl]: nftChain({ standard: 'ERC-721', ownerOf: OWNER }),
      [BASE.rpcUrl]: nftChain({ standard: 'ERC-721', ownerOf: OTHER }),
      [ARB.rpcUrl]: nftChain({ standard: 'ERC-721' }),
    });
    const res = await detectContract(CONTRACT, [ETH, BASE, ARB], {
      kind: 'nft',
      owner: OWNER,
      tokenId: '42',
    });
    const owned = Object.fromEntries(res.matches.map((m) => [m.network.chainId, m.owned]));
    expect(owned).toEqual({ 1: 1n, 8453: 0n, 42161: 0n });
  });

  it('does not take a plain contract (no ERC-165) for an NFT', async () => {
    mockChains({ [ETH.rpcUrl]: tokenChain('USDC', 6) });
    const res = await detectContract(CONTRACT, [ETH], { kind: 'nft' });
    expect(res.matches).toEqual([]);
  });

  it('finds an ERC-20 by decimals and symbol', async () => {
    mockChains({
      [ETH.rpcUrl]: tokenChain('USDC', 6),
      [BASE.rpcUrl]: nftChain({ standard: 'ERC-721' }),
    });
    const res = await detectContract(CONTRACT, [ETH, BASE], { kind: 'token' });
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].network.chainId).toBe(1);
    expect(res.matches[0].token).toEqual({ symbol: 'USDC', decimals: 6, name: 'USDC Token' });
  });

  it('lists every network where the same contract lives', async () => {
    mockChains({
      [ETH.rpcUrl]: nftChain({ standard: 'ERC-721' }),
      [BASE.rpcUrl]: nftChain({ standard: 'ERC-1155' }),
      [ARB.rpcUrl]: nftChain({ standard: 'ERC-721' }),
    });
    const res = await detectContract(CONTRACT, [ETH, BASE, ARB], { kind: 'nft' });
    expect(res.matches.map((m) => [m.network.chainId, m.standard])).toEqual([
      [1, 'ERC-721'],
      [8453, 'ERC-1155'],
      [42161, 'ERC-721'],
    ]);
  });

  it('names a network that times out or fails as unreachable, not as no match', async () => {
    mockChains({
      [ETH.rpcUrl]: nftChain({ standard: 'ERC-721' }),
      [BASE.rpcUrl]: 'hang',
      [ARB.rpcUrl]: 'down',
    });
    const started = Date.now();
    const res = await detectContract(CONTRACT, [ETH, BASE, ARB], { kind: 'nft', timeoutMs: 80 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.matches.map((m) => m.network.chainId)).toEqual([1]);
    expect(res.unreachable.map((n) => n.chainId)).toEqual([8453, 42161]);
  });

  it('asks nothing for an address that is not 0x and 40 hex', async () => {
    const fn = mockChains({});
    const res = await detectContract('0x1234', [ETH], { kind: 'nft' });
    expect(res).toEqual({ matches: [], unreachable: [] });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('ownership reads', () => {
  it('reads a revert as not held and any other failure as unknown', () => {
    expect(ownedFrom('ERC-721', OWNER, new Error('RPC eth_call: execution reverted (3)'))).toBe(0n);
    expect(ownedFrom('ERC-721', OWNER, new Error('RPC eth_call: rate limited (-32005)'))).toBe(
      null
    );
    expect(ownedFrom('ERC-721', OWNER, '0x' + OWNER.slice(2).toLowerCase().padStart(64, '0'))).toBe(
      1n
    );
    expect(ownedFrom('ERC-1155', OWNER, word(12n))).toBe(12n);
  });

  it('returns null when the network does not answer', async () => {
    mockChains({ [ETH.rpcUrl]: 'down' });
    expect(await readNftOwned(ETH, CONTRACT, 'ERC-721', OWNER, 1n)).toBeNull();
  });

  it('parses token ids as digits within uint256 only', () => {
    expect(parseTokenId('0')).toBe(0n);
    expect(parseTokenId(' 42 ')).toBe(42n);
    expect(parseTokenId('-1')).toBeNull();
    expect(parseTokenId('0x10')).toBeNull();
    expect(parseTokenId((1n << 256n).toString())).toBeNull();
  });
});
