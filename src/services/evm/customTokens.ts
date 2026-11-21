import { toChecksumAddress } from './accounts';
import type { EvmNetwork } from './networks';
import { enableNetwork, findNetwork } from './registry';
import { isHex, rpcBatch } from './rpc';
import {
  CUSTOM_TOKENS_KEY,
  isCuratedEvmToken,
  loadCustomEvmTokens,
  readCustomTokenStore,
  safeTokenLogo,
  type EvmToken,
} from './tokens';

export { CUSTOM_TOKENS_KEY, loadCustomEvmTokens };

export type EvmTokenProblem =
  | 'network'
  | 'address'
  | 'listed'
  | 'symbol'
  | 'decimals'
  | 'decimalsMismatch'
  | 'noContract'
  | 'unreachable'
  | 'unreadable';

export class EvmTokenError extends Error {
  constructor(
    message: string,
    readonly problem: EvmTokenProblem
  ) {
    super(message);
    this.name = 'EvmTokenError';
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SYMBOL_MAX = 11;
const NAME_MAX = 40;
const SELECTOR = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567' } as const;
// Control, zero-width and bidi characters can make one token pass for another.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

const clean = (s: string, max: number) => s.replace(HIDDEN, '').trim().slice(0, max);

function hexToBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** An ABI string return, or the bytes32 some older tokens (MKR) return instead. */
export function decodeAbiString(result: unknown): string | null {
  if (!isHex(result) || result.length < 66 || (result.length - 2) % 64 !== 0) return null;
  const bytes = hexToBytes(result);
  const utf8 = (b: Uint8Array) => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
      return null;
    }
  };
  if (bytes.length === 32) {
    let end = 32;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return utf8(bytes.slice(0, end));
  }
  const word = (at: number) => {
    if (at + 32 > bytes.length) return null;
    const v = BigInt('0x' + result.slice(2 + at * 2, 2 + (at + 32) * 2));
    return v > BigInt(bytes.length) ? null : Number(v);
  };
  const offset = word(0);
  if (offset === null) return null;
  const length = word(offset);
  if (length === null || offset + 32 + length > bytes.length) return null;
  return utf8(bytes.slice(offset + 32, offset + 32 + length));
}

function decodeDecimals(result: unknown): number | null {
  if (!isHex(result) || result.length !== 66) return null;
  const v = BigInt(result);
  return v <= 36n ? Number(v) : null;
}

export interface Erc20Metadata {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

export async function readErc20Metadata(
  network: EvmNetwork,
  address: string,
  opts: { signal?: AbortSignal } = {}
): Promise<Erc20Metadata> {
  if (!ADDRESS.test(address)) throw new EvmTokenError('Invalid contract address', 'address');
  const call = (data: string) => ({
    method: 'eth_call',
    params: [{ to: address, data }, 'latest'],
  });
  let results: unknown[];
  try {
    results = await rpcBatch(
      network.rpcUrl,
      [
        { method: 'eth_getCode', params: [address, 'latest'] },
        call(SELECTOR.symbol),
        call(SELECTOR.name),
        call(SELECTOR.decimals),
      ],
      opts
    );
  } catch {
    throw new EvmTokenError(`Could not reach ${network.name}`, 'unreachable');
  }
  const [code, symbol, name, decimals] = results;
  if (code instanceof Error || !isHex(code)) {
    throw new EvmTokenError(`Could not reach ${network.name}`, 'unreachable');
  }
  if (code === '0x' || /^0x0*$/.test(code)) {
    throw new EvmTokenError(`No contract at this address on ${network.name}`, 'noContract');
  }
  const str = (v: unknown, max: number) => {
    const s = v instanceof Error ? null : decodeAbiString(v);
    const c = s === null ? '' : clean(s, max);
    return c || null;
  };
  return {
    symbol: str(symbol, SYMBOL_MAX),
    name: str(name, NAME_MAX),
    decimals: decimals instanceof Error ? null : decodeDecimals(decimals),
  };
}

export interface CustomEvmTokenInput {
  chainId: number;
  address: string;
  symbol?: string;
  decimals?: number;
  name?: string;
  logo?: string;
}

export async function resolveCustomEvmToken(
  input: CustomEvmTokenInput,
  opts: { signal?: AbortSignal } = {}
): Promise<EvmToken> {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new EvmTokenError('Unknown network', 'network');
  }
  const network = await findNetwork(input.chainId);
  if (!network) throw new EvmTokenError('Add this network first', 'network');
  const raw = typeof input.address === 'string' ? input.address.trim() : '';
  if (!ADDRESS.test(raw)) throw new EvmTokenError('Invalid contract address', 'address');
  const address = toChecksumAddress(raw);
  if (isCuratedEvmToken(input.chainId, address)) {
    throw new EvmTokenError('This token is already listed', 'listed');
  }
  if (
    input.decimals !== undefined &&
    !(Number.isInteger(input.decimals) && input.decimals >= 0 && input.decimals <= 36)
  ) {
    throw new EvmTokenError('Decimals must be a whole number from 0 to 36', 'decimals');
  }
  let symbol: string | null = null;
  if (input.symbol !== undefined) {
    symbol = typeof input.symbol === 'string' ? clean(input.symbol, 64) : '';
    if (!symbol || symbol.length > SYMBOL_MAX) {
      throw new EvmTokenError('The symbol must be 1 to 11 characters', 'symbol');
    }
  }

