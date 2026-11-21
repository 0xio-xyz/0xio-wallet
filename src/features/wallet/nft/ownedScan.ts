import { logger } from 'src/utils/logger';
import { keepKnownIds } from 'src/features/wallet/nft/euint/chainState';
import {
  type NftCollection,
  type OwnedIdsScan,
  fetchOwnedTokenIds,
  ownedIdsCache,
  scheduleSnapshotSave,
  stillOwned,
} from 'src/features/wallet/nft/nftData';
import { onsOwnedIds } from 'src/features/wallet/nft/onsNames';
import { onsContractFor } from 'src/services/names/ons';

export const ownedIdsKey = (networkId: string, contract: string, wallet: string) =>
  `${networkId}:${contract}:${wallet}`;

export interface OwnedScanResult {
  ids: string[] | null;
  failed: boolean;
}

interface SharedScan {
  result: Promise<OwnedScanResult | null>;
  waiters: number;
}

const running = new Map<string, SharedScan>();

async function scanOwned(
  networkId: string,
  wallet: string,
  c: NftCollection,
  gone: () => boolean
): Promise<OwnedScanResult | null> {
  const ck = ownedIdsKey(networkId, c.contractAddress, wallet);
  const hit = ownedIdsCache.get(ck);
  const known = hit && hit.count === c.ownedCount ? hit.ids : [];
  let scan: OwnedIdsScan | null = null;
  try {
    if ((await onsContractFor(networkId)) === c.contractAddress) {
      scan = await onsOwnedIds(networkId, wallet);
    } else {
      const held =
        known.length === Math.min(c.ownedCount, 50) &&
        (await stillOwned(networkId, c.contractAddress, wallet, known, gone));
      scan =
        held === true
          ? { ids: known, complete: true }
          : held === null
            ? { ids: [], complete: false }
            : await fetchOwnedTokenIds(
                c.contractAddress,
                wallet,
                c.totalSupply,
                c.ownedCount,
                gone
              );
    }
  } catch (err) {
    logger.debug(`[NFT] enumeration failed for ${c.contractAddress.slice(0, 10)}…: ${err}`);
  }
  if (gone()) return null;
  const fetched = scan?.ids ?? null;
  let next: string[] | null;
  let failed = false;
  if (scan && !scan.complete) {
    next = keepKnownIds(hit?.ids ?? [], scan.ids);
    if (next.length > 0) {
      ownedIdsCache.set(ck, { ids: next, ts: 0, count: hit?.count ?? c.ownedCount });
    } else failed = true;
  } else if (fetched && fetched.length > 0) {
    next = fetched;
    ownedIdsCache.set(ck, { ids: next, ts: Date.now(), count: c.ownedCount });
  } else if (hit && fetched && c.countKnown && c.ownedCount === 0) {
    next = [];
    ownedIdsCache.delete(ck);
  } else if (hit) {
    next = hit.ids;
  } else if (fetched === null) {
    next = null;
    failed = true;
  } else {
    next = [];
  }
  scheduleSnapshotSave();
  return { ids: next, failed };
}

export function joinOwnedScan(
  networkId: string,
  wallet: string,
  c: NftCollection
): { result: Promise<OwnedScanResult | null>; leave: () => void } {
  const key = `${ownedIdsKey(networkId, c.contractAddress, wallet)}:${c.ownedCount}`;
  let shared = running.get(key);
  if (!shared) {
    const mine: SharedScan = { result: Promise.resolve(null), waiters: 0 };
    const drop = () => {
      if (running.get(key) === mine) running.delete(key);
    };
    const gone = () => {
      if (mine.waiters > 0) return false;
      drop();
      return true;
    };
    running.set(key, mine);
    mine.result = scanOwned(networkId, wallet, c, gone).finally(drop);
    shared = mine;
  }
  const joined = shared;
  joined.waiters += 1;
  let left = false;
  return {
    result: joined.result,
    leave: () => {
      if (left) return;
      left = true;
      joined.waiters -= 1;
    },
  };
}
