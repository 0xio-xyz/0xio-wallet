import { logger } from '../../utils/logger';
import { bytesToBase64 } from 'src/lib/encoding';
import { walletStorage } from 'src/services/wallet/WalletStorage';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import { DAPP_CONNECTION_EXPIRY_MS } from '../constants';
import { approvalQueue } from './approvals';
import { getActiveWallet } from './wallet';
import { canSignAddress, keyRefusal, walletCanSign } from './signingKey';

export const dappConnections = new Map();

export interface DappPvacKey {
  ok: boolean;
  wallet?: { address: string; id: string };
  privateKey?: string;
  error?: { code: string; message: string };
}

/**
 * Resolves the active wallet's private key for a connected dapp's PVAC return-primitive.
 * Requires a wallet, an approved origin connection carrying the right permission, and an
 * unlocked extension. These read/compute ops never move funds or reveal keys (only
 * ciphertexts, proofs, and decrypted views), so they run without a popup. The private key
 * stays in the background; the dapp only ever sees its outputs.
 */
export async function resolveDappPvacKey(
  sender: chrome.runtime.MessageSender,
  requiredPermission: string
): Promise<DappPvacKey> {
  const wallet = await getActiveWallet();
  if (!wallet) {
    return { ok: false, error: { code: 'WALLET_LOCKED', message: 'No active wallet found.' } };
  }
  const origin = sender.origin || sender.url || '';
  const conn = dappConnections.get(origin);
  if (!conn) {
    return { ok: false, error: { code: 'NOT_CONNECTED', message: 'Origin is not connected.' } };
  }
  // Private reads run on the open wallet only, and only for a site that sits on it.
  if (conn.address && conn.address !== wallet.address) {
    return {
      ok: false,
      error: {
        code: 'WALLET_CHANGED',
        message: 'This site is on another wallet. Send the request again.',
      },
    };
  }
  if (!conn.permissions?.includes(requiredPermission)) {
    return {
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: `${requiredPermission} permission required.` },
    };
  }
  const sessionKey = await passwordManager.getSessionKey();
  if (!sessionKey) {
    return {
      ok: false,
      error: { code: 'WALLET_LOCKED', message: 'Wallet is locked - unlock the 0xio extension.' },
    };
  }
  const allWallets = await walletStorage.loadVault(sessionKey);
  const unlocked = allWallets.find((w: any) => w.address === wallet.address || w.id === wallet.id);
  if (!walletCanSign(unlocked)) {
    return {
      ok: false,
      error: keyRefusal(unlocked, { code: 'WALLET_LOCKED', message: 'Private key not available.' }),
    };
  }
  return {
    ok: true,
    wallet: { address: unlocked.address, id: unlocked.id },
    privateKey: unlocked.privateKey,
  };
}

export function dappRawInt(params: any): number {
  const v = params?.value_raw ?? params?.value ?? params?.amount_raw ?? params?.amount;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0)
    throw new Error('Invalid value: expected a non-negative integer');
  return n;
}

