import { ChevronRight } from 'src/shared/ui/icons';
import { usePiece } from 'src/features/wallet/nft/piece/usePiece';
import { LiveTag, NameStatusTag, NftArt, PriceTag } from 'src/features/wallet/nft/gallery/NftArt';
import { ChainBadge } from 'src/features/wallet/nft/evm/EvmNftParts';
import { Bone, BoneLine } from 'src/shared/ui/Skeleton';

interface TileProps {
  contract: string;
  tokenId: string;
  onOpen: () => void;
  onGone: () => void;
  hiddenAction?: { label: string; onClick: () => void };
}

export function NftTile({ contract, tokenId, onOpen, onGone, hiddenAction }: TileProps) {
  const piece = usePiece(contract, tokenId, {
    onGone,
    readMarket: !hiddenAction,
    capturePoster: !hiddenAction,
  });
  if (piece.burned) return null;
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
          <NftArt piece={piece} tokenId={tokenId} />
          {!hiddenAction && piece.isLiving && <LiveTag />}
          {!hiddenAction && !piece.isOns && piece.listing && (
            <PriceTag micro={piece.listing.price} />
          )}
          {!hiddenAction && <NameStatusTag ons={piece.ons} />}
        </span>
        <span
          className="truncate!"
          style={{ fontSize: '12px', fontWeight: 500, color: 'var(--fg)' }}
        >
          {piece.name}
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

function Thumb({ contract, tokenId, k }: { contract: string; tokenId: string; k: number }) {
  const piece = usePiece(contract, tokenId, { capturePoster: true });
  return (
    <span
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
      <NftArt piece={piece} tokenId={tokenId} />
    </span>
  );
}

export function CollectionRow({
  contract,
  name,
  count,
  thumbs,
  muted = false,
  badge = null,
  onOpen,
}: {
  contract: string;
  name: string;
  count: string;
  thumbs: string[];
  muted?: boolean;
  badge?: string | null;
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
      {!muted && (
        <span className="relative! shrink-0!" style={{ width: '52px', height: '52px' }}>
          {thumbs.length === 0 ? (
            <span
              className="absolute! bg-(--bg-1)!"
              style={{ left: 0, top: 0, width: '44px', height: '44px', borderRadius: '10px' }}
            />
          ) : (
            thumbs
              .slice(0, 3)
              .map((id, k) => <Thumb key={id} contract={contract} tokenId={id} k={k} />)
          )}
          <ChainBadge logo={badge} />
        </span>
      )}
      <span className="flex-1! min-w-0! flex! flex-col!" style={{ gap: '2px' }}>
        <span
          className="truncate!"
          style={{ fontSize: '14px', fontWeight: 600, color: muted ? 'var(--fg-2)' : 'var(--fg)' }}
        >
          {name}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{count}</span>
      </span>
      <ChevronRight size={16} style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
    </button>
  );
}

const TileSkeleton = () => (
  <div className="flex! flex-col! min-w-0!" style={{ gap: '6px' }}>
    <Bone w="100%" r={12} style={{ display: 'block', aspectRatio: '1' }} />
    <BoneLine size={12} w="60%" h={9} />
  </div>
);

const RowSkeleton = () => (
  <div className="flex! items-center! w-full!" style={{ gap: '12px', padding: '8px 0' }}>
    <span className="relative! shrink-0!" style={{ width: '52px', height: '52px' }}>
      <Bone w={44} h={44} r={10} style={{ position: 'absolute', left: 0, top: 0 }} />
    </span>
    <span className="flex-1! min-w-0! flex! flex-col!" style={{ gap: '2px' }}>
      <BoneLine size={14} w={110} h={12} />
      <BoneLine size={12} w={52} h={9} />
    </span>
  </div>
);

export const NftHomeSkeleton = () => (
  <>
    <section className="flex! flex-col!">
      <span style={{ display: 'block', marginBottom: '8px' }}>
        <BoneLine size={13} w={54} h={12} />
      </span>
      <div className="grid! grid-cols-3!" style={{ gap: '10px' }}>
        {[0, 1, 2].map((i) => (
          <TileSkeleton key={i} />
        ))}
      </div>
    </section>
    <section className="flex! flex-col!">
      <span style={{ display: 'block', marginBottom: '8px' }}>
        <BoneLine size={13} w={80} h={12} />
      </span>
      {[0, 1, 2, 3].map((i) => (
        <RowSkeleton key={i} />
      ))}
    </section>
  </>
);

export const NftGridSkeleton = () => (
  <div className="grid! grid-cols-2!" style={{ gap: '12px' }}>
    {[0, 1, 2, 3].map((i) => (
      <TileSkeleton key={i} />
    ))}
  </div>
);
