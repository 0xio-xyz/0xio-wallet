import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('src/services/network/NetworkService', () => ({
  networkService: { jsonRpcCall: h.rpc },
}));
vi.mock('src/services/network/txScope', () => ({
  resolveNetworkPin: async (networkId: string) => ({ networkId, rpcUrl: `https://${networkId}` }),
}));
vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      String(o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(o?.[k] ?? '')),
  }),
}));

import { abiParamNames, argLabel, knownCallArgs, networkName } from 'src/utils/callArgs';
import { knownOctraContract } from 'src/utils/callReading';
import {
  CALL_DATA_MAX,
  callInput,
  callMethod,
  callSelector,
  evmArgRow,
  evmCallData,
  evmShownArgs,
  octraArgRows,
  type CallData,
} from 'src/shared/ui/callRows';
import { CALL_VALUE_MAX } from 'src/utils/callArgs';
import { evmCallCut, fetchEvmTxDetail, readEvmCall } from 'src/services/evm/callDetail';
import {
  abiKey,
  loadAbiNames,
  peekAbiNames,
  useEvmTxDetail,
} from 'src/hooks/transactions/useCallDetails';
import { TxDetails } from 'src/shared/ui/TxDetails';
import { clearSessionCaches } from 'src/utils/sessionCaches';
import type { EvmCall } from 'src/services/evm/callDetail';

const t = (key: string, o?: Record<string, unknown>) =>
  String(o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(o?.[k] ?? ''));

const VAULT = 'octHqBuw3TGsgeGpu6GiumRTjQwc8VCRAo1ANhy5zL4ZVPc';
const BRIDGE = 'oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq';
const OTHER = 'octZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZ';
const DEST = '0xc68f177AC0465C51E6Cf37cB4068142802F69a78';
const ME = 'oct2qyupyPfAof4kJ8LcTdN7fyQkLxiKhfemLCz94NNoxio';
const LOCK_ARGS = [
  'swap_1b60d87e1e828f45ce7444a122b987de',
  'sepolia',
  DEST,
  '1559940',
  '151749169604113',
  'ETH',
];

beforeEach(() => {
  h.rpc.mockReset();
  clearSessionCaches();
});

describe('argument labels', () => {
  it('reads parameter names as sentence case with the wallet words for known meanings', () => {
    expect(argLabel('swap_id', t)).toBe('Swap ID');
    expect(argLabel('tokenId', t)).toBe('Token ID');
    expect(argLabel('new_owner', t)).toBe('New owner');
    expect(argLabel('_feeBps', t)).toBe('Fee BPS');
    expect(argLabel('dest_chain', t)).toBe('To network');
    expect(argLabel('recipient', t)).toBe('Recipient');
    expect(argLabel('receiver', t)).toBe('Recipient');
    expect(argLabel('_to', t)).toBe('Recipient');
    expect(argLabel('amount', t)).toBe('Amount');
    expect(argLabel('_value', t)).toBe('Amount');
    expect(argLabel('expiry', t)).toBe('Expires');
    expect(argLabel('deadline', t)).toBe('Expires');
    expect(argLabel('timeout', t)).toBe('Expires');
    expect(argLabel('asset', t)).toBe('Asset');
    expect(argLabel('token', t)).toBe('Asset');
    expect(argLabel('symbol', t)).toBe('Asset');
    expect(argLabel('amountOutMin', t)).toBe('Minimum received');
  });

  it('names chains the way the wallet does', () => {
    expect(networkName('sepolia')).toBe('Sepolia');
    expect(networkName('ethereum')).toBe('Ethereum');
    expect(networkName('Robinhood-Chain')).toBe('Robinhood Chain');
    expect(networkName('base')).toBe('base');
  });
});

