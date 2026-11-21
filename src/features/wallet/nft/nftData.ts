import { networkService } from 'src/services/network/NetworkService';
import { logger } from 'src/utils/logger';
import {
  bytesToB64,
  CircleAssetError,
  resolveCircleAsset,
  type CircleAssetReply,
} from 'src/utils/octra/circleAsset';
import { getCachedAsset, putCachedAsset } from 'src/features/wallet/nft/circleAssetCache';
import { circleAssetKey, isDurableAsset } from 'src/features/wallet/nft/circleAssetKey';
import { xpectrumConfig } from 'src/features/wallet/nft/xpectrum/config';
import { callView, toNum } from 'src/features/wallet/nft/xpectrum/read';
import { type Listing } from 'src/features/wallet/nft/xpectrum/market';
import { getContractAbiMethods } from 'src/features/wallet/nft/abi';
import {
  isInlineJsonUri,
  isMissingMethodError,
  isRevertError,
  ownedIdsFromPage,
  OWNERS_PAGE_SIZE,
  parseInlineJsonUri,
  scanCeiling,
  withBusyRetry,
} from 'src/features/wallet/nft/euint/chainState';
import { knownCollections, probeCollections } from 'src/features/wallet/nft/knownCollections';
import { onsKnownCollections } from 'src/features/wallet/nft/onsNames';
import { onsContractFor } from 'src/services/names/ons';

export interface NftCollection {
  contractAddress: string;
  name: string;
  symbol: string;
  totalSupply: string | null;
  ownedCount: number;
  ownedTokenIds: string[];
  countKnown?: boolean;
  imported?: boolean;
}

export interface NftTokenDetail {
  tokenId: string;
  uri: string | null;
  image: string | null;
  metaName: string | null;
  metaDescription: string | null;
  animationUrl: string | null;
  poster?: string | null;
  attributes: NftAttribute[] | null;
  rarity: NftRarity | null;
  metaFetched: boolean;
}

export const IMPORTED_NFTS_KEY_PREFIX = 'imported_nfts_';

export function groupThousands(raw: string): string {
  if (!raw) return '';
  const [intPart, dec] = raw.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec !== undefined ? `${grouped}.${dec}` : grouped;
}

export function isLivingProgramUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  const u = uri.toLowerCase();
  return u.startsWith('oct://') && (u.includes('.html') || u.includes('/index.htm'));
}

export function deriveStandard(methods: string[]): string | null {
  if (methods.includes('transfer_from') && methods.includes('approve')) return 'XNS-1';
  if (methods.includes('transfer_to')) return 'Single-token';
  return methods.length ? 'NFT' : null;
}

export type Listability = 'unknown' | 'ready' | 'incompatible';

export function marketActionsOn(s: {
  market: boolean;
  verdictIn: boolean;
  listable: Listability;
  listed: boolean;
  listingUnknown: boolean;
}): boolean {
  if (!s.market) return false;
  if (s.listed) return true;
  return s.verdictIn && s.listable !== 'incompatible' && !s.listingUnknown;
}

export function deriveListability(methods: string[]): Listability {
  if (methods.length === 0) return 'unknown';
  const canApprove = methods.includes('approve');
  const canSettle = methods.includes('transfer_from') || methods.includes('transfer');
  return canApprove && canSettle ? 'ready' : 'incompatible';
}

// The market's full XNS-1 interface. A contract with all five is tradeable out of the box; a
// reduced-interface collection (e.g. the EUINT living NFTs, only approve/get_approved/owner_of/
// transfer_from) is listable ONLY if the admin enabled it via set_standard_mode > 0.
export const XNS1_MARKET_METHODS = [
  'is_approved_or_owner',
  'transfer_from',
  'owner_of',
  'creator_of',
  'royalty_of',
];

export function isFullXns1(methods: string[]): boolean {
  return XNS1_MARKET_METHODS.every((m) => methods.includes(m));
}

export async function marketStandardMode(
  networkId: string,
  contract: string
): Promise<number | null> {
  const market = xpectrumConfig(networkId)?.market;
  if (!market) return null;
  try {
    const raw = await callView(market, 'get_standard_mode', [contract]);
    return raw != null ? toNum(raw) : null;
  } catch {
    return null;
  }
}

export const collectionStdCache = new Map<
  string,
  { standard: string | null; listability: Listability }
>();

export const NFT_STD_CACHE_KEY = '0xio_nft_std_cache';
export let stdCacheHydrated = false;

