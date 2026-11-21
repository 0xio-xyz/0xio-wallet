import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { Mascot } from 'src/shared/ui/Mascot';
import type { PieceState } from 'src/features/wallet/nft/piece/usePiece';
import { NamePlate } from 'src/features/wallet/nft/gallery/NamePlate';
import { fmtMicro } from 'src/features/wallet/nft/piece/format';

const shownArt = new Set<string>();

export function NftArt({ piece, tokenId }: { piece: PieceState; tokenId: string }) {
  const [broken, setBroken] = useState<string[]>([]);
  const poster = piece.isLiving && piece.detail.metaFetched ? (piece.detail.poster ?? null) : null;
  const src = [piece.artUrl, poster].find((u): u is string => !!u && !broken.includes(u)) ?? null;
  if (piece.isOns ? piece.artPending : !piece.detail.metaFetched) {
    return (
      <span className="absolute! inset-0! flex! items-center! justify-center!">
        <Mascot mood="loading" size={20} hole="var(--bg-1)" />
      </span>
    );
  }
  if (src) {
    const seen = shownArt.has(src);
    return (
      <img
        key={src}
        src={src}
        alt={piece.name}
        loading={seen ? 'eager' : 'lazy'}
        onLoad={() => shownArt.add(src)}
        onError={() => setBroken((b) => [...b, src])}
        className={`${seen ? '' : 'nft-art-in '}absolute! inset-0! w-full! h-full! object-cover!`}
      />
    );
  }
  if (piece.isOns) {
    return <NamePlate title={piece.ons?.loaded ? piece.name : null} off={!!piece.ons?.inactive} />;
  }
  return (
    <span
      className="absolute! inset-0! flex! items-center! justify-center! font-mono!"
      style={{ fontSize: '11px', color: 'var(--fg-3)' }}
    >
      #{tokenId}
    </span>
  );
}

const tagStyle: React.CSSProperties = {
  height: '20px',
  padding: '0 7px',
  borderRadius: '10px',
  background: 'rgba(10, 12, 18, 0.6)',
  backdropFilter: 'blur(10px)',
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: '#f2f2f5',
  gap: '4px',
};

export function LiveTag() {
  const { t } = useTranslation();
  return (
    <span
      className="absolute! z-raised! inline-flex! items-center! whitespace-nowrap!"
      style={{ ...tagStyle, left: '6px', top: '6px' }}
    >
      <i className="nft-live-dot" aria-hidden="true" />
      {t('nft.liveTag', { defaultValue: 'LIVE' })}
    </span>
  );
}

export function NameStatusTag({ ons }: { ons: PieceState['ons'] }) {
  const { t } = useTranslation();
  if (!ons?.expired) return null;
  return (
    <span
      className="absolute! z-raised! inline-flex! items-center! whitespace-nowrap!"
      style={{ ...tagStyle, right: '6px', bottom: '6px' }}
    >
      {t('nft.expired', { defaultValue: 'Expired' })}
    </span>
  );
}

export function PriceTag({ micro }: { micro: number }) {
  return (
    <span
      className="absolute! z-raised! inline-flex! items-center! whitespace-nowrap!"
      style={{ ...tagStyle, right: '6px', bottom: '6px', fontVariantNumeric: 'tabular-nums' }}
    >
      {fmtMicro(micro)} OCT
    </span>
  );
}
