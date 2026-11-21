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

import { normalizeSiteCall, normalizeSiteTx } from 'src/utils/octra/dappTxRequest';
import TransactionApprovalScreen from 'src/features/transactions/screens/TransactionApprovalScreen';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'octCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
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

const normalized = (n: { ok: boolean; tx?: object }) => {
  if (!n.ok) throw new Error('not normalized');
  return n.tx!;
};

describe('the site review shows what is signed', () => {
  it('shows the signed contract, method and every argument digit', async () => {
    const tx = normalizeSiteTx({
      to: C,
      encrypted_data: 'lock',
      message: '[12345678901234567890, "oct"]',
    });
    await show({ methods: 'send_transaction', params: { ...normalized(tx), ou: '3500' } });
    expect(await screen.findByText(C)).toBeTruthy();
    expect(screen.getByText('Lock')).toBeTruthy();
    expect(screen.getByText('12,345,678,901,234,567,890')).toBeTruthy();
    expect((screen.getByText('common.confirm') as HTMLElement).closest('button')!.disabled).toBe(
      false
    );
  });

  it('reads no alias the signer ignores', async () => {
    await show({
      methods: 'send_transaction',
      params: { op_type: 'standard', to: B, contract: C, amount: '1000000', ou: '3500' },
    });
    expect(await screen.findByText(B)).toBeTruthy();
    expect(screen.queryByText(C)).toBeNull();
  });

  it('blocks a review whose recipient is not an address', async () => {
    await show({
      methods: 'send_transaction',
      params: { op_type: 'standard', contract: C, amount: '1000000', ou: '3500' },
    });
    expect(await screen.findByText('Invalid request')).toBeTruthy();
    expect((screen.getByText('common.confirm') as HTMLElement).closest('button')!.disabled).toBe(
      true
    );
  });

  it('lists each sequence step with the exact arguments and amount it signs', async () => {
    const step = normalized(
      normalizeSiteCall({
        contract: C,
        method: 'swap',
        message: '[99999999999999999999, "a"]',
        amount: '2500000',
      })
    );
    await show({
      methods: 'send_contract_transaction_sequence',
      params: { transactions: [{ ...step, ou: '3500' }] },
    });
    expect(await screen.findByText('1. swap')).toBeTruthy();
    expect(screen.getByText(C)).toBeTruthy();
    expect(
      screen.getByText((_c, el) => el?.textContent === '99999999999999999999\na')
    ).toBeTruthy();
    expect(screen.getByText(/Attaching 2.5 OCT/)).toBeTruthy();
  });
});