describe('SwapVault and bridge calls', () => {
  it('reads a lock as the swap it is, in the order a person checks it', () => {
    const known = knownOctraContract('devnet', VAULT);
    const specs = knownCallArgs(known?.calls, 'lock');
    const { rows, args } = octraArgRows(LOCK_ARGS, specs, null, t);
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['To network', 'Sepolia'],
      ['Recipient', '0xc68f177A…02F69a78'],
      ['Minimum received', '0.000151 ETH'],
      ['Expires', 'Epoch 1559940'],
      ['Swap ID', 'swap_1b60d…22b987de'],
    ]);
    expect(rows[1].copy).toBe(DEST);
    expect(rows[4].copy).toBe(LOCK_ARGS[0]);
    expect(args).toEqual([
      { index: 0, name: 'intent_hash', label: 'Swap ID', type: 'string', value: LOCK_ARGS[0] },
      {
        index: 1,
        name: 'dest_chain',
        label: 'To network',
        type: 'string',
        value: 'sepolia',
        friendly: 'Sepolia',
      },
      { index: 2, name: 'dest_addr', label: 'Recipient', type: 'address', value: DEST },
      {
        index: 3,
        name: 'expiry',
        label: 'Expires',
        type: 'string',
        value: '1559940',
        friendly: 'Epoch 1559940',
      },
      {
        index: 4,
        name: 'min_receive',
        label: 'Minimum received',
        type: 'string',
        value: '151749169604113',
        friendly: '0.000151 ETH',
      },
      { index: 5, name: 'dest_token', label: 'Asset', type: 'string', value: 'ETH' },
    ]);
  });

  it('keeps an amount raw with its asset when the asset has no known unit', () => {
    const specs = knownCallArgs('swapVault', 'lock');
    const args = [...LOCK_ARGS.slice(0, 5), 'USDC'];
    const rows = octraArgRows(args, specs, null, t).rows;
    expect(rows.find((r) => r.label === 'Minimum received')?.value).toBe('151749169604113');
    expect(rows.find((r) => r.label === 'Asset')?.value).toBe('USDC');
  });

  it('reads an older four argument lock without inventing the rest', () => {
    const rows = octraArgRows(LOCK_ARGS.slice(0, 4), knownCallArgs('swapVault', 'lock'), null, t);
    expect(rows.rows.map((r) => r.label)).toEqual([
      'To network',
      'Recipient',
      'Expires',
      'Swap ID',
    ]);
  });

  it('reads the bridge methods', () => {
    expect(knownOctraContract('mainnet', BRIDGE)?.calls).toBe('octBridge');
    const lock = octraArgRows([DEST], knownCallArgs('octBridge', 'lock_to_eth'), null, t);
    expect(lock.rows).toMatchObject([{ label: 'Recipient', copy: DEST }]);
    const unlock = octraArgRows(
      [ME, '2500000', '0xabc'],
      knownCallArgs('octBridge', 'unlock_trusted'),
      null,
      t
    );
    expect(unlock.rows.map((r) => [r.label, r.value])).toEqual([
      ['Recipient', `${ME.slice(0, 10)}…${ME.slice(-8)}`],
      ['Amount', '2.5 OCT'],
      ['Message ID', '0xabc'],
    ]);
  });
});

describe('arguments without names', () => {
  it('never lists numbered rows: unnamed arguments read Value n on the call data page', () => {
    const { rows, args } = octraArgRows([7, 'hello', true], null, null, t);
    expect(rows).toEqual([]);
    expect(args).toEqual([
      { index: 0, label: 'Value 1', type: 'int', value: '7' },
      { index: 1, label: 'Value 2', type: 'string', value: 'hello' },
      { index: 2, label: 'Value 3', type: 'bool', value: 'true' },
    ]);
  });

  it('names what the ABI names and leaves the rest to the call data', () => {
    const { rows, args } = octraArgRows(
      [OTHER, '1790000000', 'x'],
      null,
      ['to', 'deadline', ''],
      t
    );
    expect(rows.map((r) => r.label)).toEqual(['Recipient', 'Expires']);
    expect(rows[1].value).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(args.map((a) => [a.label, a.value])).toEqual([
      ['Recipient', OTHER],
      ['Expires', '1790000000'],
      ['Value 3', 'x'],
    ]);
    expect(args[1].friendly).toBe(rows[1].value);
  });

  it('keeps an epoch sized expiry as the number it is', () => {
    expect(octraArgRows(['1559940'], null, ['expiry'], t).rows[0].value).toBe('1559940');
  });
});

