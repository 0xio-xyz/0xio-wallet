import { useState } from 'react';
import { ChevronRight } from 'src/shared/ui/icons';
import { nftImageSrc, type EvmNft } from 'src/services/evm/nfts';
import { evmNftName } from 'src/features/wallet/nft/evm/deriveEvmGallery';

export function EvmNftArt({ nft }: { nft: Pick<EvmNft, 'image' | 'name' | 'tokenId'> }) {
  const src = nftImageSrc(nft.image);
  const [broken, setBroken] = useState<string | null>(null);
  if (src && src !== broken) {
    return (
      <img
        src={src}
        alt={nft.name ?? ''}
        loading="lazy"
        onError={() => setBroken(src)}
        className="absolute! inset-0! w-full! h-full! object-cover!"
      />
    );
  }
  return (
    <span
      className="absolute! inset-0! flex! items-center! justify-center! font-mono! truncate!"
      style={{ fontSize: '11px', color: 'var(--fg-3)', padding: '0 6px' }}
    >
      #{nft.tokenId.length > 10 ? `${nft.tokenId.slice(0, 8)}...` : nft.tokenId}
    </span>
  );
}

export function ChainBadge({ logo, size = 16 }: { logo: string | null; size?: number }) {
  if (!logo) return null;
  return (
    <img
      src={logo}
      alt=""
      width={size}
      height={size}
      className="absolute! z-raised! rounded-full!"
      style={{
        right: '4px',
        bottom: '4px',
        width: `${size}px`,
        height: `${size}px`,
        background: 'var(--bg)',
        boxShadow: '0 0 0 2px var(--bg)',
      }}
    />
  );
}

export function CountTag({ amount }: { amount: string }) {
  return (
    <span
      className="absolute! z-raised! inline-flex! items-center! whitespace-nowrap!"
      style={{
        left: '6px',
        top: '6px',
        height: '20px',
        padding: '0 7px',
        borderRadius: '10px',
        background: 'rgba(10, 12, 18, 0.6)',
        backdropFilter: 'blur(10px)',
        fontSize: '10px',
        fontWeight: 700,
        color: '#f2f2f5',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      ×{amount.length > 6 ? `${amount.slice(0, 5)}+` : amount}
    </span>
  );
}

export function EvmNftTile({
  nft,
  onOpen,
  hiddenAction,
}: {
  nft: EvmNft;
  onOpen: () => void;
  hiddenAction?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex! flex-col! min-w-0!" style={{ gap: '6px' }}>
      <button
        onClick={onOpen}
        className="nft-tile flex! flex-col! text-left! min-w-0!"
        style={{ gap: '6px', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <span
          className="nft-tile-art relative! block! w-full! aspect-square! rounded-xl! overflow-hidden! bg-(--bg-1)!"
          style={{ opacity: hiddenAction ? 0.5 : 1 }}
        >
          <EvmNftArt nft={nft} />
          {!hiddenAction && nft.standard === 'ERC-1155' && <CountTag amount={nft.amount} />}
        </span>
        <span
          className="truncate!"
          style={{ fontSize: '12px', fontWeight: 500, color: 'var(--fg)' }}
        >
          {evmNftName(nft)}
        </span>
      </button>
      {hiddenAction && (
        <button
          onClick={hiddenAction.onClick}
          className="press self-start! max-w-full! truncate! hover:bg-(--bg-2)! transition-colors!"
          style={{
            height: '24px',
            padding: '0 10px',
            borderRadius: '999px',
            background: 'var(--bg-1)',
            border: 'none',
            fontSize: '11.5px',
            fontWeight: 600,
            color: 'var(--fg-2)',
            cursor: 'pointer',
          }}
        >
          {hiddenAction.label}
        </button>
      )}
    </div>
  );
}

export function EvmCollectionRow({
  name,
  count,
  thumbs,
  logo,
  onOpen,
}: {
  name: string;
  count: string;
  thumbs: EvmNft[];
  logo: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="press flex! items-center! w-full! text-left! rounded-lg!"
      style={{
        gap: '12px',
        padding: '8px 0',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      <span className="relative! shrink-0!" style={{ width: '52px', height: '52px' }}>
        {thumbs.length === 0 ? (
          <span
            className="absolute! bg-(--bg-1)!"
            style={{ left: 0, top: 0, width: '44px', height: '44px', borderRadius: '10px' }}
          />
        ) : (
          thumbs.slice(0, 3).map((n, k) => (
            <span
              key={n.tokenId}
              className="absolute! overflow-hidden! bg-(--bg-1)!"
              style={{
                left: `${k * 4}px`,
                top: `${k * 4}px`,
                zIndex: 3 - k,
                width: '44px',
                height: '44px',
                borderRadius: '10px',
                boxShadow: '0 0 0 2px var(--bg)',
              }}
            >
              <EvmNftArt nft={n} />
            </span>
          ))
        )}
        <ChainBadge logo={logo} />
      </span>
      <span className="flex-1! min-w-0! flex! flex-col!" style={{ gap: '2px' }}>
        <span
          className="truncate!"
          style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg)' }}
        >
          {name}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{count}</span>
      </span>
      <ChevronRight size={16} style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
    </button>
  );
}
