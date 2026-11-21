import type { EvmNft } from 'src/services/evm/nfts';
import {
  NO_HIDDEN,
  isCollectionHidden,
  isPieceHidden,
  type NftHidden,
} from 'src/features/wallet/nft/hidden';

export interface EvmCollection {
  key: string;
  chainId: number;
  contract: string;
  name: string;
  pieces: EvmNft[];
}

export const evmCollectionKey = (chainId: number, contract: string) =>
  `${chainId}:${contract.toLowerCase()}`;

const byId = (a: EvmNft, b: EvmNft) => {
  const x = BigInt(a.tokenId);
  const y = BigInt(b.tokenId);
  return x < y ? -1 : x > y ? 1 : 0;
};

export const evmNftName = (n: Pick<EvmNft, 'name' | 'tokenId'>) => n.name ?? `#${n.tokenId}`;

export const shortContract = (contract: string) =>
  `${contract.slice(0, 6)}...${contract.slice(-4)}`;

export function deriveEvmGallery(
  items: readonly EvmNft[],
  hidden: Readonly<Record<number, NftHidden>>
) {
  const isHidden = (n: EvmNft) => {
    const h = hidden[n.chainId] ?? NO_HIDDEN;
    return isCollectionHidden(h, n.contract) || isPieceHidden(h, n.contract, n.tokenId);
  };
  const sorted = [...items].sort(byId);
  const visible = sorted.filter((n) => !isHidden(n));
  const hiddenItems = sorted.filter(isHidden);
  const groups = new Map<string, EvmCollection>();
  for (const n of visible) {
    const key = evmCollectionKey(n.chainId, n.contract);
    const g = groups.get(key);
    if (g) {
      g.pieces.push(n);
      if (g.name === shortContract(g.contract) && n.collection) g.name = n.collection;
    } else {
      groups.set(key, {
        key,
        chainId: n.chainId,
        contract: n.contract,
        name: n.collection ?? shortContract(n.contract),
        pieces: [n],
      });
    }
  }
  const collections = [...groups.values()].sort(
    (a, b) =>
      b.pieces.length - a.pieces.length ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
  return { visible, hiddenItems, collections };
}
