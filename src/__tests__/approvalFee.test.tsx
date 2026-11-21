import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'src/lib/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('src/services/network/NetworkService', () => ({
  networkService: { getContractParamNames: vi.fn(async () => null) },
  privacyNetworkService: {},
}));
vi.mock('src/services/crypto/PasskeyService', () => ({
  isPasskeyEnabled: vi.fn(async () => false),
  authenticateWithPasskey: vi.fn(),
}));
vi.mock('src/contexts/WalletContext', () => ({
  useWallet: () => ({ isLocked: false, unlockWallet: vi.fn(), passwordSkipped: false }),
}));
vi.mock('src/features/dapp/components/SignerRow', () => ({ default: (): null => null }));
vi.mock('src/shared/ui/Mascot', () => ({ Mascot: (): null => null }));
vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      String(opts?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts?.[k])),
  }),
}));

import TransactionApprovalScreen from 'src/features/transactions/screens/TransactionApprovalScreen';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
let stored: Record<string, unknown> = {};

beforeEach(() => {
  (chrome.storage as any).local = {
    get: async (key: string) => ({ [key]: stored }),
    set: async () => {},
    remove: async () => {},
  };
});

const show = async (request: Record<string, unknown>) => {
  stored = {
    origin: 'https://a.app',
    walletAddress: A,
    networkId: 'mainnet',
    networkUrl: 'https://octra.network',
    ...request,
  };
  render(
    <MemoryRouter initialEntries={['/approve/1']}>
      <Routes>
        <Route path="/approve/:approvalId" element={<TransactionApprovalScreen />} />
      </Routes>
    </MemoryRouter>
  );
};

describe('the site review fee', () => {
  it('shows the claim amount, the count and the live fee', async () => {
    await show({
      methods: 'claim_private_transfer',
      params: { transferId: '42', amount_raw: '2500000', count: 1, ou: '1000000' },
    });
    expect(await screen.findByText('Claim 2.5 OCT privately')).toBeTruthy();
    expect(screen.getByText('Transfers')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('1 OCT')).toBeTruthy();
    expect((screen.getByText('common.confirm') as HTMLElement).closest('button')!.disabled).toBe(
      false
    );
  });

  it('blocks a review that carries no fee and never shows a default', async () => {
    await show({ methods: 'send_transaction', params: { to: A, amount: '1000000' } });
    expect(await screen.findByText('Network fee unavailable. Try again.')).toBeTruthy();
    expect(screen.queryByText('0.003 OCT')).toBeNull();
    expect((screen.getByText('common.confirm') as HTMLElement).closest('button')!.disabled).toBe(
      true
    );
  });
});
