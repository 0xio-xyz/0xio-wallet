import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionHistoryItem } from 'src/types/transaction';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

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

import { octraCallView, octraContractName } from 'src/shared/ui/txLabels';
import TxRow from 'src/shared/ui/TxRow';
import {
  methodKey,
  resetContractMethods,
  useContractMethods,
} from 'src/hooks/transactions/useContractMethods';
import { octraCallArgs } from 'src/hooks/transactions/useCallDetails';

const t = (key: string, o?: Record<string, unknown>) =>
  String(o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(o?.[k] ?? ''));

const ME = 'octMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeM';
const VAULT = 'octHqBuw3TGsgeGpu6GiumRTjQwc8VCRAo1ANhy5zL4ZVPc';
const BRIDGE = 'oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq';
const OTHER = 'octZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZ';

const call = (over: Partial<TransactionHistoryItem> = {}): TransactionHistoryItem => ({
  hash: 'aa'.repeat(32),
  timestamp: 1_790_000_000,
  type: 'outgoing',
  amount: 0,
  from: ME,
  to: VAULT,
  address: VAULT,
  nonce: 3,
  confirmed: true,
  status: 'success',
  opType: 'call',
  network: 'devnet',
  ...over,
});

beforeEach(() => {
  h.rpc.mockReset();
  resetContractMethods();
});

describe('Octra call rows', () => {
  it('names the action and the contract', () => {
    expect(octraCallView(call(), 'lock', 'devnet', t)).toMatchObject({
      title: 'Swap',
      contract: { address: VAULT, name: 'SwapVault' },
      method: 'Lock',
    });
    expect(octraCallView(call({ to: BRIDGE }), 'lock_to_eth', 'mainnet', t)).toMatchObject({
      title: 'Bridge',
      contract: { name: 'OCT Bridge' },
    });
    expect(octraCallView(call({ to: OTHER }), 'set_price', 'devnet', t)).toMatchObject({
      title: 'Set Price',
      contract: { address: OTHER, name: null },
      method: null as null,
    });
    expect(octraCallView(call({ to: OTHER }), undefined, 'devnet', t)?.title).toBe('Contract call');
    expect(octraCallView(call({ opType: 'transfer' }), 'lock', 'devnet', t)).toBeNull();
  });

  it('never names a contract after a token that looks like spam', () => {
    const tt = { recipient: ME, raw_amount: '5', contract_address: OTHER };
    expect(octraContractName('devnet', OTHER, { ...tt, symbol: 'GOOD', name: 'Good' })).toBe(
      'GOOD'
    );
    expect(octraContractName('devnet', OTHER, { ...tt, symbol: 'OCT', name: 'Octra' })).toBeNull();
    expect(
      octraContractName('devnet', OTHER, { ...tt, kind: 'nft', name: 'Claim at free-nft.io' })
    ).toBeNull();
  });

  it('shows a failed call as failed with no sign', () => {
    render(<TxRow tx={call({ status: 'failed', amount: 2 })} method="lock" network="Devnet" />);
    expect(screen.getByText('Swap')).toBeTruthy();
    expect(screen.getByText('history.failed')).toBeTruthy();
    expect(screen.getByText('SwapVault')).toBeTruthy();
    expect(screen.getByText('2 OCT')).toBeTruthy();
    expect(screen.queryByText(/^-/)).toBeNull();
  });

  it('reads call arguments from the transaction message', () => {
    expect(octraCallArgs('["swap_1b60", 5]')).toEqual(['swap_1b60', 5]);
    expect(octraCallArgs('not json')).toBeNull();
    expect(octraCallArgs(undefined)).toBeNull();
  });
});

