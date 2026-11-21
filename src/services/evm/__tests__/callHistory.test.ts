import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evmNetworksFor } from '../networks';
import { explorerName, knownParams, readEvmCall, type EvmCall } from '../callDetail';
import { evmArgRow, evmShownArgs } from 'src/shared/ui/callRows';
import { evmAmountSign, evmTitle } from 'src/shared/ui/txLabels';
import type { EvmHistoryItem } from '../history';

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ROUTER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const FAKE_USDC = '0x6d36Dd7BAC03b886b607fA8128766621166609a5';
const MAX = ((1n << 256n) - 1n).toString();
const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const h = (n: number) => `0x${String(n).padStart(64, '0')}`;
const at = (d: string) => `2026-10-${d}T00:00:00.000000Z`;
const t = (key: string, o?: Record<string, unknown>) =>
  String(o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(o?.[k] ?? ''));

const approveInput = `0x095ea7b3${word(ROUTER)}${BigInt(MAX).toString(16)}`;

const full = [
  {
    hash: h(1),
    timestamp: at('10'),
    from: { hash: ME },
    to: { hash: USDC, name: 'FiatTokenProxy', is_contract: true, is_verified: true },
    value: '0',
    status: 'ok',
    method: 'approve',
    raw_input: approveInput,
    decoded_input: {
      method_call: 'approve(address spender, uint256 value)',
      method_id: '095ea7b3',
      parameters: [
        { name: 'spender', type: 'address', value: ROUTER },
        { name: 'value', type: 'uint256', value: MAX },
      ],
    },
    fee: { type: 'actual', value: '47408596268000' },
  },
  {
    hash: h(2),
    timestamp: at('11'),
    from: { hash: ME },
    to: { hash: ROUTER, name: 'UniversalRouter', is_contract: true, is_verified: true },
    value: '1000000000000000000',
    status: 'ok',
    method: 'execute',
    raw_input: `0x3593564c${'0'.repeat(64)}`,
    fee: { type: 'actual', value: '1000' },
  },
  {
    hash: h(3),
    timestamp: at('12'),
    from: { hash: ME },
    to: { hash: ROUTER },
    value: '0',
    status: 'error',
    method: '0xdeadbeef',
    raw_input: '0xdeadbeef',
  },
  {
    hash: h(4),
    timestamp: at('13'),
    from: { hash: ME },
    to: { hash: USDC },
    value: '0',
    status: 'ok',
    method: null,
    raw_input: `0x095ea7b3${word(ROUTER)}${word('0')}`,
  },
];
const trimmed = full.map(({ hash, timestamp, value, status, method, from, to }) => ({
  hash,
  timestamp,
  value,
  status,
  method: method ?? (hash === h(4) ? '0x095ea7b3' : null),
  from: { hash: from.hash },
  to: { hash: to.hash },
  created_contract: null as null,
}));
const transfers = [
  {
    transaction_hash: h(2),
    timestamp: at('11'),
    log_index: 7,
    from: { hash: ROUTER },
    to: { hash: ME },
    total: { value: '2500000000', decimals: '6' },
    token: { address_hash: USDC },
  },
  {
    transaction_hash: h(2),
    timestamp: at('11'),
    log_index: 8,
    from: { hash: ROUTER },
    to: { hash: ME },
    total: { value: '5', decimals: '0' },
    token: { address_hash: FAKE_USDC },
  },
];

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

