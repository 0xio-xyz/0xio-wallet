import { useRef, useState } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useNavigate, useLocation } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import Header from 'src/shared/ui/Header';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import {
  RuledList,
  ListRow,
  ToggleRow,
  SectionLabel,
  TextButton,
  PrimaryButton,
  QuietInput,
  QuietSelect,
  PasswordField,
  Modal,
} from 'src/shared/ui/primitives';
import ConfirmDialog from 'src/shared/ui/ConfirmDialog';
import { useConfirm } from 'src/hooks/ui/useConfirm';
import { logger } from 'src/utils/logger';
import { plainError } from 'src/utils/plainError';
import { WrongPasswordError } from 'src/services/crypto/PasswordManager';
import SecretSheet from 'src/features/settings/components/SecretSheet';
import CreatePasswordModal from 'src/features/settings/components/CreatePasswordModal';
import {
  grantReveal,
  revealEvmKey,
  revealWallet,
  type RevealGrant,
} from 'src/services/crypto/secretReveal';
import { needsRebackup, markRebackupDone } from 'src/services/wallet/rebackup';
import useRebackupNeeded from 'src/hooks/wallet/useRebackupNeeded';
import { copySecret } from 'src/utils/secretClipboard';

const RESET_CONFIRMATION_PHRASE = 'DELETE MY WALLET';

