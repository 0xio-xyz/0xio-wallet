import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import 'src/i18n';

const rpc = vi.hoisted(() => vi.fn());
const view = vi.hoisted(() => vi.fn());
const ctx = vi.hoisted(() => ({
  networkId: 'devnet',
  stored: 'devnet',
  address: 'oct7xKq3mVbT9fWc2ZnHs5RdYgPj8LuAe4GtNwB6CrXhEaS',
  ons: null as string | null,
}));
const disk = vi.hoisted(() => new Map<string, { bytes: Uint8Array; contentType: string }>());

vi.mock('src/services/network/NetworkService', () => ({
  networkService: {
    jsonRpcCall: rpc,
    contractCallView: view,
    getCurrentNetworkId: async () => ctx.stored,
  },
  privacyNetworkService: {},
}));
vi.mock('src/contexts/WalletContext', () => ({
  useWallet: () => ({
    networkId: ctx.networkId,
    activeWallet: { address: ctx.address, name: 'Spending', privateKey: 'key' },
  }),
}));
vi.mock('src/features/wallet/nft/circleAssetCache', () => ({
  getCachedAsset: async (k: string) => disk.get(k) ?? null,
  putCachedAsset: async (k: string, a: { bytes: Uint8Array; contentType: string }) => {
    disk.set(k, a);
  },
  deleteCachedAsset: async (k: string) => {
    disk.delete(k);
  },
}));
vi.mock('src/hooks/wallet/useOnsContract', () => ({ useOnsContract: () => ctx.ons }));
vi.mock('src/features/wallet/nft/useOnsPiece', () => ({
  useOnsPiece: (_n: string, contract: string) =>
    contract === ctx.ons
      ? {
          title: '0xio.oct',
          loaded: true,
          active: true,
          inactive: false,
          expired: false,
          expires: null as number | null,
        }
      : null,
}));
vi.mock('src/features/wallet/nft/xpectrum/config', async (original) => ({
  ...(await original<typeof import('src/features/wallet/nft/xpectrum/config')>()),
  xpectrumConfig: (): null => null,
}));
vi.mock('src/features/wallet/nft/piece/format', async (original) => ({
  ...(await original<typeof import('src/features/wallet/nft/piece/format')>()),
  readOctUsd: async (): Promise<null> => null,
}));
vi.mock('src/shared/ui/WalletAvatar', () => ({ default: (): null => null }));
vi.mock('src/shared/ui/Header', () => ({
  default: ({ title, rightAction }: { title: string; rightAction?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {rightAction}
    </header>
  ),
}));
vi.mock('src/features/wallet/nft/piece/NftFlowSheet', () => ({
  NftFlowSheet: (): null => null,
}));

import {
  type NftCollection,
  cardDetailCache,
  ownedIdsCache,
  setSnapshotCtx,
  snapshotKey,
} from 'src/features/wallet/nft/nftData';
import {
  imageBlobUrl,
  pieceCacheKey,
  refreshPiece,
  resolvePiece,
} from 'src/features/wallet/nft/piece/pieceData';
import { usePiece } from 'src/features/wallet/nft/piece/usePiece';
import { NftPiecePage } from 'src/features/wallet/nft/piece/NftPiecePage';
import { getPoster, posterKey, savePoster } from 'src/features/wallet/nft/euint/posterCache';

const WALLET = ctx.address;
const OTHER = 'oct2Zd8FhWq5TnYc9RmJv4KsXb7PgLe3AuNtC6GwHyBiQo1';
const POSTER = 'data:image/png;base64,AAAA';

type TokenState = 'ok' | 'down' | 'burned';
const chain = {
  uri: '',
  token: 'ok' as TokenState,
  http: new Map<string, () => Promise<unknown> | unknown>(),
  files: new Map<string, string>(),
};
const store = new Map<string, unknown>();
const fetched = vi.fn();
let seq = 0;
let made = 0;

const tokenUriReads = () => view.mock.calls.filter(([, method]) => method === 'token_uri').length;
const reloads = () =>
  fetched.mock.calls.filter(([, init]) => init?.cache === 'reload').map(([url]) => url);
const file = (circle: string, path: string, body: string) =>
  chain.files.set(`${circle}|${path}`, body);

function httpToken(name: string, extra: Record<string, unknown> = {}) {
  const n = ++seq;
  const contract = `octRefreshC${n}`;
  const meta = `https://meta.example/${n}.json`;
  const art = `https://art.example/${n}.png`;
  const state = { name, imageOk: true, gate: Promise.resolve() };
  chain.uri = meta;
  chain.http.set(meta, async () => {
    await state.gate;
    return { name: state.name, image: art, ...extra };
  });
  chain.http.set(art, () => (state.imageOk ? new Blob([state.name]) : null));
  return { contract, meta, art, state, key: pieceCacheKey('devnet', contract, '1', WALLET) };
}

const page = (contract: string, onGone = () => {}) =>
  render(
    <NftPiecePage
      contract={contract}
      tokenId="1"
      collection="Geodesics"
      onClose={() => {}}
      onHidePiece={() => {}}
      onHideCollection={() => {}}
      onGone={onGone}
    />
  );
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'More options' }));
const menuRows = () => screen.getAllByRole('menuitem').map((el) => el.textContent);
const pick = (label: string) => {
  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
};
const artBox = (container: HTMLElement) => container.querySelector<HTMLElement>('[aria-busy]')!;