async function history(source: 'oracle' | 'keyless') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('https://oracle.0xio.xyz')) {
        return source === 'oracle'
          ? ok({ transactions: trimmed, token_transfers: transfers })
          : new Response('{}', { status: 503 });
      }
      return ok({ items: url.includes('token-transfers') ? transfers : full });
    })
  );
  const { fetchEvmHistory } = await import('../history');
  const eth = evmNetworksFor('mainnet').filter((n) => n.chainId === 1);
  const { items } = await fetchEvmHistory(ME, eth);
  return items.sort((a, b) => a.timestamp - b.timestamp);
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading an EVM call', () => {
  it('takes the Blockscout decoded input with names and types', () => {
    const call = readEvmCall(full[0], USDC)!;
    expect(call).toMatchObject({
      method: 'approve',
      selector: '0x095ea7b3',
      signature: 'approve(address spender, uint256 value)',
    });
    expect(call.params).toEqual([
      { name: 'spender', type: 'address', value: ROUTER },
      { name: 'value', type: 'uint256', value: MAX },
    ]);
  });

  it('falls back to the selector map when only a selector is known', () => {
    const call = readEvmCall({ method: '0x095ea7b3' }, USDC)!;
    expect(call).toMatchObject({ method: 'approve', selector: '0x095ea7b3', params: null });
    expect(readEvmCall({ method: '0xdeadbeef' }, USDC)?.method).toBe('0xdeadbeef');
    expect(readEvmCall({ raw_input: '0x' }, USDC)).toBeNull();
  });

  it('decodes the common token calls from raw input', () => {
    expect(knownParams(`0xa22cb465${word(ROUTER)}${word('0')}`)).toEqual([
      { name: 'operator', type: 'address', value: ROUTER.toLowerCase() },
      { name: 'approved', type: 'bool', value: 'false' },
    ]);
    expect(knownParams('0xa9059cbb1234')).toBeNull();
  });

  it('names only verified contracts that are not tokens or scams', () => {
    const base = { is_verified: true, is_contract: true, token: null as unknown };
    expect(explorerName({ ...base, name: 'UniversalRouter' })).toBe('UniversalRouter');
    expect(
      explorerName({ ...base, name: 'Proxy', implementations: [{ name: 'OptimismPortal2' }] })
    ).toBe('OptimismPortal2');
    expect(explorerName({ ...base, name: 'USDC', token: { symbol: 'USDC' } })).toBeNull();
    expect(explorerName({ ...base, name: 'Router', is_scam: true })).toBeNull();
    expect(explorerName({ ...base, name: 'Router', is_verified: false })).toBeNull();
    expect(explorerName({ ...base, name: 'Claim your airdrop' })).toBeNull();
  });
});

describe('approval rows', () => {
  const call = (params: EvmCall['params'], token = true): EvmCall => ({
    method: 'approve',
    selector: '0x095ea7b3',
    signature: null,
    contract: USDC,
    token: token
      ? { chainId: 1, address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, logo: null }
      : null,
    params,
  });

  it('shows Unlimited for max uint256 and the spender by name', () => {
    const c = call([
      { name: 'spender', type: 'address', value: ROUTER },
      { name: 'value', type: 'uint256', value: MAX },
    ]);
    const names = { [ROUTER.toLowerCase()]: 'UniversalRouter' };
    expect(evmArgRow(c, c.params![0], names, t)).toMatchObject({
      label: 'Spender',
      value: 'UniversalRouter',
      copy: ROUTER,
    });
    expect(evmArgRow(c, c.params![1], names, t).value).toBe('Unlimited USDC');
  });

  it('formats an amount with the token decimals and cuts unknown addresses in the middle', () => {
    const c = call([
      { name: 'spender', type: 'address', value: ROUTER },
      { name: 'value', type: 'uint256', value: '2500000' },
    ]);
    expect(evmArgRow(c, c.params![1], {}, t).value).toBe('2.5 USDC');
    expect(evmArgRow(c, c.params![0], {}, t)).toMatchObject({ mono: true, copy: ROUTER });
    const unknown = call(c.params, false);
    expect(evmArgRow(unknown, unknown.params![1], {}, t).value).toBe('2500000');
  });
});

