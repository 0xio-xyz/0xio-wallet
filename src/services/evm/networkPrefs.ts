export interface NetworkPref {
  enabled: boolean;
  activeRpc?: string;
  rpcs?: string[];
  explorer?: string;
  addedBy?: string;
}

export type NetworkPrefs = Record<string, NetworkPref>;

export const NETWORK_PREFS_KEY = 'evm_network_prefs';
export const MAX_URL_LENGTH = 512;
export const MAX_USER_RPCS = 20;

export const isChainId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

export function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_URL_LENGTH || !/^https:\/\/[^\s]+$/.test(v)) {
    return false;
  }
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

export const isOrigin = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 256 && /^https?:\/\/[^\s/?#]+$/.test(v);

export function cleanPref(raw: unknown): NetworkPref | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const pref: NetworkPref = { enabled: p.enabled !== false };
  if (Array.isArray(p.rpcs)) {
    const rpcs = [...new Set(p.rpcs.filter(isHttpsUrl))].slice(0, MAX_USER_RPCS);
    if (rpcs.length) pref.rpcs = rpcs;
  }
  if (isHttpsUrl(p.activeRpc)) pref.activeRpc = p.activeRpc;
  if (isHttpsUrl(p.explorer)) pref.explorer = p.explorer;
  if (isOrigin(p.addedBy)) pref.addedBy = p.addedBy;
  return pref;
}

export function cleanPrefs(raw: unknown): NetworkPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: NetworkPrefs = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{1,16}$/.test(key) || !isChainId(Number(key))) continue;
    const pref = cleanPref(value);
    if (pref) out[String(Number(key))] = pref;
  }
  return out;
}

export async function loadNetworkPrefs(): Promise<NetworkPrefs> {
  try {
    const stored = await chrome.storage.local.get([NETWORK_PREFS_KEY]);
    return cleanPrefs(stored?.[NETWORK_PREFS_KEY]);
  } catch {
    return {};
  }
}

let writing: Promise<unknown> = Promise.resolve();

export function updateNetworkPref(
  chainId: number,
  change: (current: NetworkPref) => NetworkPref | null
): Promise<NetworkPref | null> {
  const run = writing.then(async () => {
    const prefs = await loadNetworkPrefs();
    const key = String(chainId);
    const next = change(prefs[key] ?? { enabled: true });
    const clean = next ? cleanPref(next) : null;
    if (clean) prefs[key] = clean;
    else delete prefs[key];
    await chrome.storage.local.set({ [NETWORK_PREFS_KEY]: prefs });
    return clean;
  });
  writing = run.catch((): undefined => undefined);
  return run;
}
