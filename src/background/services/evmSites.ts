import { ZeroXIOConfig } from '../../utils/config';
import { logger } from '../../utils/logger';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import { walletStorage } from 'src/services/wallet/WalletStorage';
import { evmMetaOf, evmSourceOf, isEvmOn, type EvmSource } from '../../services/evm/walletEvm';
import {
  followOpen,
  readSite,
  siteWalletIds,
  withWallet,
  withoutWallets,
  type EvmSide,
  type EvmSite,
  type EvmSiteAccount,
  type EvmSites,
  type UsableWallet,
} from '../../services/evm/siteModel';
import { allNetworks } from '../../services/evm/registry';
import { evmNetworksFor, type EvmNetwork } from '../../services/evm/networks';

export const EVM_SITES_KEY = 'evm_sites';

export type { EvmSide, EvmSite, EvmSiteAccount, EvmSites };

export interface EvmWalletRef {
  walletId: string;
  walletName: string;
  address: string;
  octraAddress: string;
  source: EvmSource;
}

export type EvmVault =
  | { status: 'locked' }
  | {
      status: 'ok';
      open: {
        walletId: string;
        walletName: string;
        octraAddress: string;
        evm: EvmWalletRef | null;
      };
      evm: Map<string, EvmWalletRef>;
      ids: Set<string>;
    };

export type OpenVault = Extract<EvmVault, { status: 'ok' }>;

const DEFAULT_CHAIN: Record<EvmSide, number> = { mainnet: 1, testnet: 11155111 };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export async function loadEvmSites(): Promise<EvmSites> {
  try {
    const stored = await chrome.storage.local.get(EVM_SITES_KEY);
    const raw = stored?.[EVM_SITES_KEY];
    if (!isRecord(raw)) return {};
    const out: EvmSites = {};
    for (const [origin, site] of Object.entries(raw)) {
      const read = readSite(origin, site);
      if (read) out[origin] = read;
    }
    return out;
  } catch {
    return {};
  }
}

let writes: Promise<unknown> = Promise.resolve();

/** One writer at a time, so two requests never drop each other's change. */
function mutate<T>(fn: (sites: EvmSites) => T): Promise<T> {
  const run = writes.then(async () => {
    const sites = await loadEvmSites();
    const out = fn(sites);
    for (const [origin, site] of Object.entries(sites)) {
      if (!Object.keys(site.accounts).length && !Object.keys(site.chains).length) {
        delete sites[origin];
      }
    }
    await chrome.storage.local.set({ [EVM_SITES_KEY]: sites });
    return out;
  });
  writes = run.catch(() => {});
  return run;
}

const blank = (origin: string): EvmSite => ({ origin, chains: {}, accounts: {} });

export async function currentSide(): Promise<EvmSide> {
  const key = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;
  const stored = await chrome.storage.local.get(key);
  return stored?.[key] === 'devnet' ? 'testnet' : 'mainnet';
}

export async function siteChainId(origin: string, sites?: EvmSites): Promise<number> {
  const side = await currentSide();
  const all = sites ?? (await loadEvmSites());
  return all[origin]?.chains[side] ?? DEFAULT_CHAIN[side];
}

export async function siteNetwork(origin: string): Promise<EvmNetwork> {
  const chainId = await siteChainId(origin);
  const known = (await allNetworks()).find((n) => n.chainId === chainId);
  if (known) return known;
  const side = await currentSide();
  return evmNetworksFor(side === 'testnet' ? 'devnet' : 'mainnet')[0];
}

export async function setSiteChain(origin: string, chainId: number): Promise<void> {
  const side = await currentSide();
  await mutate((sites) => {
    const site = sites[origin] ?? blank(origin);
    site.chains[side] = chainId;
    sites[origin] = site;
  });
}

export async function connectEvmSite(
  origin: string,
  walletId: string,
  address: string,
  openId: string | null = null
): Promise<void> {
  await mutate((sites) => {
    sites[origin] = withWallet(sites[origin] ?? blank(origin), walletId, address, openId);
  });
}

export async function setEvmSiteWallet(
  origin: string,
  walletId: string,
  openId: string | null
): Promise<boolean> {
  return mutate((sites) => {
    const site = sites[origin];
    if (!site?.accounts[walletId]) return false;
    site.inUse = walletId;
    if (openId) site.seenOpen = openId;
    return true;
  });
}

export async function disconnectEvmSite(origin: string, walletId?: string): Promise<void> {
  await mutate((sites) => {
    const site = sites[origin];
    if (!site) return;
    sites[origin] = withoutWallets(site, (id) => !walletId || id === walletId);
  });
}

export async function evmVault(): Promise<EvmVault> {
  try {
    const sessionKey = await passwordManager.getSessionKey();
    if (!sessionKey) return { status: 'locked' };
    const { activeWalletId, [ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET]: activeAddress } =
      await chrome.storage.local.get(['activeWalletId', ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET]);
    const wallets = await walletStorage.loadVault(sessionKey);
    const wallet =
      wallets.find((w) => w.id === activeWalletId) ??
      wallets.find((w) => w.address === activeAddress);
    if (!wallet) return { status: 'locked' };
    const evm = new Map<string, EvmWalletRef>();
    for (const w of wallets) {
      const meta = evmMetaOf(w);
      const source = evmSourceOf(w, wallets);
      if (!meta || !source || !isEvmOn(w, wallets)) continue;
      evm.set(w.id, {
        walletId: w.id,
        walletName: w.name || 'Wallet',
        address: meta.address,
        octraAddress: w.address,
        source,
      });
    }
    return {
      status: 'ok',
      open: {
        walletId: wallet.id,
        walletName: wallet.name || 'Wallet',
        octraAddress: wallet.address,
        evm: evm.get(wallet.id) ?? null,
      },
      evm,
      ids: new Set(wallets.map((w) => w.id)),
    };
  } catch (e) {
    logger.warn('[EVM sites] reading the vault failed', e);
    return { status: 'locked' };
  }
}

