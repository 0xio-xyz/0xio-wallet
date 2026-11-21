export type EvmSide = 'mainnet' | 'testnet';

export interface EvmSiteAccount {
  address: string;
  connectedAt: number;
}

export interface EvmSite {
  origin: string;
  chains: Partial<Record<EvmSide, number>>;
  accounts: Record<string, EvmSiteAccount>;
  inUse?: string;
  seenOpen?: string;
}

export type EvmSites = Record<string, EvmSite>;

export type UsableWallet = (walletId: string, address: string) => boolean;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function readSite(origin: string, raw: unknown): EvmSite | null {
  if (!isRecord(raw)) return null;
  const chains: EvmSite['chains'] = {};
  if (isRecord(raw.chains)) {
    for (const side of ['mainnet', 'testnet'] as const) {
      const id = raw.chains[side];
      if (Number.isSafeInteger(id) && (id as number) > 0) chains[side] = id as number;
    }
  }
  const accounts: EvmSite['accounts'] = {};
  if (isRecord(raw.accounts)) {
    for (const [id, a] of Object.entries(raw.accounts)) {
      if (!isRecord(a) || typeof a.address !== 'string' || !EVM_ADDRESS.test(a.address)) continue;
      accounts[id] = {
        address: a.address,
        connectedAt: Number.isFinite(a.connectedAt) ? (a.connectedAt as number) : 0,
      };
    }
  }
  const site: EvmSite = { origin, chains, accounts };
  if (typeof raw.inUse === 'string' && accounts[raw.inUse]) site.inUse = raw.inUse;
  else {
    const latest = newestFirst(accounts)[0];
    if (latest) site.inUse = latest;
  }
  if (typeof raw.seenOpen === 'string') site.seenOpen = raw.seenOpen;
  return site;
}

const newestFirst = (accounts: EvmSite['accounts']): string[] =>
  Object.entries(accounts)
    .sort((a, b) => b[1].connectedAt - a[1].connectedAt)
    .map(([id]) => id);

export function followOpen(site: EvmSite, openId: string | null, usable: UsableWallet): EvmSite {
  if (!openId || openId === site.seenOpen) return site;
  const account = site.accounts[openId];
  const follows = !!account && usable(openId, account.address);
  return { ...site, seenOpen: openId, ...(follows ? { inUse: openId } : {}) };
}

export function siteWalletIds(
  site: EvmSite | undefined,
  openId: string | null,
  usable: UsableWallet
): string[] {
  if (!site) return [];
  const s = followOpen(site, openId, usable);
  const ids = newestFirst(s.accounts).filter((id) => usable(id, s.accounts[id].address));
  return s.inUse && ids.includes(s.inUse) ? [s.inUse, ...ids.filter((i) => i !== s.inUse)] : ids;
}

export function withWallet(
  site: EvmSite,
  walletId: string,
  address: string,
  openId: string | null,
  now = Date.now()
): EvmSite {
  return {
    ...site,
    accounts: { ...site.accounts, [walletId]: { address, connectedAt: now } },
    inUse: walletId,
    ...(openId ? { seenOpen: openId } : {}),
  };
}

export function withoutWallets(site: EvmSite, gone: (walletId: string) => boolean): EvmSite {
  const accounts = Object.fromEntries(Object.entries(site.accounts).filter(([id]) => !gone(id)));
  const next: EvmSite = { ...site, accounts };
  if (!next.inUse || !accounts[next.inUse]) {
    const latest = newestFirst(accounts)[0];
    if (latest) next.inUse = latest;
    else delete next.inUse;
  }
  return next;
}
