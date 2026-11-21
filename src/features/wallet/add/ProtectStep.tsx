import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { Eye, EyeOff, Fingerprint } from 'src/shared/ui/icons';
import { PrimaryButton } from 'src/shared/ui/primitives';
import { FlowLayout, FlowCopy, FlowHero, BIG_BUTTON } from './StepParts';
import { MIN_PASSWORD, strengthBars } from './strength';

export interface Protection {
  password: string;
  passkey: boolean;
}

export const PasswordStep = ({
  phase,
  value,
  onChange,
  first,
  busy,
  onNext,
}: {
  phase: 'create' | 'confirm';
  value: string;
  onChange: (v: string) => void;
  first: string;
  busy: boolean;
  onNext: () => void;
}) => {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const confirm = phase === 'confirm';
  const bars = strengthBars(value);
  const mismatch = confirm && value.length > 0 && value.length >= first.length && value !== first;
  const ready = confirm ? value === first : value.length >= MIN_PASSWORD;
  const next = () => ready && !busy && onNext();

  const strengthWord = [
    t('addWallet.tooShort', { defaultValue: 'Too short' }),
    t('addWallet.strengthWeak', { defaultValue: 'Weak' }),
    t('addWallet.strengthFair', { defaultValue: 'Fair' }),
    t('addWallet.strengthGood', { defaultValue: 'Good' }),
    t('addWallet.strengthStrong', { defaultValue: 'Strong' }),
  ][bars];
  const note = confirm
    ? mismatch
      ? t('addWallet.noMatch', { defaultValue: 'Passwords do not match' })
      : ''
    : value.length > 0
      ? strengthWord
      : '';
  const label = confirm
    ? t('addWallet.passwordAgain', { defaultValue: 'Confirm password' })
    : t('addWallet.password', { defaultValue: 'Password' });

  return (
    <FlowLayout
      onSubmit={next}
      footer={
        <PrimaryButton onClick={next} disabled={!ready} loading={busy} style={BIG_BUTTON}>
          {t('common.continue', { defaultValue: 'Continue' })}
        </PrimaryButton>
      }
    >
      <FlowCopy
        title={
          confirm
            ? t('addWallet.againTitle', { defaultValue: 'Confirm password' })
            : t('addWallet.passwordTitle', { defaultValue: 'Create a password' })
        }
      />
      <div
        className={`flex! items-center! rounded-xl! border! bg-(--bg-1)! focus-within:border-(--fg-3)! ${
          mismatch ? 'border-(--neg)!' : 'border-transparent!'
        }`}
        style={{ height: '48px', padding: '0 6px 0 14px', gap: '8px' }}
      >
        <input
          key={phase}
          type={shown ? 'text' : 'password'}
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            confirm
              ? label
              : t('addWallet.passwordPlaceholder', {
                  defaultValue: 'At least {{n}} characters',
                  n: MIN_PASSWORD,
                })
          }
          aria-label={label}
          autoFocus
          autoComplete="new-password"
          className="outline-none!"
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--fg)',
            fontSize: '15px',
            letterSpacing: '0.02em',
          }}
        />
        <button
          type="button"
          onClick={() => setShown(!shown)}
          aria-label={
            shown
              ? t('addWallet.hide', { defaultValue: 'Hide' })
              : t('addWallet.show', { defaultValue: 'Show' })
          }
          className="flex! items-center! justify-center! rounded-lg! hover:bg-(--bg-2)!"
          style={{
            width: '36px',
            height: '36px',
            border: 'none',
            background: 'transparent',
            color: 'var(--fg-3)',
            cursor: 'pointer',
          }}
        >
          {shown ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <div
        aria-hidden="true"
        className="flex!"
        style={{ gap: '4px', marginTop: '10px', visibility: confirm ? 'hidden' : 'visible' }}
      >
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: '3px',
              borderRadius: '2px',
              background: i <= bars ? 'var(--accent)' : 'var(--line)',
              transition: 'background 200ms ease-out',
            }}
          />
        ))}
      </div>
      <p
        aria-live="polite"
        style={{
          margin: '8px 0 0',
          height: '16px',
          fontSize: '12px',
          color: mismatch ? 'var(--neg)' : 'var(--fg-2)',
        }}
      >
        {note}
      </p>
    </FlowLayout>
  );
};

export const PasskeyStep = ({
  busy,
  onChoose,
}: {
  busy: boolean;
  onChoose: (passkey: boolean) => void;
}) => {
  const { t } = useTranslation();
  return (
    <FlowLayout
      footer={
        <PrimaryButton onClick={() => onChoose(true)} loading={busy} style={BIG_BUTTON}>
          {t('addWallet.usePasskey', { defaultValue: 'Use a passkey' })}
        </PrimaryButton>
      }
    >
      <FlowHero
        art={<Fingerprint size={48} style={{ color: 'var(--fg)' }} aria-hidden="true" />}
        title={t('addWallet.passkeyTitle', { defaultValue: 'Unlock with a passkey?' })}
      />
    </FlowLayout>
  );
};