function safeBase64Encode(str: string) {
  try {
    return bytesToBase64(new TextEncoder().encode(str))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch (error) {
    logger.error('Error encoding origin:', error);
    return encodeURIComponent(str).replace(/[^a-zA-Z0-9]/g, '_');
  }
}

export function connectionKey(origin: string): string {
  return `dapp_connection_${safeBase64Encode(origin)}`;
}

export async function persistDAppConnection(
  origin: string,
  connectionData: Record<string, unknown>
) {
  try {
    const key = connectionKey(origin);
    await chrome.storage.local.set({ [key]: connectionData });
  } catch (error) {
    logger.error('Error persisting connection:', error);
  }
}

export async function loadDAppConnection(origin: string) {
  try {
    const key = connectionKey(origin);
    const result = await chrome.storage.local.get(key);
    const connection = result[key] || null;

    if (connection && connection.connectedAt) {
      const connectionAge = Date.now() - connection.connectedAt;
      if (connectionAge > DAPP_CONNECTION_EXPIRY_MS) {
        logger.debug(`[Background] DApp connection expired for ${origin}`);
        await removeDAppConnection(origin);
        dappConnections.delete(origin);
        return null;
      }
    }

    return connection;
  } catch (error) {
    logger.error('Error loading connection:', error);
    return null;
  }
}

export async function getConnection(origin: string) {
  let conn = dappConnections.get(origin);
  if (!conn) {
    const persisted = await loadDAppConnection(origin);
    if (persisted?.connected) {
      dappConnections.set(origin, persisted);
      conn = persisted;
    }
  }
  return conn?.connected ? conn : null;
}

export async function moveConnections(
  origins: string[],
  wallet: { address: string; publicKey?: string | null }
): Promise<void> {
  for (const origin of origins) {
    const conn = await getConnection(origin);
    if (!conn) continue;
    conn.address = wallet.address;
    conn.publicKey = wallet.publicKey;
    dappConnections.set(origin, conn);
    await persistDAppConnection(origin, conn);
    void sendEventToOrigins([origin], {
      type: 'accountChanged',
      data: {
        address: wallet.address,
        publicKey: wallet.publicKey,
        canSign: await canSignAddress(wallet.address, wallet.publicKey),
      },
    });
  }
}

export async function clearAllDAppConnections() {
  try {
    const storage = (await chrome.storage.local.get(null)) as unknown as Record<string, any>;
    const connectionKeys = Object.keys(storage).filter((key) => key.startsWith('dapp_connection_'));

    if (connectionKeys.length > 0) {
      await chrome.storage.local.remove(connectionKeys);
      logger.debug(`[Background] Cleared ${connectionKeys.length} DApp connections on wallet lock`);
    }

    dappConnections.clear();
  } catch (error) {
    logger.error('Error clearing DApp connections:', error);
  }
}

export async function checkExpiredDAppConnections() {
  try {
    const storage = (await chrome.storage.local.get(null)) as unknown as Record<string, any>;
    const expiredKeys: string[] = [];

    for (const [key, value] of Object.entries(storage)) {
      if (key.startsWith('dapp_connection_') && value.connectedAt) {
        const connectionAge = Date.now() - value.connectedAt;
        if (connectionAge > DAPP_CONNECTION_EXPIRY_MS) {
          expiredKeys.push(key);
          if (value.origin) {
            dappConnections.delete(value.origin);
          }
        }
      }
    }

    if (expiredKeys.length > 0) {
      await chrome.storage.local.remove(expiredKeys);
      logger.debug(`[Background] Removed ${expiredKeys.length} expired DApp connections`);
    }
  } catch (error) {
    logger.error('Error checking expired connections:', error);
  }
}

export async function removeDAppConnection(origin: string) {
  try {
    const key = connectionKey(origin);
    await chrome.storage.local.remove(key);
  } catch (error) {
    logger.error('Error removing connection:', error);
  }
}

/**
 * Tabs and frames each site's Octra requests came from. Without the "tabs" permission a tab's URL
 * is hidden for most sites, so events are sent to the frames that talked to us, kept per session.
 */
const OCTRA_FRAMES_KEY = 'octra_site_frames';

async function loadOctraFrames(): Promise<Record<string, string[]>> {
  try {
    const stored = await chrome.storage.session.get(OCTRA_FRAMES_KEY);
    const v = stored?.[OCTRA_FRAMES_KEY];
    return v && typeof v === 'object' ? (v as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

export async function markOctraOrigin(sender: chrome.runtime.MessageSender): Promise<void> {
  const tabId = sender.tab?.id;
  const raw = sender.origin ?? sender.url;
  if (typeof tabId !== 'number' || !raw) return;
  let origin = '';
  try {
    origin = new URL(raw).origin;
  } catch {
    return;
  }
  if (!/^https?:/.test(origin)) return;
  const all = await loadOctraFrames();
  const id = `${tabId}:${sender.frameId ?? 0}`;
  const list = all[origin] ?? [];
  if (list.includes(id)) return;
  all[origin] = [...list, id].slice(-20);
  await chrome.storage.session.set({ [OCTRA_FRAMES_KEY]: all }).catch(() => {});
}

const originOf = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const o = new URL(raw).origin;
    return /^https?:/.test(o) ? o : null;
  } catch {
    return null;
  }
};

/**
 * Deliver a wallet event to the pages of the given origins: the frames that sent us Octra
 * requests, plus `frames` ("tabId:frameId"), plus any tab whose URL the browser shows. Matching
 * is on the full origin (scheme, host, port), never the hostname alone. Each message names its
 * origin and the content script drops one that is not its own, so a tab that navigated away
 * hears nothing.
 */
export function sendEventToOrigins(
  origins: Iterable<string>,
  eventData: unknown,
  frames: string[] = []
): Promise<void> {
  const wanted = new Set<string>();
  for (const o of origins) {
    const origin = originOf(o);
    if (origin) wanted.add(origin);
  }
  if (wanted.size === 0) return Promise.resolve();
  return loadOctraFrames().then(async (all) => {
    let changed = false;
    const reached = new Set<string>();
    for (const origin of wanted) {
      const known = all[origin] ?? [];
      for (const id of new Set([...known, ...frames])) {
        const [tabId, frameId] = id.split(':').map(Number);
        if (!Number.isInteger(tabId)) continue;
        try {
          await chrome.tabs.sendMessage(
            tabId,
            { type: 'WALLET_EVENT', origin, eventData },
            { frameId: frameId || 0 }
          );
          reached.add(`${tabId}`);
        } catch {
          if (!known.includes(id)) continue;
          all[origin] = (all[origin] ?? []).filter((f) => f !== id);
          if (!all[origin].length) delete all[origin];
          changed = true;
        }
      }
    }
    if (changed) await chrome.storage.session.set({ [OCTRA_FRAMES_KEY]: all }).catch(() => {});
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs ?? []) {
        const origin = originOf(tab.url);
        if (!tab.id || !origin || !wanted.has(origin) || reached.has(`${tab.id}`)) continue;
        chrome.tabs
          .sendMessage(tab.id, { type: 'WALLET_EVENT', origin, eventData })
          .catch(() => {});
      }
    });
  });
}

