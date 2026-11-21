import { logger } from 'src/utils/logger';
import {
  parseOctUri,
  fetchCircleBytes,
  fetchCircleJson,
  getManifest,
  refetchCircleBytes,
  sniffImageType,
  bytesToB64,
} from './circle';
import { compositeToken } from './compositor';
import type { Manifest, TokenAttr, XpectrumToken } from './types';

async function resolveMediaUri(uri: string | null, fresh = false): Promise<string | null> {
  if (!uri) return null;
  const t = uri.trim();
  if (t.startsWith('data:')) return t;
  if (t.toLowerCase().startsWith('oct://')) {
    const parsed = parseOctUri(t);
    if (!parsed) return null;
    const bytes = await (fresh ? refetchCircleBytes : fetchCircleBytes)(
      parsed.circleId,
      parsed.path
    );
    if (!bytes) return null;
    return `data:${sniffImageType(bytes)};base64,${bytesToB64(bytes)}`;
  }
  if (t.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${t.slice(7)}`;
  return t;
}

export async function resolveXpectrumToken(
  tokenUri: string | null,
  fresh = false
): Promise<XpectrumToken | null> {
  if (!tokenUri) return null;
  const parsed = parseOctUri(tokenUri);
  if (!parsed) return null;

  const tokenJson = await fetchCircleJson<{
    name?: string;
    description?: string;
    image?: string;
    animation_url?: string;
    attributes?: TokenAttr[];
  }>(parsed.circleId, parsed.path, fresh);
  if (!tokenJson) return null;

  const manifest = await getManifest(parsed.circleId, fresh);
  const rt = manifest?.render_type;
  if (rt !== 'composed' && rt !== 'prerendered') return null;

  const name = typeof tokenJson.name === 'string' ? tokenJson.name : null;
  const description = typeof tokenJson.description === 'string' ? tokenJson.description : null;
  const animationUrl = typeof tokenJson.animation_url === 'string' ? tokenJson.animation_url : null;

  if (rt === 'composed') {
    const image = await compositeToken(
      parsed.circleId,
      manifest as Manifest,
      Array.isArray(tokenJson.attributes) ? tokenJson.attributes : [],
      fresh
    );
    logger.debug(
      `[Xpectrum] composed token ${parsed.path} -> ${image ? 'composited' : 'no layers'}`
    );
    return { image, name, description, animationUrl };
  }

  const image = await resolveMediaUri(
    typeof tokenJson.image === 'string' ? tokenJson.image : null,
    fresh
  );
  return { image, name, description, animationUrl };
}

export { parseOctUri, getManifest, slug } from './circle';
export { compositeToken } from './compositor';
export type { XpectrumToken, Manifest, TraitType, TokenAttr } from './types';
