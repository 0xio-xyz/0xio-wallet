import { rpcCall } from '../evm/rpc';
import { broadcast } from '../evm/send';
import { fetchStatus } from './relay/anyChain';
import {
  burnMessageId,
  claimCheck,
  ethereumMainnet,
  findUnlock,
  lockProgress,
  wOctAllowance,
  type ClaimCheck,
  type LockedEvent,
} from './bridge';

export type BridgeDirection = 'o2e' | 'e2o' | 'a2o';

export type BridgeStatus =
  | 'locking'
  | 'waiting'
  | 'claimable'
  | 'claiming'
  | 'approving'
  | 'ready_to_burn'
  | 'burning'
  | 'swapping'
  | 'unlocking'
  | 'blocked'
  | 'done'
  | 'failed';

export interface StoredLock {
  hash: string;
  epoch: number;
  amountRaw: string;
  ethAddress: string;
  srcNonce: number;
}

export interface BridgeTransfer {
  id: string;
  direction: BridgeDirection;
  amountRaw: string;
  octAddress: string;
  evmAddress: string;
  recipient: string;
  createdAt: number;
  updatedAt: number;
  status: BridgeStatus;
  note?: string;
  lockHash?: string;
  locked?: StoredLock;
  claimData?: string;
  claimHash?: string;
  claimNonce?: number;
  claimRaw?: string;
  claimSentAt?: number;
  approveHash?: string;
  approveNonce?: number;
  approveRaw?: string;
  approveSentAt?: number;
  burnHash?: string;
  burnNonce?: number;
  burnRaw?: string;
  burnedAt?: number;
  messageId?: string | null;
  unlockHash?: string;
  relayRequestId?: string;
  sourceChain?: string;
  sourcePaid?: string;
  depositHash?: string;
  sourceExplorer?: string | null;
}

export const ACTIVE: ReadonlySet<BridgeStatus> = new Set([
  'locking',
  'waiting',
  'claimable',
  'claiming',
  'approving',
  'burning',
  'swapping',
  'unlocking',
  'blocked',
]);

export const transfersKey = (octAddress: string) => `bridge_transfers:mainnet:${octAddress}`;

export async function loadTransfers(octAddress: string): Promise<BridgeTransfer[]> {
  try {
    const key = transfersKey(octAddress);
    const stored = await chrome.storage.local.get([key]);
    const list = stored?.[key];
    return Array.isArray(list) ? (list as BridgeTransfer[]) : [];
  } catch {
    return [];
  }
}

export async function saveTransfers(octAddress: string, list: BridgeTransfer[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [transfersKey(octAddress)]: list.slice(0, 50) });
  } catch {}
}

export const UNANSWERED = 'unanswered';
export const NOT_FOUND = 'not_found';
const UNANSWERED_GIVE_UP_MS = 15 * 60_000;
export const CLAIM_DROPPED = 'claim_dropped';
export const SENT_GIVE_UP_MS = 10 * 60_000;

export const toLock = (l: StoredLock): LockedEvent => ({ ...l, amountRaw: BigInt(l.amountRaw) });

async function receiptStatus(hash: string): Promise<'success' | 'failed' | null> {
  const r = await rpcCall<{ status?: string; blockNumber?: string } | null>(
    (await ethereumMainnet()).rpcUrl,
    'eth_getTransactionReceipt',
    [hash]
  );
  if (!r) return null;
  return r.status === '0x1' ? 'success' : 'failed';
}

export interface SentTx {
  hash: string;
  from: string;
  nonce?: number;
  raw?: string;
  sentAt: number;
}

/**
 * Where a signed Ethereum tx stands without waiting for it: its receipt, or 'gone' once its nonce
 * was used without it or no node has known it for 10 minutes. A tx the node does not know is
 * sent again with the same signed bytes, which can never spend twice.
 */
export async function sentTxState(s: SentTx): Promise<'success' | 'failed' | 'pending' | 'gone'> {
  const net = await ethereumMainnet();
  const receipt = await receiptStatus(s.hash);
  if (receipt) return receipt;
  const seen = await rpcCall<unknown>(net.rpcUrl, 'eth_getTransactionByHash', [s.hash]).then(
    (tx) => tx !== null,
    () => true
  );
  if (!seen && s.raw) await broadcast(net, s.raw).catch(() => {});
  if (s.nonce !== undefined) {
    const latest = await rpcCall<string>(net.rpcUrl, 'eth_getTransactionCount', [
      s.from,
      'latest',
    ]).then(
      (n): number | null =>
        typeof n === 'string' && /^0x[0-9a-f]+$/i.test(n) ? Number(BigInt(n)) : null,
      (): null => null
    );
    if (latest !== null && latest > s.nonce) return (await receiptStatus(s.hash)) ?? 'gone';
  }
  return !seen && Date.now() - s.sentAt > SENT_GIVE_UP_MS ? 'gone' : 'pending';
}

const NO_CLAIM: Partial<BridgeTransfer> = {
  claimHash: undefined,
  claimNonce: undefined,
  claimRaw: undefined,
  claimSentAt: undefined,
};

