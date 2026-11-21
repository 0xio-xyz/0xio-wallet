import { evmExplorerBase, evmTxUrl } from './history';
import {
  MAX_USER_RPCS,
  NETWORK_PREFS_KEY,
  cleanPrefs,
  isChainId,
  isHttpsUrl,
  isOrigin,
  loadNetworkPrefs,
  updateNetworkPref,
  type NetworkPref,
  type NetworkPrefs,
} from './networkPrefs';
import { evmNetworksFor, type EvmNetwork } from './networks';

export interface CustomEvmNetwork extends EvmNetwork {
  custom: true;
  explorerUrl?: string;
}

export interface ManagedEvmNetwork extends EvmNetwork {
  builtin: boolean;
  custom?: true;
  enabled: boolean;
  defaultRpcUrl: string;
  userRpcs: string[];
  explorerUrl?: string;
  addedBy?: string;
}

export const CUSTOM_NETWORKS_KEY = 'evm_custom_networks';

export type EvmNetworkProblem =
  | 'name'
  | 'rpc'
  | 'symbol'
  | 'chainId'
  | 'builtin'
  | 'mismatch'
  | 'exists'
  | 'duplicate'
  | 'explorer';

export class EvmNetworkError extends Error {
  constructor(
    message: string,
    readonly problem: EvmNetworkProblem,
    readonly served?: number
  ) {
    super(message);
    this.name = 'EvmNetworkError';
  }
}

export const isBuiltinChain = (chainId: number): boolean =>
  [...evmNetworksFor('mainnet'), ...evmNetworksFor('devnet')].some((n) => n.chainId === chainId);

const trimUrl = (url: string) => url.replace(/\/+$/, '');

function toCustom(raw: unknown): CustomEvmNetwork | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Partial<Record<keyof CustomEvmNetwork, unknown>>;
  if (!isChainId(n.chainId) || isBuiltinChain(n.chainId)) return null;
  if (typeof n.name !== 'string' || typeof n.nativeSymbol !== 'string') return null;
  if (!isHttpsUrl(n.rpcUrl)) return null;
  const name = n.name.trim().slice(0, 40);
  const symbol = n.nativeSymbol.trim().slice(0, 11);
  if (!name || !symbol) return null;
  const nativeName =
    typeof n.nativeName === 'string' && n.nativeName.trim()
      ? n.nativeName.trim().slice(0, 40)
      : symbol;
  return {
    custom: true,
    chainId: n.chainId,
    name,
    rpcUrl: n.rpcUrl,
    testnet: n.testnet === true,
    nativeSymbol: symbol,
    nativeName,
    logoChainId: isChainId(n.logoChainId) ? n.logoChainId : n.chainId,
    ...(isHttpsUrl(n.explorerUrl) ? { explorerUrl: trimUrl(n.explorerUrl) } : {}),
  };
}

function cleanCustomList(raw: unknown): CustomEvmNetwork[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: CustomEvmNetwork[] = [];
  for (const item of raw) {
    const n = toCustom(item);
    if (!n || seen.has(n.chainId)) continue;
    seen.add(n.chainId);
    out.push(n);
  }
  return out;
}

async function loadState(): Promise<{ custom: CustomEvmNetwork[]; prefs: NetworkPrefs }> {
  try {
    const stored = await chrome.storage.local.get([CUSTOM_NETWORKS_KEY, NETWORK_PREFS_KEY]);
    return {
      custom: cleanCustomList(stored?.[CUSTOM_NETWORKS_KEY]),
      prefs: cleanPrefs(stored?.[NETWORK_PREFS_KEY]),
    };
  } catch {
    return { custom: [], prefs: {} };
  }
}

export async function loadCustomNetworks(): Promise<CustomEvmNetwork[]> {
  return (await loadState()).custom;
}

async function saveCustomNetworks(list: CustomEvmNetwork[]): Promise<void> {
  await chrome.storage.local.set({ [CUSTOM_NETWORKS_KEY]: list });
}

