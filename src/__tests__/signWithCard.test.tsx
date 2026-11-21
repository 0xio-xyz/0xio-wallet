import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'src/lib/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('src/shared/ui/Mascot', () => ({ Mascot: (): null => null }));
vi.mock('src/shared/ui/WalletAvatar', () => ({ default: (): null => null }));
vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? key),
  }),
}));

import DAppApprovalScreen from 'src/features/dapp/screens/DAppApprovalScreen';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const sentTypes: string[] = [];

const show = async (extra: Record<string, unknown>, desktopReply: unknown = { status: 'done' }) => {
  const approval = {
    approvalId: 'x',
    origin: 'https://a.app',
    title: 'A',
    walletAddress: A,
    extensionNetwork: 'mainnet',
    permissions: [] as string[],
    ...extra,
  };
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((async (msg: any) => {
    sentTypes.push(msg.type);
    if (msg.type === 'GET_APPROVAL_DATA') return { success: true, data: approval };
    if (msg.type === 'GET_ALL_WALLETS') return { wallets: [{ id: A, name: 'Main', address: A }] };
    if (msg.type === 'DAPP_APPROVAL_DESKTOP') return desktopReply;
    return { success: true };
  }) as any);
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/dapp-approval/x']}>
        <Routes>
          <Route path="/dapp-approval/:approvalId" element={<DAppApprovalScreen />} />
        </Routes>
      </MemoryRouter>
    );
  });
};

beforeEach(() => {
  sentTypes.length = 0;
});

describe('Sign with on the connect review', () => {
  it('is hidden when the worker offers no desktop (not paired)', async () => {
    await show({});
    expect(await screen.findByText('dapp.connect')).toBeTruthy();
    expect(screen.queryByText('Sign with')).toBeNull();
    expect(screen.queryByText('0xio Desktop')).toBeNull();
  });

  it('shows both rows, and picking 0xio Desktop turns Connect into Continue', async () => {
    await show({ signWith: { available: true, pick: 'browser', network: 'mainnet' } });
    expect(await screen.findByText('Sign with')).toBeTruthy();
    expect(screen.getByText('This browser')).toBeTruthy();
    fireEvent.click(screen.getByText('0xio Desktop'));
    expect(screen.getByText('Continue')).toBeTruthy();
    expect(screen.queryByText('dapp.connect')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Continue'));
    });
    expect(sentTypes).toContain('DAPP_APPROVAL_DESKTOP');
    expect(sentTypes).not.toContain('DAPP_APPROVAL_RESPONSE');
  });

  it('offers Try again and Use this browser when the desktop is not reachable', async () => {
    await show(
      { signWith: { available: true, pick: 'desktop', network: 'mainnet' } },
      { status: 'unreachable' }
    );
    await act(async () => {
      fireEvent.click(await screen.findByText('Continue'));
    });
    expect(await screen.findByText('0xio Desktop is not reachable')).toBeTruthy();
    fireEvent.click(screen.getByText('Use this browser'));
    expect(screen.getByText('dapp.connect')).toBeTruthy();
  });
});
