import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WORDS = ['one', 'two', 'three'];
const store: Record<string, unknown> = {};

const h = vi.hoisted(() => ({
  ctx: null as unknown as Record<string, unknown>,
  showMessage: vi.fn(),
  state: null as { rebackup?: boolean } | null,
  passkey: false,
  authenticateWithPasskey: vi.fn(async () => 'pw'),
  loadWallet: vi.fn(),
  withEvmKey: vi.fn(),
  verifyPassword: vi.fn(),
  changePassword: vi.fn(),
  skipped: (): boolean => false,
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
  isPasskeyEnabled: async () => h.passkey,
  isWebAuthnAvailable: () => true,
  authenticateWithPasskey: h.authenticateWithPasskey,
}));
vi.mock('src/services/crypto/PasswordManager', () => ({
  WrongPasswordError: class WrongPasswordError extends Error {},
  passwordManager: {
    getSessionKey: async () => 'vk1.token',
    isPasswordSkipped: async () => h.skipped(),
    verifyPassword: h.verifyPassword,
    changePassword: h.changePassword,
  },
}));
vi.mock('src/services/wallet/WalletStorage', () => ({
  walletStorage: { loadWallet: h.loadWallet },
}));
vi.mock('src/services/evm/signer', () => ({ withEvmKey: h.withEvmKey }));
vi.mock('src/contexts/WalletContext', () => ({ useWallet: () => h.ctx }));
vi.mock('src/utils/secretClipboard', () => ({ copySecret: vi.fn(async () => true) }));

import SecurityBackupScreen from 'src/features/settings/screens/SecurityBackupScreen';

const open = async (evm = false) => {
  h.ctx = {
    showMessage: h.showMessage,
    activeWallet: {
      id: 'w1',
      address: 'oct1wallet',
      type: 'standard',
      mnemonic: true,
      metadata: {
        source: h.state?.rebackup ? 'generate' : 'imported',
        createdAt: Date.UTC(2026, 6, 1),
        ...(evm ? { evm: { enabled: true, address: '0xabc', index: 0 } } : {}),
      },
    },
    passwordManager: {},
    refreshWallets: vi.fn(async () => {}),
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

const typeNewPassword = (value: string) => {
  for (const field of screen.getByRole('dialog').querySelectorAll('input')) {
    fireEvent.change(field, { target: { value } });
  }
};

const cancelDialog = async () => {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await new Promise((r) => setTimeout(r, 400));
  });
};

const nothingRead = () => {
  expect(h.loadWallet).not.toHaveBeenCalled();
  expect(h.withEvmKey).not.toHaveBeenCalled();
};

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store.passwordSkipped = true;
  h.skipped = () => !!store.passwordSkipped;
  h.state = null;
  h.passkey = false;
  h.showMessage.mockClear();
  h.authenticateWithPasskey.mockClear();
  h.loadWallet.mockReset();
  h.loadWallet.mockImplementation(async () => ({ mnemonic: WORDS, privateKey: 'OCTRAKEY' }));
  h.withEvmKey.mockReset();
  h.withEvmKey.mockImplementation(async (_id, _index, _address, fn) => fn(new Uint8Array(32)));
  h.verifyPassword.mockReset();
  h.verifyPassword.mockImplementation(async (password: string) => password === 'pw');
  h.changePassword.mockReset();
  h.changePassword.mockImplementation(async (_old: string, next: string) => {
    store.passwordSkipped = false;
    store.hashedPassword = 'hash';
    h.verifyPassword.mockImplementation(async (password: string) => password === next);
    return { passkey: 'none' };
  });
  vi.mocked(chrome.storage.local.get).mockImplementation((async (keys: string | string[]) => {
    const out: Record<string, unknown> = {};
    for (const k of [keys].flat()) if (k in store) out[k] = store[k];
    return out;
  }) as never);
  vi.mocked(chrome.storage.local.set).mockImplementation((async (items: object) => {
    Object.assign(store, items);
  }) as never);
});

