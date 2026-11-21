import type { CSSProperties } from 'react';

export const CAPSULE =
  'M 30 14 H 70 A 12 12 0 0 1 82 26 V 41 C 82 45.95 85.96 50 94 50 C 85.96 50 82 54.05 82 59 V 74 A 12 12 0 0 1 70 86 H 30 A 12 12 0 0 1 18 74 V 59 C 18 54.05 14.04 50 6 50 C 14.04 50 18 45.95 18 41 V 26 A 12 12 0 0 1 30 14 Z';
const SLASH =
  'M 46.5533 74.2718 L 64.5533 30.2718 A 6 6 0 0 0 61.2718 22.4467 A 6 6 0 0 0 53.4467 25.7282 L 35.4467 69.7282 A 6 6 0 0 0 38.7282 77.5533 A 6 6 0 0 0 46.5533 74.2718 Z';

interface LogoProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

const Logo = ({ size = 64, className, style }: LogoProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 100 100"
    role="img"
    aria-label="0xio"
    className={className}
    style={{ color: 'var(--logo-ink)', flexShrink: 0, ...style }}
  >
    <path d={`${CAPSULE} ${SLASH}`} fill="currentColor" fillRule="evenodd" />
  </svg>
);

export default Logo;
