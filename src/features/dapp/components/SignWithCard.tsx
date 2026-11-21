import { useTranslation } from 'src/i18n/react';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { sanitizeText } from 'src/lib/sanitize';
import DesktopMark from './DesktopMark';

export type SignWith = 'browser' | 'desktop';

const Choice = ({
  mark,
  label,
  sub,
  selected,
  disabled,
  onClick,
}: {
  mark: React.ReactNode;
  label: string;
  sub?: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    disabled={disabled}
    onClick={onClick}
    className={`w-full! flex! items-center! rounded-[14px]! transition-colors! duration-200! ${
      selected ? 'bg-(--bg-2)!' : 'enabled:hover:bg-(--bg-2)!'
    }`}
    style={{
      minHeight: '48px',
      padding: '8px 10px',
      gap: '10px',
      border: 'none',
      background: selected ? undefined : 'transparent',
      cursor: disabled ? 'default' : 'pointer',
      textAlign: 'left',
      opacity: disabled ? 0.45 : 1,
    }}
  >
    {mark}
    <span className="flex! flex-col! min-w-0!" style={{ gap: '1px' }}>
      <span className="truncate!" style={{ fontSize: '13px', color: 'var(--fg)' }}>
        {label}
      </span>
      {sub && (
        <span className="truncate!" style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
          {sub}
        </span>
      )}
    </span>
  </button>
);

const SignWithCard = ({
  value,
  onChange,
  walletName,
  walletAddress,
  desktopOff = false,
  disabled = false,
}: {
  value: SignWith;
  onChange: (v: SignWith) => void;
  walletName: string;
  walletAddress: string;
  desktopOff?: boolean;
  disabled?: boolean;
}) => {
  const { t } = useTranslation();
  return (
    <div style={{ marginBottom: '12px' }}>
      <div className="tab-caps" style={{ color: 'var(--fg-3)', margin: '0 4px 8px' }}>
        {t('desktopSites.signWith', { defaultValue: 'Sign with' })}
      </div>
      <div
        role="radiogroup"
        aria-label={t('desktopSites.signWith', { defaultValue: 'Sign with' })}
        className="rounded-[18px]! bg-(--bg-1)!"
        style={{ padding: '4px' }}
      >
        <Choice
          mark={<WalletAvatar address={walletAddress} size={30} />}
          label={t('desktopSites.thisBrowser', { defaultValue: 'This browser' })}
          sub={sanitizeText(walletName)}
          selected={value === 'browser'}
          disabled={disabled}
          onClick={() => onChange('browser')}
        />
        <Choice
          mark={<DesktopMark />}
          label={t('desktopSites.desktop', { defaultValue: '0xio Desktop' })}
          selected={value === 'desktop'}
          disabled={disabled || desktopOff}
          onClick={() => onChange('desktop')}
        />
      </div>
    </div>
  );
};

export default SignWithCard;
