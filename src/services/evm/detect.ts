import { decodeAbiString } from './customTokens';
import type { EvmNetwork } from './networks';
import { isHex, rpcBatch, type RpcRequest } from './rpc';

export type DetectKind = 'nft' | 'token';
export type NftStandard = 'ERC-721' | 'ERC-1155';

export interface DetectMatch {
  network: EvmNetwork;
  standard?: NftStandard;
  token?: { symbol: string; decimals: number; name: string | null };
  owned?: bigint | null;
}

export interface DetectResult {
  matches: DetectMatch[];
  unreachable: EvmNetwork[];
}

export interface DetectOptions {
  kind: DetectKind;
  owner?: string | null;
  tokenId?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DETECT_TIMEOUT_MS = 6_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ID = /^\d{1,78}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

export const SELECTORS = {
  supportsInterface: '0x01ffc9a7',
  ownerOf: '0x6352211e',
  balanceOf1155: '0x00fdd58e',
  tokenURI: '0xc87b56dd',
  uri: '0x0e89341c',
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
} as const;

export const INTERFACE_IDS: Record<NftStandard, string> = {
  'ERC-721': '80ac58cd',
  'ERC-1155': 'd9b67a26',
};

const word = (v: bigint) => v.toString(16).padStart(64, '0');
const addressWord = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');

export const isContractAddress = (v: unknown): v is string =>
  typeof v === 'string' && ADDRESS.test(v);

export function parseTokenId(v: unknown): bigint | null {
  if (typeof v !== 'string' || !TOKEN_ID.test(v.trim())) return null;
  const n = BigInt(v.trim());
  return n <= MAX_UINT256 ? n : null;
}

const ethCall = (to: string, data: string): RpcRequest => ({
  method: 'eth_call',
  params: [{ to, data }, 'latest'],
});

const supportsCall = (to: string, id: string) =>
  ethCall(to, SELECTORS.supportsInterface + id.padEnd(64, '0'));

export function ownershipCall(
  contract: string,
  standard: NftStandard,
  owner: string,
  tokenId: bigint
): RpcRequest {
  return standard === 'ERC-721'
    ? ethCall(contract, SELECTORS.ownerOf + word(tokenId))
    : ethCall(contract, SELECTORS.balanceOf1155 + addressWord(owner) + word(tokenId));
}

const hasCode = (code: unknown) => isHex(code) && code !== '0x' && !/^0x0*$/.test(code);

function readBool(v: unknown): boolean {
  return isHex(v) && v.length === 66 && BigInt(v) === 1n;
}

function readUint(v: unknown): bigint | null {
  return isHex(v) && v.length === 66 ? BigInt(v) : null;
}

function readDecimals(v: unknown): number | null {
  const n = readUint(v);
  return n !== null && n <= 36n ? Number(n) : null;
}

const reverted = (e: Error) => /revert|execution/i.test(e.message);

export function ownedFrom(standard: NftStandard, owner: string, result: unknown): bigint | null {
  if (result instanceof Error) return reverted(result) ? 0n : null;
  if (standard === 'ERC-721') {
    if (!isHex(result) || result.length !== 66) return null;
    return BigInt(result) === BigInt(owner) ? 1n : 0n;
  }
  return readUint(result);
}

const clean = (s: string | null, max: number) =>
  s
    ? s
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
        .trim()
        .slice(0, max) || null
    : null;

export async function probeNetwork(
  network: EvmNetwork,
  address: string,
  opts: DetectOptions
): Promise<DetectMatch | null> {
  const timeoutMs = opts.timeoutMs ?? DETECT_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const tokenId = parseTokenId(opts.tokenId ?? '');
  const owner = isContractAddress(opts.owner) ? opts.owner : null;
  const getCode: RpcRequest = { method: 'eth_getCode', params: [address, 'latest'] };

  if (opts.kind === 'token') {
    const [code, decimals, symbol, name] = await rpcBatch(
      network.rpcUrl,
      [
        getCode,
        ethCall(address, SELECTORS.decimals),
        ethCall(address, SELECTORS.symbol),
        ethCall(address, SELECTORS.name),
      ],
      { timeoutMs, signal }
    );
    if (code instanceof Error) throw code;
    if (!hasCode(code)) return null;
    const d = decimals instanceof Error ? null : readDecimals(decimals);
    const s = symbol instanceof Error ? null : clean(decodeAbiString(symbol), 11);
    if (d === null || !s) return null;
    const n = name instanceof Error ? null : clean(decodeAbiString(name), 40);
    return { network, token: { symbol: s, decimals: d, name: n } };
  }

  const calls: RpcRequest[] = [
    getCode,
    supportsCall(address, INTERFACE_IDS['ERC-721']),
    supportsCall(address, INTERFACE_IDS['ERC-1155']),
  ];
  if (tokenId !== null && owner) {
    calls.push(ownershipCall(address, 'ERC-721', owner, tokenId));
    calls.push(ownershipCall(address, 'ERC-1155', owner, tokenId));
  }
  const [code, is721, is1155, owner721, owner1155] = await rpcBatch(network.rpcUrl, calls, {
    timeoutMs,
    signal,
  });
  if (code instanceof Error) throw code;
  if (!hasCode(code)) return null;
  const standard: NftStandard | null = readBool(is721)
    ? 'ERC-721'
    : readBool(is1155)
      ? 'ERC-1155'
      : null;
  if (!standard) return null;
  if (tokenId === null || !owner) return { network, standard };
  const owned = ownedFrom(standard, owner, standard === 'ERC-721' ? owner721 : owner1155);
  return { network, standard, owned };
}

export async function detectContract(
  address: string,
  networks: readonly EvmNetwork[],
  opts: DetectOptions
): Promise<DetectResult> {
  if (!isContractAddress(address)) return { matches: [], unreachable: [] };
  const results = await Promise.allSettled(networks.map((n) => probeNetwork(n, address, opts)));
  const matches: DetectMatch[] = [];
  const unreachable: EvmNetwork[] = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') unreachable.push(networks[i]);
    else if (r.value) matches.push(r.value);
  });
  return { matches, unreachable };
}

export async function readNftOwned(
  network: EvmNetwork,
  contract: string,
  standard: NftStandard,
  owner: string,
  tokenId: bigint,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<bigint | null> {
  if (!isContractAddress(contract) || !isContractAddress(owner)) return null;
  try {
    const [result] = await rpcBatch(
      network.rpcUrl,
      [ownershipCall(contract, standard, owner, tokenId)],
      { timeoutMs: opts.timeoutMs ?? DETECT_TIMEOUT_MS, signal: opts.signal }
    );
    return ownedFrom(standard, owner, result);
  } catch {
    return null;
  }
}
