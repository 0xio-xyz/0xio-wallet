import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import type { TFunction } from 'src/i18n/core';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { EvmGlyph, OctraGlyph } from 'src/shared/ui/ChainGlyph';
import { middleCut } from 'src/features/wallet/add/format';
import { walletKind, type WalletKind } from 'src/features/wallet/walletKind';
import { sanitizeText, sanitizeUrl } from 'src/lib/sanitize';
import type { Wallet } from 'src/types/wallet';
import { hostOf, mono } from '../siteWallets';

export const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div
    className="flex! items-start! justify-between!"
    style={{ padding: '10px 10px', gap: '14px' }}
  >
    <span className="tab-caps" style={{ color: 'var(--fg-3)', paddingTop: '2px', flexShrink: 0 }}>
      {label}
    </span>
    <span
      className="min-w-0!"
      style={{
        fontSize: '13px',
        color: 'var(--fg)',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        overflowWrap: 'anywhere',
      }}
    >
      {children}
    </span>
  </div>
);

export const Note = ({
  children,
  strong = false,
}: {
  children: React.ReactNode;
  strong?: boolean;
}) => (
  <div
    className="rounded-[18px]! bg-(--bg-1)!"
    style={{
      padding: '12px 14px',
      fontSize: '12px',
      lineHeight: 1.5,
      color: strong ? 'var(--fg)' : 'var(--fg-2)',
    }}
  >
    {children}
  </div>
);

export const Caps = ({ children }: { children: React.ReactNode }) => (
  <div className="tab-caps" style={{ color: 'var(--fg-3)', margin: '18px 4px 8px' }}>
    {children}
  </div>
);

const KIND: Record<WalletKind, (t: TFunction) => string> = {
  phrase: (t) => t('wallet.kindPhrase', { defaultValue: 'Phrase' }),
  key: (t) => t('wallet.kindKey', { defaultValue: 'Private key' }),
  watch: (t) => t('wallet.kindWatch', { defaultValue: 'Watch-only' }),
};

export const KindChip = ({ wallet }: { wallet: Wallet }) => {
  const { t } = useTranslation();
  return (
    <span
      className="shrink-0! rounded-full! bg-(--bg-2)!"
      style={{
        fontSize: '10px',
        lineHeight: '16px',
        padding: '0 7px',
        color: 'var(--fg-2)',
        whiteSpace: 'nowrap',
      }}
    >
      {KIND[walletKind(wallet)](t)}
    </span>
  );
};

export const WalletValue = ({
  name,
  avatar,
  address,
  chip,
}: {
  name: string;
  avatar: string;
  address?: string;
  chip?: React.ReactNode;
}) => (
  <span className="inline-flex! items-center! min-w-0!" style={{ gap: '8px' }}>
    <WalletAvatar address={avatar} size={20} />
    <span className="flex! flex-col! items-start! min-w-0!" style={{ gap: '1px' }}>
      <span className="flex! items-center! min-w-0! max-w-full!" style={{ gap: '6px' }}>
        <span className="truncate!" style={{ fontSize: '13px', color: 'var(--fg)' }}>
          {sanitizeText(name)}
        </span>
        {chip}
      </span>
      {address && (
        <span style={{ ...mono, fontSize: '11px', color: 'var(--fg-3)' }}>
          {middleCut(address, 8, 6)}
        </span>
      )}
    </span>
  </span>
);

export const WalletRow = ({
  wallet,
  address,
  evm,
  selected = false,
  onClick,
  right,
  dim = false,
}: {
  wallet: Wallet;
  address: string;
  evm: boolean;
  selected?: boolean;
  onClick?: () => void;
  right?: React.ReactNode;
  dim?: boolean;
}) => {
  const Tag: 'button' | 'div' = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
      className={`w-full! flex! items-center! rounded-[14px]! transition-colors! duration-200! ${
        selected ? 'bg-(--bg-2)!' : onClick ? 'hover:bg-(--bg-2)!' : ''
      }`}
      style={{
        minHeight: '52px',
        padding: '8px 10px',
        gap: '10px',
        border: 'none',
        background: selected ? undefined : 'transparent',
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
        opacity: dim ? 0.55 : 1,
      }}
    >
      <WalletAvatar address={wallet.address} size={30} />
      <span className="flex! flex-col! min-w-0! flex-1!" style={{ gap: '2px' }}>
        <span className="flex! items-center! min-w-0!" style={{ gap: '6px' }}>
          <span className="truncate!" style={{ fontSize: '13px', color: 'var(--fg)' }}>
            {sanitizeText(wallet.name)}
          </span>
          <KindChip wallet={wallet} />
        </span>
        <span
          className="flex! items-center!"
          style={{ gap: '4px', ...mono, fontSize: '11px', color: 'var(--fg-3)' }}
        >
          {evm ? <EvmGlyph size={9} /> : <OctraGlyph size={9} />}
          {middleCut(address, 10, 8)}
        </span>
      </span>
      {right}
    </Tag>
  );
};

export const SiteMark = ({
  origin,
  favicon,
  size = 36,
}: {
  origin: string;
  favicon?: string;
  size?: number;
}) => {
  const [broken, setBroken] = useState(false);
  const src = sanitizeUrl(favicon ?? `${origin}/favicon.ico`);
  const letter = hostOf(origin)
    .replace(/^www\./, '')
    .charAt(0)
    .toUpperCase();
  return (
    <span
      className="flex! shrink-0! items-center! justify-center! rounded-full! bg-(--bg-2)!"
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      {src && !broken ? (
        <img
          src={src}
          alt=""
          onError={() => setBroken(true)}
          style={{
            width: `${Math.round(size * 0.55)}px`,
            height: `${Math.round(size * 0.55)}px`,
            borderRadius: '5px',
            objectFit: 'contain',
          }}
        />
      ) : (
        <span
          style={{
            fontSize: `${Math.round(size * 0.36)}px`,
            fontWeight: 600,
            color: 'var(--fg-2)',
          }}
        >
          {letter}
        </span>
      )}
    </span>
  );
};

export const SiteHead = ({ origin, favicon }: { origin: string; favicon?: string }) => (
  <div className="flex! items-center!" style={{ gap: '10px', marginTop: '12px' }}>
    <SiteMark origin={origin} favicon={favicon} />
    <div className="flex! min-w-0! flex-col!" style={{ gap: '2px' }}>
      <span className="truncate!" style={{ fontSize: '15px', color: 'var(--fg)' }}>
        {hostOf(origin)}
      </span>
      <span className="truncate!" style={{ fontSize: '11.5px', color: 'var(--fg-3)' }}>
        {origin}
      </span>
    </div>
  </div>
);

export const ReviewHeading = ({
  children,
  big = false,
}: {
  children: React.ReactNode;
  big?: boolean;
}) => (
  <div
    style={{
      margin: '18px 4px 16px',
      fontSize: big ? '28px' : '20px',
      fontWeight: 300,
      letterSpacing: big ? '-0.03em' : '-0.01em',
      lineHeight: 1.25,
      color: 'var(--fg)',
      fontVariantNumeric: 'tabular-nums',
      overflowWrap: 'anywhere',
    }}
  >
    {children}
  </div>
);
