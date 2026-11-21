import { sha256 } from '@noble/hashes/sha2.js';

export const CIRCLE_CHUNK_FORMAT = 'octra.circle.asset.chunks.v1';
export const CIRCLE_CHUNK_MANIFEST_TYPE = 'application/vnd.octra.circle.chunks+json';
const CHUNK_TYPE = 'application/octet-stream';
const MAX_RAW = 33554432;
const CHUNK_RAW = 2097152;
const CHUNK_COUNT_MAX = 32;
const MANIFEST_B64_MAX = 131072;
export const MAX_CIRCLE_ASSET_B64 = Math.ceil((MAX_RAW * 4) / 3);

export type CircleAssetReply = {
  content_type?: string;
  body_b64?: string;
  data_base64?: string;
  [key: string]: unknown;
} | null;

export type CircleAsset = { contentType: string; bytes: Uint8Array };

export class CircleAssetError extends Error {}

type FetchAsset = (path: string) => Promise<CircleAssetReply>;

export function bytesFromB64(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(s);
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const isHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const sizeOf = (v: unknown): number | null =>
  typeof v === 'string' && /^\d+$/.test(v) && Number(v) <= Number.MAX_SAFE_INTEGER
    ? Number(v)
    : null;

function canonicalBody(b64: unknown): Uint8Array | null {
  if (typeof b64 !== 'string') return null;
  try {
    const bytes = bytesFromB64(b64);
    return bytesToB64(bytes) === b64 ? bytes : null;
  } catch {
    return null;
  }
}

const chunkIndex = (i: number) => String(i).padStart(4, '0');

export const isChunkManifest = (reply: CircleAssetReply): boolean =>
  reply?.content_type === CIRCLE_CHUNK_MANIFEST_TYPE;

async function assembleChunks(
  fetchAsset: FetchAsset,
  root: NonNullable<CircleAssetReply>
): Promise<CircleAsset & { sha256: string; chunks: number }> {
  const b64 = root.body_b64 ?? root.data_base64;
  if (typeof b64 !== 'string' || !b64 || b64.length > MANIFEST_B64_MAX) {
    throw new CircleAssetError('Invalid circle chunk manifest');
  }
  const manifestBytes = canonicalBody(b64);
  if (!manifestBytes) throw new CircleAssetError('Invalid circle chunk manifest');
  let manifest: any;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new CircleAssetError('Invalid circle chunk manifest');
  }
  const total = sizeOf(manifest?.size_bytes);
  const contentType = manifest?.content_type;
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.format !== CIRCLE_CHUNK_FORMAT ||
    typeof contentType !== 'string' ||
    !/^[\x20-\x7e]{1,256}$/.test(contentType) ||
    manifest.encoding !== 'identity' ||
    !isHash(manifest.sha256) ||
    total === null ||
    total > MAX_RAW ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length === 0 ||
    manifest.chunks.length > CHUNK_COUNT_MAX
  ) {
    throw new CircleAssetError('Invalid circle chunk manifest');
  }

  const prefix = `/.octra/chunks/${manifest.sha256}/`;
  const body = new Uint8Array(total);
  let filled = 0;
  for (let i = 0; i < manifest.chunks.length; i++) {
    const item = manifest.chunks[i];
    const size = sizeOf(item?.size_bytes);
    if (
      !item ||
      typeof item !== 'object' ||
      item.path !== prefix + chunkIndex(i) ||
      !isHash(item.sha256) ||
      size === null ||
      size === 0 ||
      size > CHUNK_RAW ||
      size > total - filled
    ) {
      throw new CircleAssetError('Invalid circle chunk entry');
    }
    const part = await fetchAsset(item.path);
    if (!part || part.content_type !== CHUNK_TYPE)
      throw new CircleAssetError('Circle chunk unavailable');
    const chunk = canonicalBody(part.body_b64 ?? part.data_base64);
    if (!chunk || chunk.length !== size || hex(sha256(chunk)) !== item.sha256) {
      throw new CircleAssetError('Circle chunk verification failed');
    }
    body.set(chunk, filled);
    filled += size;
  }
  if (filled !== total || hex(sha256(body)) !== manifest.sha256) {
    throw new CircleAssetError('Circle asset verification failed');
  }
  return { contentType, bytes: body, sha256: manifest.sha256, chunks: manifest.chunks.length };
}

/** One circle file, with chunked files assembled and checked the way the reference client does. */
export async function resolveCircleAsset(
  fetchAsset: FetchAsset,
  path: string
): Promise<CircleAsset | null> {
  const root = await fetchAsset(path);
  if (!root) return null;
  if (isChunkManifest(root)) {
    const { contentType, bytes } = await assembleChunks(fetchAsset, root);
    return { contentType, bytes };
  }
  const b64 = root.body_b64 ?? root.data_base64;
  if (typeof b64 !== 'string') return null;
  if (b64.length > MAX_CIRCLE_ASSET_B64) throw new CircleAssetError('Circle asset too large');
  return {
    contentType: root.content_type || 'application/octet-stream',
    bytes: bytesFromB64(b64),
  };
}

export async function resolveCircleAssetReply(
  fetchAsset: FetchAsset,
  path: string
): Promise<CircleAssetReply> {
  const root = await fetchAsset(path);
  if (!root || !isChunkManifest(root)) return root;
  const out = await assembleChunks(fetchAsset, root);
  const rest = { ...root };
  delete rest.data_base64;
  return {
    ...rest,
    content_type: out.contentType,
    encoding: 'identity',
    size_bytes: String(out.bytes.length),
    blob_hash: out.sha256,
    body_b64: bytesToB64(out.bytes),
    chunked: true,
    chunks: out.chunks,
  };
}
