import { SELECTOR as BRIDGE_SELECTOR } from 'src/services/bridge/constants';
import { BoundedCache, safeContractName } from 'src/utils/callReading';
import { CALL_VALUE_MAX } from 'src/utils/callArgs';
import { registerSessionCache } from 'src/utils/sessionCaches';
import type { EvmToken } from './tokens';

export interface EvmParam {
  name: string;
  type: string;
  value: string;
}

export interface EvmCall {
  method: string | null;
  selector: string | null;
  signature: string | null;
  contract: string;
  token?: EvmToken | null;
  params: EvmParam[] | null;
  input?: string | null;
}

export interface EvmMove {
  token: EvmToken;
  amount: string;
  direction: 'incoming' | 'outgoing';
}

export const METHOD_SELECTORS: Readonly<Record<string, string>> = {
  '0x095ea7b3': 'approve',
  '0x39509351': 'increaseAllowance',
  '0xd505accf': 'permit',
  '0xa9059cbb': 'transfer',
  '0x23b872dd': 'transferFrom',
  '0x42842e0e': 'safeTransferFrom',
  '0xb88d4fde': 'safeTransferFrom',
  '0xf242432a': 'safeTransferFrom',
  '0xa22cb465': 'setApprovalForAll',
  '0xac9650d8': 'multicall',
  '0x5ae401dc': 'multicall',
  '0x1f0464d1': 'multicall',
  '0x252dba42': 'aggregate',
  '0x82ad56cb': 'aggregate3',
  '0x3593564c': 'execute',
  '0x24856bc3': 'execute',
  '0x38ed1739': 'swapExactTokensForTokens',
  '0x7ff36ab5': 'swapExactETHForTokens',
  '0x18cbafe5': 'swapExactTokensForETH',
  '0x8803dbee': 'swapTokensForExactTokens',
  '0xfb3bdb41': 'swapETHForExactTokens',
  '0x4a25d94a': 'swapTokensForExactETH',
  '0x414bf389': 'exactInputSingle',
  '0x04e45aaf': 'exactInputSingle',
  '0xc04b8d59': 'exactInput',
  '0xb858183f': 'exactInput',
  '0xd0e30db0': 'deposit',
  '0xb6b55f25': 'deposit',
  '0x6e553f65': 'deposit',
  '0x2e1a7d4d': 'withdraw',
  '0x3ccfd60b': 'withdraw',
  '0xb460af94': 'withdraw',
  '0xba087652': 'redeem',
  '0x1249c58b': 'mint',
  '0xa0712d68': 'mint',
  '0x40c10f19': 'mint',
  '0x4e71d92d': 'claim',
  '0x372500ab': 'claimRewards',
  '0x3d18b912': 'getReward',
  '0xa694fc3a': 'stake',
  '0x42966c68': 'burn',
  '0xe9e05c42': 'depositTransaction',
  '0xe11013dd': 'bridgeETHTo',
  [BRIDGE_SELECTOR.burnToOctra]: 'burnToOctra',
  [BRIDGE_SELECTOR.verifyAndMint]: 'verifyAndMint',
};

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const SELECTOR_RE = /^0x[0-9a-f]{8}$/i;

/**
 * The name an explorer gives a contract, dropped when it is not verified, is marked as a scam or is
 * a token: a token's name is its own claim, and only the wallet's token list may name one.
 */
export function explorerName(addr: unknown): string | null {
  const a = obj(addr);
  if (!a || a.is_scam === true || a.reputation === 'scam' || a.is_verified !== true) return null;
  if (a.token != null) return null;
  const own = str(a.name);
  const impl = Array.isArray(a.implementations) ? str(obj(a.implementations[0])?.name) : null;
  const pick = own && /proxy$/i.test(own) && impl ? impl : (own ?? impl);
  return safeContractName(pick);
}

const paramValue = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : JSON.stringify(v);

function decodedParams(decoded: Json | null): EvmParam[] | null {
  const list = decoded?.parameters;
  if (!Array.isArray(list)) return null;
  return list.map((raw) => {
    const p = obj(raw) ?? {};
    return {
      name: str(p.name) ?? '',
      type: str(p.type) ?? '',
      value: paramValue(p.value),
    };
  });
}

