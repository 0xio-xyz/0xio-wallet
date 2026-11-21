import { forwardRef, useCallback, useId, useImperativeHandle, useRef, useState } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import Logo, { CAPSULE } from 'src/shared/ui/Logo';

export type MascotMood = 'peek' | 'open' | 'awake' | 'loading' | 'encrypt' | 'decrypt' | 'still';
type Phase = MascotMood | 'wake' | 'doze';

const PHASE_CLASS: Record<Phase, string> = {
  peek: 'mascot-peek',
  open: 'mascot-open',
  awake: 'mascot-awake',
  wake: 'mascot-wake',
  doze: 'mascot-doze',
  loading: 'mascot-loading',
  encrypt: 'mascot-encrypt',
  decrypt: 'mascot-decrypt',
  still: '',
};

const ARM_L = 'M 26 41 H 18 C 18 45.95 14.04 50 6 50 C 14.04 50 18 54.05 18 59 H 26 Z';
const ARM_R = 'M 74 41 H 82 C 82 45.95 85.96 50 94 50 C 85.96 50 82 54.05 82 59 H 74 Z';
const Z_GLYPH = 'M -3 -3 H 3 L -3 3 H 3';
const ZS = [
  { x: 80, y: 12, s: 0.8 },
  { x: 88, y: 4, s: 1 },
  { x: 97, y: -5, s: 1.25 },
];

interface MascotProps {
  mood: MascotMood;
  size: number;
  hole?: string;
  className?: string;
}

const MascotArt = ({
  phase,
  size,
  hole = 'var(--bg)',
  className = '',
}: Omit<MascotProps, 'mood'> & { phase: Phase }) => {
  const clip = `mascot-ledge-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  if (phase === 'still') return <Logo size={size} className={className} />;
  const layer = (
    <path
      d={CAPSULE}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      vectorEffect="non-scaling-stroke"
    />
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="0xio"
      className={`mascot ${PHASE_CLASS[phase]} ${className}`}
    >
      <defs>
        <clipPath id={clip}>
          <rect x="-30" y="-40" width="160" height="128" />
        </clipPath>
      </defs>
      <g className="mascot-layer mascot-layer-a">{layer}</g>
      <g className="mascot-layer mascot-layer-b">{layer}</g>
      <g clipPath={`url(#${clip})`}>
        <g className="mascot-wrap">
          <path className="mascot-arm-l" d={ARM_L} fill="currentColor" />
          <path className="mascot-arm-r" d={ARM_R} fill="currentColor" />
          <rect x="18" y="14" width="64" height="72" rx="12" fill="currentColor" />
          <g className="mascot-dial">
            <line
              className="mascot-face"
              x1="41"
              y1="72"
              x2="59"
              y2="28"
              strokeWidth="12"
              strokeLinecap="round"
              style={{ stroke: hole }}
            />
          </g>
        </g>
      </g>
      <g className="mascot-zs">
        {ZS.map(({ x, y, s }, i) => (
          <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
            <path
              className={`mascot-z mascot-z${i + 1}`}
              d={Z_GLYPH}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))}
      </g>
    </svg>
  );
};

export const Mascot = ({ mood, ...rest }: MascotProps) => <MascotArt phase={mood} {...rest} />;

export const MASCOT_IDLE_MS = 8000;

const RESTLESS = new Set<Phase>(['peek', 'open', 'awake', 'wake']);

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export interface MascotHandle {
  poke: () => void;
  play: (mood: MascotMood) => void;
}

export const IdleMascot = forwardRef<MascotHandle, MascotProps>(function IdleMascot(
  { mood, ...rest },
  ref
) {
  const [phase, setPhaseState] = useState<Phase>(mood);
  const current = useRef<Phase>(mood);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setPhase = useCallback((next: Phase) => {
    current.current = next;
    setPhaseState(next);
  }, []);

  const arm = useCallback(() => {
    clearTimeout(timer.current);
    if (!RESTLESS.has(current.current)) return;
    timer.current = setTimeout(() => {
      if (!reducedMotion() && RESTLESS.has(current.current)) setPhase('doze');
    }, MASCOT_IDLE_MS);
  }, [setPhase]);

  useImperativeHandle(
    ref,
    () => ({
      poke: () => {
        if (current.current === 'doze') setPhase('wake');
        arm();
      },
      play: (next) => {
        setPhase(next);
        arm();
      },
    }),
    [arm, setPhase]
  );

  useMountEffect(() => {
    arm();
    return () => clearTimeout(timer.current);
  });

  return <MascotArt phase={phase} {...rest} />;
});
