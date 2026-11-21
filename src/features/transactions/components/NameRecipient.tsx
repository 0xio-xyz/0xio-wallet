import { middleCut } from 'src/features/wallet/add/format';
import { useTranslation } from 'src/i18n/react';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import type { NameLookup } from 'src/hooks/wallet/useNameLookup';
import type { OnsFailure } from 'src/utils/octra/ons';
import {
  isRetryable,
  nameLabel,
  nameReasonText,
  type NameCheck,
} from 'src/features/transactions/onsRecipient';

export const NAME_ROW_HEIGHT = 52;
export const NAME_CARD_HEIGHT = 140;

const nameStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--fg)',
  whiteSpace: 'nowrap',
};

const linkStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--fg)',
  textDecoration: 'underline',
  textUnderlineOffset: '3px',
  whiteSpace: 'nowrap',
};

export const FullAddress = ({ address, color }: { address: string; color?: string }) => {
  const half = Math.ceil(address.length / 2);
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '11.5px',
        lineHeight: 1.4,
        color: color ?? 'var(--fg-2)',
      }}
    >
      {address.slice(0, half)}
      <wbr />
      {address.slice(half)}
    </span>
  );
};

const Blank = ({ size }: { size: number }) => (
  <span
    aria-hidden="true"
    style={{
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: `${Math.round(size * 0.28)}px`,
      background: 'var(--bg-2)',
      flexShrink: 0,
    }}
  />
);

const Dots = ({ label }: { label: string }) => (
  <span className="name-dots" role="status" aria-label={label}>
    <i />
    <i />
    <i />
  </span>
);

const Reason = ({ reason, onRetry }: { reason: OnsFailure; onRetry?: () => void }) => {
  const { t } = useTranslation();
  return (
    <span className="flex! items-center!" style={{ gap: '10px', fontSize: '12px' }}>
      <span style={{ color: 'var(--neg)' }}>{nameReasonText(t, reason)}</span>
      {onRetry && isRetryable(reason) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          style={linkStyle}
        >
          {t('ons.tryAgain', { defaultValue: 'Try again' })}
        </button>
      )}
    </span>
  );
};

export function NameRow({
  lookup,
  selected,
  onPick,
  onRetry,
}: {
  lookup: Exclude<NameLookup, { state: 'off' }>;
  selected: boolean;
  onPick: (name: string, address: string) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const found = lookup.state === 'resolved';
  const dimmed = lookup.state === 'failed' && !isRetryable(lookup.reason);
  const dim = dimmed ? 0.55 : 1;
  return (
    <div
      role={found ? 'button' : undefined}
      tabIndex={found ? 0 : undefined}
      aria-pressed={found ? selected : undefined}
      aria-disabled={dimmed || undefined}
      onClick={found ? () => onPick(lookup.name, lookup.address) : undefined}
      onKeyDown={
        found
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPick(lookup.name, lookup.address);
              }
            }
          : undefined
      }
      className={`flex! items-center! transition-colors! duration-200! ${
        selected ? 'bg-(--bg-2)!' : found ? 'hover:bg-(--bg-2)!' : ''
      }`}
      style={{
        height: `${NAME_ROW_HEIGHT}px`,
        gap: '12px',
        padding: '8px 12px',
        borderRadius: '10px',
        cursor: found ? 'pointer' : 'default',
      }}
    >
      <span className="flex! shrink-0!" style={{ opacity: dim }}>
        {found ? <WalletAvatar address={lookup.address} size={32} /> : <Blank size={32} />}
      </span>
      <span className="flex! flex-col! min-w-0! flex-1!" style={{ gap: '2px' }}>
        <span style={{ ...nameStyle, opacity: dim }}>{lookup.label}</span>
        {lookup.state === 'resolving' ? (
          <Dots label={t('ons.lookingUp', { defaultValue: 'Looking up the name' })} />
        ) : lookup.state === 'resolved' ? (
          <span
            key={lookup.address}
            className="animate-in! fade-in! duration-200! truncate!"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--fg-2)' }}
          >
            {middleCut(lookup.address)}
          </span>
        ) : (
          <Reason reason={lookup.reason} onRetry={onRetry} />
        )}
      </span>
    </div>
  );
}

const kv = (label: string, address: string, color: string) => (
  <div className="flex! items-start! justify-between!" style={{ gap: '16px', padding: '2px 0' }}>
    <span style={{ fontSize: '12.5px', color: 'var(--fg-3)', flexShrink: 0 }}>{label}</span>
    <span style={{ textAlign: 'right', minWidth: 0 }}>
      <FullAddress address={address} color={color} />
    </span>
  </div>
);

export function NameToCard({
  name,
  address,
  check,
  onUseNew,
  onRetry,
}: {
  name: string;
  address: string;
  check: Exclude<NameCheck, { kind: 'same' }> | null;
  onUseNew: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const label = nameLabel(name);
  const card = 'rounded-[18px]! bg-(--bg-2)! overflow-hidden! animate-in! fade-in! duration-200!';
  const box: React.CSSProperties = {
    height: `${NAME_CARD_HEIGHT}px`,
    padding: '10px 14px',
    marginBottom: '8px',
    boxSizing: 'border-box',
  };

  if (check?.kind === 'changed') {
    return (
      <div
        key="changed"
        role="alert"
        className={`${card} flex! flex-col! justify-center!`}
        style={{ ...box, gap: '4px' }}
      >
        <span className="flex! items-baseline! min-w-0!" style={{ gap: '5px' }}>
          <span style={nameStyle}>{label}</span>
          <span
            className="truncate!"
            style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}
          >
            {t('ons.newAddress', { defaultValue: 'points to a new address' })}
          </span>
        </span>
        {kv(t('ons.was', { defaultValue: 'Was' }), check.was, 'var(--fg-3)')}
        {kv(t('ons.now', { defaultValue: 'Now' }), check.now, 'var(--fg)')}
        <button type="button" onClick={onUseNew} style={linkStyle}>
          {t('ons.useNew', { defaultValue: 'Use new address' })}
        </button>
      </div>
    );
  }

  const stopped = check?.kind === 'stopped' ? check.reason : null;
  return (
    <div
      key={stopped ? 'stopped' : 'to'}
      role={stopped ? 'alert' : undefined}
      className={`${card} flex! items-center!`}
      style={{ ...box, gap: '12px' }}
    >
      {stopped ? <Blank size={36} /> : <WalletAvatar address={address} size={36} />}
      <div className="flex! flex-col! min-w-0! flex-1!" style={{ gap: '3px' }}>
        <span className="flex! items-baseline!" style={{ gap: '6px' }}>
          <span style={{ fontSize: '12.5px', color: 'var(--fg-3)' }}>
            {t('evmSend.to', { defaultValue: 'To' })}
          </span>
          <span style={nameStyle}>{label}</span>
        </span>
        <span className="flex! items-start!" style={{ minHeight: '33px' }}>
          {stopped ? (
            <Reason reason={stopped} onRetry={onRetry} />
          ) : (
            <FullAddress address={address} />
          )}
        </span>
      </div>
    </div>
  );
}