export function activeRpcUrl(defaultRpcUrl: string, pref: NetworkPref | undefined): string {
  const pick = pref?.activeRpc;
  return pick && (pick === defaultRpcUrl || !!pref?.rpcs?.includes(pick)) ? pick : defaultRpcUrl;
}

function manage(
  base: EvmNetwork,
  pref: NetworkPref | undefined,
  custom: CustomEvmNetwork | null
): ManagedEvmNetwork {
  const explorer = pref?.explorer ?? custom?.explorerUrl ?? evmExplorerBase(base.chainId);
  return {
    chainId: base.chainId,
    name: base.name,
    testnet: base.testnet,
    nativeSymbol: base.nativeSymbol,
    nativeName: base.nativeName,
    logoChainId: base.logoChainId,
    ...(custom ? { custom: true as const } : {}),
    builtin: !custom,
    enabled: pref?.enabled ?? true,
    rpcUrl: activeRpcUrl(base.rpcUrl, pref),
    defaultRpcUrl: base.rpcUrl,
    userRpcs: (pref?.rpcs ?? []).filter((u) => u !== base.rpcUrl),
    ...(explorer ? { explorerUrl: trimUrl(explorer) } : {}),
    ...(pref?.addedBy ? { addedBy: pref.addedBy } : {}),
  };
}

function sideList(
  octraNetworkId: string | null | undefined,
  custom: CustomEvmNetwork[],
  prefs: NetworkPrefs
): ManagedEvmNetwork[] {
  const testnet = octraNetworkId === 'devnet';
  return [
    ...evmNetworksFor(octraNetworkId).map((n) => manage(n, prefs[n.chainId], null)),
    ...custom.filter((n) => n.testnet === testnet).map((n) => manage(n, prefs[n.chainId], n)),
  ];
}

export async function allNetworksFor(
  octraNetworkId: string | null | undefined,
  opts: { includeDisabled?: boolean } = {}
): Promise<ManagedEvmNetwork[]> {
  const { custom, prefs } = await loadState();
  const list = sideList(octraNetworkId, custom, prefs);
  return opts.includeDisabled ? list : list.filter((n) => n.enabled);
}

export function networksFor(octraNetworkId: string | null | undefined) {
  return allNetworksFor(octraNetworkId);
}

export async function allNetworks(
  opts: { includeDisabled?: boolean } = {}
): Promise<ManagedEvmNetwork[]> {
  const { custom, prefs } = await loadState();
  const list = [...sideList('mainnet', custom, prefs), ...sideList('devnet', custom, prefs)];
  return opts.includeDisabled === false ? list.filter((n) => n.enabled) : list;
}

export async function findNetwork(chainId: number): Promise<ManagedEvmNetwork | null> {
  return (await allNetworks()).find((n) => n.chainId === chainId) ?? null;
}

export async function probeChainId(rpcUrl: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The RPC answered HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown };
  if (typeof body.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.result)) {
    throw new Error('The RPC did not return a chain id');
  }
  return parseInt(body.result, 16);
}

async function probeMatching(rpcUrl: string, chainId: number): Promise<void> {
  let served: number;
  try {
    served = await probeChainId(rpcUrl);
  } catch (e) {
    throw new EvmNetworkError(e instanceof Error ? e.message : 'The RPC did not answer', 'rpc');
  }
  if (served !== chainId) {
    throw new EvmNetworkError(
      `This RPC serves chain ${served}, not ${chainId}`,
      'mismatch',
      served
    );
  }
}

/**
 * Adds a network after checking its RPC really serves the given chain. A built-in or already
 * added chain id is refused, so nothing a site or the user adds ever overwrites a network. It
 * starts on.
 */
