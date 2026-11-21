// Octra transactions carry no chain id: a tx signed for one network is valid on another when the
// nonce fits. Every signing flow binds itself to one {network, rpc, wallet} scope up front and
// refuses to submit once the wallet has moved, instead of quietly re-targeting.

import {
  ZeroXIOConfig,
  isCustomNetworkId,
  resolveCustomNetwork,
  type NetworkId,
} from 'src/utils/config';

export interface NetworkPin {
  networkId: NetworkId;
  rpcUrl: string;
}

export interface TxScope extends NetworkPin {
  address: string;
  /**
   * A site's request signs with the wallet the site is bound to, which need not be the active
   * one. Its scope names the site's connection record instead: the tx stands while that record
   * still points at `address`, whatever wallet is open.
   */
  siteKey?: string;
}

/** errorType of a refusal: the tx never reached a node, so its nonce and claim slot are free. */
export const SCOPE_CHANGED = 'scope_changed';

export class TxScopeError extends Error {
  readonly errorType = SCOPE_CHANGED;
  constructor(message: string) {
    super(message);
    this.name = 'TxScopeError';
  }
}

const NETWORK_KEY = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;
const ACTIVE_WALLET_KEY = ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET;

export async function rpcUrlFor(networkId: string): Promise<string> {
  if (networkId === 'devnet') return ZeroXIOConfig.NETWORKS.devnet.rpc_url;
  if (isCustomNetworkId(networkId)) {
    const net = await resolveCustomNetwork(networkId);
    if (net?.rpc_url) {
      try {
        const parsed = new URL(net.rpc_url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return net.rpc_url;
      } catch {}
    }
  }
  return ZeroXIOConfig.NETWORKS.mainnet.rpc_url;
}

export async function storedNetworkId(): Promise<NetworkId> {
  try {
    const r = await chrome.storage.local.get(NETWORK_KEY);
    return (r[NETWORK_KEY] || 'mainnet') as NetworkId;
  } catch {
    return 'mainnet';
  }
}

/** One read of the network id, and the RPC URL of THAT id (never a second, racing read). */
export async function resolveNetworkPin(networkId?: NetworkId): Promise<NetworkPin> {
  const id = networkId ?? (await storedNetworkId());
  return { networkId: id, rpcUrl: await rpcUrlFor(id) };
}

export async function captureTxScope(address: string, networkId?: NetworkId): Promise<TxScope> {
  return { ...(await resolveNetworkPin(networkId)), address };
}

export async function captureSiteTxScope(address: string, siteKey: string): Promise<TxScope> {
  return { ...(await captureTxScope(address)), siteKey };
}

export function isTxScope(v: unknown): v is TxScope {
  const s = v as TxScope | null;
  return (
    !!s &&
    typeof s.networkId === 'string' &&
    typeof s.rpcUrl === 'string' &&
    typeof s.address === 'string' &&
    s.address.length > 0
  );
}

export async function txScopeMismatch(scope: TxScope): Promise<string | null> {
  let stored: Record<string, unknown>;
  try {
    const keys = [NETWORK_KEY, ACTIVE_WALLET_KEY];
    if (scope.siteKey) keys.push(scope.siteKey);
    stored = await chrome.storage.local.get(keys);
  } catch {
    return 'Could not read the active network. Try again.';
  }
  const net = String(stored[NETWORK_KEY] || 'mainnet');
  if (net !== scope.networkId || (await rpcUrlFor(net)) !== scope.rpcUrl) {
    return 'The network changed after this transaction was prepared. Nothing was sent. Review it again on the current network.';
  }
  if (scope.siteKey) {
    const site = stored[scope.siteKey] as { connected?: boolean; address?: string } | undefined;
    if (!site?.connected || site.address !== scope.address) {
      return 'This site moved to another wallet after this request was prepared. Nothing was sent. Review it again.';
    }
    return null;
  }
  const active = stored[ACTIVE_WALLET_KEY];
  // Older installs may hold a wallet id here rather than an address: only an address compares.
  if (typeof active === 'string' && active.startsWith('oct') && active !== scope.address) {
    return 'The active wallet changed after this transaction was prepared. Nothing was sent. Review it again.';
  }
  return null;
}

export async function onPinnedNetwork(pin: NetworkPin): Promise<boolean> {
  try {
    const r = await chrome.storage.local.get(NETWORK_KEY);
    const net = String(r[NETWORK_KEY] || 'mainnet');
    return net === pin.networkId && (await rpcUrlFor(net)) === pin.rpcUrl;
  } catch {
    return false;
  }
}

export async function assertTxScope(scope: TxScope): Promise<void> {
  const why = await txScopeMismatch(scope);
  if (why) throw new TxScopeError(why);
}
