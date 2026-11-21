import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  type NftHidden,
  fromLegacyIgnored,
  isCollectionHidden,
  isPieceHidden,
  loadHidden,
  setCollectionHidden,
  setPieceHidden,
} from 'src/features/wallet/nft/hidden';
import {
  BASELINE_WINDOW_MS,
  newestFirst,
  pieceKey,
  stampPieces,
} from 'src/features/wallet/nft/firstSeen';
import { deriveGallery } from 'src/features/wallet/nft/gallery/deriveGallery';
import type { NftCollection } from 'src/features/wallet/nft/nftData';

const W = 'oct1wallet';
const OTHER = 'oct1other';
let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  const pick = (keys: unknown) => {
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
  };
  vi.mocked(chrome.storage.local.get).mockImplementation((async (keys: unknown) =>
    pick(keys)) as never);
  vi.mocked(chrome.storage.local.set).mockImplementation((async (items: object) => {
    Object.assign(store, items);
  }) as never);
  vi.mocked(chrome.storage.local.remove).mockImplementation((async (keys: unknown) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k as string];
  }) as never);
});

describe('hidden', () => {
  it('keeps collections and pieces per network and wallet', async () => {
    await setCollectionHidden('devnet', W, 'octA', true);
    await setPieceHidden('devnet', W, 'octB', '7', true);
    const h = await loadHidden('devnet', W);
    expect(isCollectionHidden(h, 'OCTA')).toBe(true);
    expect(isPieceHidden(h, 'octB', '7')).toBe(true);
    expect(await loadHidden('mainnet', W)).toEqual({ collections: [], pieces: [] });
    expect(await loadHidden('devnet', OTHER)).toEqual({ collections: [], pieces: [] });
  });

  it('shows again what was hidden', async () => {
    await setCollectionHidden('devnet', W, 'octA', true);
    await setPieceHidden('devnet', W, 'octB', '7', true);
    await setCollectionHidden('devnet', W, 'OCTA', false);
    const h = await setPieceHidden('devnet', W, 'octB', '7', false);
    expect(h).toEqual({ collections: [], pieces: [] });
  });

  it('starts the old ignored collections and pieces hidden, once, and drops the wallet list', async () => {
    store[`ignored_nfts_devnet_${W}`] = ['octScam', 'octA|3'];
    const h = await loadHidden('devnet', W);
    expect(h).toEqual({ collections: ['octScam'], pieces: ['octA:3'] });
    expect(store[`ignored_nfts_devnet_${W}`]).toBeUndefined();
    await setCollectionHidden('devnet', W, 'octScam', false);
    expect((await loadHidden('devnet', W)).collections).toEqual([]);
  });

  it('folds in the network-wide list when the wallet has none, and leaves it for other wallets', async () => {
    store['ignored_nfts_mainnet'] = ['octOld'];
    expect((await loadHidden('mainnet', W)).collections).toEqual(['octOld']);
    expect((await loadHidden('mainnet', OTHER)).collections).toEqual(['octOld']);
    expect(store['ignored_nfts_mainnet']).toEqual(['octOld']);
  });

  it('reads the old entry format', () => {
    expect(fromLegacyIgnored(['a', 'b|1', 'a', 7])).toEqual({
      collections: ['a'],
      pieces: ['b:1'],
    });
  });
});

