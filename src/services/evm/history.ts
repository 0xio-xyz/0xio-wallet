import { fromUnits } from 'src/utils/amount';
import { isEvmAddress } from './balances';
import { feeWei, readEvmCall, type EvmCall, type EvmMove } from './callDetail';
import type { EvmNetwork } from './networks';
import { evmTokensFor, loadCustomEvmTokens, type EvmToken } from './tokens';

const ORACLE_HISTORY = 'https://oracle.0xio.xyz/api/evm/history';

/** Chains the oracle reads from Blockscout with its own key, so no key ships in the extension. */
const ORACLE_CHAINS = new Set([1, 11155111, 4663, 46630]);

const KEYLESS: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  11155111: 'https://eth-sepolia.blockscout.com',
};

const EXPLORER_UI: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  11155111: 'https://eth-sepolia.blockscout.com',
  4663: 'https://robinhoodchain.blockscout.com',
  46630: 'https://explorer.testnet.chain.robinhood.com',
};

const TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 8_000;
const CHAINS_AT_ONCE = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCKSCOUT_TTL_MS = 7 * DAY_MS;
const NOT_BLOCKSCOUT_TTL_MS = DAY_MS;
const UNREACHABLE_TTL_MS = 60 * 60 * 1000;
const NOT_BLOCKSCOUT_HOST = /(scan\.(io|com|org|build)|snowtrace\.io)$/i;

export const blockscoutProbeKey = (chainId: number) => `evm_blockscout:${chainId}`;

export const evmTxUrl = (chainId: number, hash: string): string | null =>
  EXPLORER_UI[chainId] ? `${EXPLORER_UI[chainId]}/tx/${hash}` : null;

export const evmExplorerBase = (chainId: number): string | null => EXPLORER_UI[chainId] ?? null;

export const evmHistorySupported = (chainId: number): boolean =>
  ORACLE_CHAINS.has(chainId) || chainId in KEYLESS;

export interface EvmHistoryItem {
  key: string;
  chainId: number;
  chainName: string;
  testnet: boolean;
  hash: string;
  timestamp: number;
  direction: 'incoming' | 'outgoing' | 'self';
  from: string;
  to: string;
  token: EvmToken | null;
  amount: string;
  method: string | null;
  failed: boolean;
  explorerUrl: string;
  call?: EvmCall | null;
  moved?: EvmMove[];
  fee?: string | null;
}

export interface EvmHistoryResult {
  items: EvmHistoryItem[];
  failedChains: number[];
  unavailableChains: number[];
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const hashOf = (v: unknown): string | null => {
  const h = str(obj(v)?.hash);
  return h && isEvmAddress(h) ? h : null;
};
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const txHashOf = (v: unknown): string | null => {
  const h = str(v);
  return h && TX_HASH.test(h) ? h.toLowerCase() : null;
};
const seconds = (v: unknown): number | null => {
  const ms = Date.parse(str(v) ?? '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};
const units = (v: unknown): bigint | null => {
  const s = str(v);
  return s && /^\d{1,78}$/.test(s) ? BigInt(s) : null;
};

function directionOf(me: string, from: string, to: string): EvmHistoryItem['direction'] | null {
  const out = from.toLowerCase() === me;
  const inc = to.toLowerCase() === me;
  return out && inc ? 'self' : out ? 'outgoing' : inc ? 'incoming' : null;
}

async function request<T>(
  url: string,
  opts: { signal?: AbortSignal; headers?: Record<string, string>; timeoutMs?: number },
  read: (res: Response) => Promise<T>
): Promise<T> {
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      credentials: 'omit',
      headers: opts.headers,
    });
    return await read(res);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
}

const getJson = (url: string, signal?: AbortSignal, headers?: Record<string, string>) =>
  request(url, { signal, headers }, async (res): Promise<Json> => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = obj(await res.json());
    if (!body) throw new Error('Bad response');
    return body;
  });

interface ProbeRecord {
  base: string;
  ok: boolean;
  until: number;
}

const probeMem = new Map<number, ProbeRecord>();
const probing = new Map<string, Promise<boolean>>();

