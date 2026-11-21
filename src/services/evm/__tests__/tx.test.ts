// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { evmAddressFromPublicKey } from '../accounts';
import { evmNetworksFor } from '../networks';
import { rlpEncode } from '../rlp';
import {
  broadcast,
  estimateFees,
  estimateGas,
  getNonce,
  prepareTransfer,
  waitForReceipt,
} from '../send';
import { evmTokensFor } from '../tokens';
import {
  buildEip1559,
  deriveEvmPrivateKey,
  erc20ApproveData,
  erc20TransferData,
  signEip1559,
  signLegacyEip155,
  type Eip1559Tx,
} from '../tx';

const ABANDON = [...Array(11).fill('abandon'), 'about'];
const ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const TO = '0x3535353535353535353535353535353535353535';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const GWEI = 1_000_000_000n;
const ETHER = 10n ** 18n;

const hex = (b: Uint8Array) => '0x' + bytesToHex(b);
const text = (s: string) => new TextEncoder().encode(s);

type Call = { id: number; method: string; params: unknown[] };

function mockRpc(handler: (call: Call) => unknown) {
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Call | Call[];
    const answer = (c: Call) => {
      const out = handler(c);
      return out instanceof Error
        ? { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: out.message } }
        : { jsonrpc: '2.0', id: c.id, result: out };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rlp', () => {
  it('encodes the spec vectors', () => {
    expect(hex(rlpEncode(text('dog')))).toBe('0x83646f67');
    expect(hex(rlpEncode([text('cat'), text('dog')]))).toBe('0xc88363617483646f67');
    expect(hex(rlpEncode(text('')))).toBe('0x80');
    expect(hex(rlpEncode([]))).toBe('0xc0');
    expect(hex(rlpEncode(0))).toBe('0x80');
    expect(hex(rlpEncode(0n))).toBe('0x80');
    expect(hex(rlpEncode(15))).toBe('0x0f');
    expect(hex(rlpEncode(1024))).toBe('0x820400');
    expect(hex(rlpEncode(Uint8Array.of(0)))).toBe('0x00');
    expect(hex(rlpEncode([[], [[]], [[], [[]]]]))).toBe('0xc7c0c1c0c3c0c1c0');
  });

  it('uses long headers from 56 bytes on', () => {
    const lorem = 'Lorem ipsum dolor sit amet, consectetur adipisicing elit';
    expect(hex(rlpEncode(text(lorem)))).toBe('0xb838' + bytesToHex(text(lorem)));
  });

  it('refuses negative and unsafe numbers', () => {
    expect(() => rlpEncode(-1n)).toThrow();
    expect(() => rlpEncode(-1)).toThrow();
    expect(() => rlpEncode(2 ** 60)).toThrow();
  });
});

