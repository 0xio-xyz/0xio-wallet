import { networkService } from '../network/NetworkService';
import type { NetworkPin } from '../network/txScope';
import { ZeroXIOConfig } from 'src/utils/config';
import { fromUnits } from 'src/utils/amount';
import { registerSessionCache } from 'src/utils/sessionCaches';
import { isOctAddress } from 'src/utils/octra/address';
import { octraSpamReason, type SpamReason } from './tokenSpam';

export const TOKEN_LIST_URL =
  'https://raw.githubusercontent.com/0xio-xyz/Token-lists/main/octra.tokenlist.json';
export const TOKEN_LIST_CACHE_KEY = 'octra_token_list_v1';
export const TOKEN_LIST_TTL_MS = 6 * 60 * 60_000;
export const TOKEN_META_KEY = 'octra_token_meta_v1';
export const IMPORTED_TOKENS_KEY_PREFIX = 'imported_tokens_';
export const OCT_LOGO =
  'https://cdn.jsdelivr.net/gh/0xio-xyz/Token-lists@main/logos/Octra/Oct_Public.svg';

export interface ListedToken {
  network?: string;
  address: string;
  name: string;
  symbol: string;
  decimals?: number;
  logoURI?: string;
  tags?: string[];
  extensions?: { isPrivate?: boolean; [key: string]: unknown };
}

export interface TokenMeta {
  symbol: string;
  name: string;
  decimals: number;
}

export interface ContractToken extends TokenMeta {
  contractAddress: string;
  balance: string;
  logoURI?: string;
}

export interface OctraHoldings {
  balances: Record<string, string>;
  imported: ContractToken[];
  held: ContractToken[];
  read: boolean;
}

export interface TokenListEntry {
  at: number;
  tokens: ListedToken[];
}

const isListedToken = (v: unknown): v is ListedToken => {
  const t = v as ListedToken | null;
  return (
    !!t &&
    typeof t === 'object' &&
    typeof t.address === 'string' &&
    typeof t.symbol === 'string' &&
    typeof t.name === 'string'
  );
};

const isListEntry = (v: unknown): v is TokenListEntry => {
  const e = v as TokenListEntry | null;
  return !!e && typeof e.at === 'number' && Array.isArray(e.tokens);
};

let listMem: TokenListEntry | null = null;
let listFetch: Promise<TokenListEntry> | null = null;

export const peekTokenList = (): TokenListEntry | null => listMem;

export const tokenListFresh = (e: TokenListEntry | null, now = Date.now()): boolean =>
  !!e && now - e.at < TOKEN_LIST_TTL_MS;

export async function readCachedTokenList(): Promise<TokenListEntry | null> {
  if (listMem) return listMem;
  try {
    const stored = (await chrome.storage.local.get(TOKEN_LIST_CACHE_KEY))?.[TOKEN_LIST_CACHE_KEY];
    if (!isListEntry(stored)) return null;
    listMem = { at: stored.at, tokens: stored.tokens.filter(isListedToken) };
    return listMem;
  } catch {
    return null;
  }
}

export function fetchTokenList(): Promise<TokenListEntry> {
  listFetch ??= (async () => {
    const res = await fetch(TOKEN_LIST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.tokens)) throw new Error('Invalid token list');
    const entry: TokenListEntry = { at: Date.now(), tokens: data.tokens.filter(isListedToken) };
    listMem = entry;
    try {
      await chrome.storage.local.set({ [TOKEN_LIST_CACHE_KEY]: entry });
    } catch {}
    return entry;
  })().finally(() => {
    listFetch = null;
  });
  return listFetch;
}

export async function loadTokenList(): Promise<TokenListEntry | null> {
  const cached = await readCachedTokenList();
  if (tokenListFresh(cached)) return cached;
  try {
    return await fetchTokenList();
  } catch {
    return cached;
  }
}

