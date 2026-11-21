import { toChecksumAddress } from './accounts';
import { decodeAbiString } from './customTokens';
import {
  SELECTORS,
  isContractAddress,
  parseTokenId,
  readNftOwned,
  type NftStandard,
} from './detect';
import type { EvmNetwork } from './networks';
import { enableNetwork } from './registry';
import { isHex, rpcBatch } from './rpc';
import { erc1155SafeTransferData, erc721SafeTransferData } from './tx';

export interface EvmNft {
  chainId: number;
  contract: string;
  tokenId: string;
  standard: NftStandard;
  amount: string;
  name: string | null;
  collection: string | null;
  image: string | null;
}

export interface NftMetadata {
  name: string | null;
  image: string | null;
}

export interface NftHoldings {
  items: EvmNft[];
  complete: boolean;
}

export interface EvmNftsResult {
  items: EvmNft[];
  failedChains: number[];
}

const ORACLE_NFTS = 'https://oracle.0xio.xyz/api/evm/nfts';
export const IMAGE_PROXY = 'https://rpc-proxy.0xio.xyz/nft/image';
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const TIMEOUT_MS = 12_000;
const METADATA_TIMEOUT_MS = 6_000;
const MAX_ITEMS = 500;
const MAX_METADATA_BYTES = 256_000;
const NAME_MAX = 80;
const COLLECTION_MAX = 60;
const URL_MAX = 2_048;
const INLINE_IMAGE_MAX = 200_000;
const INLINE_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml)(;base64)?,/i;

// Control, zero-width and bidi characters can make one name pass for another.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(HIDDEN, '').trim().slice(0, max);
  return s || null;
};

const decimal = (v: unknown): bigint | null => {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  return parseTokenId(v);
};

export function nftImageSrc(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (INLINE_IMAGE.test(v)) return v.length <= INLINE_IMAGE_MAX ? v : null;
  if (v.length > URL_MAX || /\s/.test(v)) return null;
  if (/^https:\/\/[^/]/i.test(v) || /^ipfs:\/\/./i.test(v)) {
    return `${IMAGE_PROXY}?u=${encodeURIComponent(v)}`;
  }
  return null;
}

const imageOf = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : null;
  return s && nftImageSrc(s) ? s : null;
};

export function parseNftItem(raw: unknown, chainId: number): EvmNft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const it = raw as Record<string, unknown>;
  if (!isContractAddress(it.contract)) return null;
  const id = decimal(it.tokenId);
  if (id === null) return null;
  const standard = it.standard;
  if (standard !== 'ERC-721' && standard !== 'ERC-1155') return null;
  let amount = decimal(it.amount ?? (standard === 'ERC-721' ? '1' : null));
  if (amount === null || amount === 0n) return null;
  if (standard === 'ERC-721') amount = 1n;
  return {
    chainId,
    contract: toChecksumAddress(it.contract),
    tokenId: id.toString(),
    standard,
    amount: amount.toString(),
    name: text(it.name, NAME_MAX),
    collection: text(it.collection, COLLECTION_MAX),
    image: imageOf(it.image),
  };
}

export const nftKey = (n: Pick<EvmNft, 'chainId' | 'contract' | 'tokenId'>) =>
  `${n.chainId}:${n.contract.toLowerCase()}:${n.tokenId}`;

export function parseNftHoldings(body: unknown, chainId: number): NftHoldings | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.items)) return null;
  const seen = new Set<string>();
  const items: EvmNft[] = [];
  for (const raw of b.items) {
    if (items.length >= MAX_ITEMS) break;
    const item = parseNftItem(raw, chainId);
    if (!item) continue;
    const k = nftKey(item);
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(item);
  }
  return { items, complete: b.complete === true };
}

export class NftIndexUnsupported extends Error {
  constructor(chainId: number) {
    super(`No NFT index for chain ${chainId}`);
    this.name = 'NftIndexUnsupported';
  }
}

export async function fetchNftHoldings(
  chainId: number,
  address: string,
  signal?: AbortSignal
): Promise<NftHoldings> {
  if (!isContractAddress(address)) throw new Error('Invalid EVM address');
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`${ORACLE_NFTS}?chain=${chainId}&address=${address}`, {
    credentials: 'omit',
    headers: { 'x-0xio-client': 'extension' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 400 || res.status === 404) throw new NftIndexUnsupported(chainId);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = parseNftHoldings(await res.json(), chainId);
  if (!parsed) throw new Error('Bad NFT index response');
  return parsed;
}

export async function fetchEvmNfts(
  address: string,
  networks: readonly EvmNetwork[],
  opts: { signal?: AbortSignal } = {}
): Promise<EvmNftsResult> {
  const results = await Promise.allSettled(
    networks.map((n) => fetchNftHoldings(n.chainId, address, opts.signal))
  );
  const items: EvmNft[] = [];
  const failedChains: number[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value.items);
    else if (!(r.reason instanceof NftIndexUnsupported)) failedChains.push(networks[i].chainId);
  });
  return { items, failedChains };
}

const importsKey = (chainId: number, owner: string) =>
  `evm_nft_imports_${chainId}_${owner.toLowerCase()}`;

export async function loadImportedNfts(chainId: number, owner: string): Promise<EvmNft[]> {
  if (!isContractAddress(owner)) return [];
  try {
    const key = importsKey(chainId, owner);
    const stored = await chrome.storage.local.get([key]);
    const list = stored?.[key];
    if (!Array.isArray(list)) return [];
    return list.map((raw) => parseNftItem(raw, chainId)).filter((n): n is EvmNft => n !== null);
  } catch {
    return [];
  }
}

