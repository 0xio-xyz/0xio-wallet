import { networkService } from 'src/services/network/NetworkService';
import { namesOf, onsContractFor, type OnsOwnedName } from 'src/services/names/ons';
import { resolveNetworkPin } from 'src/services/network/txScope';
import type { NetworkId } from 'src/utils/config';
import { ONS_SUFFIX, onsErrorCode } from 'src/utils/octra/ons';
import { registerSessionCache } from 'src/utils/sessionCaches';
import { withBusyRetry } from 'src/features/wallet/nft/euint/chainState';
import type { KnownCollection } from 'src/features/wallet/nft/knownCollections';
import type { NftAttribute, OwnedIdsScan } from 'src/features/wallet/nft/nftData';

export const ONS_NAMES_TTL_MS = 60_000;

export async function onsKnownCollections(networkId: string): Promise<KnownCollection[]> {
  const address = await onsContractFor(networkId);
  return address ? [{ address, name: 'ONS', symbol: 'ONS' }] : [];
}

export const onsPieceTitle = (name: string) => `${name}${ONS_SUFFIX}`;

const CHAIN_FACTS = new Set(['expires', 'expiry', 'points to', 'owner', 'status']);

export const onsTraits = (attributes: NftAttribute[] | null): NftAttribute[] =>
  (attributes ?? []).filter((a) => !CHAIN_FACTS.has(a.trait_type.trim().toLowerCase()));

interface Owned {
  at: number;
  names: OnsOwnedName[];
}

const owned = new Map<string, Owned>();
const reading = new Map<string, Promise<OnsOwnedName[]>>();
const ownedKey = (networkId: string, wallet: string) => `${networkId}|${wallet}`;

export function clearOnsNames(): void {
  owned.clear();
}
registerSessionCache(clearOnsNames);

export function readOnsNames(networkId: string, wallet: string): Promise<OnsOwnedName[]> {
  const key = ownedKey(networkId, wallet);
  const running = reading.get(key);
  if (running) return running;
  const job = (async () => {
    const read = await namesOf(wallet, { at: await resolveNetworkPin(networkId as NetworkId) });
    if (read.ok !== true) throw new Error(`ons names: ${read.reason}`);
    owned.set(key, { at: Date.now(), names: read.names });
    return read.names;
  })().finally(() => reading.delete(key));
  reading.set(key, job);
  return job;
}

export function peekOnsName(
  networkId: string,
  wallet: string,
  tokenId: string
): { name: OnsOwnedName | null; fresh: boolean } | null {
  const hit = owned.get(ownedKey(networkId, wallet));
  if (!hit) return null;
  const age = Date.now() - hit.at;
  return {
    name: hit.names.find((n) => n.tokenId === tokenId) ?? null,
    fresh: age >= 0 && age < ONS_NAMES_TTL_MS,
  };
}

export async function onsOwnedIds(networkId: string, wallet: string): Promise<OwnedIdsScan> {
  const names = await readOnsNames(networkId, wallet);
  return { ids: names.map((n) => n.tokenId), complete: true };
}

export async function onsOwnerState(
  networkId: string,
  tokenId: string,
  wallet: string
): Promise<'held' | 'lapsed' | 'unknown'> {
  const contract = await onsContractFor(networkId);
  if (!contract) return 'unknown';
  try {
    const owner = await withBusyRetry(() =>
      networkService.contractCallView(contract, 'owner_of', [parseInt(tokenId)], wallet)
    );
    return String(owner) === wallet ? 'held' : 'unknown';
  } catch (e) {
    const code = onsErrorCode(
      e instanceof Error ? e.message : String(e),
      (e as { code?: number } | null)?.code
    );
    return code === 'name_lapsed' || code === 'reverted' ? 'lapsed' : 'unknown';
  }
}
