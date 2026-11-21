export async function evmSiteMessage(
  type: 'EVM_SITE_CONNECT' | 'EVM_SITE_USE' | 'EVM_SITE_DISCONNECT',
  origin: string,
  walletId?: string
): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ type, origin, walletId });
    return !!res?.success;
  } catch {
    return false;
  }
}

export async function desktopSiteMessage(
  type: 'DESKTOP_SITE_DISCONNECT' | 'DESKTOP_SITE_MOVE',
  site: { origin: string; network: string }
): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({
      type,
      origin: site.origin,
      network: site.network,
    });
    return !!res?.success;
  } catch {
    return false;
  }
}

export async function revokeOctraSite(origin: string, key: string): Promise<void> {
  await chrome.storage.local.remove(key);
  try {
    await chrome.runtime.sendMessage({ type: 'REVOKE_DAPP_CONNECTION', origin });
  } catch {}
  let pageOrigin = origin;
  try {
    pageOrigin = new URL(origin).origin;
  } catch {}
  const tabs = await chrome.tabs.query({ url: `${pageOrigin}/*` });
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'WALLET_EVENT',
        origin: pageOrigin,
        eventData: { type: 'disconnect', data: { origin } },
      });
    } catch {}
  }
}
