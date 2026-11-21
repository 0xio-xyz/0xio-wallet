import {
  evmSpamReason,
  isSpamReason,
  tokenShown,
  type SpamReason,
} from 'src/services/tokens/tokenSpam';
import { evmVisKey, readVisibility, type VisMap } from 'src/services/tokens/tokenVisibility';
import { registerSessionCache } from 'src/utils/sessionCaches';
import { toChecksumAddress } from './accounts';
import { evmTokenKey, isEvmAddress } from './balances';
import { sentTokenContracts } from './history';
import { nftImageSrc } from './nfts';
import {
  curatedEvmTokens,
  explorerLogoUrl,
  isCuratedEvmToken,
  loadCustomEvmTokens,
  type EvmToken,
} from './tokens';

export interface DetectedToken {
  contract: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  balance: string;
  price: number | null;
  verified: boolean | null;
  spam: boolean | null;
  spamReason: SpamReason | null;
  logo: string | null;
}

export interface DetectedRecord {
  at: number;
  indexed: boolean;
  complete: boolean;
  items: DetectedToken[];
  sent: string[];
}

const ORACLE_TOKENS = 'https://oracle.0xio.xyz/api/evm/tokens';
export const DETECTED_PREFIX = '0xio_evm_detected_';
export const SENT_PREFIX = '0xio_evm_sent_';
export const DETECT_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;
const MAX_ITEMS = 200;
const MAX_SENT = 500;
const SYMBOL_MAX = 11;
const NAME_MAX = 40;
const NOT_INDEXED = new Set([400, 402, 404, 503]);

// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

export const detectedKey = (chainId: number, address: string) =>
  `${DETECTED_PREFIX}${chainId}_${address.toLowerCase()}`;

export const sentKey = (chainId: number, address: string) =>
  `${SENT_PREFIX}${chainId}_${address.toLowerCase()}`;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(HIDDEN, '').trim();
  return s && [...s].length <= max ? s : null;
};

export function parseDetectedToken(raw: unknown): DetectedToken | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const it = raw as Record<string, unknown>;
  if (!isEvmAddress(it.contract)) return null;
  const decimals = it.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    return null;
  const balance = it.balance;
  if (typeof balance !== 'string' || !/^\d{1,78}$/.test(balance) || /^0+$/.test(balance)) {
    return null;
  }
  const price =
    typeof it.price === 'number' && Number.isFinite(it.price) && it.price > 0 ? it.price : null;
  const spam = typeof it.spam === 'boolean' ? it.spam : null;
  const reason = isSpamReason(it.spamReason) ? it.spamReason : null;
  return {
    contract: toChecksumAddress(it.contract),
    symbol: text(it.symbol, SYMBOL_MAX),
    name: text(it.name, NAME_MAX),
    decimals,
    balance,
    price,
    verified: typeof it.verified === 'boolean' ? it.verified : null,
    spam,
    spamReason: spam ? (reason ?? 'flagged') : null,
    logo: spam ? null : explorerLogoUrl(it.logo),
  };
}

function parseItems(list: unknown): DetectedToken[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: DetectedToken[] = [];
  for (const raw of list) {
    if (out.length >= MAX_ITEMS) break;
    const item = parseDetectedToken(raw);
    if (!item) continue;
    const c = item.contract.toLowerCase();
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(item);
  }
  return out;
}

export function parseOracleTokens(
  body: unknown
): { items: DetectedToken[]; complete: boolean } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.items)) return null;
  return { items: parseItems(b.items), complete: b.complete === true };
}

export async function fetchOracleTokens(
  chainId: number,
  address: string
): Promise<{ items: DetectedToken[]; complete: boolean } | null> {
  if (!isEvmAddress(address)) throw new Error('Invalid EVM address');
  const res = await fetch(`${ORACLE_TOKENS}?chain=${chainId}&address=${address}`, {
    credentials: 'omit',
    headers: { 'x-0xio-client': 'extension' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (NOT_INDEXED.has(res.status)) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = parseOracleTokens(await res.json());
  if (!parsed) throw new Error('Bad token index response');
  return parsed;
}

export function cleanSentList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const c of raw) {
    if (out.size >= MAX_SENT) break;
    if (isEvmAddress(c)) out.add(c.toLowerCase());
  }
  return [...out];
}

export function cleanDetectedRecord(raw: unknown): DetectedRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  return {
    at: r.at,
    indexed: r.indexed !== false,
    complete: r.complete === true,
    items: parseItems(r.items),
    sent: cleanSentList(r.sent),
  };
}

export function detectedSignature(raw: unknown): string {
  const r = cleanDetectedRecord(raw);
  if (!r) return '';
  return JSON.stringify([
    r.indexed,
    r.items.map((i) => [
      i.contract,
      i.symbol,
      i.name,
      i.decimals,
      i.spam,
      i.spamReason,
      !!i.price,
      i.logo,
    ]),
    r.sent,
  ]);
}