describe('ABI parameter names', () => {
  it('reads names from the shapes nodes answer, never types as names', () => {
    expect(abiParamNames({ methods: [{ name: 'lock', view: true }] })).toEqual({});
    expect(
      abiParamNames({ methods: [{ name: 'lock', params: ['intent_hash', 'expiry'] }] })
    ).toEqual({ lock: ['intent_hash', 'expiry'] });
    expect(abiParamNames({ methods: [{ name: 'withdraw', inputs: ['u128'] }] })).toEqual({});
    const saved = JSON.stringify({
      functions: [{ name: 'withdraw', inputs: ['u128'], input_names: ['amt'] }],
    });
    expect(abiParamNames({ methods: [], abi: saved })).toEqual({ withdraw: ['amt'] });
    expect(abiParamNames('not json')).toEqual({});
  });

  it('caches per network + contract and reads each pair once', async () => {
    h.rpc.mockImplementation(async (_m: string, [contract]: string[], _p: boolean, pin: any) => ({
      methods: [{ name: 'go', params: [`${pin.networkId}_${contract.slice(0, 5)}`] }],
    }));
    await Promise.all([loadAbiNames('devnet', VAULT), loadAbiNames('devnet', VAULT)]);
    await loadAbiNames('mainnet', VAULT);
    await loadAbiNames('devnet', OTHER);
    await loadAbiNames('devnet', VAULT);
    expect(h.rpc).toHaveBeenCalledTimes(3);
    expect(peekAbiNames('devnet', VAULT)).toEqual({ go: ['devnet_octHq'] });
    expect(peekAbiNames('mainnet', VAULT)).toEqual({ go: ['mainnet_octHq'] });
    expect(peekAbiNames('devnet', OTHER)).toEqual({ go: ['devnet_octZz'] });
    expect(abiKey('devnet', VAULT)).not.toBe(abiKey('mainnet', VAULT));
  });

  it('keeps a failed read for a while instead of asking again on every open', async () => {
    h.rpc.mockRejectedValue(new Error('HTTP 429'));
    await loadAbiNames('devnet', VAULT);
    await loadAbiNames('devnet', VAULT);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(peekAbiNames('devnet', VAULT)).toBeNull();
  });

  it('holds at most 50 contracts', async () => {
    h.rpc.mockResolvedValue({ methods: [] });
    for (let i = 0; i < 52; i++) await loadAbiNames('devnet', `oct${i}`);
    expect(peekAbiNames('devnet', 'oct0')).toBeUndefined();
    expect(peekAbiNames('devnet', 'oct51')).toEqual({});
  });
});

describe('EVM arguments', () => {
  const call: EvmCall = {
    method: 'swapExactTokensForTokens',
    selector: '0x38ed1739',
    signature: null,
    contract: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
    token: null,
    params: [
      { name: 'amountOutMin', type: 'uint256', value: '42' },
      { name: '', type: 'uint256', value: '7' },
      { name: 'to', type: 'address', value: DEST },
      { name: 'deadline', type: 'uint256', value: '1790000000' },
      { name: 'data', type: 'bytes', value: '0xdeadbeef' },
    ],
  };

  it('shows named arguments in the card and lists every argument on the call data page', () => {
    const shown = evmShownArgs(call);
    expect(shown.map((a) => a.index)).toEqual([0, 2, 3]);
    const rows = shown.map(({ param }) => evmArgRow(call, param, {}, t));
    expect(rows.map((r) => r.label)).toEqual(['Minimum received', 'Recipient', 'Expires']);
    expect(rows[2].value).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
    const args = evmCallData(call, {}, t);
    expect(args.map((a) => [a.label, a.type, a.value])).toEqual([
      ['Minimum received', 'uint256', '42'],
      ['Value 2', 'uint256', '7'],
      ['Recipient', 'address', DEST],
      ['Expires', 'uint256', '1790000000'],
      ['Data', 'bytes', '0xdeadbeef'],
    ]);
    expect(args[3].friendly).toBe(rows[2].value);
    expect(args[2].friendly).toBeUndefined();
    expect(evmCallData(call, { [DEST.toLowerCase()]: 'Vault' }, t)[2].friendly).toBe('Vault');
  });

  it('reads token amounts with the token and keeps the raw value under them', () => {
    const approve: EvmCall = {
      ...call,
      method: 'approve',
      token: { address: call.contract, symbol: 'USDC', decimals: 6, name: 'USD Coin' } as never,
      params: [
        { name: 'spender', type: 'address', value: DEST },
        { name: 'value', type: 'uint256', value: '2500000' },
      ],
    };
    expect(evmCallData(approve, {}, t)[1]).toMatchObject({
      label: 'Amount',
      value: '2500000',
      friendly: '2.5 USDC',
    });
  });

  it('names the method, the selector and the raw input of a call', () => {
    expect(callMethod('lock')).toEqual({ method: 'Lock', functionName: 'lock' });
    const signature = 'depositTransaction(address _to, uint256 _value, bytes _data)';
    expect(callMethod('depositTransaction', signature)).toEqual({
      method: 'Deposit Transaction',
      functionName: signature,
    });
    expect(callMethod('0xe9e05c42')).toEqual({ method: null, functionName: null });
    expect(callMethod(null)).toEqual({ method: null, functionName: null });
    expect(callSelector('0xE9E05C42')).toBe('0xe9e05c42');
    expect(callSelector('deposit')).toBeNull();
    expect(callInput('0x')).toBeNull();
    expect(callInput('0xe9e05c42')).toBe('0xe9e05c42');
  });
});