beforeEach(() => {
  ctx.networkId = 'devnet';
  ctx.stored = 'devnet';
  ctx.ons = null;
  chain.token = 'ok';
  chain.http.clear();
  chain.files.clear();
  disk.clear();
  store.clear();
  cardDetailCache.clear();
  ownedIdsCache.clear();
  setSnapshotCtx(null);
  view.mockReset();
  view.mockImplementation(async (_contract: string, method: string) => {
    if (method !== 'token_uri') throw new Error('no such view');
    if (chain.token === 'down') throw new Error('timeout');
    if (chain.token === 'burned') throw new Error('execution reverted');
    return chain.uri;
  });
  rpc.mockReset();
  rpc.mockImplementation(async (method: string, params: string[]) => {
    if (method === 'octra_contractAbi') return { methods: [] };
    if (method !== 'circle_asset') return null;
    const body = chain.files.get(`${params[0]}|${params[1]}`);
    return body === undefined
      ? null
      : { content_type: 'application/octet-stream', body_b64: btoa(body) };
  });
  fetched.mockReset();
  fetched.mockImplementation(async (url: string) => {
    const body = await chain.http.get(url)?.();
    if (body == null) return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => body, blob: async () => body };
  });
  vi.stubGlobal('fetch', fetched);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:art-${++made}`);
  vi.mocked(chrome.storage.local.get).mockImplementation((async (k: string) =>
    store.has(k) ? { [k]: store.get(k) } : {}) as never);
  vi.mocked(chrome.storage.local.set).mockImplementation((async (
    items: Record<string, unknown>
  ) => {
    for (const [k, v] of Object.entries(items)) store.set(k, v);
  }) as never);
});

afterEach(() => vi.restoreAllMocks());

describe('refresh metadata on the piece page', () => {
  it('is the last row, dims the art it keeps while running, and shows the fresh read', async () => {
    const t = httpToken('One');
    await resolvePiece('devnet', t.contract, '1', WALLET);
    const first = await imageBlobUrl(t.art);
    await savePoster('devnet', t.contract, '1', POSTER);
    setSnapshotCtx({
      networkId: 'devnet',
      wallet: WALLET,
      collections: [{ contractAddress: t.contract } as NftCollection],
    });
    ownedIdsCache.set(`devnet:${t.contract}:${WALLET}`, { ids: ['1'], ts: Date.now() });
    t.state.name = 'Two';
    expect(await imageBlobUrl(t.art)).toBe(first);

    const { container } = page(t.contract);
    expect(screen.getByRole('img', { name: 'One' })).toHaveAttribute('src', first);
    expect(artBox(container)).toHaveAttribute('aria-busy', 'false');
    expect(artBox(container).style.transition).toBe('opacity 200ms ease-out');

    openMenu();
    expect(menuRows()).toEqual([
      'Hide this piece',
      'Hide all Geodesics',
      'Copy contract address',
      'Refresh metadata',
    ]);
    let release = () => {};
    t.state.gate = new Promise<void>((r) => (release = r));
    const reads = tokenUriReads();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh metadata' }));
    await waitFor(() => expect(tokenUriReads()).toBe(reads + 1));

    expect(artBox(container)).toHaveAttribute('aria-busy', 'true');
    expect(artBox(container).style.opacity).toBe('0.55');
    expect(screen.getByRole('img', { name: 'One' })).toHaveAttribute('src', first);
    openMenu();
    expect(menuRows().pop()).toBe('Refreshing metadata');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refreshing metadata' }));
    await act(async () => {});
    expect(tokenUriReads()).toBe(reads + 1);

    await act(async () => release());
    const img = await screen.findByRole('img', { name: 'Two' });
    expect(img.getAttribute('src')).not.toBe(first);
    expect(img.getAttribute('src')).toMatch(/^blob:art-/);
    expect(artBox(container)).toHaveAttribute('aria-busy', 'false');
    expect(artBox(container).style.opacity).toBe('1');
    expect(screen.queryByRole('status')).toBeNull();
    openMenu();
    expect(menuRows().pop()).toBe('Refresh metadata');

    expect(reloads()).toEqual([t.meta, t.art]);
    expect(cardDetailCache.get(t.key)!.detail.metaName).toBe('Two');
    expect(await imageBlobUrl(t.art)).toBe(img.getAttribute('src'));
    expect(await getPoster('devnet', t.contract, '1')).toBeNull();
    expect(disk.has(posterKey('devnet', t.contract, '1'))).toBe(false);
    await waitFor(() => {
      const snap = store.get(snapshotKey('devnet', WALLET)) as {
        cards: Record<string, { detail: { metaName: string } }>;
      };
      expect(snap.cards[`${t.contract}:1`].detail.metaName).toBe('Two');
    });
  });

  it('keeps what is shown when the read fails', async () => {
    const t = httpToken('One');
    await resolvePiece('devnet', t.contract, '1', WALLET);
    const first = await imageBlobUrl(t.art);
    await savePoster('devnet', t.contract, '1', POSTER);
    const shown = cardDetailCache.get(t.key);
    const { container } = page(t.contract);

    for (const fail of [
      () => (chain.token = 'down'),
      () => ((chain.token = 'ok'), (t.state.name = 'Two'), (t.state.imageOk = false)),
    ]) {
      fail();
      const reads = tokenUriReads();
      pick('Refresh metadata');
      await waitFor(() => expect(tokenUriReads()).toBe(reads + 1));
      await waitFor(() => expect(artBox(container)).toHaveAttribute('aria-busy', 'false'));
      expect(screen.getByRole('img', { name: 'One' })).toHaveAttribute('src', first);
      expect(cardDetailCache.get(t.key)).toBe(shown);
      expect(await imageBlobUrl(t.art)).toBe(first);
      expect(await getPoster('devnet', t.contract, '1')).toBe(POSTER);
      expect(store.size).toBe(0);
    }
  });

  it('drops a burned piece from the gallery', async () => {
    const t = httpToken('One');
    await resolvePiece('devnet', t.contract, '1', WALLET);
    const gone = vi.fn();
    page(t.contract, gone);
    chain.token = 'burned';
    pick('Refresh metadata');
    await waitFor(() => expect(gone).toHaveBeenCalledTimes(1));
    expect(cardDetailCache.has(t.key)).toBe(false);
  });

  it('restarts a living piece so it captures a new poster', async () => {
    const circle = 'octLivingCircle';
    const t = httpToken('One', { animation_url: `oct://${circle}/index.html?token=1` });
    file(circle, '/index.html', '<html></html>');
    await resolvePiece('devnet', t.contract, '1', WALLET);
    await savePoster('devnet', t.contract, '1', POSTER);
    const { container } = page(t.contract);
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();

    chain.files.delete(`${circle}|/index.html`);
    const shown = cardDetailCache.get(t.key);
    pick('Refresh metadata');
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('circle_asset', [circle, '/index.html']));
    await waitFor(() => expect(artBox(container)).toHaveAttribute('aria-busy', 'false'));
    expect(container.querySelector('iframe')).toBe(frame);
    expect(cardDetailCache.get(t.key)).toBe(shown);
    expect(await getPoster('devnet', t.contract, '1')).toBe(POSTER);

    file(circle, '/index.html', '<html></html>');
    pick('Refresh metadata');
    await waitFor(() => expect(container.querySelector('iframe')).not.toBe(frame));
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(await getPoster('devnet', t.contract, '1')).toBeNull();
    expect(cardDetailCache.get(t.key)!.detail.poster).toBeUndefined();
  });

  it('is offered on a name and reads it past the caches', async () => {
    const t = httpToken('0xio.oct');
    ctx.ons = t.contract;
    page(t.contract);
    await screen.findByRole('img', { name: '0xio.oct' });
    openMenu();
    expect(menuRows().pop()).toBe('Refresh metadata');
    const reads = tokenUriReads();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh metadata' }));
    });
    await waitFor(() => expect(reloads()).toEqual([t.meta, t.art]));
    expect(tokenUriReads()).toBe(reads + 1);
  });
});