export function tokensForNetwork(
  list: ListedToken[],
  tag: string | undefined,
  privacy: boolean
): ListedToken[] {
  const own = tag ? list.filter((t) => t.network === tag) : [];
  const isNative = (t: ListedToken) => !!t.tags?.includes('native') && !t.extensions?.isPrivate;
  const isPrivate = (t: ListedToken) => !!t.extensions?.isPrivate;
  const native = own.find(isNative) ?? {
    network: tag,
    address: 'native',
    symbol: 'OCT',
    name: 'Octra',
    decimals: 6,
    logoURI: OCT_LOGO,
    tags: ['native'],
  };
  const encrypted = privacy
    ? [
        own.find(isPrivate) ?? {
          network: tag,
          address: 'native-private',
          symbol: 'OCT',
          name: 'Octra',
          decimals: 6,
          logoURI: OCT_LOGO,
          tags: ['native', 'private'],
          extensions: { isPrivate: true },
        },
      ]
    : [];
  return [native, ...encrypted, ...own.filter((t) => !isNative(t) && !isPrivate(t))];
}

export const isContractToken = (t: ListedToken): boolean =>
  !t.tags?.includes('native') && !t.extensions?.isPrivate;

const metaMem = new Map<string, TokenMeta>();
const notTokens = new Set<string>();
let metaHydrated: Promise<void> | null = null;
const metaId = (networkId: string, contract: string) => `${networkId}:${contract}`;

const isMeta = (v: unknown): v is TokenMeta => {
  const m = v as TokenMeta | null;
  return (
    !!m &&
    typeof m.symbol === 'string' &&
    typeof m.name === 'string' &&
    Number.isInteger(m.decimals) &&
    m.decimals >= 0 &&
    m.decimals <= 36
  );
};

function hydrateMeta(): Promise<void> {
  metaHydrated ??= (async () => {
    try {
      const stored = (await chrome.storage.local.get(TOKEN_META_KEY))?.[TOKEN_META_KEY];
      if (!stored || typeof stored !== 'object') return;
      for (const [id, meta] of Object.entries(stored as Record<string, unknown>)) {
        if (isMeta(meta) && !metaMem.has(id)) metaMem.set(id, meta);
      }
    } catch {}
  })();
  return metaHydrated;
}

export function rememberTokenMeta(networkId: string, contract: string, meta: TokenMeta): void {
  if (!isMeta(meta)) return;
  const id = metaId(networkId, contract);
  const prev = metaMem.get(id);
  if (
    prev &&
    prev.symbol === meta.symbol &&
    prev.name === meta.name &&
    prev.decimals === meta.decimals
  ) {
    return;
  }
  metaMem.set(id, { symbol: meta.symbol, name: meta.name, decimals: meta.decimals });
  try {
    chrome.storage.local.set({ [TOKEN_META_KEY]: Object.fromEntries(metaMem) }).catch(() => {});
  } catch {}
}

export async function fetchTokenMeta(contract: string, at?: NetworkPin): Promise<TokenMeta | null> {
  const [symbol, name, decimalsRaw] = await Promise.all([
    networkService.getContractStorageStrict(contract, 'symbol', at),
    networkService.getContractStorageStrict(contract, 'name', at),
    networkService.getContractStorageStrict(contract, 'decimals', at),
  ]);
  if (!symbol) return null;
  const raw = String(decimalsRaw ?? '0').trim();
  const decimals = /^\d{1,2}$/.test(raw) ? parseInt(raw, 10) : NaN;
  if (!(decimals >= 0 && decimals <= 36)) return null;
  return { symbol, name: name || symbol, decimals };
}

export async function readTokenMeta(
  networkId: string,
  contract: string,
  at?: NetworkPin
): Promise<TokenMeta | null> {
  await hydrateMeta();
  const id = metaId(networkId, contract);
  const hit = metaMem.get(id);
  if (hit) return hit;
  if (notTokens.has(id)) return null;
  const meta = await fetchTokenMeta(contract, at);
  if (meta) rememberTokenMeta(networkId, contract, meta);
  else notTokens.add(id);
  return meta;
}

export function resetOctraTokenCaches(): void {
  metaMem.clear();
  notTokens.clear();
  metaHydrated = null;
  listMem = null;
}

export async function getImportedAddresses(networkId: string): Promise<string[]> {
  try {
    const key = `${IMPORTED_TOKENS_KEY_PREFIX}${networkId}`;
    const stored = (await chrome.storage.local.get(key))?.[key];
    return Array.isArray(stored) ? stored.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveImportedAddresses(networkId: string, addrs: string[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [`${IMPORTED_TOKENS_KEY_PREFIX}${networkId}`]: addrs });
  } catch {}
}

