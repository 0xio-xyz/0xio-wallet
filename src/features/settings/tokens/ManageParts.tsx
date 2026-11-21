import { useState } from 'react';
import { Toggle } from 'src/shared/ui/primitives';
import { Caps } from 'src/features/settings/components/networkParts';
import { NftArt } from 'src/features/wallet/nft/gallery/NftArt';
import { EvmNftArt } from 'src/features/wallet/nft/evm/EvmNftParts';
import { usePiece } from 'src/features/wallet/nft/piece/usePiece';
import { IMAGE_PROXY, type EvmNft } from 'src/services/evm/nfts';

export type ManageTab = 'tokens' | 'nfts';

export function Segmented({
  value,
  onChange,
  options,
}: {
  value: ManageTab;
  onChange: (v: ManageTab) => void;
  options: { id: ManageTab; label: string }[];
}) {
  return (
    <div
      role="tablist"
      className="grid! grid-cols-2! rounded-full! bg-(--bg-1)!"
      style={{ padding: '3px', gap: '3px' }}
    >
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.id)}
            className="press rounded-full! transition-colors! duration-200! ease-out!"
            style={{
              height: '30px',
              border: 'none',
              cursor: 'pointer',
              background: on ? 'var(--bg-3)' : 'transparent',
              color: on ? 'var(--fg)' : 'var(--fg-3)',
              fontSize: '12.5px',
              fontWeight: 600,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="shrink-0! inline-flex! items-center! rounded-full! bg-(--bg-3)!"
      style={{
        height: '17px',
        padding: '0 7px',
        fontSize: '10px',
        fontWeight: 600,
        color: 'var(--fg-2)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function SectionHead({ label, count }: { label: string; count: number }) {
  return (
    <Caps
      right={
        <span
          style={{ fontSize: '11px', color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}
        >
          {count}
        </span>
      }
    >
      {label}
    </Caps>
  );
}

export function TokenMark({
  logo,
  symbol,
  badge,
  dim,
}: {
  logo: string | null;
  symbol: string;
  badge: string | null;
  dim: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const src = logo && logo !== broken ? logo : null;
  return (
    <span
      className="relative! shrink-0!"
      style={{
        width: '28px',
        height: '28px',
        opacity: dim ? 0.55 : 1,
        transition: 'opacity 200ms ease-out',
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={28}
          height={28}
          crossOrigin={
            /^https?:/.test(src) && !src.startsWith(`${IMAGE_PROXY}?`) ? 'anonymous' : undefined
          }
          onError={() => setBroken(src)}
          className="rounded-full! object-cover!"
          style={{ width: '28px', height: '28px' }}
        />
      ) : (
        <span
          className="grid! place-items-center! rounded-full! bg-(--bg-2)! uppercase!"
          style={{
            width: '28px',
            height: '28px',
            fontSize: '10px',
            fontWeight: 700,
            color: 'var(--fg-2)',
          }}
        >
          {symbol.slice(0, 3)}
        </span>
      )}
      {badge && (
        <img
          src={badge}
          alt=""
          width={13}
          height={13}
          className="absolute! rounded-full!"
          style={{
            right: '-3px',
            bottom: '-3px',
            background: 'var(--bg-1)',
            boxShadow: '0 0 0 2px var(--bg-1)',
          }}
        />
      )}
    </span>
  );
}

export function SwitchRow({
  mark,
  title,
  tag,
  sub,
  value,
  on,
  label,
  onToggle,
  onOpen,
}: {
  mark: React.ReactNode;
  title: string;
  tag?: string | null;
  sub: string;
  value?: string | null;
  on: boolean;
  label: string;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  const Body = onOpen ? 'button' : 'span';
  return (
    <div
      className="flex! items-center! rounded-[14px]! transition-colors! duration-200! hover:bg-(--bg-2)!"
      style={{ gap: '10px', padding: '9px 12px', minHeight: '50px' }}
    >
      <Body
        {...(onOpen ? { type: 'button' as const, onClick: onOpen } : {})}
        className="flex! min-w-0! flex-1! items-center! text-left!"
        style={{
          gap: '10px',
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: onOpen ? 'pointer' : 'default',
          color: 'inherit',
          font: 'inherit',
        }}
      >
        {mark}
        <span className="flex! min-w-0! flex-1! flex-col!" style={{ gap: '2px' }}>
          <span className="flex! min-w-0! items-center!" style={{ gap: '6px' }}>
            <span
              className="truncate!"
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: on ? 'var(--fg)' : 'var(--fg-2)',
                transition: 'color 200ms ease-out',
              }}
            >
              {title}
            </span>
            {tag && <Tag>{tag}</Tag>}
          </span>
          <span className="truncate!" style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
            {sub}
          </span>
        </span>
        {value && (
          <span
            className="shrink-0! truncate!"
            style={{
              maxWidth: '96px',
              fontSize: '12px',
              color: 'var(--fg-2)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {value}
          </span>
        )}
      </Body>
      <Toggle checked={on} onChange={onToggle} label={label} />
    </div>
  );
}

function OctraCoverArt({ contract, tokenId }: { contract: string; tokenId: string }) {
  const piece = usePiece(contract, tokenId);
  return <NftArt piece={piece} tokenId={tokenId} />;
}

export function CollectionCover({
  contract,
  coverId,
  coverNft,
  badge,
  dim,
}: {
  contract: string;
  coverId: string | null;
  coverNft: EvmNft | null;
  badge: string | null;
  dim: boolean;
}) {
  return (
    <span
      className="relative! shrink-0!"
      style={{
        width: '36px',
        height: '36px',
        opacity: dim ? 0.55 : 1,
        transition: 'opacity 200ms ease-out',
      }}
    >
      <span className="absolute! inset-0! overflow-hidden! rounded-[10px]! bg-(--bg-2)!">
        {coverNft ? (
          <EvmNftArt nft={coverNft} />
        ) : coverId ? (
          <OctraCoverArt contract={contract} tokenId={coverId} />
        ) : null}
      </span>
      {badge && (
        <img
          src={badge}
          alt=""
          width={13}
          height={13}
          className="absolute! rounded-full!"
          style={{
            right: '-3px',
            bottom: '-3px',
            background: 'var(--bg-1)',
            boxShadow: '0 0 0 2px var(--bg-1)',
          }}
        />
      )}
    </span>
  );
}

export function QuietAdd({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press flex! w-full! items-center! justify-center! rounded-[22px]! transition-colors! duration-200! hover:bg-(--bg-1)!"
      style={{
        marginTop: '14px',
        height: '44px',
        border: 'none',
        background: 'transparent',
        color: 'var(--fg-2)',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

export function QuietNote({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: 0, padding: '18px 4px 0', fontSize: '12px', color: 'var(--fg-3)' }}>
      {children}
    </p>
  );
}
