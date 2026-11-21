export type NetworkId = 'mainnet' | 'devnet' | 'custom' | `custom_${string}`;

export interface NetworkConfig {
  name: string;
  rpc_url: string;
  explorer_url: string;
  explorer_address_url: string;
  indexer_url: string;
  supports_privacy: boolean;
  color: string;
  default: boolean;
  editable: boolean;
}

export const ZeroXIOConfig = {
  NETWORKS: {
    mainnet: {
      name: 'Octra Mainnet',
      rpc_url: 'https://octra.network',
      explorer_url: 'https://octrascan.io/tx.html?hash=',
      explorer_address_url: 'https://octrascan.io/address.html?addr=',
      indexer_url: 'https://octrascan.io',
      supports_privacy: true,
      color: '#f59e0b',
      default: true,
      editable: false,
    },
    devnet: {
      name: 'Octra Devnet',
      rpc_url: 'https://devnet.octrascan.io',
      explorer_url: 'https://devnet.octrascan.io/tx.html?hash=',
      explorer_address_url: 'https://devnet.octrascan.io/address.html?addr=',
      indexer_url: 'https://devnet.octrascan.io',
      supports_privacy: true,
      color: '#8b5cf6',
      default: false,
      editable: false,
    },
    custom: {
      name: 'Custom Network',
      rpc_url: '',
      explorer_url: '',
      explorer_address_url: '',
      indexer_url: '',
      supports_privacy: false,
      color: '#8b5cf6',
      default: false,
      editable: true,
    },
  } as Record<NetworkId, NetworkConfig>,

  REQUEST_TIMEOUT: 30000,

  UI: {
    MESSAGE_AUTO_HIDE_TIMEOUT: 5000,
    SUCCESS_MESSAGE_TIMEOUT: 3000,
    LOADING_DEBOUNCE: 100,
  },

  WALLET: {
    MAX_WALLETS: 20,
    ADDRESS_LENGTH: 47,
    ADDRESS_PREFIX: 'oct',
    CACHE_TTL: 30000,
    BALANCE_CACHE_TTL: 5000,
    WALLET_NAME_MAX_LENGTH: 8,
  },

  STORAGE: {
    KEYS: {
      ACTIVE_WALLET: '0xio_active_wallet',
      CURRENT_NETWORK: '0xio_current_network',
      CUSTOM_NETWORK: '0xio_custom_network_config',
      CUSTOM_NETWORKS: '0xio_custom_networks',
    },
  },

  CONTRACTS: {
    DEMO_CONTRACT: 'octBUHw585BrAMPMLQvGuWx4vqEsybYH9N7a3WNj1WBwrDn',
    PARAM_REGISTRY: {
      mainnet: '',
      devnet: 'octFxmgBDTQWo4FYetW4yi9FxG7fvMk8ytdh9134kW5VPSZ',
    } as Record<string, string>,
    WOCT: {
      mainnet: '',
      devnet: 'octCcgs68MFeeG8kpcwpHjdfD1M7tvjLKMvxkKMRkbNPmVs',
    } as Record<string, string>,
  },
};

export type ZeroXIOConfigType = typeof ZeroXIOConfig;

export interface CustomNetwork {
  id: string;
  name: string;
  rpc_url: string;
  explorer_url: string;
  explorer_address_url: string;
  indexer_url: string;
  supports_privacy: boolean;
  color: string;
  contract_address?: string;
}

export function isCustomNetworkId(id: string): boolean {
  return id === 'custom' || id.startsWith('custom_');
}

export function normalizeRpcBase(url: string): string {
  return url
    .trim()
    .replace(/\/$/, '')
    .replace(/\/rpc$/, '');
}

export async function loadCustomNetworks(): Promise<CustomNetwork[]> {
  const result = await chrome.storage.local.get([
    ZeroXIOConfig.STORAGE.KEYS.CUSTOM_NETWORKS,
    ZeroXIOConfig.STORAGE.KEYS.CUSTOM_NETWORK,
  ]);
  const list = result[ZeroXIOConfig.STORAGE.KEYS.CUSTOM_NETWORKS] as CustomNetwork[] | undefined;
  if (Array.isArray(list)) return list;
  const legacy = result[ZeroXIOConfig.STORAGE.KEYS.CUSTOM_NETWORK];
  if (legacy?.rpc_url) {
    const migrated: CustomNetwork[] = [
      {
        id: 'custom',
        name: legacy.name || 'Custom Network',
        rpc_url: normalizeRpcBase(legacy.rpc_url),
        explorer_url: legacy.explorer_url || '',
        explorer_address_url: legacy.explorer_address_url || '',
        indexer_url: legacy.indexer_url || '',
        supports_privacy: legacy.supports_privacy ?? false,
        color: legacy.color || '#9b8cff',
        contract_address: legacy.contract_address,
      },
    ];
    await chrome.storage.local.set({
      [ZeroXIOConfig.STORAGE.KEYS.CUSTOM_NETWORKS]: migrated,
    });
    return migrated;
  }
  return [];
}

export async function saveCustomNetworks(nets: CustomNetwork[]): Promise<void> {
  await chrome.storage.local.set({ [ZeroXIOConfig.STORAGE.KEYS.CUSTOM_NETWORKS]: nets });
  syncCustomNetworks(nets);
}

const networkRegistry: Record<string, NetworkConfig> = { ...ZeroXIOConfig.NETWORKS };

export function syncCustomNetworks(nets: CustomNetwork[]): void {
  for (const id of Object.keys(networkRegistry)) {
    if (isCustomNetworkId(id)) delete networkRegistry[id];
  }
  for (const n of nets) networkRegistry[n.id] = { ...n, default: false, editable: true };
}

export function peekNetwork(id: string): NetworkConfig | undefined {
  return networkRegistry[id];
}

export async function hydrateCustomNetworks(): Promise<void> {
  try {
    syncCustomNetworks(await loadCustomNetworks());
  } catch {}
}

export async function resolveCustomNetwork(id: string): Promise<CustomNetwork | null> {
  if (!isCustomNetworkId(id)) return null;
  const nets = await loadCustomNetworks();
  return nets.find((n) => n.id === id) ?? null;
}
