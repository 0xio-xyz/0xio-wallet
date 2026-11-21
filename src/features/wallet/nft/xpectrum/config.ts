export interface XpectrumConfig {
  market: string;
  superFactory?: string;
  genesis?: string;
  platformWallet?: string;
}

const SEED: Record<string, XpectrumConfig> = {
  mainnet: {
    market: 'octGoeTjaF8MiKTP5ad5FJfWMCZmmEdnrfxTow6UUVmBj6h',
  },
  devnet: {
    superFactory: 'oct8EwoAcWfMoNCVvmHK86XoTRxD5YrWeTTpQ5U6NrZCMH7',
    market: 'octBQG94WAh4dqwtp3dBSMdd7RqL5oBQG74t6nxLzGaYK2m',
    genesis: 'octC2SvevEnrXwr2zBrHzhmjeY3p8Y4dEPmRzG9MdEgeZEY',
    platformWallet: 'octGuDeCNaRRRRC5eguUby8myss6MCGqNfMAmxh4rT9ni3P',
  },
};

const overrides: Record<string, XpectrumConfig> = {};

export function xpectrumConfig(networkId: string): XpectrumConfig | null {
  return overrides[networkId] ?? SEED[networkId] ?? null;
}

export function setXpectrumConfig(map: Record<string, XpectrumConfig>): void {
  for (const [net, cfg] of Object.entries(map)) {
    if (cfg && cfg.market) overrides[net] = cfg;
  }
}

let loaded = false;
export async function loadRemoteXpectrumConfig(url?: string): Promise<void> {
  const u = url ?? (import.meta.env?.VITE_XPECTRUM_CONFIG_URL as string | undefined);
  if (!u || loaded) return;
  loaded = true;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const map = (await r.json()) as Record<string, XpectrumConfig>;
    if (map && typeof map === 'object') setXpectrumConfig(map);
  } catch {}
}

void loadRemoteXpectrumConfig();

export const MICRO_OCT = 1_000_000;