const FIXED_ARGS: Readonly<Record<string, readonly [string, 'address' | 'uint256' | 'bool'][]>> = {
  '0xa9059cbb': [
    ['to', 'address'],
    ['value', 'uint256'],
  ],
  '0x095ea7b3': [
    ['spender', 'address'],
    ['value', 'uint256'],
  ],
  '0x39509351': [
    ['spender', 'address'],
    ['value', 'uint256'],
  ],
  '0x23b872dd': [
    ['from', 'address'],
    ['to', 'address'],
    ['value', 'uint256'],
  ],
  '0xa22cb465': [
    ['operator', 'address'],
    ['approved', 'bool'],
  ],
};

const selectorOf = (input: string): string | null =>
  /^0x[0-9a-fA-F]{8}/.test(input) ? input.slice(0, 10).toLowerCase() : null;

export function knownParams(input: string | null): EvmParam[] | null {
  const selector = input ? selectorOf(input) : null;
  const shape = selector ? FIXED_ARGS[selector] : undefined;
  if (!input || !shape) return null;
  const body = input.slice(10);
  if (body.length !== shape.length * 64 || !/^[0-9a-fA-F]*$/.test(body)) return null;
  const out: EvmParam[] = [];
  for (let i = 0; i < shape.length; i++) {
    const [name, type] = shape[i];
    const word = body.slice(i * 64, i * 64 + 64);
    const n = BigInt(`0x${word}`);
    if (type === 'address') {
      if (n >> 160n !== 0n) return null;
      out.push({ name, type, value: `0x${word.slice(24)}` });
    } else if (type === 'bool') {
      if (n > 1n) return null;
      out.push({ name, type, value: n === 1n ? 'true' : 'false' });
    } else {
      out.push({ name, type, value: n.toString() });
    }
  }
  return out;
}

