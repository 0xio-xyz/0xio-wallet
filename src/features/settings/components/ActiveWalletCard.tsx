import React from 'react';
import { ChevronRight } from 'src/shared/ui/icons';
import WalletAvatar from 'src/shared/ui/WalletAvatar';

const shortAddress = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}...${a.slice(-5)}` : a);

const ActiveWalletCard = ({
  name,
  address,
  trailing,
  onClick,
  style,
}: {
  name: string;
  address: string;
  trailing?: React.ReactNode;
  onClick: () => void;
  style?: React.CSSProperties;
}) => (
  <button
    onClick={onClick}
    className="press flex! w-full! items-center! rounded-xl! bg-(--bg-1)! text-left! transition-colors! hover:bg-(--bg-2)!"
    style={{ gap: '12px', padding: '12px', border: 'none', cursor: 'pointer', ...style }}
  >
    <WalletAvatar address={address} size={36} />
    <span className="flex! min-w-0! flex-1! flex-col!" style={{ gap: '3px' }}>
      <span className="truncate!" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg)' }}>
        {name}
      </span>
      <span style={{ fontSize: '11.5px', color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
        {shortAddress(address)}
      </span>
    </span>
    {trailing}
    <ChevronRight size={14} style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
  </button>
);

export default ActiveWalletCard;
