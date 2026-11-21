import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WORDS = ['one', 'two', 'three'];
const store: Record<string, unknown> = {};

const h = vi.hoisted(() => ({
  ctx: null as unknown as Record<string, unknown>,
  showMessage: vi.fn(),
  copySecret: vi.fn(async () => true),
  state: { rebackup: true } as { rebackup?: boolean } | null,
}));

vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? key),
  }),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,' } }));
vi.mock('src/lib/router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ state: h.state }),
}));
vi.mock('src/shared/ui/Header', () => ({ default: (): null => null }));
vi.mock('src/shared/ui/WalletAvatar', () => ({ default: (): null => null }));
vi.mock('src/services/crypto/PasskeyService', () => ({
  isPasskeyEnabled: async () => false,
  isWebAuthnAvailable: () => false,
}));
vi.mock('src/services/crypto/PasswordManager', () => ({
  WrongPasswordError: class WrongPasswordError extends Error {},
  passwordManager: {
    getSessionKey: async () => 'vk1.token',
    isPasswordSkipped: async () => false,
    verifyPassword: async () => true,
  },
}));
vi.mock('src/services/wallet/WalletStorage', () => ({
  walletStorage: { loadWallet: async () => ({ mnemonic: WORDS, privateKey: 'k' }) },
}));
vi.mock('src/services/evm/signer', () => ({ withEvmKey: vi.fn() }));
vi.mock('src/contexts/WalletContext', () => ({ useWallet: () => h.ctx }));
vi.mock('src/utils/secretClipboard', () => ({ copySecret: h.copySecret }));

import SecurityBackupScreen from 'src/features/settings/screens/SecurityBackupScreen';

const wallet = (address: string) => ({
  id: address,
  address,
  type: 'standard',
  mnemonic: true,
  metadata: { source: 'generate', createdAt: Date.UTC(2026, 6, 1) },
});

const openSheet = async (address: string) => {
  h.ctx = {
    showMessage: h.showMessage,
    activeWallet: wallet(address),
    passwordManager: {},
    refreshWallets: vi.fn(),
    clearMigrationState: vi.fn(),
  };
  await act(async () => {
    render(<SecurityBackupScreen view="backup" />);
  });
};

const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

const unlock = async () => {
  fireEvent.change(screen.getByPlaceholderText('security.enterWalletPassword'), {
    target: { value: 'pw' },
  });
  await press('security.verify');
};

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store.hashedPassword = 'hash';
  h.state = { rebackup: true };
  h.showMessage.mockClear();
  h.copySecret.mockClear();
  vi.mocked(chrome.storage.local.get).mockImplementation((async (keys: string | string[]) => {
    const out: Record<string, unknown> = {};
    for (const k of [keys].flat()) if (k in store) out[k] = store[k];
    return out;
  }) as never);
  vi.mocked(chrome.storage.local.set).mockImplementation((async (items: object) => {
    Object.assign(store, items);
  }) as never);
});

describe('re-backup from Settings', () => {
  it('copies through the secret clipboard and ends with Backed up', async () => {
    await openSheet('oct1again');
    await press('security.continue');
    await unlock();
    await press('security.reveal');
    await press('security.copyPhrase');
    expect(h.copySecret).toHaveBeenCalledWith('one two three');
    await press('I have written it down');
    expect(store.rebackupDone).toEqual(['oct1again']);
    expect(h.showMessage).toHaveBeenCalledWith('Backed up', 'success');
    expect(screen.queryByText('two')).toBeNull();
  });

  it('does not ask to confirm again once the re-backup is done', async () => {
    store.rebackupDone = ['oct1done'];
    h.state = null;
    await openSheet('oct1done');
    await press('security.recoveryPhrase');
    await press('security.continue');
    await unlock();
    await press('security.reveal');
    expect(screen.getByText('two')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I have written it down' })).toBeNull();
    expect(screen.getByRole('button', { name: 'security.copyPhrase' })).toBeTruthy();
  });
});
