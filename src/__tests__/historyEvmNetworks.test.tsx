import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ctx: {} as Record<string, unknown>,
  local: new Map<string, unknown>(),
  reads: [] as string[],
  urls: [] as string[],
}));

vi.mock('src/contexts/WalletContext', () => ({ useWallet: () => h.ctx }));
vi.mock('src/hooks/wallet/useTransactionHistory', () => ({
  useTransactionHistory: () => ({
    transactions: [] as unknown[],
    cancellable: [] as string[],
    isLoading: false,
    reload: () => {},
    hideTransaction: async () => true,
    cancelTransaction: async () => 'cancelled',
  }),
  useMempoolTxs: (): unknown[] => [],
}));
vi.mock('src/hooks/wallet/useTokenPrice', () => ({
  useTokenPrice: () => ({ getUsdValue: (): null => null }),
}));
vi.mock('src/hooks/transactions/useContractMethods', () => ({
  useContractMethods: () => ({}),
  methodKey: (network: string, hash: string) => `${network}:${hash}`,
}));
vi.mock('src/shared/ui/Header', () => ({
  default: ({ rightAction }: { rightAction?: unknown }) => <div>{rightAction as never}</div>,
}));
vi.mock('src/shared/ui/Mascot', () => ({ Mascot: (): null => null }));
vi.mock('src/shared/ui/TxDetailSheet', () => ({ default: (): null => null }));
vi.mock('src/shared/ui/EvmTxDetailSheet', () => ({ default: (): null => null }));
vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      String(o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(o?.[k] ?? '')),
    i18n: { resolvedLanguage: 'en' },
  }),
}));

import HistoryScreen from 'src/features/transactions/screens/HistoryScreen';

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PEER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const OCT = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const hash = (n: number) => `0x${String(n).padStart(64, '0')}`;
const PHRASE = 'test test test test test test test test test test test junk';

const added = (chainId: number, name: string, explorerUrl: string, testnet = false) => ({
  custom: true,
  chainId,
  name,
  rpcUrl: `https://rpc-${chainId}.example`,
  testnet,
  nativeSymbol: 'ETH',
  nativeName: 'Ether',
  logoChainId: chainId,
  explorerUrl,
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  h.local.clear();
  h.reads.length = 0;
  h.urls.length = 0;
  const c = chrome as unknown as Record<string, any>;
  c.storage.local.get = vi.fn(async (keys: unknown) => {
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
    h.reads.push(...list);
    return Object.fromEntries(list.filter((k) => h.local.has(k)).map((k) => [k, h.local.get(k)]));
  });
  c.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) h.local.set(k, structuredClone(v));
  });
  c.storage.onChanged = { addListener: () => {}, removeListener: () => {} };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      h.urls.push(url);
      if (url.endsWith('/api/v2/stats')) {
        return url.includes('blockscout')
          ? new Response(JSON.stringify({ total_blocks: '1' }), { status: 200 })
          : new Response('nope', { status: 404 });
      }
      if (url.includes('/token-transfers')) return new Response('{"items":[]}', { status: 200 });
      const at = url.includes('base-sepolia') ? '2026-10-11' : '2026-10-12';
      const n = url.includes('base-sepolia') ? 2 : 1;
      const items = [
        {
          hash: hash(n),
          timestamp: `${at}T00:00:00.000000Z`,
          from: { hash: PEER },
          to: { hash: ME },
          value: '1000000000000000000',
          status: 'ok',
        },
      ];
      return new Response(JSON.stringify({ items, transactions: [], token_transfers: [] }), {
        status: 200,
      });
    })
  );
});

describe('History on a wallet without EVM', () => {
  const run = async (wallet: Record<string, unknown>) => {
    h.ctx = {
      activeWallet: wallet,
      wallets: [wallet],
      networkId: 'mainnet',
      showMessage: () => {},
      refreshBalance: () => {},
    };
    render(<HistoryScreen />);
    await flush();
    fireEvent.click(screen.getByText('Testnet'));
    await flush();
  };

  it('makes no EVM request for a private key wallet, even with a stale 0x address', async () => {
    await run({
      id: 'k',
      address: OCT,
      type: 'standard',
      privateKey: 'a2V5',
      metadata: { evm: { enabled: true, address: ME, index: 0 } },
    });
    expect(h.urls).toEqual([]);
    expect(h.reads.filter((k) => k.startsWith('evm'))).toEqual([]);
  });

  it('makes no EVM request for a phrase wallet with EVM turned off', async () => {
    await run({
      id: 'p',
      address: OCT,
      type: 'standard',
      mnemonic: PHRASE,
      metadata: { evm: { enabled: false, address: ME, index: 0 } },
    });
    expect(h.urls).toEqual([]);
    expect(h.reads.filter((k) => k.startsWith('evm'))).toEqual([]);
  });
});

describe('History on added networks', () => {
  it('lists each added network on its own page with its name, and names one without history', async () => {
    h.local.set('evm_custom_networks', [
      added(8453, 'Base', 'https://base.blockscout.com'),
      added(84532, 'Base Sepolia', 'https://base-sepolia.blockscout.com', true),
      added(56, 'BNB Smart Chain', 'https://bscscan.com'),
    ]);
    h.local.set('evm_network_prefs', {
      '1': { enabled: false },
      '4663': { enabled: false },
      '11155111': { enabled: false },
      '46630': { enabled: false },
    });
    const wallet = {
      id: 'p2',
      address: OCT,
      type: 'standard',
      mnemonic: PHRASE,
      metadata: { evm: { enabled: true, address: ME, index: 0 } },
    };
    h.ctx = {
      activeWallet: wallet,
      wallets: [wallet],
      networkId: 'mainnet',
      showMessage: () => {},
      refreshBalance: () => {},
    };
    render(<HistoryScreen />);
    await flush();

    expect(screen.getByText('Base')).toBeTruthy();
    expect(screen.queryByText('Base Sepolia')).toBeNull();
    expect(screen.getByText('History not available on BNB Smart Chain.')).toBeTruthy();
    expect(h.urls.some((u) => u.includes('bscscan'))).toBe(false);

    fireEvent.click(screen.getByText('Testnet'));
    await flush();
    expect(screen.getByText('Base Sepolia')).toBeTruthy();
    expect(screen.queryByText('Base')).toBeNull();
    expect(screen.queryByText(/History not available/)).toBeNull();
    expect(h.local.get(`evm_hist:${ME.toLowerCase()}`)).toMatchObject({
      unavailableChains: [56],
    });
  });
});