const isProbe = (v: unknown): v is ProbeRecord => {
  const r = obj(v);
  return (
    !!r && typeof r.base === 'string' && typeof r.ok === 'boolean' && typeof r.until === 'number'
  );
};

const probeFresh = (r: ProbeRecord | null | undefined, base: string): r is ProbeRecord => {
  const left = r ? r.until - Date.now() : 0;
  return !!r && r.base === base && left > 0 && left <= BLOCKSCOUT_TTL_MS;
};

async function readProbe(chainId: number, base: string): Promise<boolean | null> {
  const mem = probeMem.get(chainId);
  if (probeFresh(mem, base)) return mem.ok;
  const key = blockscoutProbeKey(chainId);
  try {
    const stored = (await chrome.storage.local.get([key]))?.[key];
    if (isProbe(stored) && probeFresh(stored, base)) {
      probeMem.set(chainId, stored);
      return stored.ok;
    }
  } catch {}
  return null;
}

async function saveProbe(chainId: number, rec: ProbeRecord): Promise<void> {
  probeMem.set(chainId, rec);
  try {
    await chrome.storage.local.set({ [blockscoutProbeKey(chainId)]: rec });
  } catch {}
}

type Probe = { ok: boolean; ttl: number };

async function probeStats(base: string): Promise<Probe> {
  if (NOT_BLOCKSCOUT_HOST.test(new URL(base).hostname)) {
    return { ok: false, ttl: NOT_BLOCKSCOUT_TTL_MS };
  }
  try {
    return await request(
      `${base}/api/v2/stats`,
      { timeoutMs: PROBE_TIMEOUT_MS },
      async (res): Promise<Probe> => {
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const body = res.ok ? obj(await res.json().catch((): null => null)) : null;
        const ok =
          !!body &&
          ['total_blocks', 'total_transactions', 'total_addresses'].some((k) => k in body);
        return { ok, ttl: ok ? BLOCKSCOUT_TTL_MS : NOT_BLOCKSCOUT_TTL_MS };
      }
    );
  } catch (e) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (!(e instanceof TypeError) || offline) throw e;
    return { ok: false, ttl: UNREACHABLE_TTL_MS };
  }
}

export async function isBlockscoutExplorer(chainId: number, base: string): Promise<boolean> {
  const known = await readProbe(chainId, base);
  if (known !== null) return known;
  const key = `${chainId}|${base}`;
  let job = probing.get(key);
  if (!job) {
    job = probeStats(base)
      .then(async ({ ok, ttl }) => {
        await saveProbe(chainId, { base, ok, until: Date.now() + ttl });
        return ok;
      })
      .finally(() => probing.delete(key));
    probing.set(key, job);
  }
  return job;
}

export async function keylessApiBase(chainId: number, explorerUrl: string): Promise<string | null> {
  if (KEYLESS[chainId]) return KEYLESS[chainId];
  const base = explorerUrl.replace(/\/tx\/[^/]*$/, '');
  if (!/^https:\/\/[^\s/]+$/i.test(base)) return null;
  try {
    return (await isBlockscoutExplorer(chainId, base)) ? base : null;
  } catch {
    return null;
  }
}

function explorerOf(network: EvmNetwork): string | null {
  const own = (network as EvmNetwork & { explorerUrl?: unknown }).explorerUrl;
  if (typeof own === 'string' && /^https:\/\/[^\s/]+/i.test(own)) return own.replace(/\/+$/, '');
  return EXPLORER_UI[network.chainId] ?? null;
}

interface Pages {
  txs: Json;
  transfers: Json;
}

async function fromOracle(chainId: number, address: string, signal?: AbortSignal): Promise<Pages> {
  const url = `${ORACLE_HISTORY}?chain=${chainId}&address=${address}`;
  const body = await getJson(url, signal, { 'x-0xio-client': 'extension' });
  return { txs: { items: body.transactions }, transfers: { items: body.token_transfers } };
}