describe('call data size caps', () => {
  it('lists at most 32 arguments and caps each value with a visible cut', () => {
    const many = Array.from({ length: 40 }, (_, i) => String(i));
    expect(octraArgRows(many, null, null, t).args).toHaveLength(CALL_DATA_MAX);
    const huge = 'a'.repeat(CALL_VALUE_MAX + 500);
    const [arg] = octraArgRows([huge], null, null, t).args;
    expect(arg.value).toHaveLength(CALL_VALUE_MAX + 1);
    expect(arg.value.endsWith('…')).toBe(true);
    const params = Array.from({ length: 40 }, (_, i) => ({
      name: '',
      type: 'bytes',
      value: i ? '0x' : `0x${'ff'.repeat(CALL_VALUE_MAX)}`,
    }));
    const evm = evmCallData({ ...EVM_CALL, params }, {}, t);
    expect(evm).toHaveLength(CALL_DATA_MAX);
    expect(evm[0].value).toHaveLength(CALL_VALUE_MAX + 1);
  });

  it('keeps just past the shown size of a raw input and marks the cut', () => {
    const raw = `0xe9e05c42${'00'.repeat(CALL_VALUE_MAX)}`;
    const read = readEvmCall({ raw_input: raw }, EVM_CALL.contract)!;
    expect(read.input).toHaveLength(CALL_VALUE_MAX + 1);
    expect(read.selector).toBe('0xe9e05c42');
    const shown = callInput(read.input)!;
    expect(shown).toHaveLength(CALL_VALUE_MAX + 1);
    expect(shown.endsWith('…')).toBe(true);
  });
});

describe('calls the history list cut short', () => {
  const params = [{ name: '_to', type: 'address', value: DEST }];
  const fullInput = `0xe9e05c42${'0'.repeat(1000)}`;

  it('knows an input kept as its selector alone or a value ending in a cut', () => {
    expect(evmCallCut({ ...EVM_CALL, params, input: '0xe9e05c42' })).toBe(true);
    expect(evmCallCut({ ...EVM_CALL, params: [], input: '0xd0e30db0' })).toBe(false);
    expect(evmCallCut({ ...EVM_CALL, params, input: fullInput })).toBe(false);
    const cutValue = [{ name: 'data', type: 'bytes', value: '0xabc…' }];
    expect(evmCallCut({ ...EVM_CALL, params: cutValue, input: fullInput })).toBe(true);
    expect(evmCallCut(null)).toBe(false);
  });

  it('takes the full input from the explorer read over the cut one', async () => {
    const hash = '0xfeed';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          to: { hash: EVM_CALL.contract },
          raw_input: fullInput,
          decoded_input: { method_call: EVM_CALL.signature, parameters: params },
          fee: { value: '1' },
        }),
      }))
    );
    try {
      await fetchEvmTxDetail(11155111, hash, 'https://explorer.test');
    } finally {
      vi.unstubAllGlobals();
    }
    const item = {
      chainId: 11155111,
      hash,
      fee: '1',
      explorerUrl: '',
      call: { ...EVM_CALL, params, input: '0xe9e05c42' },
    } as never;
    const { result } = renderHook(() => useEvmTxDetail(item));
    expect(result.current.call?.input).toBe(fullInput);
    expect(result.current.loading).toBe(false);
  });
});

const EVM_CALL: EvmCall = {
  method: 'depositTransaction',
  selector: '0xe9e05c42',
  signature: 'depositTransaction(address _to, uint256 _value, bytes _data)',
  contract: '0x16Fc5058F25648194471939df75CF27A2fdC48BC',
  token: null,
  params: null,
};

const FULL: CallData = {
  method: 'Deposit Transaction',
  functionName: 'depositTransaction(address _to, uint256 _value, bytes _data)',
  selector: '0xe9e05c42',
  contract: { address: EVM_CALL.contract, name: 'OptimismPortal2' },
  args: [
    { index: 0, name: '_to', label: 'Recipient', type: 'address', value: DEST },
    {
      index: 1,
      name: '_value',
      label: 'Amount',
      type: 'uint256',
      value: '1000000000000000',
      friendly: '0.001 ETH',
    },
    { index: 2, label: 'Value 3', type: 'bytes', value: '0x' },
  ],
  input: `0xe9e05c42${'0'.repeat(120)}`,
};

