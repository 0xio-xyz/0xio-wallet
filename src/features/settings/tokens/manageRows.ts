import type { NftCollection } from 'src/features/wallet/nft/nftData';
import { NO_HIDDEN, isCollectionHidden, type NftHidden } from 'src/features/wallet/nft/hidden';
import type { EvmBalanceRow } from 'src/services/evm/balances';
import {
  detectedLogo,
  detectedSpamReason,
  type DetectedRecord,
  type DetectedToken,
} from 'src/services/evm/detectedTokens';
import type { EvmNft } from 'src/services/evm/nfts';
import { curatedEvmTokens, type EvmToken } from 'src/services/evm/tokens';
import {
  octraTokenSpam,
  type ContractToken,
  type ListedToken,
  type TokenMeta,
} from 'src/services/tokens/octraTokens';
import { collectionSpamReason, tokenShown, type SpamReason } from 'src/services/tokens/tokenSpam';
import { evmVisKey, octraVisKey, type VisMap } from 'src/services/tokens/tokenVisibility';
import { formatUnits } from 'src/utils/amount';

export type TokenOrigin = 'listed' | 'imported' | 'detected';

export interface ManageTokenRow {
  id: string;
  visKey: string;
  contract: string;
  symbol: string;
  name: string;
  network: string;
  chainId: number | null;
  logo: string | null;
  amount: string | null;
  origin: TokenOrigin;
  spam: SpamReason | null;
  shown: boolean;
}

export interface ManageNetwork {
  chainId: number;
  name: string;
}

const short = (contract: string) => `${contract.slice(0, 6)}...${contract.slice(-4)}`;

function amountOf(raw: string | null | undefined, decimals: number): string | null {
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const shown = formatUnits(raw, decimals);
  return shown === '0' && /[1-9]/.test(raw) ? '< 0.000001' : shown;
}

export function octraManageRows(input: {
  networkId: string;
  networkName: string;
  address: string;
  listed: readonly ListedToken[];
  importAddrs: readonly string[];
  importMeta: Readonly<Record<string, TokenMeta | undefined>>;
  held: readonly ContractToken[] | null;
  balances: Readonly<Record<string, string>> | null;
  vis: VisMap;
  logoByAddress?: ReadonlyMap<string, string>;
}): ManageTokenRow[] {
  const { networkId, networkName, address, vis } = input;
  const visKey = octraVisKey(networkId, address);
  const rows: ManageTokenRow[] = [];
  const taken = new Set<string>();
  const balance = (contract: string, decimals: number) =>
    input.balances ? amountOf(input.balances[contract] ?? '0', decimals) : null;
  const base = (
    contract: string
  ): Pick<ManageTokenRow, 'id' | 'visKey' | 'contract' | 'network' | 'chainId'> => ({
    id: `${visKey}|${contract}`,
    visKey,
    contract,
    network: networkName,
    chainId: null,
  });

  for (const t of input.listed) {
    if (taken.has(t.address)) continue;
    taken.add(t.address);
    const decimals = t.decimals ?? 0;
    rows.push({
      ...base(t.address),
      symbol: t.symbol,
      name: t.name,
      logo: t.logoURI ?? null,
      amount: balance(t.address, decimals),
      origin: 'listed',
      spam: null,
      shown: vis[t.address] !== false,
    });
  }
  const heldBy = new Map((input.held ?? []).map((t) => [t.contractAddress, t]));
  for (const addr of input.importAddrs) {
    if (taken.has(addr)) continue;
    taken.add(addr);
    const meta = input.importMeta[addr] ?? heldBy.get(addr);
    const decimals = meta?.decimals ?? 0;
    rows.push({
      ...base(addr),
      symbol: meta?.symbol ?? short(addr),
      name: meta?.name ?? short(addr),
      logo: input.logoByAddress?.get(addr.toLowerCase()) ?? null,
      amount: meta ? balance(addr, decimals) : null,
      origin: 'imported',
      spam: null,
      shown: vis[addr] !== false,
    });
  }
  for (const t of input.held ?? []) {
    if (taken.has(t.contractAddress)) continue;
    taken.add(t.contractAddress);
    const spam = octraTokenSpam(networkId, t);
    rows.push({
      ...base(t.contractAddress),
      symbol: t.symbol,
      name: t.name,
      logo: input.logoByAddress?.get(t.contractAddress.toLowerCase()) ?? null,
      amount: amountOf(t.balance, t.decimals),
      origin: 'detected',
      spam,
      shown: tokenShown(vis[t.contractAddress], spam),
    });
  }
  return rows;
}

