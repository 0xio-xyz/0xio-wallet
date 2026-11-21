// The last balance shown, for an instant display when the popup opens. The public half sits in
// local storage. The decrypted private half and the total live in session storage only: content
// scripts cannot read it, it is gone when the browser closes, and a lock clears it.

const PREFIX = 'balance_cache_';

export interface CachedBalance {
  balance?: string;
  privateBalance?: string | null;
  totalBalance?: string | null;
}

export interface CachedPrivateBalance {
  privateBalance: string | null;
  totalBalance: string | null;
}

export const balanceCacheKey = (network: string, address: string) =>
  `${PREFIX}${network}_${address}`;

export const privateHistoryKey = (network: string, address: string) =>
  `${PREFIX}hist_${network}_${address}`;

async function sessionIsUnlocked(): Promise<boolean> {
  try {
    return !!(await chrome.storage.session.get('wallet_unlocked'))?.wallet_unlocked;
  } catch {
    return false;
  }
}

export async function readPrivateBalanceCache(
  network: string,
  address: string
): Promise<CachedPrivateBalance | null> {
  const key = balanceCacheKey(network, address);
  try {
    const entry = (await chrome.storage.session.get(key))?.[key];
    if (!entry || entry.privateBalance == null) return null;
    return { privateBalance: entry.privateBalance, totalBalance: entry.totalBalance ?? null };
  } catch {
    return null;
  }
}

export async function readBalanceCache(
  network: string,
  address: string
): Promise<CachedBalance | null> {
  const key = balanceCacheKey(network, address);
  const [pub, priv] = await Promise.all([
    chrome.storage.local
      .get(key)
      .then((r) => r?.[key])
      .catch((): undefined => undefined),
    readPrivateBalanceCache(network, address),
  ]);
  if (!pub && !priv) return null;
  const out: CachedBalance = {};
  if (typeof pub?.balance === 'string') out.balance = pub.balance;
  if (priv) Object.assign(out, priv);
  return out;
}

export async function writeBalanceCache(
  network: string,
  address: string,
  balance: string,
  privateBalance: string | null,
  totalBalance: string | null
): Promise<void> {
  const key = balanceCacheKey(network, address);
  await chrome.storage.local.set({ [key]: { balance } }).catch(() => {});
  if (privateBalance === null || !(await sessionIsUnlocked())) return;
  await chrome.storage.session.set({ [key]: { privateBalance, totalBalance } }).catch(() => {});
}

export async function clearPrivateBalanceCache(): Promise<void> {
  try {
    const all =
      ((await chrome.storage.session.get(null)) as unknown as Record<string, unknown>) ?? {};
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
    if (keys.length) await chrome.storage.session.remove(keys);
  } catch {}
}

export async function stripPrivateFromLocalBalanceCache(): Promise<void> {
  try {
    const all = ((await chrome.storage.local.get(null)) as unknown as Record<string, any>) ?? {};
    const rewrite: Record<string, { balance: string }> = {};
    const drop: string[] = [];
    for (const [key, entry] of Object.entries(all)) {
      if (!key.startsWith(PREFIX) || !entry || typeof entry !== 'object') continue;
      if (!('privateBalance' in entry) && !('totalBalance' in entry)) continue;
      if (typeof entry.balance === 'string') rewrite[key] = { balance: entry.balance };
      else drop.push(key);
    }
    if (Object.keys(rewrite).length) await chrome.storage.local.set(rewrite);
    if (drop.length) await chrome.storage.local.remove(drop);
  } catch {}
}
