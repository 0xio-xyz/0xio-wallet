import { describe, it, expect, vi } from 'vitest';

const disk = new Map<string, { bytes: Uint8Array; contentType: string }>();
vi.mock('src/features/wallet/nft/circleAssetCache', () => ({
  getCachedAsset: async (k: string) => disk.get(k) ?? null,
  putCachedAsset: async (k: string, a: { bytes: Uint8Array; contentType: string }) => {
    disk.set(k, a);
  },
}));

import { getPoster, savePoster } from 'src/features/wallet/nft/euint/posterCache';
import { bytesToBase64 } from 'src/lib/encoding';

const NET = 'mainnet';
const C = 'oct4bKzQx7n2';
const png = (bytes: number) => {
  const raw = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) raw[i] = (i * 31 + 7) & 0xff;
  return `data:image/png;base64,${bytesToBase64(raw)}`;
};

describe('living NFT posters', () => {
  it('keeps a poster larger than the snapshot inline cap, which is what reopen used to lose', async () => {
    const big = png(60_000);
    expect(big.length).toBeGreaterThan(32 * 1024);
    await savePoster(NET, C, '1', big);
    expect(await getPoster(NET, C, '1')).toBe(big);
  });

  it('reads back from disk alone, as a freshly opened popup must', async () => {
    const url = png(40_000);
    const b64 = url.slice('data:image/png;base64,'.length);
    disk.set(`poster:${NET}:${C}:2`, {
      bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
      contentType: 'image/png',
    });
    expect(await getPoster(NET, C, '2')).toBe(url);
  });

  it('refuses to store anything but a bounded raster data URL', async () => {
    await savePoster(NET, C, '3', 'https://example.com/steal.png');
    await savePoster(NET, C, '3', 'data:image/svg+xml;base64,PHN2Zz4=');
    expect(disk.has(`poster:${NET}:${C}:3`)).toBe(false);
    expect(await getPoster(NET, C, '3')).toBeNull();
  });

  it('checks again on read, since the image came from an untrusted program', async () => {
    disk.set(`poster:${NET}:${C}:4`, {
      bytes: new Uint8Array([60, 115, 118, 103, 62]),
      contentType: 'image/svg+xml',
    });
    expect(await getPoster(NET, C, '4')).toBeNull();
  });

  it('never shares a key with a circle asset, which are always circleId|path', async () => {
    await savePoster(NET, C, '5', png(1_000));
    for (const k of disk.keys()) expect(k.includes('|')).toBe(false);
  });
});
