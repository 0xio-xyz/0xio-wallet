import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import type { IconType } from 'src/shared/ui/icons';
import { Sheet } from 'src/shared/ui/primitives';
import type { ChartRange, PricePoint } from 'src/services/evm/prices';
import PriceChart from './PriceChart';
import { fmtUsd, pointMs, thinPoints } from './tokenDetailUtils';

const CHART_RANGES: ChartRange[] = ['1D', '7D', '1M'];

const fmtWhen = (time: number) => {
  const d = new Date(pointMs(time));
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const clock = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day} ${clock}`;
};

const pct = (from: number, to: number) => ((to - from) / from) * 100;

export interface TokenMarket {
  points: PricePoint[];
  loading: boolean;
  range: ChartRange;
  onRange: (range: ChartRange) => void;
  placeholder?: string;
}

export interface TokenAction {
  id: string;
  label: string;
  icon: IconType;
  onClick: () => void;
  primary?: boolean;
}

const actionStyle = {
  height: '42px',
  gap: '7px',
  borderRadius: '21px',
  border: 'none',
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  cursor: 'pointer',
} as const;

const TokenDetailSheet = ({
  onClose,
  icon,
  title,
  tag,
  subtitle,
  market,
  balance,
  actions,
  activity,
  activityEmpty,
  footer,
}: {
  onClose: () => void;
  icon: React.ReactNode;
  title: React.ReactNode;
  tag?: React.ReactNode;
  subtitle: React.ReactNode;
  market: TokenMarket | null;
  balance: { amount: React.ReactNode; symbol: string; value: React.ReactNode | null };
  actions: TokenAction[];
  activity: React.ReactNode[];
  activityEmpty: string;
  footer?: React.ReactNode;
}) => {
  const { t } = useTranslation();
  const [scrub, setScrub] = useState<number | null>(null);
  const raw = market?.points;
  const fresh = useMemo(() => thinPoints(raw ?? []), [raw]);
  const lastDrawn = useRef<typeof fresh>([]);
  if (fresh.length > 1) lastDrawn.current = fresh;
  const stale = fresh.length <= 1 && !!market?.loading && lastDrawn.current.length > 1;
  const points = stale ? lastDrawn.current : fresh;

  const first = points.length ? points[0].price : null;
  const last = points.length ? points[points.length - 1].price : null;
  const change = last !== null && first ? pct(first, last) : null;
  const flat = change === null || Math.abs(change) < 0.05;
  const color = flat ? 'var(--fg-3)' : change! > 0 ? 'var(--pos)' : 'var(--neg)';

  const held = scrub !== null && scrub < points.length ? points[scrub] : null;
  const shownPrice = held ? held.price : last;
  const shownChange = held && first ? pct(first, held.price) : change;
  const shownFlat = shownChange === null || Math.abs(shownChange) < 0.05;
  const shownColor = !held
    ? color
    : shownFlat
      ? 'var(--fg-3)'
      : shownChange! > 0
        ? 'var(--pos)'
        : 'var(--neg)';

  const pickRange = (r: ChartRange) => {
    setScrub(null);
    market?.onRange(r);
  };

  return (
    <Sheet open onClose={onClose} maxHeight="92%">
      <div className="flex! items-center!" style={{ gap: '12px', padding: '0 4px' }}>
        {icon}
        <span className="flex! min-w-0! flex-1! flex-col!" style={{ gap: '3px' }}>
          <span className="flex! min-w-0! items-center!" style={{ gap: '8px' }}>
            <span className="truncate!" style={{ fontSize: '15px', color: 'var(--fg)' }}>
              {title}
            </span>
            {tag}
          </span>
          <span className="tab-caps truncate!" style={{ color: 'var(--fg-3)' }}>
            {subtitle}
          </span>
        </span>
      </div>

      {market && (
        <>
          <div
            style={{
              padding: '22px 4px 0',
              opacity: stale ? 0.45 : 1,
              transition: 'opacity 200ms ease-out',
            }}
          >
            <div
              style={{
                fontSize: '32px',
                fontWeight: 300,
                letterSpacing: '-0.04em',
                color: 'var(--fg)',
                fontVariantNumeric: 'tabular-nums',
                height: '40px',
                lineHeight: '40px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }}
            >
              {shownPrice !== null ? fmtUsd(shownPrice) : (market.placeholder ?? '')}
            </div>
            <div
              style={{
                marginTop: '6px',
                fontSize: '12px',
                color: shownColor,
                height: '18px',
                lineHeight: '18px',
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {shownChange !== null &&
                `${shownFlat ? '' : shownChange > 0 ? '+' : '-'}${Math.abs(shownChange).toFixed(1)}%`}
              {shownChange !== null && (
                <span className="tab-caps" style={{ marginLeft: '6px', color: 'var(--fg-3)' }}>
                  {held ? fmtWhen(held.time) : market.range}
                </span>
              )}
            </div>
          </div>

          <div
            className="relative! grid! place-items-center!"
            style={{
              height: '130px',
              margin: '10px 0 0',
              opacity: stale ? 0.45 : 1,
              transition: 'opacity 200ms ease-out',
              pointerEvents: stale ? 'none' : undefined,
            }}
          >
            {points.length > 1 ? (
              <PriceChart points={points} color={color} active={scrub} onScrub={setScrub} />
            ) : (
              <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
                {market.loading ? '' : t('evmDetail.noData', { defaultValue: 'No data' })}
              </span>
            )}
          </div>

          <div className="flex! justify-center!" style={{ gap: '6px', padding: '8px 0 0' }}>
            {CHART_RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => pickRange(r)}
                aria-pressed={r === market.range}
                className={`tab-caps press ${r === market.range ? 'bg-(--bg-2)!' : 'hover:bg-(--bg-2)!'}`}
                style={{
                  border: 'none',
                  borderRadius: '13px',
                  height: '26px',
                  padding: '0 12px',
                  cursor: 'pointer',
                  background: r === market.range ? undefined : 'transparent',
                  color: r === market.range ? 'var(--fg)' : 'var(--fg-3)',
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </>
      )}

      <div
        className="rounded-[18px]! bg-(--bg-2)!"
        style={{ marginTop: market ? '18px' : '22px', padding: '14px 16px' }}
      >
        <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
          {t('evmDetail.balance', { defaultValue: 'Your balance' })}
        </span>
        <div className="flex! items-baseline! justify-between!" style={{ marginTop: '8px' }}>
          <span
            style={{
              fontSize: '20px',
              fontWeight: 300,
              color: 'var(--fg)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {balance.amount}{' '}
            <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{balance.symbol}</span>
          </span>
          {balance.value !== null && (
            <span
              style={{
                fontSize: '12.5px',
                color: 'var(--fg-2)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {balance.value}
            </span>
          )}
        </div>
      </div>

      <div className="flex!" style={{ gap: '8px', marginTop: '14px' }}>
        {actions.map(({ id, label, icon: Icon, onClick, primary }) => (
          <button
            key={id}
            type="button"
            onClick={onClick}
            className={`press flex! min-w-0! flex-1! items-center! justify-center! ${
              primary ? '' : 'bg-(--bg-2)! hover:bg-(--bg-3)!'
            }`}
            style={
              primary
                ? {
                    ...actionStyle,
                    background: 'var(--fg)',
                    color: 'var(--bg)',
                    boxShadow: 'var(--key-shadow)',
                  }
                : { ...actionStyle, color: 'var(--fg)' }
            }
          >
            <Icon size={14} className="shrink-0!" />
            <span className="truncate!">{label}</span>
          </button>
        ))}
      </div>

      <div style={{ marginTop: '22px', padding: '0 4px' }}>
        <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
          {t('evmDetail.activity', { defaultValue: 'Recent activity' })}
        </span>
      </div>
      <div style={{ margin: '6px 0 0 -4px', width: 'calc(100% + 4px)' }}>
        {activity.length > 0 ? (
          activity
        ) : (
          <p style={{ margin: '10px 8px', fontSize: '12px', color: 'var(--fg-3)' }}>
            {activityEmpty}
          </p>
        )}
      </div>

      {footer && (
        <div className="flex! justify-center!" style={{ marginTop: '18px' }}>
          {footer}
        </div>
      )}
    </Sheet>
  );
};

export default TokenDetailSheet;