export async function addCustomNetwork(input: {
  chainId: number;
  name: string;
  rpcUrl: string;
  nativeSymbol: string;
  nativeName?: string;
  testnet?: boolean;
  explorerUrl?: string;
  logoChainId?: number;
  addedBy?: string;
}): Promise<CustomEvmNetwork> {
  const name = input.name.trim().slice(0, 40);
  const rpcUrl = input.rpcUrl.trim();
  const symbol = input.nativeSymbol.trim().slice(0, 11);
  if (!name) throw new EvmNetworkError('Enter a network name', 'name');
  if (!isHttpsUrl(rpcUrl)) throw new EvmNetworkError('The RPC must be an https URL', 'rpc');
  if (!symbol) throw new EvmNetworkError('Enter the currency symbol', 'symbol');
  if (!isChainId(input.chainId)) throw new EvmNetworkError('Invalid chain id', 'chainId');
  if (isBuiltinChain(input.chainId)) {
    throw new EvmNetworkError('This network is already built in', 'builtin');
  }
  if ((await loadCustomNetworks()).some((n) => n.chainId === input.chainId)) {
    throw new EvmNetworkError('This network is already added', 'exists');
  }
  await probeMatching(rpcUrl, input.chainId);
  const explorer = input.explorerUrl?.trim();
  const network: CustomEvmNetwork = {
    custom: true,
    chainId: input.chainId,
    name,
    rpcUrl,
    testnet: !!input.testnet,
    nativeSymbol: symbol,
    nativeName: (input.nativeName ?? symbol).trim().slice(0, 40) || symbol,
    logoChainId: isChainId(input.logoChainId) ? input.logoChainId : input.chainId,
    ...(explorer && isHttpsUrl(explorer) ? { explorerUrl: trimUrl(explorer) } : {}),
  };
  const list = await loadCustomNetworks();
  if (list.some((n) => n.chainId === network.chainId)) {
    throw new EvmNetworkError('This network is already added', 'exists');
  }
  await saveCustomNetworks([...list, network]);
  const addedBy = isOrigin(input.addedBy) ? input.addedBy : undefined;
  await updateNetworkPref(network.chainId, () => ({
    enabled: true,
    ...(addedBy ? { addedBy } : {}),
  }));
  return network;
}

export async function removeCustomNetwork(chainId: number): Promise<void> {
  if (isBuiltinChain(chainId)) {
    throw new EvmNetworkError('A built-in network can be turned off, not removed', 'builtin');
  }
  const list = await loadCustomNetworks();
  await saveCustomNetworks(list.filter((n) => n.chainId !== chainId));
  await updateNetworkPref(chainId, () => null);
}

export async function resetNetwork(chainId: number): Promise<void> {
  if (!isBuiltinChain(chainId)) {
    throw new EvmNetworkError('Only a built-in network can be reset', 'chainId');
  }
  await updateNetworkPref(chainId, () => null);
}

export async function setNetworkEnabled(chainId: number, enabled: boolean): Promise<void> {
  await updateNetworkPref(chainId, (p) => ({ ...p, enabled }));
}

export async function enableNetwork(chainId: number): Promise<boolean> {
  const prefs = await loadNetworkPrefs();
  if (prefs[String(chainId)]?.enabled !== false) return false;
  await setNetworkEnabled(chainId, true);
  return true;
}

async function requireNetwork(chainId: number): Promise<ManagedEvmNetwork> {
  const network = await findNetwork(chainId);
  if (!network) throw new EvmNetworkError('Unknown network', 'chainId');
  return network;
}

export async function addNetworkRpc(chainId: number, url: string): Promise<string> {
  const rpc = url.trim();
  if (!isHttpsUrl(rpc)) throw new EvmNetworkError('The RPC must be an https URL', 'rpc');
  const network = await requireNetwork(chainId);
  if (rpc === network.defaultRpcUrl || network.userRpcs.includes(rpc)) {
    throw new EvmNetworkError('This RPC is already listed', 'duplicate');
  }
  if (network.userRpcs.length >= MAX_USER_RPCS) {
    throw new EvmNetworkError('Remove an RPC before adding another', 'rpc');
  }
  await probeMatching(rpc, chainId);
  await updateNetworkPref(chainId, (p) => ({
    ...p,
    rpcs: [...(p.rpcs ?? []).filter((u) => u !== rpc), rpc],
    activeRpc: rpc,
  }));
  return rpc;
}