export async function hydrateStdCache(): Promise<void> {
  if (stdCacheHydrated) return;
  stdCacheHydrated = true;
  try {
    const r = await chrome.storage.local.get(NFT_STD_CACHE_KEY);
    const stored = r[NFT_STD_CACHE_KEY] as
      | Record<string, { standard: string | null; listability: Listability }>
      | undefined;
    if (stored) {
      for (const [k, v] of Object.entries(stored)) {
        if (!collectionStdCache.has(k)) collectionStdCache.set(k, v);
      }
    }
  } catch {}
}

export function persistStdVerdict(
  key: string,
  verdict: { standard: string | null; listability: Listability }
): void {
  void chrome.storage.local
    .get(NFT_STD_CACHE_KEY)
    .then((r) => {
      const map =
        (r[NFT_STD_CACHE_KEY] as
          | Record<string, { standard: string | null; listability: Listability }>
          | undefined) ?? {};
      map[key] = verdict;
      return chrome.storage.local.set({ [NFT_STD_CACHE_KEY]: map });
    })
    .catch(() => {});
}

export const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://dweb.link/ipfs/',
];

export function resolveIpfsUrl(uri: string): string {
  if (!uri) return uri;
  if (uri.startsWith('ipfs://')) {
    const cid = uri.slice(7);
    return `${IPFS_GATEWAYS[0]}${cid}`;
  }
  if (uri.startsWith('Qm') || uri.startsWith('baf')) {
    return `${IPFS_GATEWAYS[0]}${uri}`;
  }
  return uri;
}

