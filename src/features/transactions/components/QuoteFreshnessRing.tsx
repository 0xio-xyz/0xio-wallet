export function QuoteFreshnessRing({ durationMs = 10_000 }: { durationMs?: number }) {
  const SIZE = 14;
  const STROKE = 2;
  const R = (SIZE - STROKE) / 2;
  const CIRC = 2 * Math.PI * R;

  return (
    <svg width={SIZE} height={SIZE} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={R}
        fill="none"
        stroke="var(--border-color)"
        strokeWidth={STROKE}
      />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={R}
        fill="none"
        stroke="var(--octra)"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={CIRC}
        style={{ animation: `swapRingDeplete ${durationMs}ms linear forwards` }}
      />
      <style>{`@keyframes swapRingDeplete { from { stroke-dashoffset: 0; } to { stroke-dashoffset: ${CIRC}; } }`}</style>
    </svg>
  );
}
