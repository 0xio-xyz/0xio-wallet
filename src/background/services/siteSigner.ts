import { ZeroXIOConfig } from '../../utils/config';

export type SiteSigner = 'browser' | 'desktop';

export const SITE_SIGNER_KEY = '0xio_site_signer';
export const DESKTOP_SITES_KEY = 'desktop_sites';

export const DESKTOP_NETWORKS = new Set(['mainnet', 'devnet']);

const keyOf = (origin: string, network: string) => `${network}|${origin}`;

async function readAll(): Promise<Record<string, SiteSigner>> {
  try {
    const got = await chrome.storage.local.get(SITE_SIGNER_KEY);
    const v = got?.[SITE_SIGNER_KEY];
    return v && typeof v === 'object' ? (v as Record<string, SiteSigner>) : {};
  } catch {
    return {};
  }
}

export async function siteSigner(origin: string, network: string): Promise<SiteSigner | undefined> {
  const v = (await readAll())[keyOf(origin, network)];
  return v === 'desktop' || v === 'browser' ? v : undefined;
}

export async function siteSigners(origin: string): Promise<Record<string, SiteSigner>> {
  const out: Record<string, SiteSigner> = {};
  for (const [k, v] of Object.entries(await readAll())) {
    const at = k.indexOf('|');
    if (k.slice(at + 1) === origin && (v === 'desktop' || v === 'browser')) out[k.slice(0, at)] = v;
  }
  return out;
}

export async function setSiteSigner(
  origin: string,
  network: string,
  signer: SiteSigner
): Promise<void> {
  const all = await readAll();
  all[keyOf(origin, network)] = signer;
  await chrome.storage.local.set({ [SITE_SIGNER_KEY]: all });
}

export async function routedToDesktopAnywhere(origin: string): Promise<boolean> {
  const all = await readAll();
  return Object.entries(all).some(
    ([k, v]) => v === 'desktop' && k.slice(k.indexOf('|') + 1) === origin
  );
}

export async function currentNetwork(): Promise<string> {
  const key = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;
  try {
    const got = await chrome.storage.local.get(key);
    return typeof got?.[key] === 'string' && got[key] ? got[key] : 'mainnet';
  } catch {
    return 'mainnet';
  }
}