async function fromKeyless(base: string, address: string, signal?: AbortSignal): Promise<Pages> {
  const [txs, transfers] = await Promise.all([
    getJson(`${base}/api/v2/addresses/${address}/transactions`, signal),
    getJson(`${base}/api/v2/addresses/${address}/token-transfers?type=ERC-20`, signal),
  ]);
  return { txs, transfers };
}

export async function rawTransactions(
  chainId: number,
  address: string,
  signal?: AbortSignal
): Promise<Array<Record<string, unknown>>> {
  const pages = await pagesFor(chainId, address, signal);
  const items = pages?.txs.items;
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

async function pagesFor(
  chainId: number,
  address: string,
  signal?: AbortSignal,
  explorer?: string | null
): Promise<Pages | null> {
  let failure: unknown = null;
  if (ORACLE_CHAINS.has(chainId)) {
    try {
      return await fromOracle(chainId, address, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      failure = e;
    }
  }
  let base = KEYLESS[chainId] ?? null;
  if (!base && explorer) {
    try {
      if (await isBlockscoutExplorer(chainId, explorer)) base = explorer;
    } catch (e) {
      throw failure ?? e;
    }
  }
  if (base) return fromKeyless(base, address, signal);
  if (failure) throw failure;
  return null;
}

export async function sentTokenContracts(
  chainId: number,
  address: string,
  signal?: AbortSignal
): Promise<string[]> {
  if (!isEvmAddress(address) || !evmHistorySupported(chainId)) return [];
  const me = address.toLowerCase();
  const transfers = (await pagesFor(chainId, address, signal))?.transfers.items;
  const out = new Set<string>();
  for (const raw of Array.isArray(transfers) ? transfers : []) {
    const it = obj(raw);
    const from = hashOf(it?.from)?.toLowerCase();
    const contract = str(obj(it?.token)?.address_hash)?.toLowerCase();
    if (from === me && contract && isEvmAddress(contract)) out.add(contract);
  }
  return [...out];
}

/**
 * The latest page of one chain. Token rows come only from the curated list, imports and the
 * detected tokens the caller passes (shown ones, never spam or hidden), and transfers of nothing
 * are dropped, so spam tokens and address-poisoning sends never reach the list.
 */
async function chainHistory(
  address: string,
  network: EvmNetwork,
  detected: readonly EvmToken[],
  signal?: AbortSignal
): Promise<EvmHistoryItem[] | null> {
  const explorer = explorerOf(network);
  const pages = await pagesFor(network.chainId, address, signal, explorer);
  if (!pages) return null;
  const { txs, transfers } = pages;
  const me = address.toLowerCase();
  const tokens = evmTokensFor(network.chainId, {
    network,
    custom: await loadCustomEvmTokens(network.chainId),
  });
  const native = tokens.find((t) => t.address === null) ?? null;
  const byContract = new Map(
    tokens.filter((t) => t.address).map((t) => [t.address!.toLowerCase(), t])
  );
  for (const t of detected) {
    const c = t.address?.toLowerCase();
    if (t.chainId === network.chainId && t.detected && c && !byContract.has(c)) {
      byContract.set(c, t);
    }
  }
  const link = (hash: string) => (explorer ? `${explorer}/tx/${hash}` : '');
  const common = (hash: string) => ({
    chainId: network.chainId,
    chainName: network.name,
    testnet: network.testnet,
    hash,
    explorerUrl: link(hash),
  });

  type Leg = EvmMove & { from: string; to: string; at: number; logIndex: string };
  const legs = new Map<string, Leg[]>();
  for (const raw of Array.isArray(transfers.items) ? transfers.items : []) {
    const it = obj(raw);
    const hash = txHashOf(it?.transaction_hash);
    const from = hashOf(it?.from);
    const to = hashOf(it?.to);
    const at = seconds(it?.timestamp);
    const contract = str(obj(it?.token)?.address_hash)?.toLowerCase();
    const token = contract ? byContract.get(contract) : undefined;
    const value = units(obj(it?.total)?.value);
    if (!hash || !from || !to || at === null || !token || value === null || value === 0n) continue;
    const direction = directionOf(me, from, to);
    if (!direction) continue;
    const leg: Leg = {
      token,
      amount: fromUnits(value, token.decimals),
      direction: direction === 'incoming' ? 'incoming' : 'outgoing',
      from,
      to,
      at,
      logIndex: String(it?.log_index ?? ''),
    };
    legs.set(hash, [...(legs.get(hash) ?? []), leg]);
  }

  const items: EvmHistoryItem[] = [];
  const merged = new Set<string>();
  for (const raw of Array.isArray(txs.items) ? txs.items : []) {
    const it = obj(raw);
    const hash = txHashOf(it?.hash);
    const from = hashOf(it?.from);
    const to = hashOf(it?.to) ?? hashOf(it?.created_contract);
    const at = seconds(it?.timestamp);
    const value = units(it?.value);
    if (!hash || !from || !to || at === null || value === null) continue;
    const direction = directionOf(me, from, to);
    const own = legs.get(hash) ?? [];
    if (!direction || (direction === 'incoming' && value === 0n && own.length === 0)) continue;
    const read = direction === 'incoming' ? null : readEvmCall(it, to);
    const call = read ? { ...read, token: byContract.get(to.toLowerCase()) ?? null } : null;
    const failed = str(it?.status) === 'error';
    const moves: EvmMove[] = [];
    if (value > 0n && native) {
      moves.push({
        token: native,
        amount: fromUnits(value, 18),
        direction: direction === 'incoming' ? 'incoming' : 'outgoing',
      });
    }
    if (!failed)
      moves.push(
        ...own.map(({ token, amount, direction: d }) => ({ token, amount, direction: d }))
      );
    moves.sort((a, b) => Number(b.direction === 'incoming') - Number(a.direction === 'incoming'));
    if (own.length) merged.add(hash);
    const single = !call || call.method === 'transfer' || call.method === 'transferFrom';
    const leg = single && own.length === 1 && value === 0n ? own[0] : null;
    const listed = str(it?.method);
    const primary = moves[0] ?? null;
    items.push({
      ...common(hash),
      key: `${network.chainId}:${hash}`,
      timestamp: at,
      direction: leg ? (directionOf(me, leg.from, leg.to) ?? direction) : direction,
      from: leg ? leg.from : from,
      to: leg ? leg.to : to,
      token: primary?.token ?? null,
      amount: primary?.amount ?? '',
      method:
        call?.method && !call.method.startsWith('0x')
          ? call.method
          : listed && !listed.startsWith('0x')
            ? listed
            : null,
      failed,
      call,
      moved: moves,
      fee: feeWei(it),
    });
  }

  for (const [hash, list] of legs) {
    if (merged.has(hash)) continue;
    for (const leg of list) {
      const direction = directionOf(me, leg.from, leg.to);
      if (!direction) continue;
      items.push({
        ...common(hash),
        key: `${network.chainId}:${hash}:${leg.logIndex}`,
        timestamp: leg.at,
        direction,
        from: leg.from,
        to: leg.to,
        token: leg.token,
        amount: leg.amount,
        method: null,
        failed: false,
        call: null,
        moved: [{ token: leg.token, amount: leg.amount, direction: leg.direction }],
        fee: null,
      });
    }
  }
  return items;
}

async function settleEach<T, R>(
  list: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await run(list[i]) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

export async function fetchEvmHistory(
  address: string,
  networks: readonly EvmNetwork[],
  opts: { signal?: AbortSignal; detected?: readonly EvmToken[] } = {}
): Promise<EvmHistoryResult> {
  if (!isEvmAddress(address)) throw new Error('Invalid EVM address');
  const detected = opts.detected ?? [];
  const results = await settleEach(networks, CHAINS_AT_ONCE, (n) =>
    chainHistory(address, n, detected, opts.signal)
  );
  const items: EvmHistoryItem[] = [];
  const failedChains: number[] = [];
  const unavailableChains: number[] = [];
  results.forEach((r, i) => {
    const chainId = networks[i].chainId;
    if (r.status === 'rejected') failedChains.push(chainId);
    else if (r.value === null) unavailableChains.push(chainId);
    else items.push(...r.value);
  });
  items.sort((a, b) => b.timestamp - a.timestamp);
  return { items, failedChains, unavailableChains };
}