describe('method lookups', () => {
  it('reads each call on its own network and keys the answer by network and hash', async () => {
    const hash = 'bb'.repeat(32);
    h.rpc.mockImplementation(
      async (_m: string, _p: unknown[], _q: boolean, pin: { networkId: string }) => ({
        method: pin.networkId === 'devnet' ? 'settle' : 'lock_to_eth',
      })
    );
    const txs = [call({ hash, network: 'devnet' }), call({ hash, network: 'mainnet', to: BRIDGE })];
    const { result } = renderHook(() => useContractMethods(txs, 'mainnet'));
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2));
    expect(result.current[methodKey('devnet', hash)]).toBe('settle');
    expect(result.current[methodKey('mainnet', hash)]).toBe('lock_to_eth');
    expect(h.rpc.mock.calls.map((c) => c[3].networkId).sort()).toEqual(['devnet', 'mainnet']);
    const saved = vi.mocked(chrome.storage.local.set).mock.calls.slice(-1)[0]?.[0] as Record<
      string,
      Record<string, string>
    >;
    expect(Object.keys(saved.contract_methods_v2)).toEqual(
      expect.arrayContaining([`devnet:${hash}`, `mainnet:${hash}`])
    );
  });

  it('keeps the row as Contract call when the receipt cannot be read', async () => {
    h.rpc.mockRejectedValue(new Error('429'));
    const txs = [call({ hash: 'cc'.repeat(32) })];
    const { result } = renderHook(() => useContractMethods(txs, 'devnet'));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual({});
  });
});

describe('Testnet tag', () => {
  it('tags a devnet row and a Sepolia row, never a mainnet row', async () => {
    const { EvmTxRow } = await import('src/shared/ui/TxRow');
    const evm = {
      key: '11155111:0x1',
      chainId: 11155111,
      chainName: 'Sepolia',
      testnet: true,
      hash: `0x${'1'.repeat(64)}`,
      timestamp: 1_790_000_000,
      direction: 'incoming' as const,
      from: '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0',
      to: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
      token: null as null,
      amount: '',
      method: null as null,
      failed: false,
      explorerUrl: '',
    };
    const { unmount } = render(
      <>
        <TxRow tx={call({ network: 'devnet', status: 'success' })} method="lock" />
        <EvmTxRow item={evm} />
      </>
    );
    expect(screen.getAllByText('Testnet')).toHaveLength(2);
    unmount();
    render(
      <>
        <TxRow tx={call({ network: 'mainnet', to: BRIDGE })} method="lock_to_eth" />
        <EvmTxRow item={{ ...evm, testnet: false, chainId: 1, chainName: 'Ethereum' }} />
      </>
    );
    expect(screen.queryByText('Testnet')).toBeNull();
  });

  it('leaves the amount slot empty for a call that moved nothing and keeps the network line', async () => {
    const { EvmTxRow } = await import('src/shared/ui/TxRow');
    render(
      <>
        <TxRow tx={call({ to: OTHER })} method="cancel_listing" network="Devnet" />
        <EvmTxRow
          item={{
            key: '1:0x2',
            chainId: 1,
            chainName: 'Ethereum',
            testnet: false,
            hash: `0x${'2'.repeat(64)}`,
            timestamp: 1_790_000_000,
            direction: 'outgoing',
            from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
            to: '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0',
            token: null,
            amount: '',
            method: 'setApprovalForAll',
            failed: false,
            explorerUrl: '',
          }}
        />
      </>
    );
    expect(screen.queryByText(/\b0 (OCT|ETH)\b/)).toBeNull();
    expect(screen.getByText('Devnet')).toBeTruthy();
    expect(screen.getByText('Ethereum')).toBeTruthy();
  });

  it('shows dust as < 0.000001 with no sign on both sides', async () => {
    const { EvmTxRow } = await import('src/shared/ui/TxRow');
    render(
      <>
        <TxRow tx={call({ opType: 'transfer', amount: 0.0000001 })} />
        <EvmTxRow
          item={{
            key: '1:0x3',
            chainId: 1,
            chainName: 'Ethereum',
            testnet: false,
            hash: `0x${'3'.repeat(64)}`,
            timestamp: 1_790_000_000,
            direction: 'outgoing',
            from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
            to: '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0',
            token: {
              chainId: 1,
              address: null,
              symbol: 'ETH',
              name: 'Ether',
              decimals: 18,
              logo: null,
            },
            amount: '0.0000000123',
            method: null,
            failed: false,
            explorerUrl: '',
          }}
        />
      </>
    );
    expect(screen.getByText('< 0.000001 OCT')).toBeTruthy();
    expect(screen.getByText('< 0.000001 ETH')).toBeTruthy();
    expect(screen.queryByText(/-</)).toBeNull();
  });
});