export function parseOctUri(uri: string): { circleId: string; path: string } | null {
  if (!uri || !uri.toLowerCase().startsWith('oct://')) return null;
  const rest = uri.slice(6).split(/[?#]/, 1)[0];
  if (!rest) return null;
  const si = rest.indexOf('/');
  if (si === -1) return { circleId: rest, path: '/index.html' };
  const circleId = rest.slice(0, si);
  const path = rest.slice(si) || '/index.html';
  return circleId ? { circleId, path } : null;
}

export async function fetchOctAsset(
  uri: string,
  fresh = false
): Promise<{ contentType: string; dataB64: string } | null> {
  const parsed = parseOctUri(uri);
  if (!parsed) return null;
  const networkId = await networkService.getCurrentNetworkId();
  const key = circleAssetKey(networkId, parsed.circleId, parsed.path);
  const durable = isDurableAsset(parsed.path);
  const cached = durable && !fresh ? await getCachedAsset(key) : null;
  if (cached) {
    return {
      contentType: cached.contentType || 'application/octet-stream',
      dataB64: bytesToB64(cached.bytes),
    };
  }
  try {
    const asset = await resolveCircleAsset(
      (item) =>
        networkService.jsonRpcCall('circle_asset', [
          parsed.circleId,
          item,
        ]) as Promise<CircleAssetReply>,
      parsed.path
    );
    if (!asset) {
      if (fresh && durable && (await getCachedAsset(key)))
        throw new Error(`circle asset unavailable: ${parsed.path}`);
      return null;
    }
    const { contentType, bytes } = asset;
    if ((await networkService.getCurrentNetworkId()) !== networkId) return null;
    if (isDurableAsset(parsed.path, contentType)) void putCachedAsset(key, { bytes, contentType });
    return { contentType, dataB64: bytesToB64(bytes) };
  } catch (e) {
    if (e instanceof CircleAssetError)
      logger.warn(`[NFT Meta] oct:// asset rejected: ${e.message}`);
    return null;
  }
}

export async function resolveImageUri(uri: string | null, fresh = false): Promise<string | null> {
  if (!uri) return null;
  if (uri.toLowerCase().startsWith('oct://')) {
    const a = await fetchOctAsset(uri, fresh);
    return a ? `data:${a.contentType};base64,${a.dataB64}` : null;
  }
  return resolveIpfsUrl(uri);
}

export interface NftAttribute {
  trait_type: string;
  value: string | number;
}
export interface NftRarity {
  rank?: number;
  score?: number;
  total?: number;
  traits?: Record<string, number>;
}
export interface NftMeta {
  image: string | null;
  name: string | null;
  description: string | null;
  animationUrl: string | null;
  attributes: NftAttribute[] | null;
  rarity: NftRarity | null;
}
export const EMPTY_META: NftMeta = {
  image: null,
  name: null,
  description: null,
  animationUrl: null,
  attributes: null,
  rarity: null,
};

export function parseAttrs(json: { attributes?: unknown }): NftAttribute[] | null {
  if (!Array.isArray(json.attributes)) return null;
  const out = (json.attributes as unknown[])
    .filter(
      (a): a is { trait_type: unknown; value: unknown } =>
        !!a && typeof a === 'object' && 'trait_type' in a
    )
    .map((a) => ({ trait_type: String(a.trait_type), value: a.value as string | number }));
  return out.length ? out : null;
}
export function parseRarity(json: { rarity?: unknown }): NftRarity | null {
  return json.rarity && typeof json.rarity === 'object' ? (json.rarity as NftRarity) : null;
}

const STATIC_IMAGE_FIELDS = [
  'image',
  'image_url',
  'imageUrl',
  'thumbnail',
  'thumbnail_url',
  'thumbnailUrl',
  'preview',
  'preview_url',
  'previewUrl',
  'poster',
] as const;

const isHtmlUri = (uri: string) => /\.html?(?:[?#]|$)/i.test(uri);

export function staticImageCandidates(json: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const f of STATIC_IMAGE_FIELDS) {
    const v = typeof json[f] === 'string' ? (json[f] as string).trim() : '';
    if (!v || isLivingProgramUri(v) || isHtmlUri(v) || out.includes(v)) continue;
    out.push(v);
  }
  const svg = typeof json.image_data === 'string' ? json.image_data.trim() : '';
  if (svg.startsWith('<svg')) {
    out.push(`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`);
  }
  return out;
}

export async function buildMeta(json: Record<string, unknown>, fresh = false): Promise<NftMeta> {
  const animationUrl = typeof json.animation_url === 'string' ? json.animation_url : null;
  let image: string | null = null;
  for (const c of staticImageCandidates(json)) {
    image = await resolveImageUri(c, fresh);
    if (image) break;
  }
  return {
    image,
    name: typeof json.name === 'string' ? json.name : null,
    description: typeof json.description === 'string' ? json.description : null,
    animationUrl,
    attributes: parseAttrs(json),
    rarity: parseRarity(json),
  };
}

export async function resolveNftMetadata(rawUri: string | null, fresh = false): Promise<NftMeta> {
  if (!rawUri) return EMPTY_META;
  const t0 = Date.now();
  const trimmed = rawUri.trim();

  if (trimmed.startsWith('<svg') || trimmed.startsWith('<?xml')) {
    const b64 = btoa(unescape(encodeURIComponent(trimmed)));
    return { ...EMPTY_META, image: `data:image/svg+xml;base64,${b64}` };
  }
  if (trimmed.startsWith('data:image/')) {
    return { ...EMPTY_META, image: trimmed };
  }
  if (isInlineJsonUri(trimmed)) {
    const json = parseInlineJsonUri(trimmed);
    if (!json) {
      logger.warn(`[NFT Meta] inline metadata unreadable (${trimmed.length} chars)`);
      return EMPTY_META;
    }
    return buildMeta(json, fresh);
  }
  if (trimmed.toLowerCase().startsWith('oct://')) {
    const a = await fetchOctAsset(trimmed, fresh);
    if (!a) {
      logger.warn(`[NFT Meta] [${Date.now()}] oct:// metadata fetch failed | URI: ${trimmed}`);
      return EMPTY_META;
    }
    try {
      const json = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(a.dataB64), (c) => c.charCodeAt(0)))
      );
      const meta = await buildMeta(json, fresh);
      logger.debug(
        `[NFT Meta] [${Date.now()}] oct OK | name="${meta.name}" attrs=${meta.attributes?.length ?? 0} rarity=${meta.rarity ? `rank ${meta.rarity.rank}` : 'none'} | living=${isLivingProgramUri(meta.animationUrl)} animation_url=${meta.animationUrl ?? 'none'} | ${Date.now() - t0}ms`
      );
      return meta;
    } catch (e) {
      logger.warn(
        `[NFT Meta] [${Date.now()}] oct:// metadata parse failed | URI: ${trimmed} | Error: ${e}`
      );
      return EMPTY_META;
    }
  }
  const httpUri = resolveIpfsUrl(trimmed);
  try {
    const signal = AbortSignal.timeout(10000);
    const resp = await fetch(httpUri, fresh ? { signal, cache: 'reload' } : { signal });
    if (!resp.ok) {
      logger.warn(
        `[NFT Meta] [${Date.now()}] Metadata fetch HTTP error: ${resp.status} for ${httpUri}`
      );
      return EMPTY_META;
    }
    return await buildMeta(await resp.json(), fresh);
  } catch (e) {
    logger.warn(`[NFT Meta] [${Date.now()}] Metadata fetch failed | URI: ${httpUri} | Error: ${e}`);
    return EMPTY_META;
  }
}

const importedNftKey = (networkId: string, wallet: string) =>
  `${IMPORTED_NFTS_KEY_PREFIX}${networkId}_${wallet}`;

export async function getImportedNftAddresses(
  networkId: string,
  wallet: string
): Promise<string[]> {
  if (!wallet) return [];
  const key = importedNftKey(networkId, wallet);
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] || [];
  } catch (e) {
    logger.error(`[NFT Import] getImportedNftAddresses FAILED | Key: "${key}" | Error: ${e}`);
    return [];
  }
}

