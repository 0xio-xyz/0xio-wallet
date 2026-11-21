import { usePrivateStatus } from 'src/hooks/privacy/usePrivateStatus';
import { useId, useState, useMemo, useRef } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { formatUsd, useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import { useBalanceSnapshots } from 'src/hooks/wallet/useBalanceSnapshots';
import { useBalancePoll } from 'src/hooks/wallet/useBalancePoll';
import type { HomeView } from 'src/hooks/wallet/useHomeView';
import { networkCapabilities } from 'src/utils/network';
import {
  octraNative,
  pricedHoldings,
  type PricedHoldings,
} from 'src/features/wallet/home/pricedHoldings';
import { chartSeries, thinSeries } from 'src/features/wallet/home/chartSeries';

const MaskedIcon = ({ on }: { on: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="2" y="7" width="20" height="10" rx="3" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="7.5" cy="12" r={on ? 1.3 : 0.9} fill="currentColor" />
    <circle cx="12" cy="12" r={on ? 1.3 : 0.9} fill="currentColor" />
    <circle cx="16.5" cy="12" r={on ? 1.3 : 0.9} fill="currentColor" />
  </svg>
);

const fmtUsd = (n: number) =>
  n > 0 && n < 0.01
    ? '< $0.01'
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const UNKNOWN = '--';

const BalanceCard = ({
  view = 'oct',
  evmSeries = [],
  priced = null,
}: {
  view?: HomeView;
  evmSeries?: { time: number; val: number }[] | null;
  priced?: PricedHoldings | null;
}) => {
  const { t } = useTranslation();
  const {
    balance,
    privateBalance,
    totalBalance,
    privateUnavailable,
    activeWallet,
    showBalanceValues,
    setShowBalanceValues,
    networkId,
  } = useWallet();
  useBalancePoll();
  const privateStatus = usePrivateStatus();

  const tokenPrices = useTokenPrice();
  const [showUsd, setShowUsd] = useState(true);

  const native = octraNative(
    balance,
    totalBalance,
    !!activeWallet?.privateKey && networkCapabilities(networkId).privacy,
    privateUnavailable || privateStatus?.kind === 'empty' || privateStatus?.kind === 'held'
  );
  const octTotal = native.value;
  const octPrice = tokenPrices.getPrice('OCT') || 0;
  const holdings =
    priced ??
    pricedHoldings({
      view,
      networkId,
      octPrice,
      octTotal,
      octMissing: native.missing,
      octra: { tokens: [], balances: {}, imported: [], state: 'known' },
      evm: { on: false, rows: [], loading: false, failedChains: [] },
    });
  const balSnapshots = useBalanceSnapshots(
    activeWallet?.address,
    networkId,
    parseFloat(privateBalance ?? '0') || 0,
    `${balance}|${totalBalance}`
  );
  const containerRef = useRef(null);

  const HEIGHT_SCALE = 0.5;

  const [hoverData, setHoverData] = useState(null);
  const gradId = `balance-grad-${useId().replace(/:/g, '')}`;

  const formatBalance = (val: number) => parseFloat(parseFloat(String(val)).toFixed(6)).toString();
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return (
      date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      }) + ' UTC'
    );
  };

  const shownTotal = octTotal ?? 0;
  const currentDisplayBalance =
    octTotal === null ? UNKNOWN : shownTotal > 0 ? formatBalance(shownTotal) : '0';

  const displayValue = showBalanceValues ? currentDisplayBalance : '••••••';
  const octExtra = holdings.octEquivalent;

  const octPoints = useMemo(() => {
    const now = Date.now();
    const currentBal = shownTotal + octExtra;
    const priceHist = tokenPrices.priceHistory || [];

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const cutoffTime = now - ONE_DAY_MS;

    if (!activeWallet || octTotal === null) return [];

    const getBalanceAt = (tMs: number): number => {
      if (balSnapshots.length === 0) return currentBal;
      const tSec = tMs / 1000;
      let bal = balSnapshots[0].bal;
      for (const s of balSnapshots) {
        if (s.time > tSec) break;
        bal = s.bal;
      }
      return bal + octExtra;
    };

    if (priceHist.length >= 2 && octPrice > 0) {
      const cutoffSec = cutoffTime / 1000;
      const recentPrices = priceHist.filter((p) => p.time >= cutoffSec);

      if (recentPrices.length >= 2) {
        const points = recentPrices.map((p) => ({
          time: p.time * 1000,
          val: p.value * getBalanceAt(p.time * 1000),
        }));
        points.push({ time: now, val: octPrice * currentBal });
        return points;
      }
    }

    if (balSnapshots.length >= 2 && octPrice > 0) {
      const points = balSnapshots.map((s) => ({
        time: s.time * 1000,
        val: (s.bal + octExtra) * octPrice,
      }));
      points.push({ time: now, val: currentBal * octPrice });
      return points;
    }

    const worth = octPrice > 0 ? currentBal * octPrice : currentBal;
    const points = [
      { time: cutoffTime, val: worth },
      { time: now, val: worth },
    ];

    return points;
  }, [
    shownTotal,
    octTotal,
    octExtra,
    activeWallet,
    octPrice,
    tokenPrices.priceHistory,
    balSnapshots,
  ]);

  const evmUsd = holdings.evmUsd ?? 0;
  const octInUsd = view === 'oct' && showUsd && octPrice > 0;
  const loading = view === 'oct' && !octInUsd ? octTotal === null : holdings.state === 'loading';
  const headlineUsd = view === 'evm' ? evmUsd : holdings.totalUsd;

  const pending = loading || (view !== 'oct' && evmSeries === null);
  const freshPoints = useMemo(() => {
    if (view === 'oct') return octPoints;
    if (pending) return [];
    const now = Date.now();
    const evm =
      evmSeries && evmSeries.length >= 2
        ? evmSeries
        : [
            { time: now - 24 * 60 * 60 * 1000, val: evmUsd },
            { time: now, val: evmUsd },
          ];
    const endAt = (pts: { time: number; val: number }[]) => [
      ...pts.filter((p) => p.time < now),
      { time: now, val: headlineUsd },
    ];
    if (view === 'evm') return endAt(evm);
    const octPriced = octPrice > 0 ? octPoints : [];
    const at = (pts: { time: number; val: number }[], t: number) => {
      let v = pts[0]?.val ?? 0;
      for (const p of pts) {
        if (p.time > t) break;
        v = p.val;
      }
      return v;
    };
    const times = [...new Set([...evm, ...octPriced].map((p) => p.time))].sort((a, b) => a - b);
    return endAt(times.map((t) => ({ time: t, val: at(octPriced, t) + at(evm, t) })));
  }, [view, octPoints, evmSeries, evmUsd, octPrice, pending, headlineUsd]);
  const chartScope = `${networkId ?? ''}:${activeWallet?.address ?? ''}:${view}`;
  const historyPoints = useMemo(
    () => thinSeries(chartSeries(chartScope, freshPoints, !pending), 'val'),
    [chartScope, freshPoints, pending]
  );

  const { percentChange, isPositive } = useMemo(() => {
    if (view === 'oct' && !(shownTotal > 0)) return { percentChange: '0.0', isPositive: true };
    const priceChange = view === 'oct' ? tokenPrices.prices?.OCT_24H_CHANGE : undefined;
    if (priceChange !== undefined && priceChange !== null) {
      return {
        percentChange: Math.abs(priceChange).toFixed(1),
        isPositive: priceChange >= 0,
      };
    }

    if (historyPoints.length < 2) return { percentChange: '0.0', isPositive: true };
    const startVal = historyPoints[0].val;
    const currentVal = view === 'oct' ? shownTotal : historyPoints[historyPoints.length - 1].val;
    if (startVal === 0)
      return { percentChange: currentVal > 0 ? '100.0' : '0.0', isPositive: true };
    const diff = currentVal - startVal;
    const percent = (diff / startVal) * 100;
    return {
      percentChange: Math.abs(percent).toFixed(1),
      isPositive: diff >= 0,
    };
  }, [historyPoints, shownTotal, tokenPrices.prices, view]);

  const chartMetrics = useMemo(() => {
    if (historyPoints.length < 2) return null;
    const minVal = Math.min(...historyPoints.map((p) => p.val));
    const maxVal = Math.max(...historyPoints.map((p) => p.val));
    const minTime = historyPoints[0].time;
    const maxTime = historyPoints[historyPoints.length - 1].time;
    return {
      minVal,
      maxVal,
      minTime,
      maxTime,
      rangeVal: maxVal - minVal || 1,
      rangeTime: maxTime - minTime || 1,
    };
  }, [historyPoints]);

  const { pathD, areaD } = useMemo(() => {
    if (!chartMetrics) return { pathD: '', areaD: '' };
    const { minVal, maxVal, minTime, rangeVal, rangeTime } = chartMetrics;

    const width = 100;
    const height = 20;

    const coords = historyPoints.map((p) => {
      const x = ((p.time - minTime) / rangeTime) * width;
      const normalizedY = maxVal === minVal ? 0.5 : (p.val - minVal) / rangeVal;
      const padding = (1 - HEIGHT_SCALE) / 2;
      const y = height - (normalizedY * HEIGHT_SCALE + padding) * height;
      return `${x},${y}`;
    });

    const line = `M ${coords.join(' L ')}`;
    const firstX = coords[0].split(',')[0];
    const lastX = coords[coords.length - 1].split(',')[0];
    return { pathD: line, areaD: `${line} L ${lastX},${height} L ${firstX},${height} Z` };
  }, [historyPoints, chartMetrics]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || !chartMetrics) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    const hoverRatio = Math.max(0, Math.min(1, x / width));

    const { minTime, rangeTime } = chartMetrics;
    const targetTime = minTime + hoverRatio * rangeTime;

    let p0 = historyPoints[0];
    let p1 = historyPoints[historyPoints.length - 1];

    for (let i = 0; i < historyPoints.length - 1; i++) {
      if (historyPoints[i].time <= targetTime && historyPoints[i + 1].time >= targetTime) {
        p0 = historyPoints[i];
        p1 = historyPoints[i + 1];
        break;
      }
    }

    const segmentTime = p1.time - p0.time;
    const timeInSegment = targetTime - p0.time;
    const segmentRatio = segmentTime === 0 ? 0 : timeInSegment / segmentTime;
    const interpolatedVal = p0.val + (p1.val - p0.val) * segmentRatio;

    const date = new Date(targetTime);
    const minutes = date.getMinutes();
    const remainder = minutes % 5;
    const roundedMinutes = remainder < 3 ? minutes - remainder : minutes + (5 - remainder);
    date.setMinutes(roundedMinutes);
    date.setSeconds(0);

    const displayVal =
      octPrice > 0 || view !== 'oct'
        ? `$${interpolatedVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : formatBalance(interpolatedVal);
    setHoverData({
      x: x,
      ratio: hoverRatio,
      balance: displayVal,
      time: formatTime(date.getTime()),
    });
  };

  const handleMouseLeave = () => {
    setHoverData(null);
  };

  const flat = percentChange === '0.0';
  const trendColor = flat ? 'var(--fg-3)' : isPositive ? 'var(--pos)' : 'var(--neg)';
  const chartColor = trendColor;

  const getTooltipTransform = () => {
    if (!hoverData) return {};
    const { ratio } = hoverData;
    if (ratio < 0.15) return { left: hoverData.x + 4, transform: 'translateX(0)' };
    if (ratio > 0.85) return { left: hoverData.x - 4, transform: 'translateX(-100%)' };
    return { left: hoverData.x, transform: 'translateX(-50%)' };
  };

  const octOnly = view === 'oct';
  const mainDisplay = !showBalanceValues
    ? '••••••'
    : loading
      ? UNKNOWN
      : view === 'evm'
        ? fmtUsd(evmUsd)
        : view === 'all'
          ? fmtUsd(holdings.totalUsd)
          : octInUsd
            ? formatUsd(holdings.totalUsd)
            : displayValue;
  const unknown = mainDisplay === UNKNOWN;
  const missing = showBalanceValues && !(octOnly && !octInUsd) && holdings.state === 'partial';

  const isUsdDisplay = typeof mainDisplay === 'string' && mainDisplay.includes('$');
  const leadsWithSign = isUsdDisplay && mainDisplay.startsWith('$');
  const currencySign = leadsWithSign ? '$' : '';
  const numberPart = leadsWithSign ? mainDisplay.slice(1) : mainDisplay;
  const centsAt = /^[\d,]+\.\d+$/.test(numberPart) ? numberPart.lastIndexOf('.') : -1;

  return (
    <div
      className="balance-section"
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {hoverData && (
        <>
          <div className="chart-tooltip-line" style={{ left: hoverData.x }} />
          <div className="chart-tooltip-label" style={getTooltipTransform()}>
            <span style={{ fontWeight: 600 }}>
              {showBalanceValues ? hoverData.balance : '••••••'}
            </span>
            <span style={{ opacity: 0.6, marginLeft: 4 }}>{hoverData.time}</span>
          </div>
        </>
      )}

      <div className="balance-sparkline">
        {pathD && (
          <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="balance-chart-svg">
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColor} stopOpacity="0.12" />
                <stop offset="100%" stopColor={chartColor} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={areaD} fill={`url(#${gradId})`} stroke="none" />
            <path
              d={pathD}
              fill="none"
              stroke={chartColor}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>

      <div className="balance-amount">
        <span className="flex! items-center!" style={{ gap: '6px', minHeight: '16px' }}>
          <span
            className="balance-eyebrow"
            onClick={octOnly ? () => setShowUsd(!showUsd) : undefined}
            style={{ cursor: octOnly ? 'pointer' : 'default' }}
          >
            {t('balance.total', { defaultValue: 'Total balance' })}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowBalanceValues(!showBalanceValues);
            }}
            className="press grid! place-items-center!"
            title={showBalanceValues ? t('balance.hideBalance') : t('balance.showBalance')}
            aria-label={showBalanceValues ? t('balance.hideBalance') : t('balance.showBalance')}
            aria-pressed={!showBalanceValues}
            style={{
              width: '24px',
              height: '24px',
              margin: '-4px 0',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: showBalanceValues ? 'var(--fg-3)' : 'var(--fg)',
            }}
          >
            <MaskedIcon on={!showBalanceValues} />
          </button>
        </span>

        <span className="flex! items-baseline!">
          <span id="balance-display" style={unknown ? { color: 'var(--fg-3)' } : undefined}>
            {currencySign && (
              <span
                style={{
                  color: 'var(--fg-3)',
                  fontSize: '0.55em',
                  verticalAlign: 'top',
                  position: 'relative',
                  top: '0.12em',
                  marginRight: '3px',
                }}
              >
                {currencySign}
              </span>
            )}
            {centsAt > 0 ? (
              <>
                {numberPart.slice(0, centsAt)}
                <span style={{ color: 'var(--fg-3)' }}>{numberPart.slice(centsAt)}</span>
              </>
            ) : (
              numberPart
            )}
          </span>
          {octOnly && !isUsdDisplay && showBalanceValues && !unknown && (
            <span
              style={{ marginLeft: '6px', fontSize: '15px', fontWeight: 500, color: 'var(--fg-3)' }}
            >
              OCT
            </span>
          )}
        </span>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            minHeight: '18px',
          }}
        >
          {!unknown && (octOnly || historyPoints.length >= 2) && (
            <>
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 500,
                  color: trendColor,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {flat ? '' : isPositive ? '+' : '-'}
                {percentChange}%
              </span>
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 500,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: 'var(--fg-3)',
                }}
              >
                24h
              </span>
            </>
          )}
          {missing && !unknown && (
            <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--fg-3)' }}>
              {t('balance.partial', { defaultValue: 'Some balances missing' })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default BalanceCard;