const SecurityBackupScreen = ({ view = 'security' }: { view?: 'security' | 'backup' }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { showMessage, activeWallet, passwordManager, refreshWallets } = useWallet();
  const isWatchOnly = activeWallet?.type === 'watch';
  const { confirm, dialogState, handleConfirm, handleCancel } = useConfirm();

  const submitBusy = useRef(false);
  const guarded = (fn: () => Promise<void>) => async (): Promise<void> => {
    if (submitBusy.current) return;
    submitBusy.current = true;
    try {
      await fn();
    } finally {
      submitBusy.current = false;
    }
  };
  const [autoLockTime, setAutoLockTime] = useState('5');
  const [__biometricsEnabled, _setBiometricsEnabled] = useState(false);
  const [passkeyEnabled, setPasskeyEnabled] = useState(false);
  // Passkeys use the extension's own origin as the WebAuthn RP - Chromium-only (Firefox has no
  // self-RP). Gate the whole section on real capability, not just the API's presence.
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [showPasskeyVerify, setShowPasskeyVerify] = useState(false);
  const [passkeyVerifyPassword, setPasskeyVerifyPassword] = useState('');
  const [passkeyVerifyLoading, setPasskeyVerifyLoading] = useState(false);

  const [hasPassword, setHasPassword] = useState(false);
  const [isPasswordSkipped, setIsPasswordSkipped] = useState(false);
  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [passwordAction, setPasswordAction] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [showPasswordText, setShowPasswordText] = useState(false);
  const [passwordAttempted, setPasswordAttempted] = useState(false);
  const [passwordWorking, setPasswordWorking] = useState(false);
  const [currentPasswordError, setCurrentPasswordError] = useState('');
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [decryptedData, setDecryptedData] = useState(null);
  const [evmKey, setEvmKey] = useState<string | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState({ show: false, action: null });
  const [verifyPassword, setVerifyPassword] = useState('');
  const [verifyError, setVerifyError] = useState('');
  const [passkeyVerifyError, setPasskeyVerifyError] = useState('');
  const [verifyPasskeyLoading, setVerifyPasskeyLoading] = useState(false);
  const [showVerifyPasswordFallback, setShowVerifyPasswordFallback] = useState(false);
  const [showCreatePassword, setShowCreatePassword] = useState(false);
  const pendingReveal = useRef<'mnemonic' | 'rebackup' | 'privateKey' | null>(null);

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetPhrase, setResetPhrase] = useState('');

  const rebackup = needsRebackup(activeWallet);
  const rebackupOpen = useRebackupNeeded(activeWallet);
  useMountEffect(() => {
    void loadSettings().then((skipped) => {
      if (location.state?.rebackup && rebackup) void openMnemonic(skipped, true);
    });
  });

  const loadSettings = async (): Promise<boolean> => {
    try {
      const result = await chrome.storage.local.get([
        'settings',
        'security_biometrics',
        'hashedPassword',
        'passwordSkipped',
      ]);
      const settings = result.settings || {};

      setAutoLockTime(String(settings.autoLockMinutes ?? 5));
      _setBiometricsEnabled(result.security_biometrics || false);

      const hasActualPassword = !!result.hashedPassword && !result.passwordSkipped;
      setHasPassword(hasActualPassword);
      setIsPasswordSkipped(!!result.passwordSkipped);

      const { isPasskeyEnabled, isWebAuthnAvailable } =
        await import('src/services/crypto/PasskeyService');
      setPasskeySupported(isWebAuthnAvailable());
      setPasskeyEnabled(await isPasskeyEnabled());
      return !!result.passwordSkipped;
    } catch (err) {
      logger.error('Error loading security settings:', err);
      return false;
    }
  };

  const handlePasskeyToggle = async () => {
    setPasskeyVerifyLoading(true);
    setPasskeyVerifyError('');
    try {
      const storage = await chrome.storage.local.get(['hashedPassword', 'salt']);
      const isValid = await passwordManager.verifyPassword(
        passkeyVerifyPassword,
        storage.hashedPassword,
        storage.salt
      );
      if (!isValid) {
        setPasskeyVerifyError(t('toast.err.password'));
        setPasskeyVerifyPassword('');
        setPasskeyVerifyLoading(false);
        return;
      }

      const { isPasskeyEnabled, registerPasskey, removePasskey, getLastPasskeyError } =
        await import('src/services/crypto/PasskeyService');
      const enabled = await isPasskeyEnabled();

      if (enabled) {
        await removePasskey();
      } else {
        const ok = await registerPasskey(passkeyVerifyPassword);
        if (!ok) {
          showMessage(
            getLastPasskeyError() === 'no_prf'
              ? t('toast.passkeyNoPrf')
              : t('toast.passkeySetupFailed'),
            'error'
          );
        }
      }

      const { isPasskeyEnabled: check } = await import('src/services/crypto/PasskeyService');
      setPasskeyEnabled(await check());
    } catch (err: any) {
      logger.error('Passkey toggle error:', err);
      showMessage(plainError(err, t('toast.passkeySetupFailed')), 'error');
    }
    setPasskeyVerifyLoading(false);
    setShowPasskeyVerify(false);
    setPasskeyVerifyPassword('');
  };

  const handleAutoLockChange = async (value: string) => {
    const newValue = value;
    setAutoLockTime(newValue);

    try {
      const minutes = parseInt(newValue);
      const seconds = minutes * 60;

      const result = await chrome.storage.local.get(['settings']);
      const currentSettings = result.settings || {};

      await chrome.storage.local.set({
        settings: {
          ...currentSettings,
          autoLockMinutes: minutes,
        },
        autoLockDuration: seconds,
      });

      if (passwordManager && passwordManager.updateAutoLockDuration) {
        await passwordManager.updateAutoLockDuration(seconds);
      }
    } catch (err) {
      logger.error('Error saving auto-lock:', err);
      showMessage(t('toast.settingSaveFailed'), 'error');
    }
  };

  const getDecryptedWalletData = async (grant: RevealGrant) => {
    if (!activeWallet) {
      throw new Error('No active wallet found');
    }

    const walletData = await revealWallet(activeWallet.id, grant);
    if (!walletData) {
      showMessage(t('toast.err.locked'), 'error');
      navigate('/lock');
      return null;
    }

    return walletData;
  };

  const revealSecret = async (action: string | null, grant: RevealGrant): Promise<boolean> => {
    const walletData = await getDecryptedWalletData(grant);
    if (!walletData) return false;

    if (action === 'mnemonic') {
      if (!walletData.mnemonic) {
        showMessage(t('toast.noPhrase'), 'error');
      } else {
        setDecryptedData(walletData);
        setShowMnemonic(true);
      }
    } else if (action === 'privateKey') {
      await openPrivateKey(walletData, grant);
    }
    return true;
  };

  const performSecurityCheck = guarded(async () => {
    try {
      const grant = await grantReveal(verifyPassword);
      if (!(await revealSecret(passwordPrompt.action, grant))) return;

      setPasswordPrompt({ show: false, action: null });
      setVerifyPassword('');
      setVerifyError('');
    } catch (e) {
      if (e instanceof WrongPasswordError) {
        setVerifyError(t('toast.err.password'));
        return;
      }
      logger.error('Security check failed:', e);
      showMessage(t('toast.verifyFailed'), 'error');
    }
  });

  /**
   * The Octra key, plus the EVM key when EVM is on for this account. An account added from a
   * phrase wallet takes its EVM key from that wallet's phrase at its own account number.
   */
  const openPrivateKey = async (walletData: any, grant: RevealGrant) => {
    setDecryptedData(walletData);
    setEvmKey(null);
    const evm = activeWallet?.metadata?.evm;
    if (activeWallet && evm?.enabled && evm.address) {
      try {
        setEvmKey(await revealEvmKey(activeWallet.id, evm.index ?? 0, evm.address, grant));
      } catch (e) {
        logger.warn('[Backup] could not derive the EVM key', e);
      }
    }
    setShowPrivateKey(true);
  };

  const requestPassword = (action: 'mnemonic' | 'rebackup' | 'privateKey') => {
    pendingReveal.current = action;
    setShowCreatePassword(true);
  };

  const revealWithGrant = async (action: 'mnemonic' | 'privateKey', grant: RevealGrant) => {
    try {
      await revealSecret(action, grant);
    } catch (e) {
      logger.error('Could not read the wallet:', e);
      showMessage(t('toast.walletReadFailed'), 'error');
    }
  };

  const openMnemonic = async (skipped: boolean, again = false, grant?: RevealGrant) => {
    if (skipped) {
      requestPassword(again ? 'rebackup' : 'mnemonic');
      return;
    }

    const confirmed = await confirm({
      title: again
        ? t('settings.backUpAgain', { defaultValue: 'Back up again' })
        : t('security.showRecoveryPhrase'),
      message: again
        ? t('main.rebackupSub', {
            defaultValue: 'The words shown when this wallet was created may not restore it.',
          })
        : t('security.recoveryWarning'),
      type: 'warning',
      confirmText: t('security.continue'),
    });

    if (!confirmed) return;

    if (grant) {
      await revealWithGrant('mnemonic', grant);
    } else {
      setShowVerifyPasswordFallback(false);
      setPasswordPrompt({ show: true, action: 'mnemonic' });
    }
  };

  const handleShowMnemonic = () => openMnemonic(isPasswordSkipped);

  const confirmRebackup = async () => {
    if (!activeWallet) return;
    await markRebackupDone(activeWallet.address);
    resetSensitiveView();
    showMessage(t('backup.done', { defaultValue: 'Backed up' }), 'success');
  };

  const exportPrivateKey = async (skipped: boolean, grant?: RevealGrant) => {
    if (skipped) {
      requestPassword('privateKey');
      return;
    }

    const confirmed = await confirm({
      title: t('security.exportPrivateKeyTitle'),
      message: t('security.privateKeyWarning'),
      type: 'warning',
      confirmText: t('security.continue'),
    });

    if (!confirmed) return;

    if (grant) {
      await revealWithGrant('privateKey', grant);
    } else {
      setShowVerifyPasswordFallback(false);
      setPasswordPrompt({ show: true, action: 'privateKey' });
    }
  };

  const handleExportPrivateKey = () => exportPrivateKey(isPasswordSkipped);

  const handlePasswordCreated = async (password: string) => {
    const pending = pendingReveal.current;
    pendingReveal.current = null;
    setShowCreatePassword(false);
    setHasPassword(true);
    setIsPasswordSkipped(false);
    await loadSettings();
    if (!pending) return;
    try {
      const grant = await grantReveal(password);
      if (pending === 'privateKey') await exportPrivateKey(false, grant);
      else await openMnemonic(false, pending === 'rebackup', grant);
    } catch (e) {
      logger.error('Could not read the wallet:', e);
      showMessage(t('toast.walletReadFailed'), 'error');
    }
  };

  const handleCancelCreatePassword = () => {
    pendingReveal.current = null;
    setShowCreatePassword(false);
  };

  const performPasskeySecurityCheck = async () => {
    setVerifyPasskeyLoading(true);
    try {
      const { authenticateWithPasskey } = await import('src/services/crypto/PasskeyService');
      const pw = await authenticateWithPasskey();
      if (!pw) {
        showMessage(t('toast.passkeyFailed'), 'error');
        return;
      }

      let grant: RevealGrant;
      try {
        grant = await grantReveal(pw);
      } catch (e) {
        if (!(e instanceof WrongPasswordError)) throw e;
        showMessage(t('toast.passkeyFailed'), 'error');
        return;
      }
      if (!(await revealSecret(passwordPrompt.action, grant))) return;

      setPasswordPrompt({ show: false, action: null });
    } catch (err: any) {
      logger.error('[Passkey] Security check failed:', err);
      showMessage(plainError(err, t('toast.passkeyFailed')), 'error');
    } finally {
      setVerifyPasskeyLoading(false);
    }
  };

  const handleCopy = async (text: string) => {
    if (await copySecret(text)) return true;
    showMessage(t('toast.copyFailed'), 'error');
    return false;
  };

  const resetSensitiveView = () => {
    setShowMnemonic(false);
    setShowPrivateKey(false);
    setDecryptedData(null);
    setEvmKey(null);
  };

  const resetPasswordForm = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowPasswordText(false);
    setPasswordAttempted(false);
    setCurrentPasswordError('');
  };

  const openPasswordForm = (action: 'change' | 'remove') => {
    resetPasswordForm();
    setPasswordAction(action);
    setShowPasswordSection(true);
  };

  const handleCreatePassword = () => {
    pendingReveal.current = null;
    setShowCreatePassword(true);
  };
  const handleChangePassword = () => openPasswordForm('change');
  const handleRemovePassword = () => openPasswordForm('remove');

  const handleCancelPassword = () => {
    setShowPasswordSection(false);
    setPasswordAction('');
    resetPasswordForm();
  };

  const newPasswordLongEnough = newPassword.length >= 8;
  const confirmMismatch =
    confirmPassword.length > 0 &&
    confirmPassword !== newPassword &&
    (confirmPassword.length >= newPassword.length || passwordAttempted);
  const confirmMissing = passwordAttempted && newPasswordLongEnough && !confirmPassword;

  const handleSubmitPassword = async () => {
    if (passwordWorking) return;
    setPasswordAttempted(true);
    if (!currentPassword) {
      setCurrentPasswordError(t('security.enterCurrentPassword'));
      return;
    }
    if (
      passwordAction !== 'remove' &&
      (!newPasswordLongEnough || newPassword !== confirmPassword)
    ) {
      return;
    }
    if (passwordAction === 'remove') {
      const confirmed = await confirm({
        title: t('security.removePassword'),
        message: t('security.removePasswordWarning'),
        type: 'warning',
        confirmText: t('common.confirm'),
      });
      if (!confirmed) return;
    }

    setPasswordWorking(true);
    try {
      if (passwordAction === 'change') {
        const { passkey } = await passwordManager.changePassword(currentPassword, newPassword);
        if (passkey === 'removed') {
          showMessage(
            t('security.passwordChangedPasskeyOff', {
              defaultValue:
                'Password changed. Passkey turned off: set it up again to use it with the new password.',
            }),
            'info'
          );
        }
        handleCancelPassword();
        await loadSettings();
        await refreshWallets();
      } else if (passwordAction === 'remove') {
        // Empty newPassword transitions to skip mode (device key encryption)
        const { passkey } = await passwordManager.changePassword(currentPassword, '');
        if (passkey === 'removed') {
          showMessage(
            t('security.passwordRemovedPasskeyOff', {
              defaultValue:
                'Password removed. Passkey turned off too, since it unlocks with your password.',
            }),
            'info'
          );
        }
        setHasPassword(false);
        handleCancelPassword();
        await loadSettings();
        await refreshWallets();
      }
    } catch (err) {
      if (err instanceof WrongPasswordError) {
        setCurrentPasswordError(t('lock.incorrectPassword'));
      } else {
        logger.error('Error handling password:', err);
        showMessage(plainError(err, t('toast.passwordUpdateFailed')), 'error');
      }
    } finally {
      setPasswordWorking(false);
    }
  };

  const handleClearData = async () => {
    const confirmed = await confirm({
      title: t('security.clearAllData'),
      message: t('security.clearDataWarning'),
      type: 'danger',
      confirmText: t('security.continue'),
      cancelText: t('common.cancel'),
    });

    if (!confirmed) return;

    setShowResetConfirm(true);
    setResetPhrase('');
  };

  const [showDeleteAuth, setShowDeleteAuth] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deletePasswordError, setDeletePasswordError] = useState('');

  const executeReset = guarded(async () => {
    if (resetPhrase.trim() !== RESET_CONFIRMATION_PHRASE) {
      showMessage(t('security.phraseMismatch'), 'error');
      return;
    }

    try {
      const { isPasskeyEnabled, authenticateWithPasskey } =
        await import('src/services/crypto/PasskeyService');
      const passkeyOn = await isPasskeyEnabled();

      if (passkeyOn) {
        const passResult = await authenticateWithPasskey();
        if (!passResult) {
          showMessage(t('toast.passkeyFailed'), 'error');
          return;
        }
      } else {
        const storage = await chrome.storage.local.get(['hashedPassword', 'salt']);
        if (storage.hashedPassword) {
          setShowDeleteAuth(true);
          return;
        }
      }

      await performReset();
    } catch (err) {
      logger.error('Error clearing data:', err);
      showMessage(t('toast.clearFailed'), 'error');
    }
  });

  const confirmDeleteWithPassword = guarded(async () => {
    try {
      const storage = await chrome.storage.local.get(['hashedPassword', 'salt']);
      const valid = await passwordManager.verifyPassword(
        deletePassword,
        storage.hashedPassword,
        storage.salt
      );
      if (!valid) {
        setDeletePasswordError(t('toast.err.password'));
        return;
      }
      setShowDeleteAuth(false);
      setDeletePassword('');
      await performReset();
    } catch (err) {
      logger.error('Delete check failed:', err);
      showMessage(t('toast.verifyFailed'), 'error');
    }
  });

  const performReset = async () => {
    try {
      const { clearCircleAssetCache } = await import('src/features/wallet/nft/circleAssetCache');
      await clearCircleAssetCache().catch(() => {});
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      window.location.reload();
    } catch (err) {
      logger.error('Error clearing data:', err);
      showMessage(t('toast.clearFailed'), 'error');
    }
  };

  const mnemonicWords: string[] = decryptedData?.mnemonic
    ? Array.isArray(decryptedData.mnemonic)
      ? decryptedData.mnemonic
      : String(decryptedData.mnemonic).split(' ')
    : [];

  return (
    <div className="h-full! overflow-hidden! flex! flex-col! bg-(--bg)! text-(--fg)!">
      <ConfirmDialog
        isOpen={dialogState.isOpen}
        title={dialogState.title}
        message={dialogState.message}
        type={dialogState.type as 'warning' | 'danger' | 'info'}
        confirmText={dialogState.confirmText}
        cancelText={dialogState.cancelText}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />

      <Modal
        open={showResetConfirm}
        onSubmit={() => resetPhrase.trim() === RESET_CONFIRMATION_PHRASE && executeReset()}
        onClose={() => {
          setShowResetConfirm(false);
          setResetPhrase('');
        }}
        title={t('security.finalConfirmation')}
        sub={t('security.typeToDelete', { phrase: RESET_CONFIRMATION_PHRASE })}
        danger
        closeLabel={t('common.close')}
        footer={
          <PrimaryButton
            danger
            onClick={executeReset}
            disabled={resetPhrase.trim() !== RESET_CONFIRMATION_PHRASE}
          >
            {t('security.deleteWallet')}
          </PrimaryButton>
        }
      >
        <QuietInput
          type="text"
          value={resetPhrase}
          onChange={(e) => setResetPhrase(e.target.value)}
          placeholder={t('lock.typePhrase')}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      </Modal>

      <Modal
        open={showDeleteAuth}
        onSubmit={() => !!deletePassword && confirmDeleteWithPassword()}
        onClose={() => {
          setShowDeleteAuth(false);
          setDeletePassword('');
          setDeletePasswordError('');
        }}
        title="Confirm your identity"
        closeLabel={t('common.close')}
        footer={
          <PrimaryButton danger onClick={confirmDeleteWithPassword} disabled={!deletePassword}>
            Delete
          </PrimaryButton>
        }
      >
        <QuietInput
          type="password"
          value={deletePassword}
          onChange={(e) => {
            setDeletePassword(e.target.value);
            setDeletePasswordError('');
          }}
          placeholder={t('lock.password')}
          autoFocus
          note={deletePasswordError}
          noteTone={deletePasswordError ? 'neg' : 'muted'}
        />
      </Modal>

      <Modal
        open={showPasskeyVerify}
        onSubmit={() => !!passkeyVerifyPassword && !passkeyVerifyLoading && handlePasskeyToggle()}
        onClose={() => {
          setShowPasskeyVerify(false);
          setPasskeyVerifyPassword('');
          setPasskeyVerifyError('');
        }}
        title={
          passkeyEnabled
            ? t('security.passkeyRemoveTitle', { defaultValue: 'Remove passkey' })
            : t('security.passkeySetupTitle', { defaultValue: 'Set up passkey' })
        }
        closeLabel={t('common.close')}
        footer={
          <PrimaryButton
            onClick={handlePasskeyToggle}
            disabled={!passkeyVerifyPassword}
            loading={passkeyVerifyLoading}
          >
            {passkeyVerifyLoading
              ? t('lock.unlocking')
              : t('common.confirm', { defaultValue: 'Confirm' })}
          </PrimaryButton>
        }
      >
        <QuietInput
          type="password"
          value={passkeyVerifyPassword}
          onChange={(e) => {
            setPasskeyVerifyPassword(e.target.value);
            setPasskeyVerifyError('');
          }}
          placeholder={t('lock.password')}
          autoFocus
          disabled={passkeyVerifyLoading}
          note={passkeyVerifyError}
          noteTone={passkeyVerifyError ? 'neg' : 'muted'}
        />
      </Modal>

      <CreatePasswordModal
        open={showCreatePassword}
        onClose={handleCancelCreatePassword}
        onCreated={handlePasswordCreated}
      />

      <Modal
        open={showPasswordSection}
        onSubmit={handleSubmitPassword}
        onClose={handleCancelPassword}
        dismissible={!passwordWorking}
        title={
          passwordAction === 'change' ? t('security.changePassword') : t('security.removePassword')
        }
        closeLabel={t('common.close')}
        footer={
          <PrimaryButton
            onClick={handleSubmitPassword}
            danger={passwordAction === 'remove'}
            loading={passwordWorking}
          >
            {passwordAction === 'change' ? t('security.change') : t('security.remove')}
          </PrimaryButton>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <PasswordField
            label={t('security.currentPassword')}
            value={currentPassword}
            onChange={(v) => {
              setCurrentPassword(v);
              setCurrentPasswordError('');
            }}
            autoFocus
            autoComplete="current-password"
            disabled={passwordWorking}
            note={currentPasswordError}
            noteTone="neg"
            shown={showPasswordText}
            onToggle={() => setShowPasswordText(!showPasswordText)}
            showLabel={t('common.show')}
            hideLabel={t('common.hide')}
          />
          {passwordAction !== 'remove' && (
            <>
              <PasswordField
                label={t('security.newPassword')}
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
                disabled={passwordWorking}
                note={t('security.passwordRule')}
                noteTone={newPasswordLongEnough ? 'pos' : passwordAttempted ? 'neg' : 'muted'}
                shown={showPasswordText}
                onToggle={() => setShowPasswordText(!showPasswordText)}
                showLabel={t('common.show')}
                hideLabel={t('common.hide')}
              />
              <QuietInput
                label={t('security.confirmPassword')}
                type={showPasswordText ? 'text' : 'password'}
                spellCheck={false}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                disabled={passwordWorking}
                note={
                  confirmMismatch
                    ? t('security.passwordMismatch')
                    : confirmMissing
                      ? t('security.confirmAgain')
                      : ''
                }
                noteTone={confirmMismatch || confirmMissing ? 'neg' : 'muted'}
              />
            </>
          )}
        </div>
      </Modal>

      {showPrivateKey && decryptedData?.privateKey && (
        <SecretSheet
          kind="privateKey"
          value={decryptedData.privateKey}
          evmValue={evmKey}
          words={[]}
          onClose={resetSensitiveView}
          onCopy={(which) =>
            handleCopy(which === 'evm' && evmKey ? evmKey : decryptedData.privateKey)
          }
        />
      )}
      {showMnemonic && decryptedData?.mnemonic && (
        <SecretSheet
          kind="mnemonic"
          value={mnemonicWords.join(' ')}
          words={mnemonicWords}
          onClose={resetSensitiveView}
          onCopy={() => handleCopy(mnemonicWords.join(' '))}
          onBackedUp={rebackupOpen ? confirmRebackup : undefined}
        />
      )}

      <Modal
        open={passwordPrompt.show}
        onSubmit={() => (!passkeyEnabled || showVerifyPasswordFallback) && performSecurityCheck()}
        onClose={() => {
          setPasswordPrompt({ show: false, action: null });
          setVerifyPassword('');
          setVerifyError('');
          setShowVerifyPasswordFallback(false);
        }}
        title={t('security.verifyPassword')}
        closeLabel={t('common.close')}
        footer={
          passkeyEnabled && !showVerifyPasswordFallback ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                alignItems: 'center',
              }}
            >
              <PrimaryButton onClick={performPasskeySecurityCheck} loading={verifyPasskeyLoading}>
                {verifyPasskeyLoading
                  ? t('lock.verifying', { defaultValue: 'Verifying' })
                  : t('lock.unlockWithPasskey', { defaultValue: 'Passkey' })}
              </PrimaryButton>
              <TextButton muted size={11} onClick={() => setShowVerifyPasswordFallback(true)}>
                {t('lock.usePasswordInstead', { defaultValue: 'Use password instead' })}
              </TextButton>
            </div>
          ) : (
            <PrimaryButton onClick={performSecurityCheck}>{t('security.verify')}</PrimaryButton>
          )
        }
      >
        {(!passkeyEnabled || showVerifyPasswordFallback) && (
          <QuietInput
            type="password"
            value={verifyPassword}
            onChange={(e) => {
              setVerifyPassword(e.target.value);
              setVerifyError('');
            }}
            placeholder={t('security.enterWalletPassword')}
            autoFocus
            note={verifyError}
            noteTone={verifyError ? 'neg' : 'muted'}
          />
        )}
      </Modal>

      <Header
        title={
          view === 'backup'
            ? t('settings.backup', { defaultValue: 'Backup' })
            : t('settings.security', { defaultValue: 'Security' })
        }
        showBack
        showSettings={false}
      />

      <div
        className="flex-1! overflow-y-auto! scrollbar-hide! flex! flex-col! *:shrink-0!"
        style={{ padding: '4px var(--gutter) 24px' }}
      >
        {view === 'security' && hasPassword && (
          <>
            <SectionLabel first>{t('security.autoLock')}</SectionLabel>
            <QuietSelect value={autoLockTime} onChange={handleAutoLockChange}>
              <option value="5">{t('security.minutes', { count: 5 })}</option>
              <option value="15">{t('security.minutes', { count: 15 })}</option>
              <option value="30">{t('security.minutes', { count: 30 })}</option>
              <option value="60">{t('security.minutes', { count: 60 })}</option>
              <option value="0">{t('security.never')}</option>
            </QuietSelect>
            {passkeySupported && (
              <RuledList style={{ marginTop: '14px' }}>
                <ToggleRow
                  label={t('security.passkeyUnlock', { defaultValue: 'Passkey unlock' })}
                  checked={passkeyEnabled}
                  onChange={() => setShowPasskeyVerify(true)}
                />
              </RuledList>
            )}
          </>
        )}

        {view === 'security' && (
          <>
            <SectionLabel first={!hasPassword}>{t('security.password')}</SectionLabel>
            <RuledList>
              {!hasPassword ? (
                <ListRow label={t('security.createPassword')} onClick={handleCreatePassword} />
              ) : (
                <>
                  <ListRow label={t('security.changePassword')} onClick={handleChangePassword} />
                  <ListRow
                    label={t('security.removePassword')}
                    onClick={handleRemovePassword}
                    danger
                  />
                </>
              )}
            </RuledList>
          </>
        )}

        {view === 'backup' && isWatchOnly && activeWallet && (
          <div
            className="flex! flex-1! flex-col! items-center! justify-center!"
            style={{ gap: '18px', padding: '32px 32px 84px' }}
          >
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: 'var(--fg)' }}>
              {t('settings.nothingToBackUp', { defaultValue: 'Nothing to back up' })}
            </h3>
            <span
              className="flex! max-w-full! items-center! rounded-full! bg-(--bg-1)!"
              style={{ gap: '10px', height: '44px', padding: '0 14px 0 8px' }}
            >
              <WalletAvatar address={activeWallet.address} size={28} />
              <span
                className="truncate!"
                style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}
              >
                {activeWallet.name}
              </span>
              <span
                className="shrink-0! rounded-[10px]! bg-(--bg-2)!"
                style={{ fontSize: '11px', color: 'var(--fg-2)', padding: '3px 8px' }}
              >
                {t('wallet.kindWatch', { defaultValue: 'Watch-only' })}
              </span>
            </span>
          </div>
        )}

        {view === 'backup' && !isWatchOnly && (
          <>
            <SectionLabel first>{t('security.backupKeys')}</SectionLabel>
            <RuledList>
              {activeWallet?.mnemonic && (
                <ListRow label={t('security.recoveryPhrase')} onClick={handleShowMnemonic} />
              )}
              <ListRow label={t('security.privateKey')} onClick={handleExportPrivateKey} />
            </RuledList>
            <p
              style={{
                fontSize: '12px',
                color: 'var(--fg-3)',
                margin: '12px 4px 0',
                lineHeight: 1.5,
              }}
            >
              {t('settings.backupNote', {
                defaultValue:
                  'Your recovery phrase restores this wallet and every account added from it. Keep it offline; 0xio never asks for it.',
              })}
            </p>
          </>
        )}

        {view === 'security' && (
          <>
            <SectionLabel>
              {t('security.thisBrowser', { defaultValue: 'This browser' })}
            </SectionLabel>
            <RuledList>
              <ListRow
                label={t('security.resetWallet')}
                sub={t('security.resetWalletSub', {
                  defaultValue: 'Erase every wallet from this browser',
                })}
                onClick={handleClearData}
                danger
              />
            </RuledList>
          </>
        )}
      </div>
    </div>
  );
};

export default SecurityBackupScreen;
