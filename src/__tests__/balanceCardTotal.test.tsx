import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
  price: 0,
}));

vi.mock('src/contexts/WalletContext', () => ({ useWallet: () => h.wallet }));
vi.mock('src/hooks/privacy/usePrivateStatus', () => ({ usePrivateStatus: (): null => null }));
vi.mock('src/hooks/wallet/useTokenPrice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/hooks/wallet/useTokenPrice')>()),
  useTokenPrice: () => ({
    prices: {},
    priceHistory: [] as unknown[],
    getPrice: () => h.price,
    getUsdValue: (_s: string, v: number) => (h.price > 0 ? `$${(v * h.price).toFixed(2)}` : null),
  }),
}));
vi.mock('src/services/wallet/BalanceHistory', () => ({
  getSnapshots: async (): Promise<unknown[]> => [],
}));
vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

import BalanceCard from 'src/features/wallet/components/BalanceCard';
import { pricedHoldings } from 'src/features/wallet/home/pricedHoldings';

const shown = () => document.getElementById('balance-display')?.textContent;

const wallet = (
  balance: string | null,
  privateBalance: string | null,
  totalBalance: string | null,
  privateKey?: string
) => ({
  balance,
  privateBalance,
  totalBalance,
  privateUnavailable: false,
  refreshBalance: vi.fn(),
  pollBalance: vi.fn(),
  isLocked: false,
  activeWallet: { address: 'octA', privateKey },
  showBalanceValues: true,
  setShowBalanceValues: vi.fn(),
  networkId: 'devnet',
});

beforeEach(() => {
  h.price = 0;
});

describe('Home total', () => {
  it('shows the snapshot total, not a fresh public plus an older private', () => {
    h.wallet = wallet('15', '5', '15');
    const view = render(<BalanceCard />);
    expect(shown()).toBe('15');
    view.unmount();
  });

  it('agrees between the OCT and USD figures', () => {
    h.price = 2;
    h.wallet = wallet('15', '5', '15');
    const view = render(<BalanceCard />);
    expect(shown()).toBe('$30.00');
    view.unmount();
  });

  it('falls back to the public balance when the wallet has no private half', () => {
    h.wallet = wallet('12', null, null);
    const view = render(<BalanceCard />);
    expect(shown()).toBe('12');
    view.unmount();
  });

  it('shows unknown, not 0, before the first read', () => {
    h.wallet = wallet(null, null, null);
    const view = render(<BalanceCard />);
    expect(shown()).toBe('--');
    view.unmount();
  });

  it('shows the public half while the private half decrypts, with no line under it', () => {
    h.wallet = wallet('10', null, null, 'pk');
    const view = render(<BalanceCard />);
    expect(shown()).toBe('10');
    expect(view.queryByText('Some balances missing')).toBeNull();
    view.unmount();
  });

  it('shows the public half with no line when the private read failed', () => {
    h.wallet = { ...wallet('10', null, null, 'pk'), privateUnavailable: true };
    const view = render(<BalanceCard />);
    expect(shown()).toBe('10');
    expect(view.queryByText('Some balances missing')).toBeNull();
    view.unmount();
  });

  it('drops the loading line once the snapshot total lands', () => {
    h.wallet = wallet('10', '5', '15', 'pk');
    const view = render(<BalanceCard />);
    expect(shown()).toBe('15');
    expect(view.queryByText('Some balances missing')).toBeNull();
    view.unmount();
  });
});

const evmRow = (chainId: number, usd: number | null, extra: Record<string, unknown> = {}) => ({
  chainId,
  chainName: 'Ethereum',
  testnet: false,
  token: {
    chainId,
    address: null as string | null,
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    logo: null as string | null,
  },
  raw: '1',
  amount: '1',
  usd,
  ...extra,
});

describe('All networks total', () => {
  const priced = (evm: Parameters<typeof pricedHoldings>[0]['evm'], octTotal: number | null) =>
    pricedHoldings({
      view: 'all',
      networkId: 'mainnet',
      octPrice: 2,
      octTotal,
      octra: { tokens: [], balances: {}, imported: [], state: 'known' },
      evm,
    });

  it('adds Octra and priced EVM rows', () => {
    h.price = 2;
    h.wallet = wallet('5', null, null);
    const p = priced({ on: true, rows: [evmRow(1, 100)], loading: false, failedChains: [] }, 5);
    const view = render(<BalanceCard view="all" priced={p} />);
    expect(shown()).toBe('$110.00');
    view.unmount();
  });

  it('shows what is known while a chain is still loading with nothing cached', () => {
    h.price = 2;
    h.wallet = wallet('5', null, null);
    const p = priced({ on: true, rows: [], loading: true, failedChains: [] }, 5);
    expect(p.state).toBe('pending');
    const view = render(<BalanceCard view="all" priced={p} />);
    expect(shown()).toBe('$10.00');
    expect(view.queryByText('Some balances missing')).toBeNull();
    view.unmount();
  });

  it('shows unknown only while nothing at all is in', () => {
    h.price = 2;
    h.wallet = wallet(null, null, null);
    const p = priced({ on: true, rows: [], loading: true, failedChains: [] }, null);
    expect(p.state).toBe('loading');
    const view = render(<BalanceCard view="all" priced={p} />);
    expect(shown()).toBe('--');
    view.unmount();
  });

  it('marks the total partial when a chain failed with nothing cached', () => {
    h.price = 2;
    h.wallet = wallet('5', null, null);
    const p = priced({ on: true, rows: [evmRow(1, 100)], loading: false, failedChains: [4663] }, 5);
    expect(p.state).toBe('partial');
    const view = render(<BalanceCard view="all" priced={p} />);
    expect(shown()).toBe('$110.00');
    expect(view.getByText('Some balances missing')).toBeTruthy();
    view.unmount();
  });
});