describe('call data page', () => {
  const writeText = vi.fn(async () => {});
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  const sheet = (callData: CallData | null, pending = false, hash = 'aa', onClose = () => {}) => (
    <TxDetails
      open
      onClose={onClose}
      amount="Bridge"
      amountTone="var(--fg)"
      sub=""
      rows={[{ label: 'Method', value: 'Deposit Transaction' }]}
      hash={hash}
      explorerUrl={null}
      callData={callData}
      callDataPending={pending}
    />
  );

  it('opens from the View call data row and goes back with the Back button and Escape', () => {
    const onClose = vi.fn();
    render(sheet(FULL, false, 'aa', onClose));
    expect(screen.queryByText('Call data')).toBeNull();
    fireEvent.click(screen.getByText('View call data'));
    expect(screen.getByText('Call data')).toBeTruthy();
    expect(screen.queryByText('Copy hash')).toBeNull();
    const back = screen.getByRole('button', { name: 'Back' });
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    expect(screen.getByText('Copy hash')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText('View call data').closest('button'));

    fireEvent.click(screen.getByText('View call data'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back' }), { key: 'Escape' });
    expect(screen.getByText('Copy hash')).toBeTruthy();

    fireEvent.click(screen.getByText('View call data'));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('Copy hash')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lists the summary and every argument with its label, type and full value', () => {
    render(sheet(FULL));
    fireEvent.click(screen.getByText('View call data'));
    for (const text of [
      'Method',
      'Deposit Transaction',
      'Function',
      FULL.functionName!,
      'Selector',
      '0xe9e05c42',
      'Contract',
      'OptimismPortal2',
      EVM_CALL.contract,
      'Recipient',
      'address',
      DEST,
      'Amount',
      'uint256',
      '0.001 ETH',
      '1000000000000000',
      'Value 3',
      'bytes',
      'Input data',
      FULL.input!,
    ]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.queryByText(/Argument/)).toBeNull();
    expect(screen.getByText('1000000000000000').style.fontSize).toBe('10.5px');
    expect(screen.getByText('0.001 ETH').style.fontSize).toBe('12px');
  });

  it('clamps long values to six lines with Show all', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(104);
    try {
      render(sheet({ ...FULL, args: [], method: null, functionName: null, selector: null }));
      fireEvent.click(screen.getByText('View call data'));
      const value = screen.getByText(FULL.input!);
      expect(value.style.webkitLineClamp).toBe('6');
      const all = screen.getAllByText('Show all');
      fireEvent.click(all[all.length - 1]);
      expect(value.style.webkitLineClamp).toBe('none');
      expect(screen.getAllByText('Show all')).toHaveLength(1);
    } finally {
      height.mockRestore();
      client.mockRestore();
    }
  });

  it('copies the full raw value on tap and says Copied', async () => {
    render(sheet(FULL));
    fireEvent.click(screen.getByText('View call data'));
    await act(async () => {
      fireEvent.click(screen.getByText('1000000000000000'));
    });
    expect(writeText).toHaveBeenCalledWith('1000000000000000');
    expect(screen.getByText('Copied')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText(FULL.input!));
    });
    expect(writeText).toHaveBeenLastCalledWith(FULL.input);
  });

  it('holds the row disabled while reading and drops it when the call carried nothing', () => {
    const { rerender } = render(sheet(null, true));
    const row = screen.getByText('View call data').closest('button')!;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(screen.queryByText('Call data')).toBeNull();
    rerender(sheet({ ...FULL, args: [], input: null }));
    expect(screen.queryByText('View call data')).toBeNull();
    rerender(sheet({ ...FULL, args: [], input: '0xabcdef12' }));
    expect(screen.getByText('View call data').closest('button')!.disabled).toBe(false);
  });

  it('starts on the details page for another transaction', () => {
    const { rerender, unmount } = render(sheet(FULL, false, 'aa'));
    fireEvent.click(screen.getByText('View call data'));
    expect(screen.getByText('Call data')).toBeTruthy();
    rerender(sheet(FULL, false, 'bb'));
    expect(screen.queryByText('Call data')).toBeNull();
    expect(screen.getByText('View call data')).toBeTruthy();
    unmount();
    render(sheet(FULL, false, 'aa'));
    expect(screen.queryByText('Call data')).toBeNull();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