export function evmManageRows(input: {
  address: string;
  networks: readonly ManageNetwork[];
  imported: readonly EvmToken[];
  detected: Readonly<Record<number, DetectedRecord | undefined>>;
  vis: Readonly<Record<string, VisMap | undefined>>;
  balances: readonly EvmBalanceRow[];
}): ManageTokenRow[] {
  const rows: ManageTokenRow[] = [];
  for (const n of input.networks) {
    const visKey = evmVisKey(n.chainId, input.address);
    const vis = input.vis[visKey] ?? {};
    const taken = new Set<string>();
    const imported = new Set<string>();
    const held = new Map(
      input.balances
        .filter((r) => r.chainId === n.chainId && r.token.address)
        .map((r) => [r.token.address!.toLowerCase(), r])
    );
    const rec = input.detected[n.chainId];
    const found = new Map<string, DetectedToken>(
      (rec?.items ?? []).map((i) => [i.contract.toLowerCase(), i])
    );
    const amount = (c: string, decimals: number) => {
      const row = held.get(c);
      if (row) return amountOf(row.raw, decimals);
      const item = found.get(c);
      return item ? amountOf(item.balance, decimals) : null;
    };
    const push = (t: EvmToken, origin: TokenOrigin, spam: SpamReason | null, shown: boolean) => {
      const c = t.address!.toLowerCase();
      rows.push({
        id: `${visKey}|${c}`,
        visKey,
        contract: c,
        symbol: t.symbol,
        name: t.name,
        network: n.name,
        chainId: n.chainId,
        logo: t.logo,
        amount: amount(c, t.decimals),
        origin,
        spam,
        shown,
      });
    };
    for (const t of curatedEvmTokens(n.chainId)) {
      const c = t.address!.toLowerCase();
      taken.add(c);
      push(t, 'listed', null, vis[c] !== false);
    }
    for (const t of input.imported) {
      const c = t.address?.toLowerCase();
      if (t.chainId !== n.chainId || !c || taken.has(c)) continue;
      taken.add(c);
      imported.add(c);
      push(t, 'imported', null, vis[c] !== false);
    }
    const sent = new Set(rec?.sent ?? []);
    for (const item of rec?.items ?? []) {
      const c = item.contract.toLowerCase();
      if (taken.has(c)) continue;
      taken.add(c);
      const spam = detectedSpamReason(n.chainId, item, { imported, sent });
      const symbol = item.symbol ?? item.name ?? short(item.contract);
      push(
        {
          chainId: n.chainId,
          address: item.contract,
          symbol,
          name: item.name ?? symbol,
          decimals: item.decimals,
          logo: detectedLogo(item, spam),
        },
        'detected',
        spam,
        tokenShown(vis[c], spam)
      );
    }
  }
  return rows;
}

export function splitByVerdict<T extends { spam: unknown }>(rows: readonly T[]) {
  return {
    regular: rows.filter((r) => !r.spam),
    spam: rows.filter((r) => !!r.spam),
  };
}

export function matchesQuery(
  row: { symbol?: string; name: string; network: string; contract: string },
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.symbol ?? '', row.name, row.network, row.contract].some((s) =>
    s.toLowerCase().includes(q)
  );
}

export interface ManageCollectionRow {
  id: string;
  kind: 'oct' | 'evm';
  chainId: number | null;
  contract: string;
  name: string;
  network: string;
  count: number;
  coverId: string | null;
  coverNft: EvmNft | null;
  imported: boolean;
  spam: 'link' | 'bait' | null;
  shown: boolean;
}

export function octraCollectionRows(input: {
  collections: readonly NftCollection[];
  ids: Readonly<Record<string, string[]>>;
  hidden: NftHidden;
  networkName: string;
}): ManageCollectionRow[] {
  return input.collections.map((c): ManageCollectionRow => {
    const ids = input.ids[c.contractAddress];
    const imported = !!c.imported;
    return {
      id: `oct:${c.contractAddress}`,
      kind: 'oct',
      chainId: null,
      contract: c.contractAddress,
      name: c.name,
      network: input.networkName,
      count: ids ? ids.length : c.ownedCount,
      coverId: ids?.[0] ?? null,
      coverNft: null,
      imported,
      spam: imported ? null : collectionSpamReason(c.name),
      shown: !isCollectionHidden(input.hidden, c.contractAddress),
    };
  });
}

export function evmCollectionRows(input: {
  items: readonly EvmNft[];
  hidden: Readonly<Record<number, NftHidden>>;
  imported: Readonly<Record<number, readonly string[]>>;
  networks: readonly ManageNetwork[];
}): ManageCollectionRow[] {
  const groups = new Map<string, ManageCollectionRow>();
  for (const n of input.items) {
    const key = `evm:${n.chainId}:${n.contract.toLowerCase()}`;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      if (g.name === short(g.contract) && n.collection) g.name = n.collection;
      continue;
    }
    const imported = (input.imported[n.chainId] ?? []).some(
      (c) => c.toLowerCase() === n.contract.toLowerCase()
    );
    groups.set(key, {
      id: key,
      kind: 'evm',
      chainId: n.chainId,
      contract: n.contract,
      name: n.collection ?? short(n.contract),
      network: input.networks.find((x) => x.chainId === n.chainId)?.name ?? `Chain ${n.chainId}`,
      count: 1,
      coverId: null,
      coverNft: n,
      imported,
      spam: null,
      shown: !isCollectionHidden(input.hidden[n.chainId] ?? NO_HIDDEN, n.contract),
    });
  }
  return [...groups.values()].map((g) => ({
    ...g,
    spam: g.imported ? null : collectionSpamReason(g.name),
  }));
}
