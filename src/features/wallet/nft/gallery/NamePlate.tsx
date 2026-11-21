import { useTranslation } from 'src/i18n/react';
import { ONS_SUFFIX } from 'src/utils/octra/ons';

const s = { pad: 7.8, name: 9.5, glow: '30% 30%' } as const;

export function NamePlate({ title, off }: { title: string | null; off: boolean }) {
  const { t } = useTranslation();
  const named = !!title && title.endsWith(ONS_SUFFIX) && title.length > ONS_SUFFIX.length;
  const cut = named ? title.length - ONS_SUFFIX.length - 1 : 0;
  return (
    <span
      data-name-plate={title === null ? 'loading' : off ? 'off' : 'on'}
      className="absolute! inset-0! block!"
      style={{
        containerType: 'inline-size',
        borderRadius: 'inherit',
        background: off
          ? 'var(--bg-1)'
          : `radial-gradient(ellipse ${s.glow} at 85% 5%, color-mix(in oklab, var(--fg) 7%, transparent), transparent), linear-gradient(160deg, var(--bg-2), var(--bg))`,
        boxShadow: off ? 'none' : 'var(--raise-shadow)',
      }}
    >
      <span
        className="absolute! inset-0! flex! flex-col! justify-between! text-left!"
        style={{ padding: `${s.pad}cqw` }}
      >
        {title === null ? (
          <span
            className="name-dots"
            style={{ height: `${s.name * 1.2}cqw` }}
            role="status"
            aria-label={t('common.loading', { defaultValue: 'Loading' })}
          >
            <i />
            <i />
            <i />
          </span>
        ) : (
          <span
            style={{
              fontSize: `${s.name}cqw`,
              lineHeight: 1.2,
              fontWeight: 600,
              overflowWrap: 'anywhere',
              color: off ? 'var(--fg-3)' : 'var(--fg)',
            }}
          >
            {title.slice(0, cut)}
            <span style={{ whiteSpace: 'nowrap' }}>{title.slice(cut)}</span>
          </span>
        )}
      </span>
    </span>
  );
}