describe('EVM call arguments a wallet user reads', () => {
  it('leaves out raw bytes, gas limits and creation flags but keeps addresses, amounts, flags and ids', () => {
    const deposit: EvmCall = {
      method: 'depositTransaction',
      selector: '0xe9e05c42',
      signature: null,
      contract: ROUTER,
      token: null,
      params: [
        { name: '_to', type: 'address', value: ME },
        { name: '_value', type: 'uint256', value: '1000' },
        { name: '_gasLimit', type: 'uint64', value: '100000' },
        { name: '_isCreation', type: 'bool', value: 'false' },
        { name: '_data', type: 'bytes', value: '0xabcdef' },
        { name: 'salt', type: 'bytes32', value: h(9) },
        { name: 'approved', type: 'bool', value: 'true' },
        { name: 'tokenId', type: 'uint256', value: '42' },
      ],
    };
    const shown = evmShownArgs(deposit);
    expect(shown.map((a) => a.param.name)).toEqual(['_to', '_value', 'approved', 'tokenId']);
    expect(shown.map((a) => a.index)).toEqual([0, 1, 6, 7]);
    expect(evmArgRow(deposit, shown[2].param, {}, t).value).toBe('Yes');
    expect(evmShownArgs({ ...deposit, params: null })).toEqual([]);
  });
});

describe('EVM history with calls', () => {
  it('reads the same titles from the oracle and from keyless Blockscout', async () => {
    const oracle = await history('oracle');
    const keyless = await history('keyless');
    const titles = (items: EvmHistoryItem[]) => items.map((i) => evmTitle(i, t));
    expect(titles(keyless)).toEqual(['Approve', 'Swap', 'Contract call', 'Revoke']);
    expect(titles(oracle)).toEqual(['Approve', 'Swap', 'Contract call', 'Approve']);
    expect(keyless[0].call?.params).toHaveLength(2);
    expect(oracle[0].call?.params).toBeNull();
    expect(keyless[0].fee).toBe('47408596268000');
  });

  it('puts every asset a call moved in one row, token aware by contract', async () => {
    const [, swap] = await history('keyless');
    expect(swap.key).toBe(`1:${h(2)}`);
    expect(swap.moved?.map((m) => `${m.direction} ${m.amount} ${m.token.symbol}`)).toEqual([
      'incoming 2500 USDC',
      'outgoing 1 ETH',
    ]);
    expect(swap.token?.address).toBe(USDC);
    expect(evmAmountSign(swap)).toBe('+');
  });

  it('shows a failed call as failed with no sign and no amount', async () => {
    const [, , failed] = await history('keyless');
    expect(failed).toMatchObject({ failed: true, token: null, amount: '' });
    expect(evmAmountSign(failed)).toBe('');
  });

  it('names the called token from the wallet list, never from the explorer', async () => {
    const [approve, swap] = await history('keyless');
    expect(approve.call?.token?.symbol).toBe('USDC');
    expect(swap.call?.token ?? null).toBeNull();
  });
});

describe('contract name cache', () => {
  it('keeps names per chain and address, and never names a token', async () => {
    const { lookupContractName, peekContractName, resetContractNames } =
      await import('../callDetail');
    resetContractNames();
    const fetchMock = vi.fn(async (url: string) =>
      ok(
        url.startsWith('https://eth.blockscout.com')
          ? { is_verified: true, is_contract: true, name: 'UniversalRouter', token: null }
          : { is_verified: true, is_contract: true, name: 'USDC', token: { symbol: 'USDC' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await lookupContractName(1, ROUTER, 'https://eth.blockscout.com')).toBe(
      'UniversalRouter'
    );
    expect(await lookupContractName(11155111, ROUTER, 'https://eth-sepolia.blockscout.com')).toBe(
      null
    );
    expect(peekContractName(1, ROUTER.toLowerCase())).toBe('UniversalRouter');
    expect(peekContractName(11155111, ROUTER)).toBeNull();
    expect(peekContractName(4663, ROUTER)).toBeUndefined();
    await lookupContractName(1, ROUTER, 'https://eth.blockscout.com');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