export async function readOctraHoldings(opts: {
  networkId: string;
  address: string;
  imports: string[];
  previous?: ContractToken[];
  at?: NetworkPin;
  known?: readonly string[];
}): Promise<OctraHoldings> {
  const { networkId, address, imports, previous = [], at } = opts;
  const rows = await networkService.getTokensByAddressStrict(address, at);
  const balances: Record<string, string> = {};
  const held = new Map<string, (typeof rows)[number]>();
  const skip = new Set([...imports, ...(opts.known ?? [])]);
  const detected: ContractToken[] = [];
  for (const r of rows) {
    if (!r.contractAddress) continue;
    balances[r.contractAddress] = r.balance;
    held.set(r.contractAddress, r);
    if (detected.length < MAX_DETECTED && isDetectable(r) && !skip.has(r.contractAddress)) {
      detected.push({
        contractAddress: r.contractAddress,
        symbol: r.symbol,
        name: r.name || r.symbol,
        decimals: r.decimals,
        balance: r.balance,
      });
    }
  }
  const before = new Map(previous.map((t) => [t.contractAddress, t]));
  const imported: ContractToken[] = [];
  for (const addr of imports) {
    const onChain = held.get(addr);
    if (onChain) {
      const meta = { symbol: onChain.symbol, name: onChain.name, decimals: onChain.decimals };
      rememberTokenMeta(networkId, addr, meta);
      imported.push({ contractAddress: addr, ...meta, balance: onChain.balance });
      continue;
    }
    let meta: TokenMeta | null | undefined;
    try {
      meta = await readTokenMeta(networkId, addr, at);
    } catch {
      meta = undefined;
    }
    if (meta === null) continue;
    const known = meta ?? before.get(addr);
    if (!known) continue;
    imported.push({
      contractAddress: addr,
      symbol: known.symbol,
      name: known.name,
      decimals: known.decimals,
      balance: '0',
    });
  }
  return { balances, imported, held: detected, read: true };
}

const MAX_DETECTED = 200;

function isDetectable(r: {
  contractAddress: string;
  symbol: string;
  decimals: number;
  balance: string;
}): boolean {
  return (
    isOctAddress(r.contractAddress) &&
    !!r.symbol &&
    Number.isInteger(r.decimals) &&
    r.decimals > 0 &&
    r.decimals <= 36 &&
    /^\d{1,78}$/.test(r.balance) &&
    !/^0+$/.test(r.balance)
  );
}

export function octraTokenSpam(
  networkId: string,
  t: Pick<ContractToken, 'contractAddress' | 'symbol' | 'name'>
): SpamReason | null {
  return octraSpamReason(networkId, t.contractAddress, {
    symbol: t.symbol,
    name: t.name,
    priced: contractPriceSymbol(networkId, t.contractAddress) !== null,
  });
}

/** The price symbol of an Octra contract token, by contract only. Never by its symbol. */
export function contractPriceSymbol(networkId: string, contract: string): 'OCT' | null {
  const woct = ZeroXIOConfig.CONTRACTS.WOCT[networkId];
  return woct && contract === woct ? 'OCT' : null;
}

export function unitsToNumber(raw: string | null | undefined, decimals: number): number | null {
  if (raw == null || !/^\d+$/.test(String(raw).trim())) return null;
  return parseFloat(fromUnits(String(raw).trim(), decimals));
}

const holdingsMem = new Map<string, OctraHoldings>();
registerSessionCache(() => holdingsMem.clear());

export const octraHoldingsScope = (networkId: string, address: string) => `${networkId}:${address}`;

export const cachedHoldings = (scope: string): OctraHoldings | undefined => holdingsMem.get(scope);

export function storeHoldings(scope: string, data: OctraHoldings): void {
  holdingsMem.set(scope, data);
}

export function forgetImported(networkId: string, contract: string): void {
  for (const [scope, data] of holdingsMem) {
    if (!scope.startsWith(`${networkId}:`)) continue;
    holdingsMem.set(scope, {
      ...data,
      imported: data.imported.filter((t) => t.contractAddress !== contract),
    });
  }
}
