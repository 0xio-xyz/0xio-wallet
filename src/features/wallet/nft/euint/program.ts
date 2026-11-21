import { networkService } from 'src/services/network/NetworkService';
import { parseOctUri } from 'src/features/wallet/nft/xpectrum/circle';
import { resolveCircleAsset, type CircleAssetReply } from 'src/utils/octra/circleAsset';

const PROGRAM_TTL_MS = 5 * 60_000;
const programs = new Map<string, { at: number; html: string }>();

export async function loadProgram(
  networkId: string,
  circleId: string,
  path: string,
  fresh = false
): Promise<string | null> {
  const p = path.startsWith('/') ? path : `/${path}`;
  const key = `${networkId}|${circleId}|${p}`;
  const hit = fresh ? undefined : programs.get(key);
  if (hit && Date.now() - hit.at < PROGRAM_TTL_MS) return hit.html;
  try {
    if ((await networkService.getCurrentNetworkId()) !== networkId) return null;
    const asset = await resolveCircleAsset(
      (item) =>
        networkService.jsonRpcCall('circle_asset', [circleId, item]) as Promise<CircleAssetReply>,
      p
    );
    if (!asset) return null;
    const html = new TextDecoder().decode(asset.bytes);
    programs.set(key, { at: Date.now(), html });
    return html;
  } catch {
    return null;
  }
}

export async function reloadProgram(networkId: string, uri: string): Promise<boolean> {
  const parsed = parseOctUri(uri);
  return !!parsed && !!(await loadProgram(networkId, parsed.circleId, parsed.path, true));
}
