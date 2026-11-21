import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'src/lib/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sync: {
    pairSheet: null as null | { phase: string; codes: string[] | null; picked: number | null },
    pairing: false,
    status: 'unknown',
    pair: vi.fn(),
    cancelPair: vi.fn(),
    pickPairCode: vi.fn(),
    submitPairPick: vi.fn(),
    unpair: vi.fn(),
  },
  loadPairing: vi.fn(),
  showMessage: vi.fn(),
}));

vi.mock('src/hooks/wallet/useDesktopSync', () => ({ useDesktopSync: () => h.sync }));
vi.mock('src/services/desktop/desktopPairing', () => ({ loadPairing: h.loadPairing }));
vi.mock('src/contexts/WalletContext', () => ({
  useWallet: () => ({ showMessage: h.showMessage }),
}));
vi.mock('src/services/wallet/AddressBookService', () => ({
  addressBookService: { getAllContacts: vi.fn(async () => []) },
}));
vi.mock('src/shared/ui/Header', () => ({ default: (): null => null }));
vi.mock('src/shared/ui/Mascot', () => ({ Mascot: (): null => null }));
vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

import DesktopPairSheet from 'src/features/settings/components/DesktopPairSheet';
import ConnectionsScreen from 'src/features/settings/screens/ConnectionsScreen';

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

beforeEach(() => {
  Object.assign(h.sync, { pairSheet: null, pairing: false, status: 'unknown' });
  h.sync.pair.mockReset();
  h.sync.cancelPair.mockReset();
  h.sync.pickPairCode.mockReset();
  h.sync.submitPairPick.mockReset();
  h.sync.unpair.mockReset();
  h.loadPairing.mockReset();
  h.showMessage.mockReset();
});

const CODES = ['139 604', '482 913', '760 358'];
const sheetIn = (phase: string, picked: number | null = null, codes: string[] | null = CODES) =>
  Object.assign(h.sync, { pairSheet: { phase, codes, picked } });
const pairButton = () => screen.getByRole('button', { name: 'Pair' }) as HTMLButtonElement;

describe('pairing sheet', () => {
  it('is closed unless pairing', () => {
    render(<DesktopPairSheet />);
    expect(screen.queryByText('Pick the code on 0xio Desktop')).toBeNull();
  });

  it('connects with masked rows and a status line that keeps its place', () => {
    sheetIn('connecting', null, null);
    render(<DesktopPairSheet />);
    expect(screen.getByText('Pick the code on 0xio Desktop')).toBeTruthy();
    const line = screen.getByText('Connecting to 0xio Desktop') as HTMLElement;
    expect(line.style.height).toBe('18px');
    expect(screen.getAllByText('••• •••')).toHaveLength(3);
    expect(pairButton().disabled).toBe(true);
  });

  it('lets the user pick one of three codes, then pair', () => {
    sheetIn('choosing');
    const view = render(<DesktopPairSheet />);
    expect(pairButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '482 913' }));
    expect(h.sync.pickPairCode).toHaveBeenCalledWith(1);
    sheetIn('choosing', 1);
    view.rerender(<DesktopPairSheet />);
    expect(screen.getByRole('button', { name: '482 913' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    fireEvent.click(pairButton());
    expect(h.sync.submitPairPick).toHaveBeenCalled();
  });

  it('waits for the desktop after the right pick, with Cancel still open', () => {
    sheetIn('waiting', 1);
    render(<DesktopPairSheet />);
    expect(screen.getByText('Approve on 0xio Desktop')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Waiting' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.sync.cancelPair).toHaveBeenCalled();
  });

  it.each([
    ['wrong', 'Wrong code. Pairing stopped'],
    ['refused', 'Refused on 0xio Desktop'],
    ['timeout', 'Pairing timed out'],
  ])('ends a %s exchange with Close and Try again', (phase, line) => {
    sheetIn(phase, 0);
    h.sync.pair.mockResolvedValue('paired');
    render(<DesktopPairSheet />);
    expect((screen.getByText(line) as HTMLElement).style.color).toBe('var(--neg)');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(h.sync.pair).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(h.sync.cancelPair).toHaveBeenCalled();
  });

  it('shows Paired with the footer kept in place but hidden', () => {
    sheetIn('paired', 1);
    render(<DesktopPairSheet />);
    expect(screen.getByText('Paired')).toBeTruthy();
    const footer = screen.getByText('Cancel').parentElement as HTMLElement;
    expect(footer.style.visibility).toBe('hidden');
  });
});

describe('Settings: 0xio Desktop', () => {
  const show = async () => {
    render(
      <MemoryRouter>
        <ConnectionsScreen />
      </MemoryRouter>
    );
    await settle();
  };

  it('unpairs a paired desktop', async () => {
    h.loadPairing.mockResolvedValueOnce({ v: 1 }).mockResolvedValue(null);
    h.sync.unpair.mockResolvedValue(undefined);
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Unpair' }));
    await settle();
    expect(h.sync.unpair).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pair' })).toBeTruthy();
  });

  it('pairs when not paired; a refusal shows in the sheet, never as a toast', async () => {
    h.loadPairing.mockResolvedValue(null);
    h.sync.pair.mockResolvedValue('refused');
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await settle();
    expect(h.sync.pair).toHaveBeenCalled();
    expect(h.showMessage).not.toHaveBeenCalled();
  });
});
