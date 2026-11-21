import { useTranslation } from 'src/i18n/react';
import { PrimaryButton } from 'src/shared/ui/primitives';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';

export const ReviewRow = ({
  label,
  value,
  caps = true,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  caps?: boolean;
}) => (
  <div className="flex! items-start! justify-between!" style={{ padding: '10px 4px', gap: '14px' }}>
    <span
      className={caps ? 'tab-caps' : undefined}
      style={{
        color: 'var(--fg-3)',
        paddingTop: '2px',
        flexShrink: 0,
        ...(caps ? null : { fontSize: '12px', fontFamily: 'var(--font-mono)' }),
      }}
    >
      {label}
    </span>
    <span
      style={{
        fontSize: '13px',
        color: 'var(--fg)',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        overflowWrap: 'anywhere',
      }}
    >
      {value}
    </span>
  </div>
);

export const ReviewAmount = ({
  amount,
  symbol,
  usd,
}: {
  amount: string;
  symbol: string;
  usd?: string | null;
}) => (
  <div style={{ padding: '4px 4px 16px' }}>
    <div
      style={{
        fontSize: '34px',
        fontWeight: 300,
        letterSpacing: '-0.04em',
        color: 'var(--fg)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {amount}{' '}
      <span style={{ fontSize: '16px', color: 'var(--fg-3)', letterSpacing: 0 }}>{symbol}</span>
    </div>
    {usd && <div style={{ fontSize: '12px', color: 'var(--fg-3)', marginTop: '4px' }}>{usd}</div>}
  </div>
);

export const ReviewCard = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-[18px]! bg-(--bg-2)!" style={{ padding: '4px 10px' }}>
    {children}
  </div>
);

export const ReviewNote = ({ children }: { children: React.ReactNode }) => (
  <p style={{ margin: '12px 4px 0', fontSize: '11.5px', lineHeight: 1.5, color: 'var(--fg-3)' }}>
    {children}
  </p>
);

export const ReviewFooter = ({
  onBack,
  onSend,
  sending,
  disabled = false,
}: {
  onBack: () => void;
  onSend: () => void;
  sending: boolean;
  disabled?: boolean;
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex!" style={{ gap: '10px' }}>
      <PrimaryButton secondary onClick={onBack} disabled={sending} style={BIG_BUTTON}>
        {t('common.back', { defaultValue: 'Back' })}
      </PrimaryButton>
      <PrimaryButton onClick={onSend} loading={sending} disabled={disabled} style={BIG_BUTTON}>
        {t('action.send')}
      </PrimaryButton>
    </div>
  );
};