const mem = new Map<string, DetectedRecord>();
const sentMem = new Map<string, string[]>();
const inflight = new Map<string, Promise<DetectedRecord | null>>();
registerSessionCache(() => {
  mem.clear();
  sentMem.clear();
  inflight.clear();
});

const withSent = (rec: DetectedRecord | undefined, local: readonly string[] | undefined) => {
  if (!rec || !local?.length) return rec;
  const have = new Set(rec.sent);
  return local.every((c) => have.has(c))
    ? rec
    : { ...rec, sent: cleanSentList([...local, ...rec.sent]) };
};

export const peekDetected = (chainId: number, address: string): DetectedRecord | undefined =>
  withSent(mem.get(detectedKey(chainId, address)), sentMem.get(sentKey(chainId, address)));

export async function readDetected(
  chainIds: readonly number[],
  address: string
): Promise<Record<number, DetectedRecord | undefined>> {
  const keys = chainIds.map((c) => detectedKey(c, address));
  const sentKeys = chainIds.map((c) => sentKey(c, address));
  const missing = keys.filter((k) => !mem.has(k));
  const missingSent = sentKeys.filter((k) => !sentMem.has(k));
  if (missing.length || missingSent.length) {
    try {
      const stored = await chrome.storage.local.get([...missing, ...missingSent]);
      for (const k of missing) {
        const rec = cleanDetectedRecord(stored?.[k]);
        if (rec && !mem.has(k)) mem.set(k, rec);
      }
      for (const k of missingSent) {
        if (!sentMem.has(k)) sentMem.set(k, cleanSentList(stored?.[k]));
      }
    } catch {}
  }
  return Object.fromEntries(
    chainIds.map((c, i) => [c, withSent(mem.get(keys[i]), sentMem.get(sentKeys[i]))])
  );
}

export function primeSent(key: string, raw: unknown): void {
  sentMem.set(key, cleanSentList(raw));
}

let sentQueue: Promise<unknown> = Promise.resolve();

export function recordSentTokens(
  chainId: number,
  address: string,
  contracts: readonly string[]
): Promise<boolean> {
  const add = cleanSentList(contracts);
  if (!isEvmAddress(address) || !add.length) return Promise.resolve(true);
  const key = sentKey(chainId, address);
  const job = sentQueue.then(async () => {
    try {
      const stored = await chrome.storage.local.get([key]);
      const prev = cleanSentList(stored?.[key]);
      const next = cleanSentList([...add, ...prev]);
      if (next.length !== prev.length || next.some((c, i) => c !== prev[i])) {
        await chrome.storage.local.set({ [key]: next });
      }
      sentMem.set(key, next);
      return true;
    } catch {
      sentMem.set(key, cleanSentList([...add, ...(sentMem.get(key) ?? [])]));
      return false;
    }
  });
  sentQueue = job;
  return job;
}

export function primeDetected(key: string, raw: unknown): void {
  const rec = cleanDetectedRecord(raw);
  if (rec) mem.set(key, rec);
  else mem.delete(key);
}

export const isFresh = (rec: DetectedRecord | undefined, now = Date.now()) =>
  !!rec && now - rec.at < DETECT_TTL_MS && rec.at <= now;

interface NeverSpam {
  imported: ReadonlySet<string>;
  sent: ReadonlySet<string>;
}

export function detectedSpamReason(
  chainId: number,
  item: DetectedToken,
  never: NeverSpam
): SpamReason | null {
  const c = item.contract.toLowerCase();
  if (isCuratedEvmToken(chainId, c) || never.imported.has(c) || never.sent.has(c)) return null;
  if (item.spam !== null) return item.spam ? item.spamReason : null;
  return evmSpamReason(chainId, c, {
    symbol: item.symbol,
    name: item.name,
    priced: item.price !== null,
  });
}

export const detectedLogo = (item: DetectedToken, spam: SpamReason | null): string | null =>
  spam === null && item.logo ? nftImageSrc(item.logo) : null;

export function detectedEvmToken(
  chainId: number,
  item: DetectedToken,
  spam: SpamReason | null
): EvmToken {
  const symbol = item.symbol ?? (item.name ? [...item.name].slice(0, SYMBOL_MAX).join('') : null);
  const short = `${item.contract.slice(0, 6)}...${item.contract.slice(-4)}`;
  return {
    chainId,
    address: item.contract,
    symbol: symbol ?? short,
    name: item.name ?? symbol ?? short,
    decimals: item.decimals,
    logo: detectedLogo(item, spam),
    custom: true,
    detected: true,
  };
}

async function writeDetected(key: string, rec: DetectedRecord): Promise<void> {
  mem.set(key, rec);
  try {
    await chrome.storage.local.set({ [key]: rec });
  } catch {}
}