  const chain = await readErc20Metadata(network, address, opts);
  if (
    input.decimals !== undefined &&
    chain.decimals !== null &&
    chain.decimals !== input.decimals
  ) {
    throw new EvmTokenError(
      `The contract uses ${chain.decimals} decimals, not ${input.decimals}`,
      'decimalsMismatch'
    );
  }
  const decimals = chain.decimals ?? input.decimals ?? null;
  if (decimals === null) throw new EvmTokenError('Could not read this token', 'unreadable');
  symbol = symbol ?? chain.symbol;
  if (!symbol) throw new EvmTokenError('Could not read this token', 'unreadable');
  const given = typeof input.name === 'string' ? clean(input.name, NAME_MAX) : '';
  return {
    chainId: input.chainId,
    address,
    symbol,
    name: given || chain.name || symbol,
    decimals,
    logo: safeTokenLogo(input.logo),
    custom: true,
  };
}

export async function addCustomEvmToken(input: CustomEvmTokenInput): Promise<EvmToken> {
  const token = await resolveCustomEvmToken(input);
  const store = await readCustomTokenStore();
  const key = String(token.chainId);
  const a = token.address!.toLowerCase();
  const kept = (store[key] ?? []).filter((t) => t.address?.toLowerCase() !== a);
  await chrome.storage.local.set({
    [CUSTOM_TOKENS_KEY]: { ...store, [key]: [...kept, stripped(token)] },
  });
  await enableNetwork(token.chainId).catch(() => false);
  return token;
}

export async function removeCustomEvmToken(chainId: number, address: string): Promise<void> {
  const store = await readCustomTokenStore();
  const key = String(chainId);
  const a = address.toLowerCase();
  const kept = (store[key] ?? []).filter((t) => t.address?.toLowerCase() !== a).map(stripped);
  const next: Record<string, EvmToken[]> = {};
  for (const [k, list] of Object.entries(store)) if (k !== key) next[k] = list.map(stripped);
  if (kept.length) next[key] = kept;
  await chrome.storage.local.set({ [CUSTOM_TOKENS_KEY]: next });
}

const stripped = (t: EvmToken): EvmToken => ({
  chainId: t.chainId,
  address: t.address,
  symbol: t.symbol,
  name: t.name,
  decimals: t.decimals,
  logo: t.logo,
});

export interface DetectedEvmToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  raw: string;
}

const BLOCKSCOUT: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  11155111: 'https://eth-sepolia.blockscout.com',
};

export const canDetectEvmTokens = (chainId: number) => chainId in BLOCKSCOUT;

export async function detectEvmTokens(
  chainId: number,
  owner: string,
  opts: { signal?: AbortSignal } = {}
): Promise<DetectedEvmToken[]> {
  const base = BLOCKSCOUT[chainId];
  if (!base || !ADDRESS.test(owner)) return [];
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(12_000)])
    : AbortSignal.timeout(12_000);
  const res = await fetch(`${base}/api/v2/addresses/${owner}/tokens?type=ERC-20`, { signal });
  if (!res.ok) throw new Error(`Blockscout HTTP ${res.status}`);
  const body = (await res.json()) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  const out: DetectedEvmToken[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    const token = (item?.token ?? {}) as Record<string, unknown>;
    const address = token.address_hash ?? token.address;
    const decimals = Number(token.decimals);
    const raw = typeof item.value === 'string' && /^\d+$/.test(item.value) ? item.value : '0';
    if (typeof address !== 'string' || !ADDRESS.test(address)) continue;
    if (!(Number.isInteger(decimals) && decimals >= 0 && decimals <= 36)) continue;
    if (token.reputation !== undefined && token.reputation !== 'ok') continue;
    if (raw === '0' || isCuratedEvmToken(chainId, address)) continue;
    const symbol = typeof token.symbol === 'string' ? clean(token.symbol, SYMBOL_MAX) : '';
    if (!symbol) continue;
    const name = typeof token.name === 'string' ? clean(token.name, NAME_MAX) : '';
    out.push({ address: toChecksumAddress(address), symbol, name: name || symbol, decimals, raw });
  }
  return out.slice(0, 20);
}
