import React, { useMemo } from 'react';
import { walletArt, WALLET_ART_GRID } from 'src/lib/walletArt';

interface WalletAvatarProps {
  address?: string;
  size?: number;
  className?: string;
}

const PLACEHOLDER = '#15151a';

const WalletAvatar = ({ address, size = 40, className }: WalletAvatarProps) => {
  const art = useMemo(() => (address ? walletArt(address) : null), [address]);
  const ground = art?.ground ?? PLACEHOLDER;

  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: `${Math.round(size * 0.28)}px`,
        overflow: 'hidden',
        flexShrink: 0,
        backgroundColor: ground,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${WALLET_ART_GRID} ${WALLET_ART_GRID}`}
        shapeRendering="crispEdges"
        style={{ display: 'block' }}
      >
        <rect width={WALLET_ART_GRID} height={WALLET_ART_GRID} fill={ground} />
        {art?.cells.map(({ r, c, fill }) => (
          <rect key={r * WALLET_ART_GRID + c} x={c} y={r} width={1.04} height={1.04} fill={fill} />
        ))}
      </svg>
    </span>
  );
};

export default React.memo(WalletAvatar);
