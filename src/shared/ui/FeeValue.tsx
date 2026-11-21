import { useTranslation } from 'src/i18n/react';

export type FeeState = 'loading' | 'ready' | 'stale' | 'failed' | 'unsupported';

export default function FeeValue({
  state,
  text,
  ageMs,
  retry = false,
}: {
  state: FeeState;
  text?: React.ReactNode;
  ageMs?: number | null;
  retry?: boolean;
}) {
  const { t } = useTranslation();
  if (state === 'ready' && text != null) return <>{text}</>;
  if (state === 'stale' && text != null) {
    const minutes = Math.max(1, Math.round((ageMs ?? 0) / 60_000));
    return (
      <span className="inline-flex! items-center!" style={{ gap: '6px', color: 'var(--fg-3)' }}>
        <span>{text}</span>
        <span style={{ fontSize: '10.5px', fontWeight: 400 }}>
          {t('fee.age', { defaultValue: '{{n}} min ago', n: minutes })}
        </span>
      </span>
    );
  }
  if (state === 'unsupported') {
    return (
      <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
        {t('fee.unsupported', { defaultValue: 'This node does not quote fees' })}
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="inline-flex! items-center!" style={{ gap: '6px', fontSize: '11px' }}>
        <span style={{ color: 'var(--neg)' }}>
          {t('fee.unavailable', { defaultValue: 'Unavailable' })}
        </span>
        {retry && (
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
            {t('common.retry', { defaultValue: 'Retry' })}
          </span>
        )}
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-label={t('fee.loading', { defaultValue: 'Reading network fee' })}
      className="inline-block! animate-pulse! rounded-sm! bg-(--bg-2)!"
      style={{ width: '64px', height: '12px', verticalAlign: 'middle' }}
    />
  );
}
