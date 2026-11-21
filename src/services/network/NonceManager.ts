import type { NetworkService } from './NetworkService';
import type { NetworkPin, TxScope } from './txScope';
import { logger } from 'src/utils/logger';

const LOCAL_NONCE_MS = 120_000;

export const MAX_PENDING_GAP = 32;

const usedKey = (networkId: string, address: string) => `nonce_used_${networkId}:${address}`;

export async function noteNonceUsed(
  networkId: string,
  address: string,
  nonce: number
): Promise<void> {
  if (!Number.isInteger(nonce) || nonce < 0) return;
  try {
    const key = usedKey(networkId, address);
    const prior = (await chrome.storage.session.get(key))?.[key];
    const floor = prior && Date.now() - prior.ts < LOCAL_NONCE_MS ? prior.nonce : -1;
    await chrome.storage.session.set({ [key]: { nonce: Math.max(floor, nonce), ts: Date.now() } });
  } catch (e) {
    logger.warn('[nonce] could not note a used nonce', e);
  }
}

async function usedNonce(networkId: string, address: string): Promise<number> {
  try {
    const key = usedKey(networkId, address);
    const hit = (await chrome.storage.session.get(key))?.[key];
    return hit && Date.now() - hit.ts < LOCAL_NONCE_MS && Number.isInteger(hit.nonce)
      ? hit.nonce
      : -1;
  } catch {
    return -1;
  }
}

export class NonceManager {
  private _ns: NetworkService;
  // Prevents consecutive TXs from reusing nonces when the server
  // hasn't updated its confirmed nonce yet (staging pool lag). Keyed `${networkId}:${address}`.
  private _localNonces: Map<string, { nonce: number; ts: number }> = new Map();

  constructor(networkService: NetworkService) {
    this._ns = networkService;
  }

  async getNextNonce(address: string, at?: NetworkPin): Promise<number> {
    return this._reserve(address, at, 1);
  }

  async reserveRange(scope: TxScope, count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1) throw new Error('Invalid nonce count');
    return this._reserve(scope.address, scope, count);
  }

  private async _reserve(address: string, at: NetworkPin | undefined, count: number) {
    const pin = at ?? (await this._ns.resolveNetwork());
    const key = `${pin.networkId}:${address}`;
    // RPC nonce = last confirmed (already used). Next expected = nonce + 1.
    const balanceData = await this._ns.getBalance(address, true, pin);

    if (balanceData.nonce === null || balanceData.nonce === undefined) {
      logger.warn('[getNextNonce] Network nonce unavailable');
    }
    let confirmedNonce = balanceData.nonce != null ? balanceData.nonce : -1;
    let base = confirmedNonce;
    if (confirmedNonce !== -1) base = await this._pendingBase(address, pin, balanceData);

    if (confirmedNonce === -1) {
      const lastKnown = this._ns.getCachedNonce(address, pin.rpcUrl);
      if (lastKnown != null) {
        logger.warn(`[getNextNonce] network unreachable - using last-known nonce ${lastKnown}`);
        confirmedNonce = lastKnown;
      } else {
        const probed = await this._ns.probeNonce(address, pin);
        if (probed != null) {
          logger.warn(
            `[getNextNonce] forced refresh failed but re-probe recovered nonce ${probed}`
          );
          confirmedNonce = probed;
        } else {
          throw new Error('Unable to determine nonce: Network unreachable.');
        }
      }
      base = confirmedNonce;
    }

    let nextNonce = Math.max(base, await usedNonce(pin.networkId, address)) + 1;

    // Local tracking: take the max of (server nonce + 1) vs (last locally used + 1)
    // to prevent collisions when firing multiple txs before the server updates.
    const local = this._localNonces.get(key);
    const localNonceVal = local && Date.now() - local.ts < LOCAL_NONCE_MS ? local.nonce : -1;
    if (localNonceVal >= 0) nextNonce = Math.max(nextNonce, localNonceVal + 1);
    this._localNonces.set(key, { nonce: nextNonce + count - 1, ts: Date.now() });

    logger.debug(
      `[getNextNonce] ${pin.networkId} ${address.slice(0, 8)}… confirmed=${confirmedNonce} base=${base} local=${localNonceVal} -> ${nextNonce}${count > 1 ? ` (+${count - 1})` : ''}`
    );
    return nextNonce;
  }

  /**
   * The webcli's next-nonce base: the node's pending_nonce when it gives one (never below the
   * confirmed nonce), else the confirmed nonce raised to this address's highest staged nonce.
   */
  private async _pendingBase(
    address: string,
    pin: NetworkPin,
    balance: { nonce: number | null; pendingNonce?: number | null }
  ): Promise<number> {
    const confirmed = balance.nonce ?? 0;
    if (balance.pendingNonce === null) throw new Error('Invalid pending nonce from the node');
    let pending: number;
    if (balance.pendingNonce !== undefined) {
      if (balance.pendingNonce < confirmed) {
        throw new Error('Pending nonce precedes the confirmed nonce');
      }
      pending = balance.pendingNonce;
    } else {
      pending = Math.max(confirmed, await this._ns.stagingNonce(address, pin));
    }
    // A node reporting a far pending nonce would park the signed tx behind a gap it never fills.
    if (pending - confirmed > MAX_PENDING_GAP) {
      throw new Error('Too many pending transactions. Wait for them to confirm.');
    }
    return pending;
  }

  /** A definitive rejection never reached the mempool, so the nonce it reserved is free again. */
  release(address: string, nonce: number, networkId: string): void {
    this.releaseRange(address, nonce, 1, networkId);
  }

  releaseRange(address: string, first: number, count: number, networkId: string): void {
    if (!Number.isInteger(count) || count < 1) return;
    const key = `${networkId}:${address}`;
    const local = this._localNonces.get(key);
    if (!local || local.nonce !== first + count - 1) return;
    if (first - 1 >= 0) this._localNonces.set(key, { nonce: first - 1, ts: local.ts });
    else this._localNonces.delete(key);
  }
}
