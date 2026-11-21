export const RECENT_NETWORKS_KEY = 'evm_recent_networks';
export const RECENT_MAX = 5;

const isChainId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

export async function loadRecentNetworks(): Promise<number[]> {
  try {
    const stored = await chrome.storage.local.get([RECENT_NETWORKS_KEY]);
    const list = stored?.[RECENT_NETWORKS_KEY];
    return Array.isArray(list) ? [...new Set(list.filter(isChainId))].slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export async function noteRecentNetwork(chainId: number): Promise<number[]> {
  if (!isChainId(chainId)) return loadRecentNetworks();
  const next = [chainId, ...(await loadRecentNetworks()).filter((c) => c !== chainId)].slice(
    0,
    RECENT_MAX
  );
  try {
    await chrome.storage.local.set({ [RECENT_NETWORKS_KEY]: next });
  } catch {}
  return next;
}
