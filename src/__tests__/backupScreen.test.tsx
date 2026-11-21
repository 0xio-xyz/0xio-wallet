import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WORDS12 = 'one two three four five six seven eight nine ten eleven twelve'.split(' ');
const WORDS24 = [...WORDS12, ...WORDS12.map((w) => `${w}b`)];

const h = vi.hoisted(() => ({
  ctx: {
    activeWallet: { id: 'w1', address: 'oct1wallet' },
    showMessage: vi.fn(),
    isLocked: false,
    refreshWallets: vi.fn(async () => {}),
    clearMigrationState: vi.fn(),
  },
  navigate: vi.fn(),
  skipped: false,
  changePassword: vi.fn(),
  mnemonic: [] as string[] | string,
  loadWallet: vi.fn(),
  verifyPassword: vi.fn(async () => true),
  clearBackupPending: vi.fn(async () => {}),
  copySecret: vi.fn(async () => true),
}));

vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? key),
  }),
}));
vi.mock('src/lib/router', () => ({ useNavigate: () => h.navigate }));
vi.mock('src/contexts/WalletContext', () => ({ useWallet: () => h.ctx }));
vi.mock('src/services/crypto/PasswordManager', () => ({
  WrongPasswordError: class WrongPasswordError extends Error {},
  passwordManager: {
    getSessionKey: async () => 'vk1.token',
    isPasswordSkipped: async () => h.skipped,
    verifyPassword: h.verifyPassword,
    changePassword: h.changePassword,
  },
}));
vi.mock('src/services/evm/signer', () => ({ withEvmKey: vi.fn() }));
vi.mock('src/services/wallet/WalletStorage', () => ({
  walletStorage: { loadWallet: h.loadWallet },
}));
vi.mock('src/services/crypto/PasskeyService', () => ({
  authenticateWithPasskey: vi.fn(),
  isPasskeyEnabled: async () => false,
}));
vi.mock('src/services/wallet/backupPending', () => ({ clearBackupPending: h.clearBackupPending }));
vi.mock('src/utils/secretClipboard', () => ({ copySecret: h.copySecret }));

import BackupScreen from 'src/features/wallet/screens/BackupScreen';

const mount = async (mnemonic: string[] | string = WORDS12) => {
  h.mnemonic = mnemonic;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<BackupScreen />);
  });
  return view;
};

const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

const open = async (mnemonic: string[] | string = WORDS12) => {
  const view = await mount(mnemonic);
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
  await press('Continue');
  return view;
};

const typeNewPassword = (value: string) => {
  for (const field of screen.getByRole('dialog').querySelectorAll('input')) {
    fireEvent.change(field, { target: { value } });
  }
};

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

const placeholders = () => screen.queryAllByText('•••••').length;

beforeEach(() => {
  h.ctx.isLocked = false;
  h.ctx.showMessage.mockClear();
  h.navigate.mockClear();
  h.skipped = false;
  h.ctx.refreshWallets.mockClear();
  h.changePassword.mockReset();
  h.changePassword.mockImplementation(async () => {
    h.skipped = false;
    return { passkey: 'none' };
  });
  h.loadWallet.mockReset();
  h.loadWallet.mockImplementation(async () => ({ mnemonic: h.mnemonic }));
  h.verifyPassword.mockClear();
  h.clearBackupPending.mockClear();
  h.copySecret.mockClear();
  h.copySecret.mockResolvedValue(true);
});

afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('first backup', () => {
  it('opens hidden with placeholders only', async () => {
    const { container } = await open();
    expect(placeholders()).toBe(12);
    expect(container.textContent).not.toContain('seven');
    expect(screen.getByRole('button', { name: 'security.copyPhrase' })).toHaveProperty(
      'disabled',
      true
    );
  });

  it('shows on one click and stays shown', async () => {
    await open();
    await press('Show');
    expect(screen.getByText('seven')).toBeTruthy();
    expect(placeholders()).toBe(0);
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Hide' }));
    fireEvent.blur(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.getByText('seven')).toBeTruthy();
  });

  it('keeps the same cells for 12 and for 24 words, hidden and shown', async () => {
    const { container, unmount } = await open();
    const cells = () => container.querySelectorAll('.grid-cols-3\\! > span').length;
    expect(cells()).toBe(12);
    await press('Show');
    expect(cells()).toBe(12);
    unmount();
    const next = await open(WORDS24);
    const cells24 = () => next.container.querySelectorAll('.grid-cols-3\\! > span').length;
    expect(cells24()).toBe(24);
    await press('Show');
    expect(cells24()).toBe(24);
    await press('Hide');
    expect(cells24()).toBe(24);
  });

  it('hides and drops the words on Hide, then reads them again on Show', async () => {
    const { container } = await open();
    await press('Show');
    await press('Hide');
    expect(container.textContent).not.toContain('seven');
    expect(placeholders()).toBe(12);
    const reads = h.loadWallet.mock.calls.length;
    await press('Show');
    expect(h.loadWallet.mock.calls.length).toBe(reads + 1);
    expect(screen.getByText('seven')).toBeTruthy();
  });

  it('hides and drops the words when the document is hidden', async () => {
    const { container } = await open();
    await press('Show');
    setVisibility('hidden');
    expect(container.textContent).not.toContain('seven');
    setVisibility('visible');
    expect(container.textContent).not.toContain('seven');
    expect(placeholders()).toBe(12);
  });

  it('hides and drops the words on pagehide', async () => {
    const { container } = await open();
    await press('Show');
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(container.textContent).not.toContain('seven');
  });

  it('drops the words and returns to the password when the wallet locks', async () => {
    const { container, rerender } = await open();
    await press('Show');
    expect(screen.getByText('seven')).toBeTruthy();
    h.ctx.isLocked = true;
    rerender(<BackupScreen />);
    expect(container.textContent).not.toContain('seven');
    expect(placeholders()).toBe(0);
    h.ctx.isLocked = false;
    rerender(<BackupScreen />);
    expect(container.textContent).not.toContain('seven');
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('asks for the password before anything is read', async () => {
    await mount();
    expect(h.loadWallet).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
    h.verifyPassword.mockResolvedValueOnce(false);
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'bad' } });
    await press('Continue');
    expect(h.loadWallet).not.toHaveBeenCalled();
    expect(screen.getByText('security.incorrectPassword')).toBeTruthy();
  });

  it('copies the words joined by single spaces and says Copied', async () => {
    await open('  one   two\tthree four five six seven eight nine ten eleven twelve ');
    await press('Show');
    await press('security.copyPhrase');
    expect(h.copySecret).toHaveBeenCalledWith(WORDS12.join(' '));
    expect(screen.getByRole('button', { name: 'toast.copied' })).toBeTruthy();
    expect(h.ctx.showMessage).not.toHaveBeenCalled();
  });

  it('says so when the copy fails', async () => {
    h.copySecret.mockResolvedValueOnce(false);
    await open();
    await press('Show');
    await press('security.copyPhrase');
    expect(h.ctx.showMessage).toHaveBeenCalledWith('toast.copyFailed', 'error');
    expect(screen.queryByRole('button', { name: 'toast.copied' })).toBeNull();
  });

  it('cannot be confirmed before the words were shown', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'I have written it down' })).toHaveProperty(
      'disabled',
      true
    );
  });

  it('reads nothing without a password and asks to create one', async () => {
    h.skipped = true;
    const { container } = await mount();
    expect(h.loadWallet).not.toHaveBeenCalled();
    expect(screen.getByText('security.createPassword')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    await press('Show');
    expect(h.loadWallet).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('seven');
  });

  it('goes on to the words once the password is created, with no second prompt', async () => {
    h.skipped = true;
    await mount();
    typeNewPassword('longenough');
    await press('security.create');
    expect(h.changePassword).toHaveBeenCalledWith('', 'longenough');
    expect(screen.queryByText('security.createPassword')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(placeholders()).toBe(12);
    await press('Show');
    expect(screen.getByText('seven')).toBeTruthy();
  });

  it('leaves without reading anything when creating the password is cancelled', async () => {
    h.skipped = true;
    const { container } = await mount();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(h.navigate).toHaveBeenCalledWith(-1);
    expect(h.changePassword).not.toHaveBeenCalled();
    expect(h.loadWallet).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('seven');
  });

  it('ends with Backed up', async () => {
    await open();
    await press('Show');
    await press('I have written it down');
    expect(h.clearBackupPending).toHaveBeenCalledWith('oct1wallet');
    expect(h.ctx.showMessage).toHaveBeenCalledWith('Backed up', 'success');
    expect(h.navigate).toHaveBeenCalledWith('/', { replace: true });
  });
});
