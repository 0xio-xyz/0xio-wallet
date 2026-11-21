import { useState, useEffect, useRef } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { Fingerprint } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import Button from 'src/shared/ui/Button';
import Input from 'src/shared/ui/Input';
import ConfirmDialog from 'src/shared/ui/ConfirmDialog';
import { useConfirm } from 'src/hooks/ui/useConfirm';
import {
  passwordManager,
  WrongPasswordError,
  LockedOutError,
} from 'src/services/crypto/PasswordManager';
import { IdleMascot, type MascotHandle } from 'src/shared/ui/Mascot';
import { Sheet, PrimaryButton, TextButton, quietField } from 'src/shared/ui/primitives';
import { logger } from 'src/utils/logger';
import * as passkey from 'src/services/crypto/PasskeyService';

const RESET_CONFIRMATION_PHRASE = 'DELETE MY WALLET';

const SHAKE: Keyframe[] = [
  { transform: 'translateX(0)' },
  { transform: 'translateX(-7px)' },
  { transform: 'translateX(6px)' },
  { transform: 'translateX(-4px)' },
  { transform: 'translateX(2px)' },
  { transform: 'translateX(0)' },
];

const LockScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { unlockWallet, isInitialized, isLoading: contextLoading, showMessage } = useWallet();

  const { confirm, dialogState, handleConfirm, handleCancel } = useConfirm();

  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState('');
  const [localLoading, setLocalLoading] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetPhrase, setResetPhrase] = useState('');
  const [lockoutSeconds, setLockoutSeconds] = useState(0);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<MascotHandle>(null);

  const busy = localLoading || passkeyLoading;
  const passkeyMode = passkeyAvailable && !usePassword;
  const lockedOut = lockoutSeconds > 0;

  const focusField = () => fieldRef.current?.querySelector('input')?.focus();
  const shake = () => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    fieldRef.current?.animate(SHAKE, {
      duration: 360,
      easing: 'cubic-bezier(0.36, 0.07, 0.19, 0.97)',
    });
  };

  useMountEffect(() => {
    passkey.isPasskeyEnabled().then(setPasskeyAvailable);
    void passwordManager
      .loadRateLimitState()
      .then(() => setLockoutSeconds(passwordManager.getLockoutRemainingSeconds()));
  });

  // effect:audited - ticks the lockout down. The deadline lives in storage as a timestamp, so each
  // tick asks how long is left rather than counting a copy down: a throttled background popup
  // still ends on time. The field gets focus back when it ends.
  useEffect(() => {
    if (!lockedOut) return;
    const id = setInterval(() => {
      const left = passwordManager.getLockoutRemainingSeconds();
      setLockoutSeconds(left);
      if (left <= 0) {
        clearInterval(id);
        focusField();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockedOut]);

  // effect:audited - guards uninitialized state, redirects to onboarding
  useEffect(() => {
    if (!contextLoading && !isInitialized) {
      navigate('/onboarding', { replace: true });
    }
  }, [isInitialized, contextLoading, navigate]);

  // unlockWallet enforces the attempt limit and counts misses itself, so this screen only reports.
  const handleUnlock = async () => {
    if (busy || lockedOut) return;
    if (!password) {
      setError(t('lock.passwordRequired'));
      shake();
      focusField();
      return;
    }

    setError('');
    setLocalLoading(true);
    mascotRef.current?.play('loading');
    try {
      await unlockWallet(password);
      navigate('/', { replace: true });
    } catch (err) {
      mascotRef.current?.play('awake');
      setPassword('');
      if (err instanceof LockedOutError) {
        setLockoutSeconds(err.seconds);
      } else if (err instanceof WrongPasswordError) {
        setLockoutSeconds(passwordManager.getLockoutRemainingSeconds());
        const left = passwordManager.attemptsLeft();
        const warning =
          left === 1
            ? t('lock.lastTry', { defaultValue: '1 attempt left before a 30 second lockout.' })
            : left === 2
              ? t('lock.triesLeft', {
                  n: left,
                  defaultValue: '{{n}} attempts left before a 30 second lockout.',
                })
              : '';
        setError(
          warning ? `${t('lock.incorrectPassword')} ${warning}` : t('lock.incorrectPassword')
        );
        shake();
      } else {
        logger.error('[Lock] Unlock failed:', err);
        setError(t('lock.unlockFailed', { defaultValue: 'Could not unlock. Try again.' }));
      }
      focusField();
    } finally {
      setLocalLoading(false);
    }
  };

  const handlePasskeyUnlock = async () => {
    if (busy) return;
    setPasskeyLoading(true);
    setError('');
    try {
      const pw = await passkey.authenticateWithPasskey();
      if (!pw) {
        if (passkey.getLastPasskeyError() === 'rate_limited') {
          setUsePassword(true);
          setError(
            t('lock.passkeyPaused', {
              defaultValue:
                'Passkey disabled after too many failed attempts. Use your password or try again in a minute.',
            })
          );
        }
        return;
      }
      // Not counted as a password guess: this password came from the authenticator.
      mascotRef.current?.play('loading');
      await unlockWallet(pw, { countFailure: false });
      navigate('/', { replace: true });
    } catch (err) {
      mascotRef.current?.play('awake');
      if (err instanceof WrongPasswordError) {
        // The authenticator returned a password that no longer verifies, so the passkey was set up
        // before a password change. It used to fail silently on every open; remove it and say why.
        await passkey.removePasskey();
        setPasskeyAvailable(false);
        setError(
          t('lock.passkeyStale', {
            defaultValue:
              'This passkey was set up with an older password, so it has been turned off. Unlock with your password, then set it up again in Settings.',
          })
        );
        focusField();
      } else {
        logger.error('[Passkey] Unlock failed:', (err as Error)?.message);
      }
    } finally {
      setPasskeyLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    const confirmed = await confirm({
      title: t('lock.resetWallet'),
      message: t('lock.resetWarning'),
      type: 'danger',
      confirmText: t('lock.iUnderstand'),
      cancelText: t('common.cancel'),
    });

    if (!confirmed) return;

    setShowResetConfirm(true);
    setResetPhrase('');
  };

  const closeReset = () => {
    setShowResetConfirm(false);
    setResetPhrase('');
    focusField();
  };

  const executeReset = async () => {
    if (resetPhrase.trim() !== RESET_CONFIRMATION_PHRASE) {
      showMessage(t('lock.phraseMismatch'), 'error');
      return;
    }

    try {
      const { clearCircleAssetCache } = await import('src/features/wallet/nft/circleAssetCache');
      await clearCircleAssetCache().catch(() => {});
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      window.location.reload();
    } catch (_e) {
      showMessage(t('toast.clearFailed'), 'error');
    }
  };

  if (contextLoading) return null;

  const readCapsLock = (e: React.KeyboardEvent<HTMLInputElement>) =>
    setCapsLock(e.getModifierState('CapsLock'));

  return (
    <div
      className="lock-screen h-full! w-full! bg-(--bg-main) flex flex-col overflow-hidden! relative!"
      onPointerDownCapture={() => mascotRef.current?.poke()}
      onKeyDownCapture={() => mascotRef.current?.poke()}
    >
      <ConfirmDialog
        isOpen={dialogState.isOpen}
        title={dialogState.title}
        message={dialogState.message}
        type={dialogState.type as 'danger' | 'warning' | 'info'}
        confirmText={dialogState.confirmText}
        cancelText={dialogState.cancelText}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />

      <Sheet
        open={showResetConfirm}
        onClose={closeReset}
        danger
        title={t('lock.finalConfirmation')}
        sub={t('lock.typeToDelete')}
        zIndexClass="z-blocking!"
        onSubmit={() => resetPhrase.trim() === RESET_CONFIRMATION_PHRASE && void executeReset()}
        footer={
          <div className="flex! flex-col! items-center!" style={{ gap: '10px' }}>
            <PrimaryButton
              danger
              onClick={executeReset}
              disabled={resetPhrase.trim() !== RESET_CONFIRMATION_PHRASE}
            >
              {t('security.deleteWallet')}
            </PrimaryButton>
            <TextButton muted onClick={closeReset}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </TextButton>
          </div>
        }
      >
        <input
          type="text"
          value={resetPhrase}
          onChange={(e) => setResetPhrase(e.target.value)}
          placeholder={t('lock.typePhrase')}
          aria-label={t('lock.typePhrase')}
          autoComplete="off"
          autoFocus
          className={quietField}
        />
      </Sheet>

      <div className="relative z-raised flex h-full w-full flex-col justify-between px-(--gutter)! py-6!">
        <div className="flex flex-1 flex-col items-center justify-center gap-5! text-center">
          <IdleMascot ref={mascotRef} mood="open" size={88} />
          <h1
            className="text-(--text-main)"
            style={{ margin: 0, fontSize: '28px', fontWeight: 700, letterSpacing: '-0.6px' }}
          >
            {t('lock.welcomeBack', { defaultValue: 'Welcome back' })}
          </h1>
        </div>

        <div className="mx-auto flex w-full shrink-0 flex-col gap-2!">
          {passkeyMode ? (
            <>
              {error && (
                <p
                  role="alert"
                  className="text-center text-danger"
                  style={{ margin: '0 0 6px', fontSize: '12px' }}
                >
                  {error}
                </p>
              )}
              <Button
                variant="primary"
                fullWidth
                onClick={handlePasskeyUnlock}
                disabled={passkeyLoading}
                className="h-12! rounded-xl! text-accent-fg!"
              >
                {!passkeyLoading && <Fingerprint size={18} />}
                {passkeyLoading
                  ? t('lock.unlocking')
                  : t('lock.unlockWithPasskeyFull', { defaultValue: 'Unlock with passkey' })}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setUsePassword(true);
                  setError('');
                  setTimeout(focusField, 0);
                }}
                disabled={busy}
                className="press h-12! w-full! cursor-pointer! rounded-xl! bg-transparent! text-(--text-main)! transition-colors hover:bg-(--bg-1)! disabled:opacity-50!"
                style={{ fontSize: '14px', fontWeight: 600 }}
              >
                {t('lock.usePassword', { defaultValue: 'Use password' })}
              </button>
            </>
          ) : (
            <>
              {lockedOut && (
                <span role="alert" className="sr-only!">
                  {t('lock.lockedSr', {
                    defaultValue: 'Too many incorrect attempts. Unlock is temporarily disabled.',
                  })}
                </span>
              )}

              <div ref={fieldRef} className="relative! mb-6!">
                <Input
                  id="lock-password"
                  name="password"
                  type={reveal ? 'text' : 'password'}
                  spellCheck={false}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError('');
                  }}
                  onKeyDown={(e) => {
                    readCapsLock(e);
                    if (e.key === 'Enter') void handleUnlock();
                  }}
                  onKeyUp={readCapsLock}
                  onBlur={() => setCapsLock(false)}
                  error={
                    lockedOut ? t('lock.lockedForSeconds', { seconds: lockoutSeconds }) : error
                  }
                  aria-label={t('lock.password')}
                  aria-invalid={!!error}
                  placeholder={t('lock.password')}
                  autoFocus
                  disabled={localLoading || lockedOut}
                  className="pw-highlight"
                  style={{ paddingRight: '64px' }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setReveal((v) => !v);
                    focusField();
                  }}
                  aria-pressed={reveal}
                  aria-label={
                    reveal
                      ? t('lock.hidePassword', { defaultValue: 'Hide password' })
                      : t('lock.showPassword', { defaultValue: 'Show password' })
                  }
                  disabled={localLoading || lockedOut}
                  className="absolute! right-3! top-6! -translate-y-1/2! px-2! py-1! text-xs! font-medium! text-content-muted! hover:text-(--text-main)! active:opacity-60! transition-colors! cursor-pointer! disabled:opacity-40!"
                >
                  {reveal
                    ? t('lock.hide', { defaultValue: 'Hide' })
                    : t('lock.show', { defaultValue: 'Show' })}
                </button>
                {capsLock && !error && (
                  <p role="status" className="lock-caps-hint">
                    {t('lock.capsLock', { defaultValue: 'Caps Lock is on' })}
                  </p>
                )}
                <span role="alert" className="sr-only!">
                  {error}
                </span>
              </div>
              <Button
                variant="primary"
                fullWidth
                onClick={handleUnlock}
                disabled={lockedOut || passkeyLoading || localLoading}
                className="h-12! rounded-xl! text-accent-fg!"
              >
                {lockedOut
                  ? t('lock.waitSeconds', { seconds: lockoutSeconds })
                  : localLoading
                    ? t('lock.unlocking')
                    : t('lock.unlock')}
              </Button>
            </>
          )}
          <div className="flex! items-center! justify-center! gap-6! py-1!">
            {!passkeyMode && passkeyAvailable && (
              <button
                type="button"
                onClick={() => {
                  setUsePassword(false);
                  void handlePasskeyUnlock();
                }}
                disabled={busy}
                className="cursor-pointer! py-2! text-content-secondary! transition-colors hover:text-(--text-main)! disabled:opacity-50!"
                style={{ fontSize: '12.5px', fontWeight: 600 }}
              >
                {t('lock.unlockWithPasskey', { defaultValue: 'Use passkey' })}
              </button>
            )}
            <button
              type="button"
              className="cursor-pointer! py-2! text-content-muted transition-colors hover:text-(--text-main)"
              style={{ fontSize: '12.5px', fontWeight: 600 }}
              onClick={handleForgotPassword}
            >
              {t('lock.forgotPassword')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LockScreen;