function mergeIncomplete(prev: DetectedToken[], next: DetectedToken[]): DetectedToken[] {
  const have = new Set(next.map((i) => i.contract.toLowerCase()));
  const kept = prev.filter((i) => !have.has(i.contract.toLowerCase()));
  return [...next, ...kept].slice(0, MAX_ITEMS);
}

async function refreshChain(
  chainId: number,
  address: string,
  force: boolean
): Promise<DetectedRecord | null> {
  const key = detectedKey(chainId, address);
  const prev = (await readDetected([chainId], address))[chainId];
  if (!force && isFresh(prev)) return prev ?? null;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async (): Promise<DetectedRecord | null> => {
    let res: Awaited<ReturnType<typeof fetchOracleTokens>>;
    try {
      res = await fetchOracleTokens(chainId, address);
    } catch {
      return prev ?? null;
    }
    const at = Date.now();
    if (res === null) {
      const rec: DetectedRecord = { at, indexed: false, complete: true, items: [], sent: [] };
      await writeDetected(key, rec);
      return withSent(rec, sentMem.get(sentKey(chainId, address))) ?? rec;
    }
    const items = res.complete || !prev ? res.items : mergeIncomplete(prev.items, res.items);
    let sent = prev?.sent ?? [];
    const imported = new Set(
      (await loadCustomEvmTokens(chainId)).map((t) => t.address?.toLowerCase() ?? '')
    );
    const judged = items.some(
      (i) => detectedSpamReason(chainId, i, { imported, sent: new Set(sent) }) !== null
    );
    if (judged) {
      try {
        const fresh = await sentTokenContracts(chainId, address);
        await recordSentTokens(chainId, address, fresh);
        sent = cleanSentList([...sent, ...fresh]);
      } catch {}
    }
    const rec: DetectedRecord = { at, indexed: true, complete: res.complete, items, sent };
    await writeDetected(key, rec);
    return withSent(rec, sentMem.get(sentKey(chainId, address))) ?? rec;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export async function refreshDetection(
  address: string,
  chainIds: readonly number[],
  opts: { force?: boolean } = {}
): Promise<Record<number, DetectedRecord | undefined>> {
  if (!isEvmAddress(address)) return {};
  const recs = await Promise.all(chainIds.map((c) => refreshChain(c, address, !!opts.force)));
  return Object.fromEntries(chainIds.map((c, i) => [c, recs[i] ?? undefined]));
}

export interface EvmTokenPlan {
  custom: EvmToken[];
  exclude: Set<string>;
  shown: Set<string>;
}

export function planEvmTokens(input: {
  chainIds: readonly number[];
  imported: readonly EvmToken[];
  detected: Readonly<Record<number, DetectedRecord | undefined>>;
  vis: Readonly<Record<number, VisMap | undefined>>;
}): EvmTokenPlan {
  const plan: EvmTokenPlan = { custom: [], exclude: new Set(), shown: new Set() };
  for (const chainId of input.chainIds) {
    const vis = input.vis[chainId] ?? {};
    const taken = new Set<string>();
    for (const t of curatedEvmTokens(chainId)) {
      const c = t.address!.toLowerCase();
      taken.add(c);
      const key = evmTokenKey(chainId, t);
      if (vis[c] === false) plan.exclude.add(key);
      else plan.shown.add(key);
    }
    const imported = new Set<string>();
    for (const t of input.imported) {
      const c = t.address?.toLowerCase();
      if (t.chainId !== chainId || !c || taken.has(c)) continue;
      taken.add(c);
      imported.add(c);
      if (vis[c] === false) continue;
      plan.custom.push(t);
      plan.shown.add(evmTokenKey(chainId, t));
    }
    const rec = input.detected[chainId];
    if (!rec) continue;
    const sent = new Set(rec.sent);
    for (const item of rec.items) {
      const c = item.contract.toLowerCase();
      if (taken.has(c)) continue;
      taken.add(c);
      const spam = detectedSpamReason(chainId, item, { imported, sent });
      if (!tokenShown(vis[c], spam)) continue;
      const token = detectedEvmToken(chainId, item, spam);
      plan.custom.push(token);
      plan.shown.add(evmTokenKey(chainId, token));
    }
  }
  return plan;
}

export async function loadEvmTokenPlan(
  address: string,
  chainIds: readonly number[]
): Promise<EvmTokenPlan> {
  const [imported, detected, visByKey] = await Promise.all([
    loadCustomEvmTokens(),
    readDetected(chainIds, address),
    readVisibility(chainIds.map((c) => evmVisKey(c, address))),
  ]);
  const vis = Object.fromEntries(chainIds.map((c) => [c, visByKey[evmVisKey(c, address)]]));
  return planEvmTokens({ chainIds, imported, detected, vis });
}