describe('refresh metadata reads', () => {
  it('ignores a second call while one runs', async () => {
    const t = httpToken('One');
    const { result } = renderHook(() => usePiece(t.contract, '1'));
    await waitFor(() => expect(result.current.detail.metaFetched).toBe(true));
    const reads = tokenUriReads();
    await act(async () => {
      const first = result.current.refreshMetadata();
      const second = result.current.refreshMetadata();
      await Promise.all([first, second]);
    });
    expect(tokenUriReads()).toBe(reads + 1);
    expect(result.current.revision).toBe(1);
    expect(result.current.refreshing).toBe(false);
  });

  it('stays inside its network and wallet', async () => {
    const t = httpToken('One');
    await resolvePiece('devnet', t.contract, '1', WALLET);
    const mainnet = { ...cardDetailCache.get(t.key)!, ts: 1 };
    const stranger = { ...cardDetailCache.get(t.key)!, ts: 2 };
    cardDetailCache.set(pieceCacheKey('mainnet', t.contract, '1', WALLET), mainnet);
    cardDetailCache.set(pieceCacheKey('devnet', t.contract, '1', OTHER), stranger);
    await savePoster('devnet', t.contract, '1', POSTER);
    await savePoster('mainnet', t.contract, '1', POSTER);
    setSnapshotCtx({
      networkId: 'devnet',
      wallet: WALLET,
      collections: [{ contractAddress: t.contract } as NftCollection],
    });
    ownedIdsCache.set(`devnet:${t.contract}:${WALLET}`, { ids: ['1'], ts: Date.now() });
    t.state.name = 'Two';

    await refreshPiece('devnet', t.contract, '1', WALLET);
    expect(cardDetailCache.get(t.key)!.detail.metaName).toBe('Two');
    expect(cardDetailCache.get(pieceCacheKey('mainnet', t.contract, '1', WALLET))).toBe(mainnet);
    expect(cardDetailCache.get(pieceCacheKey('devnet', t.contract, '1', OTHER))).toBe(stranger);
    expect(await getPoster('devnet', t.contract, '1')).toBeNull();
    expect(await getPoster('mainnet', t.contract, '1')).toBe(POSTER);
    await waitFor(() => expect(store.has(snapshotKey('devnet', WALLET))).toBe(true));
    expect([...store.keys()]).toEqual([snapshotKey('devnet', WALLET)]);

    ctx.stored = 'mainnet';
    const reads = tokenUriReads();
    const shown = cardDetailCache.get(t.key);
    await expect(refreshPiece('devnet', t.contract, '1', WALLET)).rejects.toThrow();
    expect(tokenUriReads()).toBe(reads);
    expect(cardDetailCache.get(t.key)).toBe(shown);
  });

  it('reads a circle token past the asset caches and replaces them', async () => {
    const circle = 'octPrerenderedCircle';
    const contract = 'octRefreshPre';
    const key = pieceCacheKey('devnet', contract, '1', WALLET);
    const image = (body: string) => `data:image/*;base64,${btoa(body)}`;
    chain.uri = `oct://${circle}/1.json`;
    file(circle, '/collection.json', JSON.stringify({ render_type: 'prerendered' }));
    file(circle, '/1.json', JSON.stringify({ name: 'One', image: `oct://${circle}/img/1.png` }));
    file(circle, '/img/1.png', 'first');
    expect((await resolvePiece('devnet', contract, '1', WALLET)).detail.image).toBe(image('first'));
    expect([...disk.keys()].filter((k) => k.includes(circle))).toEqual([
      `devnet|${circle}|/img/1.png`,
    ]);

    file(circle, '/1.json', JSON.stringify({ name: 'Two', image: `oct://${circle}/img/1.png` }));
    file(circle, '/img/1.png', 'second');
    const cached = (await resolvePiece('devnet', contract, '1', WALLET)).detail;
    expect([cached.metaName, cached.image]).toEqual(['One', image('first')]);

    chain.files.delete(`${circle}|/img/1.png`);
    const shown = cardDetailCache.get(key);
    await expect(refreshPiece('devnet', contract, '1', WALLET)).rejects.toThrow();
    expect(cardDetailCache.get(key)).toBe(shown);
    expect(new TextDecoder().decode(disk.get(`devnet|${circle}|/img/1.png`)!.bytes)).toBe('first');

    file(circle, '/img/1.png', 'second');
    const fresh = (await refreshPiece('devnet', contract, '1', WALLET)).detail;
    expect([fresh.metaName, fresh.image]).toEqual(['Two', image('second')]);
    expect(new TextDecoder().decode(disk.get(`devnet|${circle}|/img/1.png`)!.bytes)).toBe('second');
    const after = (await resolvePiece('devnet', contract, '1', WALLET)).detail;
    expect([after.metaName, after.image]).toEqual(['Two', image('second')]);
  });

  it('composes a layered token again from layers read past the caches', async () => {
    const circle = 'octComposedCircle';
    const contract = 'octRefreshComposed';
    let bitmaps = 0;
    let drawn = 0;
    vi.stubGlobal('createImageBitmap', async () => ({ width: 1, height: 1, n: ++bitmaps }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: (bm: { n: number }) => (drawn = bm.n),
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      () => `data:image/webp;base64,${btoa(String(drawn))}`
    );
    const composite = (n: number) => `data:image/webp;base64,${btoa(String(n))}`;
    const saved = `xnft_composite:${circle}|/traits/body/red.png`;
    chain.uri = `oct://${circle}/1.json`;
    file(
      circle,
      '/collection.json',
      JSON.stringify({ render_type: 'composed', trait_types: [{ name: 'Body', layer_order: 0 }] })
    );
    file(
      circle,
      '/1.json',
      JSON.stringify({ name: 'One', attributes: [{ trait_type: 'Body', value: 'Red' }] })
    );
    file(circle, '/traits/body/red.png', 'layer');

    expect((await resolvePiece('devnet', contract, '1', WALLET)).detail.image).toBe(composite(1));
    expect((await resolvePiece('devnet', contract, '1', WALLET)).detail.image).toBe(composite(1));
    expect(store.get(saved)).toBe(composite(1));
    const layerReads = () =>
      rpc.mock.calls.filter(([m, p]) => m === 'circle_asset' && p[1] === '/traits/body/red.png')
        .length;
    expect(layerReads()).toBe(1);

    expect((await refreshPiece('devnet', contract, '1', WALLET)).detail.image).toBe(composite(2));
    expect(layerReads()).toBe(2);
    expect(store.get(saved)).toBe(composite(2));
    expect((await resolvePiece('devnet', contract, '1', WALLET)).detail.image).toBe(composite(2));
    expect(layerReads()).toBe(2);
  });
});