export async function removeNetworkRpc(chainId: number, url: string): Promise<void> {
  const network = await requireNetwork(chainId);
  if (url === network.defaultRpcUrl) {
    throw new EvmNetworkError('The default RPC always stays', 'rpc');
  }
  await updateNetworkPref(chainId, (p) => ({
    ...p,
    rpcs: (p.rpcs ?? []).filter((u) => u !== url),
    activeRpc: p.activeRpc === url ? undefined : p.activeRpc,
  }));
}

export async function setActiveRpc(chainId: number, url: string): Promise<void> {
  const network = await requireNetwork(chainId);
  if (url !== network.defaultRpcUrl && !network.userRpcs.includes(url)) {
    throw new EvmNetworkError('This RPC is not listed', 'rpc');
  }
  await updateNetworkPref(chainId, (p) => ({
    ...p,
    activeRpc: url === network.defaultRpcUrl ? undefined : url,
  }));
}

export async function setNetworkExplorer(chainId: number, url: string): Promise<void> {
  const value = url.trim();
  if (value && !isHttpsUrl(value)) {
    throw new EvmNetworkError('The explorer must be an https URL', 'explorer');
  }
  await requireNetwork(chainId);
  await updateNetworkPref(chainId, (p) => ({
    ...p,
    explorer: value ? trimUrl(value) : undefined,
  }));
}

export async function setNetworkSymbol(chainId: number, symbol: string): Promise<void> {
  if (isBuiltinChain(chainId)) {
    throw new EvmNetworkError('A built-in network keeps its symbol', 'builtin');
  }
  const next = symbol.trim();
  if (!next || next.length > 11) {
    throw new EvmNetworkError('The symbol must be 1 to 11 characters', 'symbol');
  }
  const list = await loadCustomNetworks();
  if (!list.some((n) => n.chainId === chainId)) {
    throw new EvmNetworkError('Unknown network', 'chainId');
  }
  await saveCustomNetworks(
    list.map((n) =>
      n.chainId === chainId
        ? {
            ...n,
            nativeSymbol: next,
            nativeName: n.nativeName === n.nativeSymbol ? next : n.nativeName,
          }
        : n
    )
  );
}

const explorerOf = (network: EvmNetwork): string | null => {
  const own = (network as Partial<CustomEvmNetwork>).explorerUrl;
  return own && isHttpsUrl(own) ? trimUrl(own) : evmExplorerBase(network.chainId);
};

export function networkTxUrl(network: EvmNetwork, hash: string): string | null {
  const base = explorerOf(network);
  return base ? `${base}/tx/${hash}` : evmTxUrl(network.chainId, hash);
}

export async function explorerTxUrl(chainId: number, hash: string): Promise<string | null> {
  const network = await findNetwork(chainId);
  return network ? networkTxUrl(network, hash) : evmTxUrl(chainId, hash);
}

export function networkTokenUrl(
  network: EvmNetwork,
  contract: string,
  tokenId?: string
): string | null {
  const base = explorerOf(network);
  if (!base || !/^0x[0-9a-fA-F]{40}$/.test(contract)) return null;
  if (tokenId === undefined) return `${base}/token/${contract}`;
  return /^\d{1,78}$/.test(tokenId) ? `${base}/token/${contract}/instance/${tokenId}` : null;
}

export function networkAddressUrl(network: EvmNetwork, address: string): string | null {
  const base = explorerOf(network);
  return base && /^0x[0-9a-fA-F]{40}$/.test(address) ? `${base}/address/${address}` : null;
}