export async function connectedOrigins(address?: string): Promise<string[]> {
  const sites = new Map<string, any>();
  for (const [origin, conn] of dappConnections) sites.set(origin, conn);
  try {
    const stored = (await chrome.storage.local.get(null)) as unknown as Record<string, any>;
    for (const [key, value] of Object.entries(stored ?? {})) {
      if (!key.startsWith('dapp_connection_') || !value?.origin || sites.has(value.origin))
        continue;
      if (value.connectedAt && Date.now() - value.connectedAt > DAPP_CONNECTION_EXPIRY_MS) continue;
      sites.set(value.origin, value);
    }
  } catch {}
  const out: string[] = [];
  for (const [origin, conn] of sites) {
    if (!conn?.connected) continue;
    if (address !== undefined && conn.address !== address) continue;
    out.push(origin);
  }
  return out;
}

export async function sendEventToConnected(eventData: unknown, address?: string): Promise<void> {
  await sendEventToOrigins(await connectedOrigins(address), eventData);
}

/**
 * A queued transaction's outcome, for the site that asked for it and nobody else: only while
 * that site is still connected and still on the wallet that signed it. A tx made in the
 * popup has no origin and tells no page anything.
 */
export async function sendTxEvent(
  tx: { origin?: string; tabId?: number; frameId?: number; signer?: string },
  eventData: unknown
): Promise<void> {
  if (!tx.origin || !tx.signer) return;
  const conn = await getConnection(tx.origin);
  if (!conn) return;
  const siteWallet = conn.address || (await getActiveWallet())?.address;
  if (siteWallet !== tx.signer) return;
  const frames = typeof tx.tabId === 'number' ? [`${tx.tabId}:${tx.frameId ?? 0}`] : [];
  await sendEventToOrigins([tx.origin], eventData, frames);
}

export async function showConnectionApproval(dappInfo: Record<string, unknown>) {
  return await approvalQueue.add(dappInfo);
}