describe('a password before any secret in Settings', () => {
  it('asks to create a password before the recovery phrase and reads nothing', async () => {
    await open();
    await press('security.recoveryPhrase');
    expect(screen.getByText('security.createPassword')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'security.continue' })).toBeNull();
    nothingRead();
  });

  it('asks to create a password before the private key and the EVM key', async () => {
    await open(true);
    await press('security.privateKey');
    expect(screen.getByText('security.createPassword')).toBeTruthy();
    nothingRead();
  });

  it('asks to create a password before the re-backup', async () => {
    h.state = { rebackup: true };
    await open();
    expect(screen.getByText('security.createPassword')).toBeTruthy();
    nothingRead();
  });

  it('shows nothing when creating the password is cancelled', async () => {
    await open(true);
    await press('security.privateKey');
    await cancelDialog();
    expect(screen.queryByText('security.createPassword')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.changePassword).not.toHaveBeenCalled();
    nothingRead();
  });

  it('goes on to the recovery phrase once the password is created', async () => {
    await open();
    await press('security.recoveryPhrase');
    typeNewPassword('longenough');
    await press('security.create');
    expect(h.changePassword).toHaveBeenCalledWith('', 'longenough');
    await press('security.continue');
    expect(screen.queryByText('security.verifyPassword')).toBeNull();
    await press('security.reveal');
    expect(screen.getByText('two')).toBeTruthy();
  });

  it('goes on to the private key and the EVM key once the password is created', async () => {
    await open(true);
    await press('security.privateKey');
    typeNewPassword('longenough');
    await press('security.create');
    nothingRead();
    await press('security.continue');
    expect(screen.queryByText('security.verifyPassword')).toBeNull();
    expect(h.loadWallet).toHaveBeenCalledWith('w1', 'vk1.token');
    expect(h.withEvmKey).toHaveBeenCalledTimes(1);
    await press('security.reveal');
    expect(screen.getByText('OCTRAKEY')).toBeTruthy();
  });

  it('only creates the password from the Security row', async () => {
    h.ctx = {
      showMessage: h.showMessage,
      activeWallet: { id: 'w1', address: 'oct1wallet', type: 'standard', mnemonic: true },
      passwordManager: {},
      refreshWallets: vi.fn(async () => {}),
      clearMigrationState: vi.fn(),
    };
    await act(async () => {
      render(<SecurityBackupScreen view="security" />);
    });
    await press('security.createPassword');
    typeNewPassword('longenough');
    await press('security.create');
    expect(h.changePassword).toHaveBeenCalledWith('', 'longenough');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'security.changePassword' })).toBeTruthy();
    nothingRead();
  });
});

describe('a wallet that already has a password', () => {
  beforeEach(() => {
    store.passwordSkipped = false;
    store.hashedPassword = 'hash';
    store.salt = 'salt';
  });

  it('asks for the password and reads nothing on a wrong one', async () => {
    await open();
    await press('security.recoveryPhrase');
    await press('security.continue');
    expect(screen.getByText('security.verifyPassword')).toBeTruthy();
    expect(screen.queryByText('security.createPassword')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('security.enterWalletPassword'), {
      target: { value: 'bad' },
    });
    await press('security.verify');
    expect(screen.getByText('toast.err.password')).toBeTruthy();
    nothingRead();
  });

  it('shows the private key and the EVM key after the password', async () => {
    await open(true);
    await press('security.privateKey');
    await press('security.continue');
    fireEvent.change(screen.getByPlaceholderText('security.enterWalletPassword'), {
      target: { value: 'pw' },
    });
    await press('security.verify');
    expect(h.withEvmKey).toHaveBeenCalledTimes(1);
    await press('security.reveal');
    expect(screen.getByText('OCTRAKEY')).toBeTruthy();
  });

  it('shows the recovery phrase after the passkey', async () => {
    h.passkey = true;
    await open();
    await press('security.recoveryPhrase');
    await press('security.continue');
    nothingRead();
    await press('Passkey');
    expect(h.authenticateWithPasskey).toHaveBeenCalledTimes(1);
    await press('security.reveal');
    expect(screen.getByText('two')).toBeTruthy();
  });
});