export function readEvmCall(it: unknown, contract: string): EvmCall | null {
  const item = obj(it);
  if (!item) return null;
  const input = str(item.raw_input);
  const decoded = obj(item.decoded_input);
  const listed = str(item.method);
  const hasInput = !!input && input.length > 2;
  if (!hasInput && !listed && !decoded) return null;

  const decodedId = str(decoded?.method_id);
  const selector =
    selectorOf(input ?? '') ??
    (listed && SELECTOR_RE.test(listed) ? listed.toLowerCase() : null) ??
    (decodedId && /^(0x)?[0-9a-f]{8}$/i.test(decodedId)
      ? `0x${decodedId.replace(/^0x/i, '').toLowerCase()}`
      : null);
  const signature = str(decoded?.method_call);
  const fromSignature = signature ? signature.replace(/\(.*$/, '').trim() : null;
  const named = listed && !SELECTOR_RE.test(listed) ? listed : null;
  const method =
    fromSignature || named || (selector ? (METHOD_SELECTORS[selector] ?? selector) : null);

  return {
    method,
    selector,
    signature,
    contract,
    params: decodedParams(decoded) ?? knownParams(input),
    input: hasInput ? input.slice(0, CALL_VALUE_MAX + 1) : null,
  };
}

export function evmCallCut(call: EvmCall | null | undefined): boolean {
  const params = call?.params ?? [];
  return (
    (call?.input?.length === 10 && params.length > 0) || params.some((p) => p.value.endsWith('…'))
  );
}

export const callArgs = (call: EvmCall | null | undefined): string[] | null =>
  call?.params ? call.params.map((p) => p.value) : null;

export function feeWei(it: unknown): string | null {
  const v = str(obj(obj(it)?.fee)?.value);
  return v && /^\d{1,78}$/.test(v) ? v : null;
}

const TIMEOUT_MS = 10_000;

async function getJson(url: string): Promise<Json | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return obj(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

export interface EvmTxDetail {
  call: EvmCall | null;
  fee: string | null;
}

const details = new BoundedCache<EvmTxDetail>(100);
const detailJobs = new Map<string, Promise<EvmTxDetail | null>>();

export function fetchEvmTxDetail(
  chainId: number,
  hash: string,
  base: string
): Promise<EvmTxDetail | null> {
  const key = `${chainId}:${hash.toLowerCase()}`;
  const hit = details.get(key);
  if (hit) return Promise.resolve(hit);
  let job = detailJobs.get(key);
  if (!job) {
    job = getJson(`${base}/api/v2/transactions/${hash}`)
      .then((body) => {
        if (!body) return null;
        const to = str(obj(body.to)?.hash);
        const detail: EvmTxDetail = {
          call: to ? readEvmCall(body, to) : null,
          fee: feeWei(body),
        };
        details.set(key, detail);
        return detail;
      })
      .catch((): null => null)
      .finally(() => detailJobs.delete(key));
    detailJobs.set(key, job);
  }
  return job;
}

export const peekEvmTxDetail = (chainId: number, hash: string): EvmTxDetail | undefined =>
  details.get(`${chainId}:${hash.toLowerCase()}`);

const NAMES_KEY = 'evm_contract_names_v1';
const NAMES_MAX = 300;
const NAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NO_NAME_TTL_MS = 24 * 60 * 60 * 1000;
const NAME_BUDGET = 12;
const NAME_WINDOW_MS = 5 * 60 * 1000;

interface NameRecord {
  n: string | null;
  at: number;
}

const names = new BoundedCache<NameRecord>(NAMES_MAX);
const nameJobs = new Map<string, Promise<string | null>>();
const nameListeners = new Set<() => void>();
let namesLoaded: Promise<void> | null = null;
let windowStart = 0;
let spent = 0;
let version = 0;

registerSessionCache(() => {
  details.clear();
  detailJobs.clear();
});

export const contractNameKey = (chainId: number, address: string) =>
  `${chainId}:${address.toLowerCase()}`;

const fresh = (r: NameRecord | undefined, now = Date.now()): r is NameRecord =>
  !!r && now - r.at < (r.n ? NAME_TTL_MS : NO_NAME_TTL_MS);

function loadNames(): Promise<void> {
  if (!namesLoaded) {
    namesLoaded = (async () => {
      try {
        const stored = (await chrome.storage.local.get([NAMES_KEY]))?.[NAMES_KEY];
        if (stored && typeof stored === 'object') {
          for (const [k, v] of Object.entries(stored as Record<string, NameRecord>)) {
            if (v && typeof v.at === 'number' && !names.has(k)) {
              names.set(k, { n: typeof v.n === 'string' ? safeContractName(v.n) : null, at: v.at });
            }
          }
          bump();
        }
      } catch {}
    })();
  }
  return namesLoaded;
}

function saveNames() {
  try {
    chrome.storage.local.set({ [NAMES_KEY]: Object.fromEntries(names.entries()) }).catch(() => {});
  } catch {}
}

function bump() {
  version++;
  nameListeners.forEach((fn) => fn());
}

export function subscribeContractNames(fn: () => void): () => void {
  nameListeners.add(fn);
  void loadNames();
  return () => nameListeners.delete(fn);
}

export const contractNamesVersion = () => version;

export function peekContractName(chainId: number, address: string): string | null | undefined {
  const r = names.get(contractNameKey(chainId, address));
  return fresh(r) ? r.n : undefined;
}

export async function lookupContractName(
  chainId: number,
  address: string,
  base: string
): Promise<string | null | undefined> {
  await loadNames();
  const key = contractNameKey(chainId, address);
  const known = names.get(key);
  if (fresh(known)) return known.n;
  const running = nameJobs.get(key);
  if (running) return running;
  const now = Date.now();
  if (now - windowStart > NAME_WINDOW_MS) {
    windowStart = now;
    spent = 0;
  }
  if (spent >= NAME_BUDGET) return undefined;
  spent++;
  const job = getJson(`${base}/api/v2/addresses/${address}`)
    .then((body) => {
      const n = body ? explorerName(body) : null;
      names.set(key, { n, at: Date.now() });
      saveNames();
      bump();
      return n;
    })
    .finally(() => nameJobs.delete(key));
  nameJobs.set(key, job);
  return job.catch((): undefined => undefined);
}

export function resetContractNames(): void {
  names.clear();
  nameJobs.clear();
  namesLoaded = null;
  windowStart = 0;
  spent = 0;
  details.clear();
  detailJobs.clear();
}
