import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  evmChart: vi.fn((key: string | null) => ({
    points: key ? [{ time: 1, price: 9 }] : [],
    loading: false,
  })),
  octChart: vi.fn((_range: string, enabled: boolean) => ({
    points: enabled ? [{ time: 1, price: 0.03 }] : [],
    loading: false,
  })),
}));

vi.mock('src/hooks/wallet/useEvmPrices', () => ({ useEvmChart: h.evmChart }));
vi.mock('src/hooks/wallet/useOctChart', () => ({ useOctChart: h.octChart }));
vi.mock('src/hooks/wallet/useTokenPrice', () => ({
  useTokenPrice: () => ({ priceHistory: [{ time: 1, value: 0.03 }] }),
}));
vi.mock('src/hooks/wallet/useEvmHistory', () => ({
  useEvmHistory: () => ({ items: [] as unknown[], loading: false }),
}));
vi.mock('src/lib/router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }): string => o?.defaultValue ?? k,
  }),
}));
vi.mock('src/features/wallet/components/TokenList', () => ({ EvmTokenIcon: (): null => null }));
vi.mock('src/features/wallet/token/TokenDetailSheet', () => ({
  default: ({ market }: { market: { points: { price: number }[] } }) => (
    <span data-testid="chart">{market.points.map((p) => p.price).join(',') || 'none'}</span>
  ),
}));

import EvmTokenDetail from 'src/features/wallet/token/EvmTokenDetail';
import { BRIDGE } from 'src/services/bridge/constants';
import type { EvmHolding } from 'src/features/wallet/home/pricedHoldings';

const holding = (address: string | null, symbol: string): EvmHolding => ({
  chainId: 1,
  chainName: 'Ethereum',
  testnet: false,
  token: { chainId: 1, address, symbol, name: symbol, decimals: 6, logo: null },
  raw: '1',
  amount: '1',
  usd: null,
});

describe('EVM token chart source', () => {
  it('charts wOCT from the OCT oracle history, never DefiLlama', () => {
    render(
      <EvmTokenDetail row={holding(BRIDGE.wOCT, 'wOCT')} evmAddress="0xE" onClose={() => {}} />
    );
    expect(screen.getByTestId('chart').textContent).toBe('0.03');
    expect(h.evmChart).toHaveBeenLastCalledWith(null, '1D');
    expect(h.octChart).toHaveBeenLastCalledWith('1D', true, [{ time: 1, value: 0.03 }]);
  });

  it('charts other tokens from DefiLlama', () => {
    render(<EvmTokenDetail row={holding(null, 'ETH')} evmAddress="0xE" onClose={() => {}} />);
    expect(screen.getByTestId('chart').textContent).toBe('9');
    expect(h.evmChart).toHaveBeenLastCalledWith('coingecko:ethereum', '1D');
    expect(h.octChart).toHaveBeenLastCalledWith('1D', false, expect.anything());
  });
});