export async function saveImportedNftAddresses(
  networkId: string,
  wallet: string,
  addrs: string[]
): Promise<void> {
  if (!networkId || networkId === 'undefined' || !wallet) {
    logger.error(
      `[NFT Import] saveImportedNftAddresses ABORTED - bad key parts: net="${networkId}" wallet="${wallet}"`
    );
    return;
  }
  const key = importedNftKey(networkId, wallet);
  try {
    await chrome.storage.local.set({ [key]: addrs });
  } catch (e) {
    logger.error(`[NFT Import] saveImportedNftAddresses FAILED | Error: ${e}`);
  }
}

async function migrateLegacyImports(
  networkId: string,
  wallet: string,
  heldContracts: Set<string>
): Promise<void> {
  if (!wallet) return;
  const impKey = importedNftKey(networkId, wallet);
  const legImpKey = `${IMPORTED_NFTS_KEY_PREFIX}${networkId}`;
  try {
    const store = await chrome.storage.local.get([impKey, legImpKey]);
    if (impKey in store) return;
    const legacy: string[] = store[legImpKey] || [];
    const held = legacy.filter((a) => heldContracts.has(a.toLowerCase()));
    await chrome.storage.local.set({ [impKey]: held });
    if (legacy.length)
      logger.debug(
        `[NFT] migrated imports for ${wallet.slice(0, 8)}… - kept ${held.length}/${legacy.length} held`
      );
  } catch (e) {
    logger.error(`[NFT] migrateLegacyImports failed: ${e}`);
  }
}

export const nftMetaCache = new Map<
  string,
  { name: string; symbol: string; totalSupply: string | null; timestamp: number }
>();
export const NFT_CACHE_TTL = 5 * 60 * 1000;

export const ownedIdsCache = new Map<string, { ids: string[]; ts: number; count?: number }>();
export const OWNED_IDS_TTL = 5 * 60 * 1000;
export type CardCacheEntry = {
  detail: NftTokenDetail;
  biontAttrs: { isAlive?: boolean; archetype?: number } | null;
  listing?: Listing | null;
  marketApproved?: boolean;
  ts: number;
};
export const cardDetailCache = new Map<string, CardCacheEntry>();
export const CARD_DETAIL_TTL = 5 * 60 * 1000;

export interface NftSnapshot {
  v: number;
  collections: NftCollection[];
  owned: Record<string, string[]>;
  cards: Record<
    string,
    {
      detail: NftTokenDetail;
      biontAttrs: { isAlive?: boolean; archetype?: number } | null;
      listing?: Listing | null;
      marketApproved?: boolean;
    }
  >;
  ts: number;
}
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_FRESH_MS = 60 * 1000;
export const snapshotKey = (networkId: string, wallet: string) =>
  `nft_snapshot_${networkId}_${wallet}`;

export async function loadNftSnapshot(
  networkId: string,
  wallet: string
): Promise<NftSnapshot | null> {
  try {
    const key = snapshotKey(networkId, wallet);
    const r = await chrome.storage.local.get(key);
    const snap = r[key] as NftSnapshot | undefined;
    return snap && snap.v === SNAPSHOT_VERSION ? snap : null;
  } catch {
    return null;
  }
}

export function hydrateNftCaches(networkId: string, wallet: string, snap: NftSnapshot): void {
  const ts = snap.ts || 0;
  for (const c of snap.collections) {
    const ids = snap.owned[c.contractAddress];
    if (ids && ids.length > 0)
      ownedIdsCache.set(`${networkId}:${c.contractAddress}:${wallet}`, {
        ids,
        ts,
        count: c.ownedCount,
      });
  }
  for (const [k, v] of Object.entries(snap.cards)) {
    cardDetailCache.set(`${networkId}:${k}:${wallet}`, {
      detail: v.detail,
      biontAttrs: v.biontAttrs,
      listing: v.listing,
      marketApproved: v.marketApproved,
      ts,
    });
  }
}

export let _snapshotCtx: {
  networkId: string;
  wallet: string;
  collections: NftCollection[];
} | null = null;
export let _snapshotTimer: ReturnType<typeof setTimeout> | null = null;
// Images are re-resolved from the IndexedDB asset cache on open, and living-NFT posters from
// posterCache, so a snapshot only needs the text. Inline data URLs past this size are dropped and
// the card marked unresolved, which keeps a wallet's snapshot far under the 10 MB
// chrome.storage.local quota. A poster has no URL to refetch from, so it must never rely on this.
const MAX_INLINE_IMAGE_B = 32 * 1024;
const MAX_SNAPSHOT_B = 3 * 1024 * 1024;
const slimDetail = <
  T extends { image: string | null; poster?: string | null; metaFetched: boolean },
