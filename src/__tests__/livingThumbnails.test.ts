import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('src/services/network/NetworkService', () => ({
  networkService: {
    getCurrentNetworkId: async () => 'devnet',
    jsonRpcCall: (method: string, params: unknown[]) => rpc(method, params),
  },
}));
vi.mock('src/features/wallet/nft/circleAssetCache', () => ({
  getCachedAsset: async (): Promise<null> => null,
  putCachedAsset: async () => {},
}));

import { buildMeta, staticImageCandidates } from 'src/features/wallet/nft/nftData';
import {
  createPosterQueue,
  jobKey,
  type PosterJob,
} from 'src/features/wallet/nft/euint/posterQueue';

const PROGRAM = 'oct://oct2geode/index.html?token=7&contract=oct2anq';
const POSTER = 'data:image/webp;base64,UklGRgAAAABXRUJQ';

describe('static image over the living program', () => {
  beforeEach(() => rpc.mockReset());

  it('skips an image that is the program and takes image_url', async () => {
    const m = await buildMeta({
      image: PROGRAM,
      image_url: 'https://cdn.example/7.png',
      animation_url: PROGRAM,
    });
    expect(m.image).toBe('https://cdn.example/7.png');
    expect(m.animationUrl).toBe(PROGRAM);
  });

  it('falls through to a preview field the collection uses', async () => {
    const m = await buildMeta({ image: PROGRAM, thumbnail: 'ipfs://bafyStill' });
    expect(m.image).toBe('https://ipfs.io/ipfs/bafyStill');
  });

  it('resolves an oct:// still through the circle, never the program', async () => {
    rpc.mockResolvedValue({ content_type: 'image/png', body_b64: 'iVBORw0K' });
    const m = await buildMeta({ image: PROGRAM, preview: 'oct://oct2geode/7.png' });
    expect(m.image).toBe('data:image/png;base64,iVBORw0K');
    expect(rpc).toHaveBeenCalledWith('circle_asset', ['oct2geode', '/7.png']);
    expect(rpc).not.toHaveBeenCalledWith('circle_asset', ['oct2geode', '/index.html']);
  });

  it('tries the next still when one does not resolve', async () => {
    rpc.mockResolvedValue(null);
    const m = await buildMeta({
      image: 'oct://gone/7.png',
      image_url: 'https://cdn.example/7.png',
    });
    expect(m.image).toBe('https://cdn.example/7.png');
  });

  it('leaves the image empty when every field is a program or a page', async () => {
    const m = await buildMeta({ image: PROGRAM, image_url: 'https://site.example/art.html' });
    expect(m.image).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps field order and drops duplicates', () => {
    expect(
      staticImageCandidates({
        image: ' https://a/1.png ',
        image_url: 'https://a/1.png',
        poster: 'https://a/2.png',
        name: 'https://a/3.png',
      })
    ).toEqual(['https://a/1.png', 'https://a/2.png']);
  });
});

const job = (tokenId: string, scope = 'devnet:oct1me'): PosterJob => ({
  networkId: scope.split(':')[0],
  contract: 'oct2anq',
  tokenId,
  uri: PROGRAM,
  scope,
});

describe('background poster queue', () => {
  let stored: Set<string>;
  let saved: string[];
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const make = () =>
    createPosterQueue({
      concurrency: 2,
      timeoutMs: 10_000,
      hasPoster: async (j) => stored.has(jobKey(j)),
      save: (j, url) => {
        saved.push(`${j.tokenId}:${url.length}`);
      },
    });
  const running = (q: ReturnType<typeof make>) => q.frames().map((j) => j.tokenId);

  beforeEach(() => {
    vi.useFakeTimers();
    stored = new Set();
    saved = [];
  });
  afterEach(() => vi.useRealTimers());

  it('renders at most two pieces at once and moves on as each finishes', async () => {
    const q = make();
    q.setScope('devnet:oct1me');
    q.setActive(true);
    ['1', '2', '3', '4'].forEach((id) => q.request(job(id)));
    await flush();
    expect(running(q)).toEqual(['1', '2']);
    q.complete(job('1'), POSTER);
    await flush();
    expect(running(q)).toEqual(['2', '3']);
    expect(saved).toEqual([`1:${POSTER.length}`]);
    q.fail(job('2'));
    await flush();
    expect(running(q)).toEqual(['3', '4']);
  });

  it('never frames a piece that already has a poster', async () => {
    stored.add(jobKey(job('1')));
    const q = make();
    q.setScope('devnet:oct1me');
    q.setActive(true);
    q.request(job('1'));
    q.request(job('2'));
    await flush();
    expect(running(q)).toEqual(['2']);
    q.request(job('1'));
    await flush();
    expect(running(q)).toEqual(['2']);
  });

  it('gives up on a piece after the timeout and skips it for the session', async () => {
    const q = make();
    q.setScope('devnet:oct1me');
    q.setActive(true);
    const release = q.request(job('1'));
    await flush();
    expect(running(q)).toEqual(['1']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(running(q)).toEqual([]);
    release();
    q.request(job('1'));
    await flush();
    expect(running(q)).toEqual([]);
    q.complete(job('1'), POSTER);
    expect(saved).toEqual([]);
  });

  it('drops the frames and the queue of another network or address', async () => {
    const q = make();
    q.setScope('devnet:oct1me');
    q.setActive(true);
    ['1', '2', '3'].forEach((id) => q.request(job(id)));
    await flush();
    expect(running(q)).toEqual(['1', '2']);
    q.setScope('mainnet:oct1me');
    await flush();
    expect(running(q)).toEqual([]);
    q.complete(job('1'), POSTER);
    expect(saved).toEqual([]);
    q.request(job('9', 'mainnet:oct1me'));
    await flush();
    expect(running(q)).toEqual(['9']);
    q.setScope('devnet:oct1me');
    await flush();
    expect(running(q)).toEqual([]);
  });

  it('runs nothing while inactive and resumes the pieces still shown', async () => {
    const q = make();
    q.setScope('devnet:oct1me');
    q.request(job('1'));
    const release2 = q.request(job('2'));
    await flush();
    expect(running(q)).toEqual([]);
    q.setActive(true);
    await flush();
    expect(running(q)).toEqual(['1', '2']);
    q.setActive(false);
    expect(running(q)).toEqual([]);
    release2();
    q.setActive(true);
    await flush();
    expect(running(q)).toEqual(['1']);
  });

  it('tears a frame down when its tile goes away, without marking the piece failed', async () => {
    const q = make();
    q.setScope('devnet:oct1me');
    q.setActive(true);
    const release = q.request(job('1'));
    await flush();
    release();
    expect(running(q)).toEqual([]);
    q.request(job('1'));
    await flush();
    expect(running(q)).toEqual(['1']);
  });

  it('refuses a poster that is not a bounded raster data URL', async () => {
    const q = make();
    q.setScope('devnet:oct1me');
    q.setActive(true);
    q.request(job('1'));
    await flush();
    q.complete(job('1'), 'https://evil.example/x.png');
    q.complete(job('1'), 'data:image/svg+xml;base64,PHN2Zz4=');
    expect(saved).toEqual([]);
    expect(running(q)).toEqual(['1']);
  });
});
