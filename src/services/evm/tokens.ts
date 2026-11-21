import { chainLogoUrl } from './chains';
import { evmNetworksFor, type EvmNetwork } from './networks';

export interface EvmToken {
  chainId: number;
  address: string | null;
  symbol: string;
  name: string;
  decimals: number;
  logo: string | null;
  stable?: boolean;
  custom?: boolean;
  detected?: boolean;
}

const CURATED: Record<number, readonly Omit<EvmToken, 'chainId'>[]> = {
  1: [
    {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      logo: '/tokens/evm/1-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.webp',
      stable: true,
    },
    {
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      logo: '/tokens/evm/1-0xdac17f958d2ee523a2206206994597c13d831ec7.webp',
      stable: true,
    },
    {
      address: '0x4647e1fE715c9e23959022C2416C71867F5a6E80',
      symbol: 'wOCT',
      name: 'Wrapped OCT',
      decimals: 6,
      logo: '/chains/octra/logo.webp',
    },
  ],
  4663: [
    {
      address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      symbol: 'USDG',
      name: 'Global Dollar',
      decimals: 6,
      logo: '/tokens/evm/4663-0x5fc5360d0400a0fd4f2af552add042d716f1d168.webp',
      stable: true,
    },
  ],
};

const ALL_NETWORKS: readonly EvmNetwork[] = [
  ...evmNetworksFor('mainnet'),
  ...evmNetworksFor('devnet'),
];

export const CUSTOM_TOKENS_KEY = 'evm_custom_tokens';

const LOGO = /^(\/[\w./-]+|data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+)$/;

/** Only a bundled path or an inline image renders: remote images are blocked by the page's COEP. */
export function safeTokenLogo(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 120_000 && LOGO.test(value) ? value : null;
}

const LOGO_HOSTS = new Set([
  'raw.githubusercontent.com',
  'assets.coingecko.com',
  'coin-images.coingecko.com',
]);
const LOGO_URL = /^https:\/\/([a-z0-9.-]+)\/[\x21-\x7e]*$/;

export function explorerLogoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  const host = LOGO_URL.exec(value)?.[1];
  return host && LOGO_HOSTS.has(host) ? value : null;
}

const isStoredToken = (v: unknown): v is EvmToken => {
  const t = v as EvmToken | null;
  return (
    !!t &&
    Number.isSafeInteger(t.chainId) &&
    t.chainId > 0 &&
    typeof t.address === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(t.address) &&
    typeof t.symbol === 'string' &&
    t.symbol.length > 0 &&
    typeof t.name === 'string' &&
    Number.isInteger(t.decimals) &&
    t.decimals >= 0 &&
    t.decimals <= 36
  );
};

export async function readCustomTokenStore(): Promise<Record<string, EvmToken[]>> {
  try {
    const stored = await chrome.storage.local.get([CUSTOM_TOKENS_KEY]);
    const raw = stored?.[CUSTOM_TOKENS_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, EvmToken[]> = {};
    for (const [chain, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const valid = list
        .filter(isStoredToken)
        .filter((t) => String(t.chainId) === chain)
        .map((t) => ({ ...t, logo: safeTokenLogo(t.logo), custom: true }));
      if (valid.length) out[chain] = valid;
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadCustomEvmTokens(chainId?: number): Promise<EvmToken[]> {
  const store = await readCustomTokenStore();
  if (chainId !== undefined) return store[String(chainId)] ?? [];
  return Object.values(store).flat();
}

export function curatedEvmTokens(chainId: number): EvmToken[] {
  return (CURATED[chainId] ?? []).map((t) => ({ ...t, chainId }));
}

export function isCuratedEvmToken(chainId: number, address: string): boolean {
  const a = address.toLowerCase();
  return (CURATED[chainId] ?? []).some((t) => t.address?.toLowerCase() === a);
}

export function nativeEvmToken(network: EvmNetwork): EvmToken {
  return {
    chainId: network.chainId,
    address: null,
    symbol: network.nativeSymbol,
    name: network.nativeName,
    decimals: 18,
    logo: chainLogoUrl(network.logoChainId),
  };
}

export function evmTokensFor(
  chainId: number,
  opts: { network?: EvmNetwork; custom?: readonly EvmToken[] } = {}
): EvmToken[] {
  const network =
    ALL_NETWORKS.find((n) => n.chainId === chainId) ??
    (opts.network?.chainId === chainId ? opts.network : undefined);
  if (!network) return [];
  const curated = curatedEvmTokens(chainId);
  const seen = new Set(curated.map((t) => t.address!.toLowerCase()));
  const custom: EvmToken[] = [];
  for (const t of opts.custom ?? []) {
    const a = t.address?.toLowerCase();
    if (t.chainId !== chainId || !a || seen.has(a)) continue;
    seen.add(a);
    custom.push({ ...t, custom: true });
  }
  return [nativeEvmToken(network), ...curated, ...custom];
}