export function claimCheckPatch(c: ClaimCheck): Partial<BridgeTransfer> {
  if (c.state === 'claimed') return { ...NO_CLAIM, status: 'done', note: undefined };
  if (c.state === 'claimable') {
    return { ...NO_CLAIM, status: 'claimable', claimData: c.data, note: CLAIM_DROPPED };
  }
  if (c.state === 'waiting') return { ...NO_CLAIM, status: 'waiting', note: undefined };
  return { ...NO_CLAIM, status: 'blocked', note: c.reason };
}

async function claimStateNow(t: BridgeTransfer): Promise<Partial<BridgeTransfer> | null> {
  if (!t.locked) return null;
  return claimCheckPatch(await claimCheck(toLock(t.locked), t.evmAddress || t.locked.ethAddress));
}

export async function advance(t: BridgeTransfer): Promise<Partial<BridgeTransfer> | null> {
  switch (t.status) {
    case 'locking': {
      const unanswered = t.note === UNANSWERED;
      if (!t.lockHash && !unanswered) return null;
      const p = await lockProgress(
        t.lockHash ?? null,
        t.octAddress,
        t.createdAt,
        unanswered ? BigInt(t.amountRaw) : undefined
      );
      if (p.state === 'pending') {
        if (!p.hash && Date.now() - t.createdAt > UNANSWERED_GIVE_UP_MS) {
          return { status: 'failed', note: NOT_FOUND };
        }
        return p.hash && p.hash !== t.lockHash ? { lockHash: p.hash, note: undefined } : null;
      }
      if (p.state === 'failed') return { status: 'failed', note: p.reason, lockHash: p.hash };
      const { locked } = p;
      return {
        status: 'waiting',
        lockHash: locked.hash,
        note: undefined,
        locked: { ...locked, amountRaw: locked.amountRaw.toString() },
      };
    }
    case 'waiting':
    case 'claimable':
    case 'blocked': {
      if (!t.locked) return null;
      const c = await claimCheck(toLock(t.locked), t.evmAddress || t.locked.ethAddress);
      if (c.state === 'claimable') {
        return t.status === 'claimable' && t.claimData === c.data
          ? null
          : { status: 'claimable', claimData: c.data, note: undefined };
      }
      if (c.state === 'claimed') return { status: 'done' };
      if (c.state === 'waiting') return t.status === 'waiting' ? null : { status: 'waiting' };
      return { status: 'blocked', note: c.reason };
    }
    case 'claiming': {
      if (!t.claimHash || !t.evmAddress) return claimStateNow(t);
      const s = await sentTxState({
        hash: t.claimHash,
        from: t.evmAddress,
        nonce: t.claimNonce,
        raw: t.claimRaw,
        sentAt: t.claimSentAt ?? t.updatedAt,
      });
      if (s === 'success') return { status: 'done', claimRaw: undefined };
      if (s === 'failed') return { status: 'claimable', note: 'claim_failed', claimRaw: undefined };
      if (s === 'gone') return claimStateNow(t);
      return null;
    }
    case 'approving': {
      if (!t.approveHash) return null;
      const s = await sentTxState({
        hash: t.approveHash,
        from: t.evmAddress,
        nonce: t.approveNonce,
        raw: t.approveRaw,
        sentAt: t.approveSentAt ?? t.createdAt,
      });
      if (s === 'success') return { status: 'ready_to_burn', approveRaw: undefined };
      if (s === 'failed')
        return { status: 'failed', note: 'approve_failed', approveRaw: undefined };
      if (s === 'pending') return null;
      return (await wOctAllowance(t.evmAddress)) >= BigInt(t.amountRaw)
        ? { status: 'ready_to_burn', approveRaw: undefined }
        : { status: 'failed', note: 'approve_dropped', approveRaw: undefined };
    }
    case 'burning': {
      if (!t.burnHash) return null;
      const s = await sentTxState({
        hash: t.burnHash,
        from: t.evmAddress,
        nonce: t.burnNonce,
        raw: t.burnRaw,
        sentAt: t.burnedAt ?? t.createdAt,
      });
      if (s === 'failed') return { status: 'failed', note: 'burn_failed', burnRaw: undefined };
      if (s !== 'success') return null;
      return {
        status: 'unlocking',
        burnRaw: undefined,
        messageId: await burnMessageId(t.burnHash),
      };
    }
    case 'swapping': {
      if (!t.relayRequestId) return null;
      const st = await fetchStatus(t.relayRequestId);
      if (st.status === 'refund') return { status: 'failed', note: 'refund' };
      if (st.status === 'failure')
        return { status: 'failed', note: st.failReason || 'relay_failed' };
      if (st.status !== 'success') return null;
      const fill =
        st.txHashes?.[st.txHashes.length - 1] ?? st.inTxHashes?.[st.inTxHashes.length - 1];
      const messageId = fill ? await burnMessageId(fill).catch((): null => null) : null;
      return { status: 'unlocking', burnHash: fill, burnedAt: Date.now(), messageId };
    }
    case 'unlocking': {
      const hash = await findUnlock({
        messageId: t.messageId ?? null,
        recipient: t.recipient,
        amountRaw: BigInt(t.amountRaw),
        burnedAtMs: t.burnedAt ?? t.createdAt,
      });
      return hash ? { status: 'done', unlockHash: hash } : null;
    }
    default:
      return null;
  }
}
