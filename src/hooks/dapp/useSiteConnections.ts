import { useRef, useState } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { readSite, type EvmSites } from 'src/services/evm/siteModel';
import { DESKTOP_SITES_KEY, SITE_SIGNER_KEY } from 'src/background/services/siteSigner';
import type { DesktopSite } from 'src/background/services/desktopRelay';

const EVM_SITES_KEY = 'evm_sites';
const OCTRA_PREFIX = 'dapp_connection_';

export interface OctraSite {
  key: string;
  origin: string;
  address: string | null;
  connectedAt: number;
  favicon?: string;
}

export interface SiteConnections {
  evm: EvmSites;
  octra: OctraSite[];
  desktop: DesktopSite[];
  desktopRoutes: Set<string>;
  loaded: boolean;
  refreshing: boolean;
}

const originOfKey = (key: string): string => {
  try {
    return atob(key.slice(OCTRA_PREFIX.length).replace(/_/g, '='));
  } catch {
    return key.slice(OCTRA_PREFIX.length);
  }
};

async function read(): Promise<Omit<SiteConnections, 'loaded' | 'refreshing'>> {
  const all = ((await chrome.storage.local.get(null)) ?? {}) as Record<string, unknown>;
  const evm: EvmSites = {};
  const raw = all[EVM_SITES_KEY];
  if (raw && typeof raw === 'object') {
    for (const [origin, site] of Object.entries(raw as Record<string, unknown>)) {
      const s = readSite(origin, site);
      if (s && Object.keys(s.accounts).length) evm[origin] = s;
    }
  }
  const octra: OctraSite[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(OCTRA_PREFIX) || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if (!v.connected) continue;
    octra.push({
      key,
      origin: typeof v.origin === 'string' ? v.origin : originOfKey(key),
      address: typeof v.address === 'string' ? v.address : null,
      connectedAt: Number(v.connectedAt) || 0,
      ...(typeof v.favicon === 'string' ? { favicon: v.favicon } : {}),
    });
  }
  octra.sort((a, b) => b.connectedAt - a.connectedAt);
  const picks = all[SITE_SIGNER_KEY];
  const desktopRoutes = new Set(
    picks && typeof picks === 'object'
      ? Object.entries(picks as Record<string, unknown>)
          .filter(([, v]) => v === 'desktop')
          .map(([k]) => k)
      : []
  );
  let desktop: DesktopSite[] = [];
  try {
    const session = await chrome.storage.session.get(DESKTOP_SITES_KEY);
    const list = session?.[DESKTOP_SITES_KEY];
    if (Array.isArray(list)) desktop = list as DesktopSite[];
  } catch {}
  desktop.sort((a, b) => b.connectedAt - a.connectedAt);
  return { evm, octra, desktop, desktopRoutes };
}

export function useSiteConnections(): SiteConnections {
  const [state, setState] = useState<SiteConnections>({
    evm: {},
    octra: [],
    desktop: [],
    desktopRoutes: new Set(),
    loaded: false,
    refreshing: false,
  });
  const run = useRef(0);

  useMountEffect(() => {
    let live = true;
    const load = () => {
      const id = ++run.current;
      read()
        .then((next) => {
          if (live && id === run.current) {
            setState({ ...next, loaded: true, refreshing: false });
          }
        })
        .catch(() => {
          if (live && id === run.current)
            setState((s) => ({ ...s, loaded: true, refreshing: false }));
        });
    };
    load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const keys = Object.keys(changes);
      const relevant =
        area === 'session'
          ? keys.includes(DESKTOP_SITES_KEY)
          : area === 'local' &&
            keys.some(
              (k) => k === EVM_SITES_KEY || k === SITE_SIGNER_KEY || k.startsWith(OCTRA_PREFIX)
            );
      if (!relevant) return;
      setState((s) => ({ ...s, refreshing: true }));
      load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  });

  return state;
}
