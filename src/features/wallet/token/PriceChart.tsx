import { useId, useRef } from 'react';
import type { PricePoint } from 'src/services/evm/prices';

const EDGE_FADE = 'linear-gradient(to right, transparent, #000 14%, #000 86%, transparent)';

const layout = (points: PricePoint[]) => {
  const prices = points.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const spread = max - min || max * 0.01 || 1;
  const t0 = points[0].time;
  const span = points[points.length - 1].time - t0 || 1;
  return points.map((p) => [((p.time - t0) / span) * 100, 8 + (1 - (p.price - min) / spread) * 84]);
};

const nearest = (xs: number[], x: number) => {
  let best = 0;
  for (let i = 1; i < xs.length; i++) {
    if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
  }
  return best;
};

const PriceChart = ({
  points,
  color,
  active,
  onScrub,
}: {
  points: PricePoint[];
  color: string;
  active: number | null;
  onScrub: (index: number | null) => void;
}) => {
  const gid = useId().replace(/:/g, '');
  const boxRef = useRef<HTMLDivElement>(null);
  const xy = layout(points);
  const line = 'M' + xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L');
  const mark = active !== null && active < xy.length ? xy[active] : null;

  const scrubAt = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const x = ((clientX - box.left) / box.width) * 100;
    onScrub(
      nearest(
        xy.map(([px]) => px),
        x
      )
    );
  };

  return (
    <div
      ref={boxRef}
      className="absolute! inset-0!"
      style={{ touchAction: 'pan-y', cursor: 'crosshair' }}
      onPointerDown={(e) => {
        if (e.pointerType !== 'mouse') e.currentTarget.setPointerCapture?.(e.pointerId);
        scrubAt(e.clientX);
      }}
      onPointerMove={(e) => scrubAt(e.clientX)}
      onPointerUp={(e) => e.pointerType !== 'mouse' && onScrub(null)}
      onPointerCancel={() => onScrub(null)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && onScrub(null)}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{
          width: '100%',
          height: '100%',
          opacity: 0.75,
          maskImage: EDGE_FADE,
          WebkitMaskImage: EDGE_FADE,
        }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.12" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L100,100 L0,100 Z`} fill={`url(#${gid})`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <span
        className="pointer-events-none! absolute! inset-y-0!"
        style={{
          left: `${mark?.[0] ?? 0}%`,
          width: '1px',
          background: 'var(--fg-3)',
          opacity: mark ? 0.6 : 0,
          transition: 'opacity 200ms ease-out',
        }}
      />
      <span
        className="pointer-events-none! absolute! rounded-full!"
        style={{
          left: `${mark?.[0] ?? 0}%`,
          top: `${mark?.[1] ?? 0}%`,
          width: '8px',
          height: '8px',
          transform: 'translate(-50%, -50%)',
          background: color,
          boxShadow: '0 0 0 2px var(--bg-1)',
          opacity: mark ? 1 : 0,
          transition: 'opacity 200ms ease-out',
        }}
      />
    </div>
  );
};

export default PriceChart;
