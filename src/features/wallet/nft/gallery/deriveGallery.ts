import type { NftCollection } from 'src/features/wallet/nft/nftData';
import { type NftHidden, isCollectionHidden, isPieceHidden } from 'src/features/wallet/nft/hidden';

export interface GalleryPiece {
  contract: string;
  tokenId: string;
  collection: string;
}

export interface GalleryRow {
  collection: NftCollection;
  count: number;
  thumbs: string[];
}

export const byHeld = (a: NftCollection, b: NftCollection) =>
  b.ownedCount - a.ownedCount || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function deriveGallery(
  collections: readonly NftCollection[],
  ids: Readonly<Record<string, string[]>>,
  hidden: NftHidden
) {
  const sorted = [...collections].sort(byHeld);
  const pieces: GalleryPiece[] = sorted.flatMap((c) =>
    [...(ids[c.contractAddress] ?? [])]
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map((tokenId) => ({ contract: c.contractAddress, tokenId, collection: c.name }))
  );
  const isHidden = (p: GalleryPiece) =>
    isCollectionHidden(hidden, p.contract) || isPieceHidden(hidden, p.contract, p.tokenId);
  const visible = pieces.filter((p) => !isHidden(p));
  const hiddenPieces = pieces.filter(isHidden);

  const rows: GalleryRow[] = [];
  let hiddenCount = 0;
  for (const c of sorted) {
    const mine = visible.filter((p) => p.contract === c.contractAddress);
    const scanned = ids[c.contractAddress];
    if (isCollectionHidden(hidden, c.contractAddress)) {
      hiddenCount += scanned?.length ?? c.ownedCount;
      continue;
    }
    const piecesHidden = scanned
      ? scanned.filter((id) => isPieceHidden(hidden, c.contractAddress, id)).length
      : hidden.pieces.filter((k) => k.startsWith(`${c.contractAddress}:`)).length;
    hiddenCount += piecesHidden;
    const count = scanned ? mine.length : Math.max(0, c.ownedCount - piecesHidden);
    if (count > 0) {
      rows.push({ collection: c, count, thumbs: mine.slice(0, 3).map((p) => p.tokenId) });
    }
  }
  return { collections: sorted, pieces, visible, hiddenPieces, rows, hiddenCount };
}