>(
  d: T
): T => {
  const big = (v: string | null | undefined) =>
    typeof v === 'string' && v.startsWith('data:') && v.length > MAX_INLINE_IMAGE_B;
  if (!big(d.image) && !big(d.poster)) return d;
  return {
    ...d,
    image: big(d.image) ? null : d.image,
    poster: big(d.poster) ? null : d.poster,
    metaFetched: false,
  };
};
export async function persistNftSnapshot(): Promise<void> {
  const ctx = _snapshotCtx;
  if (!ctx || !ctx.wallet || !ctx.networkId || ctx.collections.length === 0) return;
  const { networkId, wallet, collections } = ctx;
  const owned: Record<string, string[]> = {};
  const cards: NftSnapshot['cards'] = {};
  for (const c of collections) {
    const oh = ownedIdsCache.get(`${networkId}:${c.contractAddress}:${wallet}`);
    if (!oh || oh.ids.length === 0) continue;
    owned[c.contractAddress] = oh.ids;
    for (const id of oh.ids) {
      const ch = cardDetailCache.get(`${networkId}:${c.contractAddress}:${id}:${wallet}`);
      if (ch?.detail.metaFetched)
        cards[`${c.contractAddress}:${id}`] = {
          detail: slimDetail(ch.detail),
          biontAttrs: ch.biontAttrs,
          listing: ch.listing,
          marketApproved: ch.marketApproved,
        };
    }
  }
  try {
    let snap: NftSnapshot = { v: SNAPSHOT_VERSION, collections, owned, cards, ts: Date.now() };
    if (JSON.stringify(snap).length > MAX_SNAPSHOT_B) {
      snap = { ...snap, cards: {} };
      logger.debug('[NFT] snapshot over budget - persisted without card details');
    }
    await chrome.storage.local.set({ [snapshotKey(networkId, wallet)]: snap });
    logger.debug(
      `[NFT] snapshot saved | ${Object.keys(owned).length} collection(s), ${Object.keys(cards).length} card(s)`
    );
  } catch (e) {
    logger.debug(`[NFT] snapshot save failed: ${e}`);
  }
}
export function scheduleSnapshotSave(): void {
  if (!_snapshotCtx) return;
  if (_snapshotTimer) clearTimeout(_snapshotTimer);
  _snapshotTimer = setTimeout(() => void persistNftSnapshot(), 2500);
}

export const NFT_SIGNAL_METHODS = [
  'token_uri',
  'transfer',
  'transfer_from',
  'safe_transfer_from',
  'approve',
  'owner_of',
  'balance_of',
  'get_name',
  'collection_name',
  'name',
  'seed_of',
];