export const usableIn =
  (vault: OpenVault): UsableWallet =>
  (walletId, address) =>
    vault.evm.get(walletId)?.address.toLowerCase() === address.toLowerCase();

export function siteAccounts(origin: string, sites: EvmSites, vault: EvmVault): EvmWalletRef[] {
  if (vault.status !== 'ok') return [];
  return siteWalletIds(sites[origin], vault.open.walletId, usableIn(vault)).map(
    (id) => vault.evm.get(id)!
  );
}

/** What eth_accounts answers: only the wallet the site uses, so a site never links the others. */
export function accountsFor(origin: string, sites: EvmSites, vault: EvmVault): string[] {
  return siteAccounts(origin, sites, vault)
    .slice(0, 1)
    .map((w) => w.address.toLowerCase());
}

export async function syncEvmSites(vault?: EvmVault): Promise<string[]> {
  const v = vault ?? (await evmVault());
  if (v.status !== 'ok' || !v.ids.size) return [];
  const stored = await loadEvmSites();
  const stale = Object.values(stored).some(
    (site) =>
      site.seenOpen !== v.open.walletId || Object.keys(site.accounts).some((id) => !v.ids.has(id))
  );
  if (!stale) return [];
  return mutate((sites) => {
    const changed: string[] = [];
    for (const [origin, site] of Object.entries(sites)) {
      const pruned = withoutWallets(site, (id) => !v.ids.has(id));
      const next = followOpen(pruned, v.open.walletId, usableIn(v));
      if (
        next.inUse !== site.inUse ||
        next.seenOpen !== site.seenOpen ||
        Object.keys(next.accounts).length !== Object.keys(site.accounts).length
      ) {
        sites[origin] = next;
        changed.push(origin);
      }
    }
    return changed;
  });
}

export function recentEvmWallet(sites: EvmSites, vault: OpenVault): EvmWalletRef | null {
  let best: { id: string; at: number } | null = null;
  for (const site of Object.values(sites)) {
    for (const [id, a] of Object.entries(site.accounts)) {
      if (!usableIn(vault)(id, a.address)) continue;
      if (!best || a.connectedAt > best.at) best = { id, at: a.connectedAt };
    }
  }
  return (best && vault.evm.get(best.id)) ?? vault.evm.values().next().value ?? null;
}

export const toHexChain = (chainId: number): string => '0x' + chainId.toString(16);

/**
 * The frames that used window.ethereum, by origin. Pushes go to these frames directly: reading a
 * tab's URL needs a permission 0xio does not ask for. Kept in session storage so a worker restart
 * still reaches them.
 */
const FRAMES_KEY = 'evm_site_frames';
let frames: Record<string, string[]> | null = null;

async function loadFrames(): Promise<Record<string, string[]>> {
  if (frames) return frames;
  try {
    const stored = await chrome.storage.session.get(FRAMES_KEY);
    frames = isRecord(stored?.[FRAMES_KEY]) ? (stored[FRAMES_KEY] as Record<string, string[]>) : {};
  } catch {
    frames = {};
  }
  return frames;
}

export async function markEvmOrigin(origin: string, tabId?: number, frameId?: number) {
  if (typeof tabId !== 'number') return;
  const all = await loadFrames();
  const id = `${tabId}:${frameId ?? 0}`;
  const list = all[origin] ?? [];
  if (list.includes(id)) return;
  all[origin] = [...list, id].slice(-20);
  await chrome.storage.session.set({ [FRAMES_KEY]: all }).catch(() => {});
}

async function postToOrigins(payloads: Map<string, unknown>): Promise<void> {
  const all = await loadFrames();
  let changed = false;
  await Promise.all(
    [...payloads].flatMap(([origin, data]) =>
      (all[origin] ?? []).map(async (id) => {
        const [tabId, frameId] = id.split(':').map(Number);
        try {
          await chrome.tabs.sendMessage(tabId, { type: 'EVM_EVENT', data }, { frameId });
        } catch {
          all[origin] = (all[origin] ?? []).filter((f) => f !== id);
          if (!all[origin].length) delete all[origin];
          changed = true;
        }
      })
    )
  );
  if (changed) await chrome.storage.session.set({ [FRAMES_KEY]: all }).catch(() => {});
}

export async function pushEvmState(origins?: Iterable<string>): Promise<void> {
  const sites = await loadEvmSites();
  const targets = new Set(origins ?? Object.keys(await loadFrames()));
  if (!targets.size) return;
  const vault = await evmVault();
  const payloads = new Map<string, unknown>();
  for (const origin of targets) {
    const chainId = await siteChainId(origin, sites);
    payloads.set(origin, {
      origin,
      accounts: accountsFor(origin, sites, vault),
      chainId: toHexChain(chainId),
    });
  }
  await postToOrigins(payloads);
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function initEvmSiteEvents(): void {
  const watched = new Set([
    'activeWalletId',
    ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET,
    ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK,
    'vault',
  ]);
  chrome.storage.onChanged.addListener((changes, area) => {
    const relevant =
      (area === 'local' && Object.keys(changes).some((k) => watched.has(k))) ||
      (area === 'session' && 'wallet_unlocked' in changes);
    if (!relevant) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      syncEvmSites()
        .catch((): string[] => [])
        .then(() => pushEvmState())
        .catch(() => {});
    }, 200);
  });
}