describe('first seen', () => {
  const A1 = { contract: 'octA', tokenId: '1' };
  const A2 = { contract: 'octA', tokenId: '2' };
  const B1 = { contract: 'octB', tokenId: '1' };

  it('stamps a first scan as time unknown and later arrivals with the time', () => {
    const first = stampPieces({}, 'devnet', W, [A1], 1000);
    expect(first[pieceKey('devnet', W, 'octA', '1')]).toBe(0);
    const later = 1000 + BASELINE_WINDOW_MS + 1;
    const m = stampPieces(first, 'devnet', W, [A1, A2], later);
    expect(m[pieceKey('devnet', W, 'octA', '1')]).toBe(0);
    expect(m[pieceKey('devnet', W, 'octA', '2')]).toBe(later);
  });

  it('keeps network and wallet apart', () => {
    const m = stampPieces({}, 'devnet', W, [A1], 1000);
    const later = 1000 + BASELINE_WINDOW_MS + 1;
    expect(stampPieces(m, 'mainnet', W, [A1], later)[pieceKey('mainnet', W, 'octA', '1')]).toBe(0);
    expect(
      stampPieces(m, 'devnet', OTHER, [A1], later)[pieceKey('devnet', OTHER, 'octA', '1')]
    ).toBe(0);
  });

  it('returns the same map when nothing is new', () => {
    const m = stampPieces({}, 'devnet', W, [A1], 1000);
    expect(stampPieces(m, 'devnet', W, [A1], 2000)).toBe(m);
  });

  it('puts new arrivals first and keeps collection order for the rest', () => {
    const first = stampPieces({}, 'devnet', W, [A1, A2, B1], 1000);
    const arrived = { contract: 'octC', tokenId: '9' };
    const m = stampPieces(first, 'devnet', W, [arrived], 1000 + BASELINE_WINDOW_MS + 5);
    const ordered = [A1, A2, B1, arrived];
    expect(newestFirst(ordered, m, 'devnet', W, 3)).toEqual([arrived, A1, A2]);
    expect(newestFirst([A1, A2, B1], first, 'devnet', W, 3)).toEqual([A1, A2, B1]);
  });
});

describe('opt-out collection list', () => {
  const coll = (contractAddress: string, name: string, ownedCount: number, imported = false) =>
    ({
      contractAddress,
      name,
      symbol: '',
      totalSupply: null,
      ownedCount,
      ownedTokenIds: [],
      imported,
    }) as NftCollection;
  const held = coll('octHeld', 'Geodesics', 3);
  const imported = coll('octImp', 'Bloom', 1, true);
  const scam = coll('octScam', 'Free Prize', 5);
  const ids = { octHeld: ['9', '2', '4'], octImp: ['7'], octScam: ['1', '2', '3', '4', '5'] };
  const none: NftHidden = { collections: [], pieces: [] };

  it('shows held and imported collections with no import step, most held first', () => {
    const g = deriveGallery([imported, held], { octHeld: ids.octHeld, octImp: ids.octImp }, none);
    expect(g.rows.map((r) => [r.collection.name, r.count])).toEqual([
      ['Geodesics', 3],
      ['Bloom', 1],
    ]);
    expect(g.visible.map((p) => `${p.contract}:${p.tokenId}`)).toEqual([
      'octHeld:2',
      'octHeld:4',
      'octHeld:9',
      'octImp:7',
    ]);
    expect(g.rows[0].thumbs).toEqual(['2', '4', '9']);
    expect(g.hiddenCount).toBe(0);
  });

  it('leaves hidden collections and pieces out of the rows and counts them under Hidden', () => {
    const g = deriveGallery([held, imported, scam], ids, {
      collections: ['OCTSCAM'],
      pieces: ['octHeld:4'],
    });
    expect(g.rows.map((r) => [r.collection.name, r.count])).toEqual([
      ['Geodesics', 2],
      ['Bloom', 1],
    ]);
    expect(g.visible.some((p) => p.contract === 'octScam')).toBe(false);
    expect(g.hiddenPieces.map((p) => `${p.contract}:${p.tokenId}`)).toEqual([
      'octScam:1',
      'octScam:2',
      'octScam:3',
      'octScam:4',
      'octScam:5',
      'octHeld:4',
    ]);
    expect(g.hiddenCount).toBe(6);
  });

  it('counts from the held number before a scan, and drops a row with nothing to show', () => {
    const g = deriveGallery(
      [held, coll('octEmpty', 'Gone', 0, true)],
      {},
      {
        collections: [],
        pieces: ['octHeld:1'],
      }
    );
    expect(g.rows.map((r) => [r.collection.name, r.count])).toEqual([['Geodesics', 2]]);
  });
});
