import type { BridgeStatus, BridgeTransfer } from 'src/services/bridge/transfers';
import type { NetworkId } from 'src/utils/config';
import { networkCapabilities } from 'src/utils/network';
import { fromUnits } from 'src/utils/amount';
import { toChecksumAddress } from 'src/services/evm/accounts';

export const WEB_BRIDGE_URL = 'https://bridge.0xio.xyz';

export const checkEthAddress = (value: string): 'ok' | 'checksum' | 'invalid' => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return 'invalid';
  const body = value.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return 'ok';
  return toChecksumAddress(value) === value ? 'ok' : 'checksum';
};

export const fmtRaw = (raw: bigint, decimals = 6, places = 6) => {
  const [int, frac = ''] = fromUnits(raw, decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cut = frac.slice(0, places).replace(/0+$/, '');
  return cut ? `${grouped}.${cut}` : grouped;
};

/** Transfers live under the wallet's Octra address on mainnet, the only network the bridge runs on. */
export const bridgeScope = (
  networkId: NetworkId,
  octAddress: string | null | undefined
): string | null => (octAddress && networkCapabilities(networkId).bridge ? octAddress : null);

const DONE: ReadonlySet<BridgeStatus> = new Set(['done', 'failed']);

const inScope = (list: readonly BridgeTransfer[], scope: string | null) =>
  scope ? list.filter((t) => t.octAddress === scope) : [];

const claimsOf = (list: readonly BridgeTransfer[], scope: string | null) =>
  inScope(list, scope).filter((t) => t.direction === 'o2e');

export const transferCount = (list: readonly BridgeTransfer[], scope: string | null): number =>
  claimsOf(list, scope).length;

export const claimCount = (list: readonly BridgeTransfer[], scope: string | null): number =>
  claimsOf(list, scope).filter((t) => t.status === 'claimable').length;

export const burnsWaiting = (list: readonly BridgeTransfer[], scope: string | null) =>
  inScope(list, scope).filter((t) => t.direction === 'e2o' && t.status === 'ready_to_burn');

/**
 * A wOCT to OCT transfer already under way for this 0x address that a new one must continue
 * instead of signing a second allowance: one waiting for its allowance to confirm, or one allowed
 * for the same amount and recipient. A new allowance would replace the one it is waiting on.
 */
export const resumableBurn = (
  list: readonly BridgeTransfer[],
  scope: string | null,
  evmAddress: string,
  amountRaw: bigint,
  recipient: string
): BridgeTransfer | null => {
  const mine = inScope(list, scope).filter(
    (t) => t.direction === 'e2o' && t.evmAddress.toLowerCase() === evmAddress.toLowerCase()
  );
  return (
    mine.find((t) => t.status === 'approving') ??
    mine.find(
      (t) =>
        t.status === 'ready_to_burn' &&
        t.amountRaw === amountRaw.toString() &&
        t.recipient === recipient
    ) ??
    null
  );
};

const MOVING: Record<'o2e' | 'e2o', ReadonlySet<BridgeStatus>> = {
  o2e: new Set(['locking', 'waiting', 'blocked', 'claiming']),
  e2o: new Set(['approving', 'burning', 'unlocking']),
};

export const latestActive = (
  list: readonly BridgeTransfer[],
  scope: string | null,
  direction: 'o2e' | 'e2o'
): BridgeTransfer | null =>
  inScope(list, scope)
    .filter((t) => t.direction === direction && MOVING[direction].has(t.status))
    .reduce<BridgeTransfer | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);

export interface TransferGroups {
  ready: BridgeTransfer[];
  moving: BridgeTransfer[];
  done: BridgeTransfer[];
}

export const groupTransfers = (
  list: readonly BridgeTransfer[],
  scope: string | null
): TransferGroups => {
  const groups: TransferGroups = { ready: [], moving: [], done: [] };
  for (const t of claimsOf(list, scope)) {
    if (t.status === 'claimable') groups.ready.push(t);
    else if (DONE.has(t.status)) groups.done.push(t);
    else groups.moving.push(t);
  }
  return groups;
};

export type ClaimTab = keyof TransferGroups;

export const defaultClaimTab = (groups: TransferGroups): ClaimTab =>
  groups.ready.length > 0 ? 'ready' : groups.moving.length > 0 ? 'moving' : 'done';
