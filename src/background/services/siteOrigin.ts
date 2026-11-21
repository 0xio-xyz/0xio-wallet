import { IS_FIREFOX } from '../../shared/buildTarget';

/** A page as the browser names it: never from the message body. */
export interface SenderSite {
  origin: string;
  tabId: number;
  frameId: number;
  framed: boolean;
  topOrigin?: string;
  browser: 'chrome' | 'firefox';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const isDevBuild = (): boolean => {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
};

/** An origin a site may carry to 0xio Desktop: https, or http on this machine in development. */
export function relayableOrigin(raw: unknown, dev = isDevBuild()): string | null {
  if (typeof raw !== 'string' || !raw || raw === 'null') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin === 'null' || url.origin !== raw) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && dev && LOCAL_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

const originOfUrl = (u: unknown): string | null => {
  if (typeof u !== 'string' || !u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

export function siteOfSender(
  sender: chrome.runtime.MessageSender,
  dev = isDevBuild()
): SenderSite | null {
  if (sender.id !== chrome.runtime.id || !sender.tab || typeof sender.tab.id !== 'number') {
    return null;
  }
  const origin = relayableOrigin(sender.origin || originOfUrl(sender.url), dev);
  if (!origin) return null;
  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
  const top = originOfUrl(sender.tab.url);
  return {
    origin,
    tabId: sender.tab.id,
    frameId,
    framed: frameId !== 0,
    ...(top && top !== 'null' ? { topOrigin: top } : {}),
    browser: IS_FIREFOX ? 'firefox' : 'chrome',
  };
}