export async function saveImportedNft(nft: EvmNft, owner: string): Promise<void> {
  if (!isContractAddress(owner)) throw new Error('Invalid EVM address');
  const list = await loadImportedNfts(nft.chainId, owner);
  const k = nftKey(nft);
  const next = [...list.filter((n) => nftKey(n) !== k), nft];
  await chrome.storage.local.set({ [importsKey(nft.chainId, owner)]: next });
  await enableNetwork(nft.chainId).catch(() => false);
}

export async function removeImportedNft(
  owner: string,
  nft: Pick<EvmNft, 'chainId' | 'contract' | 'tokenId'>
): Promise<void> {
  const list = await loadImportedNfts(nft.chainId, owner);
  const k = nftKey(nft);
  const next = list.filter((n) => nftKey(n) !== k);
  if (next.length !== list.length) {
    await chrome.storage.local.set({ [importsKey(nft.chainId, owner)]: next });
  }
}

export async function collectEvmNfts(
  owner: string,
  networks: readonly EvmNetwork[],
  opts: { signal?: AbortSignal } = {}
): Promise<EvmNftsResult> {
  const [indexed, imports] = await Promise.all([
    fetchEvmNfts(owner, networks, opts),
    Promise.all(networks.map((n) => loadImportedNfts(n.chainId, owner))),
  ]);
  const have = new Set(indexed.items.map(nftKey));
  const extra = await Promise.all(
    networks.map(async (network, i) => {
      const missing = imports[i].filter((n) => !have.has(nftKey(n)));
      const checked = await Promise.all(
        missing.map(async (n) => {
          const owned = await readNftOwned(
            network,
            n.contract,
            n.standard,
            owner,
            BigInt(n.tokenId),
            { signal: opts.signal }
          );
          if (owned === 0n) return null;
          return owned === null ? n : { ...n, amount: owned.toString() };
        })
      );
      return checked.filter((n): n is EvmNft => n !== null);
    })
  );
  return { items: [...indexed.items, ...extra.flat()], failedChains: indexed.failedChains };
}

export function metadataUrl(uri: string, tokenId: bigint): string | null {
  const v = uri.trim().replace(/\{id\}/gi, tokenId.toString(16).padStart(64, '0'));
  if (v.startsWith('data:')) return v;
  if (/^ipfs:\/\//i.test(v)) return IPFS_GATEWAY + v.replace(/^ipfs:\/\/(ipfs\/)?/i, '');
  return /^https:\/\/[^/]/i.test(v) && v.length <= URL_MAX ? v : null;
}

function parseDataJson(uri: string): unknown {
  const comma = uri.indexOf(',');
  if (comma < 0 || !/^data:application\/json/i.test(uri)) return null;
  const head = uri.slice(0, comma);
  const body = uri.slice(comma + 1);
  if (body.length > MAX_METADATA_BYTES * 2) return null;
  try {
    if (/;base64$/i.test(head)) {
      const bin = atob(body);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    return JSON.parse(decodeURIComponent(body));
  } catch {
    return null;
  }
}

export async function fetchNftMetadata(
  uri: string,
  tokenId: bigint,
  signal?: AbortSignal
): Promise<NftMetadata> {
  const none: NftMetadata = { name: null, image: null };
  const url = metadataUrl(uri, tokenId);
  if (!url) return none;
  let json: unknown;
  if (url.startsWith('data:')) {
    json = parseDataJson(url);
  } else {
    try {
      const timeout = AbortSignal.timeout(METADATA_TIMEOUT_MS);
      const res = await fetch(url, {
        credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) return none;
      const body = await res.text();
      if (body.length > MAX_METADATA_BYTES) return none;
      json = JSON.parse(body);
    } catch {
      return none;
    }
  }
  if (!json || typeof json !== 'object') return none;
  const m = json as Record<string, unknown>;
  return {
    name: text(m.name, NAME_MAX),
    image: imageOf(m.image) ?? imageOf(m.image_url),
  };
}

export async function readNftOnChain(
  network: EvmNetwork,
  contract: string,
  standard: NftStandard,
  tokenId: bigint,
  signal?: AbortSignal
): Promise<{ collection: string | null; name: string | null; image: string | null }> {
  const idWord = tokenId.toString(16).padStart(64, '0');
  const uriSelector = standard === 'ERC-721' ? SELECTORS.tokenURI : SELECTORS.uri;
  let collection: string | null = null;
  let uri: string | null = null;
  try {
    const [name, tokenUri] = await rpcBatch(
      network.rpcUrl,
      [
        { method: 'eth_call', params: [{ to: contract, data: SELECTORS.name }, 'latest'] },
        {
          method: 'eth_call',
          params: [{ to: contract, data: uriSelector + idWord }, 'latest'],
        },
      ],
      { timeoutMs: METADATA_TIMEOUT_MS, signal }
    );
    collection = name instanceof Error ? null : text(decodeAbiString(name), COLLECTION_MAX);
    uri = tokenUri instanceof Error || !isHex(tokenUri) ? null : decodeAbiString(tokenUri);
  } catch {
    return { collection: null, name: null, image: null };
  }
  const meta: NftMetadata = uri
    ? await fetchNftMetadata(uri, tokenId, signal)
    : { name: null, image: null };
  return { collection, ...meta };
}

export function nftTransferData(
  nft: Pick<EvmNft, 'standard' | 'tokenId'>,
  from: string,
  to: string,
  amount: bigint
): string {
  const id = BigInt(nft.tokenId);
  return nft.standard === 'ERC-721'
    ? erc721SafeTransferData(from, to, id)
    : erc1155SafeTransferData(from, to, id, amount);
}