describe('ERC-20 calldata', () => {
  it('encodes transfer and approve', () => {
    expect(erc20TransferData(TO, 1234567n)).toBe(
      '0xa9059cbb0000000000000000000000003535353535353535353535353535353535353535000000000000000000000000000000000000000000000000000000000012d687'
    );
    expect(erc20ApproveData(ADDR, (1n << 256n) - 1n)).toBe(
      '0x095ea7b30000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda94ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    );
  });

  it('refuses bad input', () => {
    expect(() => erc20TransferData('0x1234', 1n)).toThrow('recipient');
    expect(() => erc20TransferData(TO, -1n)).toThrow('amount');
    expect(() => erc20TransferData(TO, 1n << 256n)).toThrow('amount');
  });
});

describe('signing', () => {
  it('matches the EIP-155 spec vector', () => {
    const key = new Uint8Array(32).fill(0x46);
    const signed = signLegacyEip155(
      {
        chainId: 1,
        nonce: 9,
        gasPrice: 20n * GWEI,
        gasLimit: 21000n,
        to: TO,
        value: ETHER,
        data: '0x',
      },
      key
    );
    expect(signed.raw).toBe(
      '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83'
    );
  });

  it('derives the key behind the standard address', async () => {
    const key = await deriveEvmPrivateKey(ABANDON, 0);
    expect(key).toHaveLength(32);
    expect(evmAddressFromPublicKey(secp256k1.getPublicKey(key))).toBe(ADDR);
    await expect(deriveEvmPrivateKey(ABANDON, -1)).rejects.toThrow();
  });

  it('matches viem for a native EIP-1559 transfer', async () => {
    const key = await deriveEvmPrivateKey(ABANDON.join(' '), 0);
    const signed = signEip1559(
      {
        chainId: 1,
        nonce: 7,
        maxPriorityFeePerGas: 1_500_000_000n,
        maxFeePerGas: 30n * GWEI,
        gasLimit: 21000n,
        to: TO,
        value: ETHER / 100n,
        data: '0x',
      },
      key
    );
    expect(signed.raw).toBe(
      '0x02f87201078459682f008506fc23ac00825208943535353535353535353535353535353535353535872386f26fc1000080c080a0c05d12f56d80a8da06d403e20337b68957a5c81b82c5f13077435e2dc991c68ba02f79e01996b407c4f87d576265c9591ec20fc6abeb10f48ceb570765f8403566'
    );
    expect(signed.hash).toBe('0xcd8ec7a88a7bc61c511c4ffda065c2d4336a979b91944ba3db87e1472333e5e4');
  });

  it('matches viem for an ERC-20 transfer', async () => {
    const key = await deriveEvmPrivateKey(ABANDON, 0);
    const signed = signEip1559(
      {
        chainId: 11155111,
        nonce: 300,
        maxPriorityFeePerGas: 2n * GWEI,
        maxFeePerGas: 40n * GWEI,
        gasLimit: 65000n,
        to: USDC,
        value: 0n,
        data: erc20TransferData(TO, 1234567n),
      },
      key
    );
    expect(signed.raw).toBe(
      '0x02f8b583aa36a782012c84773594008509502f900082fde894a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4880b844a9059cbb0000000000000000000000003535353535353535353535353535353535353535000000000000000000000000000000000000000000000000000000000012d687c001a091a08306be7bd2f51bc991627ccc7dc9cb0410ffacb73cd5b104c9fb4a0f4464a01acaf0ee33fb2854ed6936bf7cd2f16dd736818f46eff2496da8715bd8977cf8'
    );
    expect(signed.hash).toBe('0x9c1d2ee6b5ea2db10579b1fb11e613c382b91743f3e60f03cd60324a407ef40a');
  });

  it('refuses invalid transactions', () => {
    const key = new Uint8Array(32).fill(0x46);
    const base: Eip1559Tx = {
      chainId: 1,
      nonce: 0,
      maxPriorityFeePerGas: GWEI,
      maxFeePerGas: 2n * GWEI,
      gasLimit: 21000n,
      to: TO,
      value: 1n,
      data: '0x',
    };
    expect(buildEip1559(base)[0]).toBe(2);
    expect(() => signEip1559({ ...base, chainId: 0 }, key)).toThrow('chain id');
    expect(() => signEip1559({ ...base, nonce: -1 }, key)).toThrow('nonce');
    expect(() => signEip1559({ ...base, to: '0xabc' }, key)).toThrow('recipient');
    expect(() => signEip1559({ ...base, value: -1n }, key)).toThrow('value');
    expect(() => signEip1559({ ...base, gasLimit: 0n }, key)).toThrow('gas limit');
    expect(() => signEip1559({ ...base, data: '0x1' }, key)).toThrow('data');
    expect(() => signEip1559({ ...base, maxPriorityFeePerGas: 3n * GWEI }, key)).toThrow(
      'Priority fee'
    );
    expect(() => signEip1559(base, new Uint8Array(32))).toThrow('private key');
  });
});

describe('send', () => {
  const [ethereum] = evmNetworksFor('mainnet');
  const [eth, usdc] = evmTokensFor(1);

  const feeHistory = {
    oldestBlock: '0x10',
    baseFeePerGas: ['0x1', '0x2', '0x3', '0x4', '0x5', String('0x' + (10n * GWEI).toString(16))],
    gasUsedRatio: [0.5, 0.5, 0.5, 0.5, 0.5],
    reward: [['0x3b9aca00'], ['0x77359400'], ['0x1dcd6500'], ['0xb2d05e00'], ['0x59682f00']],
  };

  it('reads the pending nonce', async () => {
    const fetch = mockRpc((c) => {
      expect(c).toMatchObject({ method: 'eth_getTransactionCount', params: [ADDR, 'pending'] });
      return '0x2a';
    });
    expect(await getNonce(ethereum, ADDR)).toBe(42);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('builds fees from fee history', async () => {
    mockRpc((c) => {
      if (c.method === 'eth_gasPrice') return '0x' + (11n * GWEI).toString(16);
      expect(c).toMatchObject({ method: 'eth_feeHistory', params: ['0x5', 'latest', [50]] });
      return feeHistory;
    });
    expect(await estimateFees(ethereum)).toEqual({
      baseFeePerGas: 10n * GWEI,
      maxPriorityFeePerGas: 1_500_000_000n,
      maxFeePerGas: 21_500_000_000n,
    });
  });

  it('falls back to a legacy gas price when fee history is missing and blocks have no base fee', async () => {
    mockRpc((c) =>
      c.method === 'eth_feeHistory'
        ? new Error('method not found')
        : c.method === 'eth_getBlockByNumber'
          ? { number: '0x1' }
          : '0x' + (7n * GWEI).toString(16)
    );
    expect(await estimateFees(ethereum)).toEqual({
      baseFeePerGas: null,
      maxPriorityFeePerGas: 8_400_000_000n,
      maxFeePerGas: 8_400_000_000n,
      legacy: true,
    });
  });

  it('adds headroom to gas estimates but keeps plain transfers at 21000', async () => {
    let answer = '0x5208';
    mockRpc(() => answer);
    const req = { from: ADDR, to: TO, value: 1n, data: '0x' };
    expect(await estimateGas(ethereum, req)).toBe(21000n);
    answer = '0xfde8';
    expect(await estimateGas(ethereum, req)).toBe(78000n);
    answer = '0x3';
    expect(await estimateGas(ethereum, req)).toBe(4n);
  });

  it('prepares a native transfer with the max fee shown up front', async () => {
    const seen: Call[] = [];
    mockRpc((c) => {
      seen.push(c);
      if (c.method === 'eth_getTransactionCount') return '0x7';
      if (c.method === 'eth_feeHistory') return feeHistory;
      if (c.method === 'eth_gasPrice') return '0x' + (11n * GWEI).toString(16);
      if (c.method === 'eth_estimateGas') return '0x5208';
      throw new Error(c.method);
    });
    const prepared = await prepareTransfer({
      network: ethereum,
      from: ADDR,
      to: TO,
      token: eth,
      amount: ETHER,
    });
    expect(prepared.tx).toEqual({
      chainId: 1,
      nonce: 7,
      maxPriorityFeePerGas: 1_500_000_000n,
      maxFeePerGas: 21_500_000_000n,
      gasLimit: 21000n,
      to: TO,
      value: ETHER,
      data: '0x',
    });
    expect(prepared.feeWei).toBe(21000n * 21_500_000_000n);
    expect(prepared.totalNative).toBe(ETHER + 21000n * 21_500_000_000n);
    expect(seen.filter((c) => c.method === 'eth_gasPrice')).toHaveLength(1);
    expect(seen.find((c) => c.method === 'eth_estimateGas')?.params).toEqual([
      { from: ADDR, to: TO, value: '0xde0b6b3a7640000', data: '0x' },
    ]);
  });

  it('prepares an ERC-20 transfer against the token contract', async () => {
    mockRpc((c) => {
      if (c.method === 'eth_getTransactionCount') return '0x0';
      if (c.method === 'eth_feeHistory') return feeHistory;
      if (c.method === 'eth_gasPrice') return '0x' + (11n * GWEI).toString(16);
      if (c.method === 'eth_estimateGas') return '0xfde8';
      throw new Error(c.method);
    });
    const prepared = await prepareTransfer({
      network: ethereum,
      from: ADDR,
      to: TO,
      token: usdc,
      amount: 1234567n,
    });
    expect(prepared.tx.to).toBe(USDC);
    expect(prepared.tx.value).toBe(0n);
    expect(prepared.tx.data).toBe(erc20TransferData(TO, 1234567n));
    expect(prepared.tx.gasLimit).toBe(78000n);
    expect(prepared.feeWei).toBe(78000n * 21_500_000_000n);
    expect(prepared.totalNative).toBe(prepared.feeWei);
  });

  it('refuses tokens from another network and zero amounts', async () => {
    mockRpc(() => '0x0');
    const [sepoliaEth] = evmTokensFor(11155111);
    await expect(
      prepareTransfer({ network: ethereum, from: ADDR, to: TO, token: sepoliaEth, amount: 1n })
    ).rejects.toThrow('different network');
    await expect(
      prepareTransfer({ network: ethereum, from: ADDR, to: TO, token: eth, amount: 0n })
    ).rejects.toThrow('amount');
  });

  it('broadcasts and waits for the receipt', async () => {
    const hash = '0x' + 'ab'.repeat(32);
    let polls = 0;
    mockRpc((c) => {
      if (c.method === 'eth_sendRawTransaction') return hash;
      if (c.method === 'eth_getTransactionReceipt') {
        polls++;
        return polls < 3 ? null : { status: '0x1', blockNumber: '0x10' };
      }
      throw new Error(c.method);
    });
    expect(await broadcast(ethereum, '0x02c0')).toBe(hash);
    expect(await waitForReceipt(ethereum, hash, { intervalMs: 1 })).toEqual({
      status: 'success',
      blockNumber: 16,
    });
    expect(polls).toBe(3);
  });

  it('reports reverted transactions and times out', async () => {
    const hash = '0x' + 'cd'.repeat(32);
    let receipt: unknown = { status: '0x0', blockNumber: '0x2' };
    mockRpc(() => receipt);
    expect(await waitForReceipt(ethereum, hash, { intervalMs: 1 })).toEqual({
      status: 'failed',
      blockNumber: 2,
    });
    receipt = null;
    await expect(waitForReceipt(ethereum, hash, { intervalMs: 1, timeoutMs: 5 })).rejects.toThrow(
      'Timed out'
    );
  });

  it('stops waiting when aborted', async () => {
    mockRpc(() => null);
    const controller = new AbortController();
    const pending = waitForReceipt(ethereum, '0x' + 'ef'.repeat(32), {
      signal: controller.signal,
      intervalMs: 50,
    });
    controller.abort(new Error('Stopped'));
    await expect(pending).rejects.toThrow();
  });
});
