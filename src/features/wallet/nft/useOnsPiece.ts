import { useEffect, useState } from 'react';
import { useOnsContract } from 'src/hooks/wallet/useOnsContract';
import {
  onsOwnerState,
  onsPieceTitle,
  peekOnsName,
  readOnsNames,
} from 'src/features/wallet/nft/onsNames';

export interface OnsPiece {
  title: string | null;
  loaded: boolean;
  active: boolean;
  inactive: boolean;
  expired: boolean;
  expires: number | null;
}

export function useOnsPiece(
  networkId: string,
  contract: string,
  tokenId: string,
  wallet: string,
  checkOwner = false
): OnsPiece | null {
  const names = useOnsContract(networkId);
  const ons = !!wallet && names === contract;
  const key = ons ? `${networkId}|${wallet}|${tokenId}` : '';
  const [read, setRead] = useState<{ key: string } | null>(null);
  const [lapsed, setLapsed] = useState<string | null>(null);

  // effect:audited - reads the wallet's names; the piece page also asks owner_of.
  useEffect(() => {
    if (!key) return;
    let alive = true;
    if (!peekOnsName(networkId, wallet, tokenId)?.fresh) {
      readOnsNames(networkId, wallet)
        .then(() => alive && setRead({ key }))
        .catch(() => {});
    }
    if (checkOwner) {
      void onsOwnerState(networkId, tokenId, wallet).then((state) => {
        if (alive && state === 'lapsed') setLapsed(key);
      });
    }
    return () => {
      alive = false;
    };
  }, [key, networkId, wallet, tokenId, checkOwner]);

  if (!ons) return null;
  void read;
  const hit = peekOnsName(networkId, wallet, tokenId);
  const name = hit?.name ?? null;
  const active = lapsed !== key && name?.status === 'active';
  return {
    title: name ? onsPieceTitle(name.name) : null,
    loaded: !!hit,
    active,
    inactive: lapsed === key || (!!hit && !active),
    expired:
      lapsed === key ||
      name?.status === 'grace' ||
      (!!name && !active && name.expires * 1000 <= Date.now()),
    expires: name?.expires ?? null,
  };
}
