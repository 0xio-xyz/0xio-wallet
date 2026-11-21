import { isCustomNetworkId, resolveCustomNetwork } from '../../utils/config';
import { logger } from '../../utils/logger';
import { rpcUrlFor } from 'src/services/network/txScope';
import { rpcFetch } from 'src/services/network/rpcExchange';
import {
  CONFIRMED_MARKER_TTL_MS,
  isConfirmedMarker,
  isDeadStatus,
} from 'src/services/wallet/historyRows';

const FAILED_RECORD_TTL_MS = 30 * 60 * 1000;
const UNCONFIRMED_TTL_MS = 6 * 60 * 60 * 1000;
const BUILT_INS = ['mainnet', 'devnet'];

type Rpc = (method: string, params: unknown[]) => Promise<any>;

async function rpcFor(networkId: string): Promise<Rpc | null> {
  if (isCustomNetworkId(networkId) && !(await resolveCustomNetwork(networkId))) return null;
  const base = await rpcUrlFor(networkId);
  return async (method, params) => {
    const response = await rpcFetch(
      `${base}/rpc`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      },
      { lane: 'poll' }
    );
    if (!response.ok) return null;
    const json = await response.json();
    return json?.result ?? null;
  };
}

export async function checkPendingTransactionsConfirmation(): Promise<void> {
  try {
    const storage = (await chrome.storage.local.get(null)) as unknown as Record<string, any>;
    const pendingTxs = Object.keys(storage)
      .filter((key) => key.startsWith('pending_tx_'))
      .map((key) => ({ key, tx: storage[key] }))
      .filter(({ tx }) => tx && tx.from);
    if (pendingTxs.length === 0) return;

    const rpcs = new Map<string, Promise<Rpc | null>>();
    const rpcOf = (net: string) => {
      if (!rpcs.has(net))
        rpcs.set(
          net,
          rpcFor(net).catch((): null => null)
        );
      return rpcs.get(net)!;
    };
    const nonces = new Map<string, Promise<number | null>>();
    const accountNonce = (net: string, address: string) => {
      const key = `${net}:${address.toLowerCase()}`;
      if (!nonces.has(key)) {
        nonces.set(
          key,
          (async () => {
            const rpc = await rpcOf(net);
            if (!rpc) return null;
            const bal = await rpc('octra_balance', [address]).catch((): null => null);
            const n = Number(bal?.nonce);
            return Number.isFinite(n) ? n : null;
          })()
        );
      }
      return nonces.get(key)!;
    };
    const statusOn = async (net: string, hash: string): Promise<string> => {
      const rpc = await rpcOf(net);
      if (!rpc) return '';
      try {
        const detail = await rpc('octra_transaction', [hash]);
        return String(detail?.status ?? '').toLowerCase();
      } catch {
        return '';
      }
    };

    const keysToRemove: string[] = [];
    const now = Date.now();

    for (const { key, tx } of pendingTxs) {
      if (isConfirmedMarker(tx)) {
        if (now - (tx.confirmedAt || tx.timestamp || 0) > CONFIRMED_MARKER_TTL_MS) {
          keysToRemove.push(key);
        }
        continue;
      }
      if (tx.status === 'failed') {
        if (now - (tx.failedAt || tx.timestamp || 0) > FAILED_RECORD_TTL_MS) keysToRemove.push(key);
        continue;
      }

      const nets: string[] = tx.network ? [tx.network] : BUILT_INS;

      let status = '';
      if (tx.hash) {
        for (const net of nets) {
          status = await statusOn(net, tx.hash);
          if (status) break;
        }
      }
      if (status === 'confirmed') {
        await chrome.storage.local
          .set({
            [key]: { ...tx, status: 'success', confirmed: true, pending: false, confirmedAt: now },
          })
          .catch(() => {});
        continue;
      }
      if (isDeadStatus(status)) {
        await chrome.storage.local
          .set({
            [key]: {
              ...tx,
              status: 'failed',
              error: 'Dropped by the network (expired or replaced)',
              failedAt: now,
              pending: false,
            },
          })
          .catch(() => {});
        continue;
      }

      // The account's confirmed nonce on this network moved past this tx's nonce while its own
      // hash is not confirmed: a different tx consumed it. The one that confirmed shows from
      // the chain.
      if (tx.network && tx.nonce !== undefined) {
        const n = await accountNonce(tx.network, tx.from);
        if (n !== null && Number(tx.nonce) <= n) {
          keysToRemove.push(key);
          continue;
        }
      }

      if (now - (tx.timestamp || 0) > UNCONFIRMED_TTL_MS) {
        await chrome.storage.local
          .set({
            [key]: {
              ...tx,
              status: 'failed',
              error: 'Not confirmed after 6 hours',
              failedAt: now,
              pending: false,
            },
          })
          .catch(() => {});
      }
    }

    if (keysToRemove.length > 0) {
      logger.debug(`[Background] Removing ${keysToRemove.length} settled pending records`);
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch (error) {
    logger.error('[Background] Error checking pending tx confirmation:', error);
  }
}