export async function validateNftContract(
  address: string
): Promise<{ name: string; symbol: string; totalSupply: string | null } | null> {
  const t0 = Date.now();
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  logger.debug(`[NFT] [${t0}] validateNftContract | ${short}`);

  const net = await networkService.getCurrentNetworkId();
  const metaKey = `${net}:${address}`;
  const remember = async (info: { name: string; symbol: string; totalSupply: string | null }) => {
    if ((await networkService.getCurrentNetworkId()) === net) {
      nftMetaCache.set(metaKey, { ...info, timestamp: Date.now() });
    }
  };
  const cached = nftMetaCache.get(metaKey);
  if (cached && Date.now() - cached.timestamp < NFT_CACHE_TTL) {
    return { name: cached.name, symbol: cached.symbol, totalSupply: cached.totalSupply };
  }

  async function call(method: string): Promise<{ value: string | null; resolved: boolean }> {
    const TIMED_OUT = Symbol();
    try {
      const r = await Promise.race<unknown>([
        networkService.contractCallView(address, method, [], address),
        new Promise<unknown>((res) => setTimeout(() => res(TIMED_OUT), 10000)),
      ]);
      if (r === TIMED_OUT) return { value: null, resolved: false };
      return { value: r != null ? String(r) : null, resolved: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { value: null, resolved: !/timeout|failed to fetch|network|unreachable/i.test(msg) };
    }
  }

  let abiMethods: string[] = [];
  let abiOk = false;
  try {
    const abi = await networkService.jsonRpcCall('octra_contractAbi', [address]);
    abiMethods = (
      ((abi as { methods?: unknown[] })?.methods || []) as Array<{ name?: string } | string>
    ).map((m) => (typeof m === 'string' ? m : (m.name ?? '')));
    abiOk = true;
  } catch {
    logger.warn(`[NFT] [${Date.now()}] ABI unavailable for ${short}, blind-probing`);
  }

  if (abiOk) {
    if (!abiMethods.some((m) => NFT_SIGNAL_METHODS.includes(m))) {
      logger.warn(
        `[NFT] [${Date.now()}] REJECTED ${short} | ABI has no NFT methods | ${Date.now() - t0}ms`
      );
      return null;
    }
    const nameMs = ['collection_name', 'name', 'biont_name', 'get_name'].filter((m) =>
      abiMethods.includes(m)
    );
    const symM = abiMethods.includes('symbol')
      ? 'symbol'
      : abiMethods.includes('get_symbol')
        ? 'get_symbol'
        : null;
    const supM = abiMethods.includes('total_supply')
      ? 'total_supply'
      : abiMethods.includes('get_total_supply')
        ? 'get_total_supply'
        : null;
    const [names, sym, sup] = await Promise.all([
      Promise.all(nameMs.map((m) => call(m))),
      symM ? call(symM) : Promise.resolve({ value: null, resolved: true }),
      supM ? call(supM) : Promise.resolve({ value: null, resolved: true }),
    ]);
    const name = names.find((r) => r.value)?.value ?? null;
    const info = {
      name: name || sym.value || short,
      symbol: sym.value || '???',
      totalSupply: sup.value,
    };
    await remember(info);
    logger.info(
      `[NFT] [${Date.now()}] OK ${short} | "${info.name}" sym=${info.symbol} | ${Date.now() - t0}ms`
    );
    return info;
  }

  const nameMs = ['collection_name', 'name', 'biont_name', 'get_name'];
  const probes = await Promise.all(
    [...nameMs, 'get_symbol', 'symbol', 'get_total_supply', 'total_supply'].map((m) => call(m))
  );
  if (!probes.some((p) => p.resolved)) {
    logger.warn(
      `[NFT] [${Date.now()}] node unreachable validating ${short} | ${Date.now() - t0}ms`
    );
    throw new Error('NODE_UNREACHABLE');
  }
  const name = probes.slice(0, nameMs.length).find((p) => p.value)?.value ?? null;
  const symbol = probes[nameMs.length].value ?? probes[nameMs.length + 1].value ?? null;
  if (!name && !symbol) {
    logger.warn(
      `[NFT] [${Date.now()}] REJECTED ${short} | no name or symbol | ${Date.now() - t0}ms`
    );
    return null;
  }
  const info = {
    name: name || symbol || short,
    symbol: symbol || '???',
    totalSupply: probes[nameMs.length + 2].value ?? probes[nameMs.length + 3].value ?? null,
  };
  await remember(info);
  return info;
}

const NFT_VIEWS = ['owner_of', 'owners_page', 'token_uri'];
async function looksLikeNft(networkId: string, contract: string): Promise<boolean> {
  try {
    const methods = await getContractAbiMethods(networkId, contract);
    return methods.length === 0 || methods.some((m) => NFT_VIEWS.includes(m));
  } catch {
    return true;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const part = await Promise.all(items.slice(i, i + limit).map(fn));
    part.forEach((r, k) => (out[i + k] = r));
  }
  return out;
}

const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

export async function fetchGalleryCollections(
  networkId: string,
  walletAddress: string,
  prevByAddr?: Map<string, NftCollection>
): Promise<NftCollection[]> {
  const t0 = Date.now();
  let allTokens: Awaited<ReturnType<typeof networkService.getTokensByAddressStrict>> = [];
  let tokensOk = false;
  try {
    allTokens = await networkService.getTokensByAddressStrict(walletAddress);
    tokensOk = true;
  } catch (e) {
    logger.debug(`[NFT] holdings read failed: ${e}`);
  }
  const lc = (a: string) => a.toLowerCase();
  const heldTokens = allTokens.filter((tk) => tk.decimals === 0 && (parseInt(tk.balance) || 0) > 0);

  if (tokensOk) {
    await migrateLegacyImports(
      networkId,
      walletAddress,
      new Set(heldTokens.map((tk) => lc(tk.contractAddress)))
    );
  }
  const importedAddrs = await getImportedNftAddresses(networkId, walletAddress);
  const importedLc = new Set(importedAddrs.map(lc));
  const collections: NftCollection[] = [];
  const added = new Set<string>();
  const push = (c: NftCollection) => {
    if (added.has(lc(c.contractAddress))) return;
    added.add(lc(c.contractAddress));
    collections.push(c);
  };

  const held = heldTokens.filter((tk) => !importedLc.has(lc(tk.contractAddress)));
  const nftShaped = await mapLimit(held, 4, (tk) => looksLikeNft(networkId, tk.contractAddress));
  held.forEach((tk, i) => {
    if (!nftShaped[i]) return;
    const prev = prevByAddr?.get(tk.contractAddress);
    push({
      contractAddress: tk.contractAddress,
      name: tk.name || tk.symbol || prev?.name || shortAddr(tk.contractAddress),
      symbol: tk.symbol || prev?.symbol || '',
      totalSupply: prev?.totalSupply ?? null,
      ownedCount: parseInt(tk.balance) || 0,
      ownedTokenIds: [],
      countKnown: true,
      imported: false,
    });
  });

  for (const addr of importedAddrs) {
    const match = allTokens.find((tk) => tk.contractAddress === addr);
    const prev = prevByAddr?.get(addr);
    let ownedCount = tokensOk
      ? match
        ? parseInt(match.balance) || 0
        : 0
      : (prev?.ownedCount ?? 0);
    let countKnown = tokensOk && !!match;
    let info = nftMetaCache.get(`${networkId}:${addr}`) ?? null;
    if (tokensOk && !match) {
      const [count, validated] = await Promise.all([
        readBalanceOf(addr, walletAddress),
        info ? Promise.resolve(info) : validateNftContract(addr).catch((): null => null),
      ]);
      if (count !== null) {
        ownedCount = count;
        countKnown = true;
      } else {
        ownedCount = prev?.ownedCount ?? 0;
      }
      info = validated ? { ...validated, timestamp: Date.now() } : info;
    }
    push({
      contractAddress: addr,
      name: match?.name || match?.symbol || info?.name || prev?.name || shortAddr(addr),
      symbol: match?.symbol || info?.symbol || prev?.symbol || '',
      totalSupply: info?.totalSupply ?? prev?.totalSupply ?? null,
      ownedCount,
      ownedTokenIds: [],
      countKnown,
      imported: true,
    });
  }

  if (tokensOk) {
    const skip = new Set([...allTokens.map((tk) => lc(tk.contractAddress)), ...importedLc]);
    try {
      const probed = await probeCollections(
        networkId,
        walletAddress,
        [...(await knownCollections(networkId)), ...(await onsKnownCollections(networkId))],
        skip,
        (contract) => readBalanceOf(contract, walletAddress),
        () => networkService.getCurrentNetworkId().then((n) => n === networkId)
      );
      for (const p of probed) {
        push({
          contractAddress: p.address,
          name: p.name || p.symbol || shortAddr(p.address),
          symbol: p.symbol,
          totalSupply: prevByAddr?.get(p.address)?.totalSupply ?? null,
          ownedCount: p.count,
          ownedTokenIds: [],
          countKnown: true,
          imported: false,
        });
      }
    } catch (e) {
      logger.debug(`[NFT] known collection probe failed: ${e}`);
    }
  } else if (prevByAddr) {
    for (const prev of prevByAddr.values()) if (!prev.imported) push(prev);
  }

  logger.debug(
    `[NFT] fetchGalleryCollections | ${collections.length} collection(s), ${importedAddrs.length} imported | ${Date.now() - t0}ms`
  );
  return collections;
}

async function readBalanceOf(contract: string, wallet: string): Promise<number | null> {
  try {
    const raw = await withBusyRetry(() =>
      networkService.contractCallView(contract, 'balance_of', [wallet], wallet)
    );
    const s = raw != null ? String(raw).trim() : '';
    return /^\d+$/.test(s) ? parseInt(s, 10) : 0;
  } catch (e) {
    return isRevertError(e) || isMissingMethodError(e) ? 0 : null;
  }
}

export interface OwnedIdsScan {
  ids: string[];
  complete: boolean;
}

const MAX_FAILED_STREAK = 5;

async function ownedIdsByPage(
  contract: string,
  walletAddress: string,
  ceil: number,
  exactCeil: boolean,
  target: number,
  isCancelled?: () => boolean
): Promise<OwnedIdsScan> {
  const found: string[] = [];
  for (let start = 0; start < ceil && found.length < target; start += OWNERS_PAGE_SIZE) {
    if (isCancelled?.()) throw new Error('enumeration cancelled');
    const count = exactCeil ? Math.min(OWNERS_PAGE_SIZE, ceil - start) : OWNERS_PAGE_SIZE;
    let ids: string[] | null = null;
    try {
      const page = await withBusyRetry(() =>
        networkService.contractCallView(contract, 'owners_page', [start, count], walletAddress)
      );
      ids = ownedIdsFromPage(page != null ? String(page) : null, start, count, walletAddress);
    } catch {
      ids = null;
    }
    if (!ids) return { ids: found.slice(0, target), complete: false };
    found.push(...ids);
  }
  return { ids: found.slice(0, target), complete: true };
}

const NO_SUCH_VIEW = /method not found|unknown method|-32601/i;
const isNoSuchView = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === -32601 ||
  NO_SUCH_VIEW.test(e instanceof Error ? e.message : String(e));

const RECHECK_AT_MOST = 10;

export async function stillOwned(
  networkId: string,
  contractAddress: string,
  walletAddress: string,
  ids: readonly string[],
  isCancelled?: () => boolean
): Promise<boolean | null> {
  if (ids.length === 0 || ids.length > RECHECK_AT_MOST) return false;
  if (!ids.every((id) => /^\d+$/.test(id))) return false;
  if ((await onsContractFor(networkId)) === contractAddress) return false;
  for (const id of ids) {
    if (isCancelled?.()) throw new Error('enumeration cancelled');
    try {
      const owner = await withBusyRetry(() =>
        networkService.contractCallView(
          contractAddress,
          'owner_of',
          [parseInt(id, 10)],
          walletAddress
        )
      );
      if (owner == null || String(owner) !== walletAddress) return false;
    } catch (e) {
      return isRevertError(e) ? false : null;
    }
  }
  return true;
}

export async function fetchOwnedTokenIds(
  contractAddress: string,
  walletAddress: string,
  totalSupply: string | null,
  ownedCount: number,
  isCancelled?: () => boolean
): Promise<OwnedIdsScan> {
  if (ownedCount === 0) return { ids: [], complete: true };
  try {
    const r = await withBusyRetry(() =>
      networkService.jsonRpcCall(
        'contract_call',
        [contractAddress, 'total_supply', '', walletAddress],
        true
      )
    );
    const storage =
      r && typeof r === 'object' ? (r as { storage?: Record<string, string> }).storage : undefined;
    if (storage) {
      const ids = Object.keys(storage)
        .filter(
          (k) => k.startsWith('tokens:') && k.endsWith(':owner') && storage[k] === walletAddress
        )
        .map((k) => k.split(':')[1])
        .filter((id) => /^\d+$/.test(id))
        .sort((a, b) => parseInt(a) - parseInt(b))
        .slice(0, 50);
      if (ids.length > 0) {
        logger.debug(
          `[NFT Grid] owned ids via storage-map | ${contractAddress.slice(0, 10)}… -> ${ids.length}: [${ids.join(',')}]`
        );
        return { ids, complete: true };
      }
    }
  } catch (e) {
    if (!isRevertError(e) && !isNoSuchView(e)) {
      logger.debug(
        `[NFT Grid] storage read unanswered | ${contractAddress.slice(0, 10)}… (incomplete)`
      );
      return { ids: [], complete: false };
    }
  }

  const networkId = await networkService.getCurrentNetworkId();
  const methods = await getContractAbiMethods(networkId, contractAddress).catch(
    () => [] as string[]
  );
  let nextId: string | null = null;
  if (methods.includes('get_next_id')) {
    nextId = await withBusyRetry(() =>
      networkService.contractCallView(contractAddress, 'get_next_id', [], walletAddress)
    )
      .then((v): string | null => (v != null ? String(v) : null))
      .catch((): null => null);
  }
  const scanCeil = scanCeiling(nextId, totalSupply);
  const exactCeil = nextId != null && /^\d+$/.test(nextId.trim());
  const target = Math.min(ownedCount, 50);

  if (methods.includes('owners_page')) {
    const paged = await ownedIdsByPage(
      contractAddress,
      walletAddress,
      scanCeil,
      exactCeil,
      target,
      isCancelled
    );
    logger.debug(
      `[NFT Grid] owned ids via owners_page | ${contractAddress.slice(0, 10)}… -> ${paged.ids.length}: [${paged.ids.join(',')}]${paged.complete ? '' : ' (incomplete)'}`
    );
    return paged;
  }
  logger.debug(
    `[NFT Grid] owned ids via owner_of scan | ${contractAddress.slice(0, 10)}… (ceil=${scanCeil}, want=${target})`
  );
  const found: string[] = [];
  let failures = 0;
  let streak = 0;
  for (let i = 0; i < scanCeil && found.length < target && streak < MAX_FAILED_STREAK; i++) {
    if (isCancelled?.()) throw new Error('enumeration cancelled');
    let owner: unknown = null;
    try {
      owner = await withBusyRetry(() =>
        networkService.contractCallView(contractAddress, 'owner_of', [i], walletAddress)
      );
    } catch (e) {
      if (!isRevertError(e)) {
        failures += 1;
        streak += 1;
      }
      continue;
    }
    streak = 0;
    if (owner != null && String(owner) === walletAddress) found.push(String(i));
  }
  const complete = found.length >= target || failures === 0;
  logger.debug(
    `[NFT Grid] owned ids via owner_of scan | ${contractAddress.slice(0, 10)}… -> ${found.length}: [${found.join(',')}]${complete ? '' : ' (incomplete)'}`
  );
  return { ids: found, complete };
}

export function setSnapshotCtx(ctx: typeof _snapshotCtx): void {
  _snapshotCtx = ctx;
}
