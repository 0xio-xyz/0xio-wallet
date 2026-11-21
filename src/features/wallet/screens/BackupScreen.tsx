import React, { useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { ChevronLeft } from 'src/shared/ui/icons';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import useCopied from 'src/hooks/ui/useCopied';
import useHideWhenAway from 'src/hooks/ui/useHideWhenAway';
import { useWallet } from 'src/contexts/WalletContext';
import { passwordManager, WrongPasswordError } from 'src/services/crypto/PasswordManager';
import { grantReveal, revealWallet, type RevealGrant } from 'src/services/crypto/secretReveal';
import { clearBackupPending } from 'src/services/wallet/backupPending';
import { authenticateWithPasskey, isPasskeyEnabled } from 'src/services/crypto/PasskeyService';
import CreatePasswordModal from 'src/features/settings/components/CreatePasswordModal';
import IconButton from 'src/shared/ui/IconButton';
import { PrimaryButton, TextButton } from 'src/shared/ui/primitives';
import { FlowLayout, FlowCopy, BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import { logger } from 'src/utils/logger';
import { plainError } from 'src/utils/plainError';
import { copySecret } from 'src/utils/secretClipboard';

const toWords = (mnemonic: unknown): string[] =>
  Array.isArray(mnemonic)
    ? mnemonic.map(String)
    : typeof mnemonic === 'string'
      ? mnemonic.trim().split(/\s+/)
      : [];

const BackupScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeWallet, showMessage, isLocked } = useWallet();
  const [count, setCount] = useState<number | null>(null);
  const [words, setWords] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [checking, setChecking] = useState(false);
  const [passkey, setPasskey] = useState(false);
  const [grant, setGrant] = useState<RevealGrant | null>(null);
  const [creating, setCreating] = useState(false);
  const [seen, setSeen] = useState(false);
  const [done, setDone] = useState(false);
  const { isCopied, flash } = useCopied();

  const hide = () => setWords(null);
  useHideWhenAway(hide);
  if (isLocked && (words || count !== null || grant)) {
    setWords(null);
    setCount(null);
    setGrant(null);
  }

  const leave = () => navigate('/', { replace: true });

  const readWords = async (held: RevealGrant | null): Promise<string[] | null> => {
    const wallet = activeWallet?.id ? await revealWallet(activeWallet.id, held) : null;
    if (!wallet) {
      showMessage(t('toast.err.locked'), 'error');
      leave();
      return null;
    }
    const found = toWords(wallet.mnemonic);
    if (found.length === 0) {
      showMessage(t('toast.noPhrase'), 'error');
      leave();
      return null;
    }
    return found;
  };

  const open = async (held: RevealGrant) => {
    const found = await readWords(held);
    if (found) setCount(found.length);
  };

  const show = async () => {
    try {
      const found = await readWords(grant);
      if (!found || document.visibilityState === 'hidden') return;
      setWords(found);
      setSeen(true);
    } catch (e) {
      logger.error('[Backup] could not read the wallet', e);
      showMessage(t('toast.walletReadFailed'), 'error');
    }
  };

  const copy = async () => {
    if (!words) return;
    if (await copySecret(words.join(' '))) flash();
    else showMessage(t('toast.copyFailed'), 'error');
  };

  useMountEffect(() => {
    void (async () => {
      try {
        if (await passwordManager.isPasswordSkipped()) setCreating(true);
        else {
          setPasskey(await isPasskeyEnabled());
        }
      } catch (e) {
        logger.error('[Backup] could not read the wallet', e);
        showMessage(t('toast.walletReadFailed'), 'error');
      }
    })();
  });

  const unlockWith = async (candidate: string | null) => {
    if (!candidate) return;
    setChecking(true);
    try {
      const held = await grantReveal(candidate);
      setPassword('');
      setGrant(held);
      await open(held);
    } catch (e) {
      if (e instanceof WrongPasswordError) {
        setWrong(true);
        return;
      }
      logger.error('[Backup] verification failed', e);
      showMessage(t('toast.walletReadFailed'), 'error');
    } finally {
      setChecking(false);
    }
  };

  const passwordCreated = async (created: string) => {
    try {
      const held = await grantReveal(created);
      setGrant(held);
      await open(held);
    } catch (e) {
      logger.error('[Backup] could not read the wallet', e);
      showMessage(t('toast.walletReadFailed'), 'error');
    } finally {
      setCreating(false);
    }
  };

  const submit = () => {
    if (password && !checking) void unlockWith(password);
  };

  const unlockWithPasskey = async () => {
    try {
      const pw = await authenticateWithPasskey();
      if (pw) await unlockWith(pw);
      else showMessage(t('toast.passkeyFailed'), 'error');
    } catch (e) {
      showMessage(plainError(e, t('toast.passkeyFailed')), 'error');
    }
  };

  const wroteThem = async () => {
    if (!activeWallet?.address || done) return;
    setDone(true);
    try {
      await clearBackupPending(activeWallet.address);
      showMessage(t('backup.done', { defaultValue: 'Backed up' }), 'success');
      leave();
    } catch (e) {
      logger.error('[Backup] could not save the backup state', e);
      setDone(false);
    }
  };

  const shown = !!words && !isLocked;
  const cells = shown ? words : Array.from({ length: count ?? 12 }, () => '');
  const quietButton: React.CSSProperties = {
    height: '48px',
    border: 'none',
    color: 'var(--fg)',
    fontSize: '14px',
    fontWeight: 600,
    transition: 'opacity 200ms ease-out',
  };

  let body: React.ReactNode;
  if ((count === null && !creating) || isLocked)
    body = (
      <FlowLayout
        onSubmit={submit}
        footer={
          <>
            <PrimaryButton
              onClick={submit}
              disabled={!password}
              loading={checking}
              style={BIG_BUTTON}
            >
              {t('common.continue', { defaultValue: 'Continue' })}
            </PrimaryButton>
            {passkey && (
              <TextButton
                muted
                size={14}
                disabled={checking}
                onClick={() => void unlockWithPasskey()}
                style={{ height: '40px', fontWeight: 600, color: 'var(--fg-2)' }}
              >
                {t('addWallet.usePasskey', { defaultValue: 'Use a passkey' })}
              </TextButton>
            )}
          </>
        }
      >
        <FlowCopy title={t('backup.passwordTitle', { defaultValue: 'Enter your password' })} />
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setWrong(false);
          }}
          placeholder={t('addWallet.password', { defaultValue: 'Password' })}
          aria-label={t('addWallet.password', { defaultValue: 'Password' })}
          autoFocus
          autoComplete="current-password"
          className={`w-full! rounded-xl! border! bg-(--bg-1)! outline-none! focus:border-(--line-2)! ${
            wrong ? 'border-(--neg)!' : 'border-transparent!'
          }`}
          style={{ height: '48px', padding: '0 14px', fontSize: '15px', color: 'var(--fg)' }}
        />
        <p
          aria-live="polite"
          style={{ margin: '8px 0 0', height: '16px', fontSize: '12px', color: 'var(--neg)' }}
        >
          {wrong ? t('security.incorrectPassword') : ''}
        </p>
      </FlowLayout>
    );
  else
    body = (
      <FlowLayout
        footer={
          <>
            <div className="grid! grid-cols-2!" style={{ gap: '12px' }}>
              <button
                type="button"
                onClick={() => (shown ? hide() : void show())}
                className="press rounded-xl! bg-(--bg-1)! hover:bg-(--bg-2)!"
                style={{ ...quietButton, cursor: 'pointer' }}
              >
                {shown
                  ? t('common.hide', { defaultValue: 'Hide' })
                  : t('common.show', { defaultValue: 'Show' })}
              </button>
              <button
                type="button"
                onClick={() => void copy()}
                disabled={!shown}
                className="press rounded-xl! bg-(--bg-1)! hover:bg-(--bg-2)!"
                style={{
                  ...quietButton,
                  cursor: shown ? 'pointer' : 'default',
                  opacity: shown ? 1 : 0.4,
                }}
              >
                {isCopied() ? t('toast.copied') : t('security.copyPhrase')}
              </button>
            </div>
            <PrimaryButton
              onClick={() => void wroteThem()}
              disabled={!seen}
              loading={done}
              style={BIG_BUTTON}
            >
              {t('backup.wrote', { defaultValue: 'I have written it down' })}
            </PrimaryButton>
          </>
        }
      >
        <FlowCopy
          title={t('backup.wordsTitle', { defaultValue: 'Write down your recovery phrase' })}
        />
        <div
          aria-hidden={!shown}
          className="grid! grid-cols-3!"
          style={{
            gap: '6px',
            filter: shown ? 'none' : 'blur(6px)',
            userSelect: 'none',
            transition: 'filter 200ms ease-out',
          }}
        >
          {cells.map((word, i) => (
            <span
              key={i}
              className="flex! min-w-0! items-center! rounded-[10px]! bg-(--bg-1)!"
              style={{ height: '36px', gap: '6px', padding: '0 8px' }}
            >
              <span
                style={{
                  width: '14px',
                  flexShrink: 0,
                  textAlign: 'right',
                  fontSize: '11px',
                  color: 'var(--fg-3)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  fontSize: 'clamp(10px, 3.2vw, 13px)',
                  whiteSpace: 'nowrap',
                  color: 'var(--fg)',
                }}
              >
                {shown ? word : '•••••'}
              </span>
            </span>
          ))}
        </div>
        <p
          style={{
            margin: '12px 0 0',
            textAlign: 'center',
            fontSize: '12px',
            color: 'var(--fg-3)',
          }}
        >
          {t('backup.neverAsk', { defaultValue: '0xio never asks for your recovery phrase.' })}
        </p>
      </FlowLayout>
    );

  return (
    <div className="flex! h-full! min-h-0! flex-col! bg-(--bg)!">
      <div
        className="flex! shrink-0! items-center!"
        style={{ height: '52px', padding: '0 10px 0 6px' }}
      >
        <IconButton
          onClick={() => navigate(-1)}
          aria-label={t('common.back', { defaultValue: 'Back' })}
        >
          <ChevronLeft size={17} />
        </IconButton>
      </div>
      {body}
      <CreatePasswordModal
        open={creating && !isLocked}
        onClose={() => navigate(-1)}
        onCreated={passwordCreated}
      />
    </div>
  );
};

export default BackupScreen;
