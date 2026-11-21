export interface NftHidden {
  collections: string[];
  pieces: string[];
}

export const NO_HIDDEN: NftHidden = { collections: [], pieces: [] };

const COLLS = (networkId: string, wallet: string) => `0xio_nft_hidden_colls_${networkId}_${wallet}`;
const PIECES = (networkId: string, wallet: string) =>
  `0xio_nft_hidden_pieces_${networkId}_${wallet}`;
const SHOWN = (networkId: string, wallet: string) => `0xio_nft_shown_colls_${networkId}_${wallet}`;
const LEGACY_WALLET = (networkId: string, wallet: string) => `ignored_nfts_${networkId}_${wallet}`;
const LEGACY_NETWORK = (networkId: string) => `ignored_nfts_${networkId}`;

export const pieceId = (contract: string, tokenId: string) => `${contract}:${tokenId}`;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];

export function fromLegacyIgnored(list: unknown): NftHidden {
  const collections: string[] = [];
  const pieces: string[] = [];
  for (const entry of strings(list)) {
    const bar = entry.indexOf('|');
    if (bar === -1) collections.push(entry);
    else pieces.push(pieceId(entry.slice(0, bar), entry.slice(bar + 1)));
  }
  return { collections: [...new Set(collections)], pieces: [...new Set(pieces)] };
}

export const isCollectionHidden = (h: NftHidden, contract: string) =>
  h.collections.some((a) => same(a, contract));

export const isPieceHidden = (h: NftHidden, contract: string, tokenId: string) =>
  h.pieces.includes(pieceId(contract, tokenId));

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch((): undefined => undefined);
  return next;
}

async function readOrMigrate(networkId: string, wallet: string): Promise<NftHidden> {
  const colls = COLLS(networkId, wallet);
  const pieces = PIECES(networkId, wallet);
  const legacyWallet = LEGACY_WALLET(networkId, wallet);
  const legacyNetwork = LEGACY_NETWORK(networkId);
  const r = await chrome.storage.local.get([colls, pieces, legacyWallet, legacyNetwork]);
  if (colls in r || pieces in r) {
    return { collections: strings(r[colls]), pieces: strings(r[pieces]) };
  }
  const h = fromLegacyIgnored(legacyWallet in r ? r[legacyWallet] : r[legacyNetwork]);
  await chrome.storage.local.set({ [colls]: h.collections, [pieces]: h.pieces });
  if (legacyWallet in r) await chrome.storage.local.remove(legacyWallet);
  return h;
}

export function loadHidden(networkId: string, wallet: string): Promise<NftHidden> {
  if (!networkId || !wallet) return Promise.resolve(NO_HIDDEN);
  return serial(() => readOrMigrate(networkId, wallet));
}

async function readShown(networkId: string, wallet: string): Promise<string[]> {
  const key = SHOWN(networkId, wallet);
  return strings((await chrome.storage.local.get([key]))?.[key]);
}

export function setCollectionHidden(
  networkId: string,
  wallet: string,
  contract: string,
  hidden: boolean
): Promise<NftHidden> {
  return serial(async () => {
    const h = await readOrMigrate(networkId, wallet);
    const rest = h.collections.filter((a) => !same(a, contract));
    const collections = hidden ? [...rest, contract] : rest;
    const shownRest = (await readShown(networkId, wallet)).filter((a) => !same(a, contract));
    await chrome.storage.local.set({
      [COLLS(networkId, wallet)]: collections,
      [SHOWN(networkId, wallet)]: hidden ? shownRest : [...shownRest, contract],
    });
    return { ...h, collections };
  });
}

export function hideSpamCollections(
  networkId: string,
  wallet: string,
  contracts: readonly string[]
): Promise<NftHidden> {
  if (!networkId || !wallet) return Promise.resolve(NO_HIDDEN);
  return serial(async () => {
    const h = await readOrMigrate(networkId, wallet);
    if (contracts.length === 0) return h;
    const shown = await readShown(networkId, wallet);
    const add = contracts.filter(
      (c, i) =>
        !isCollectionHidden(h, c) &&
        !shown.some((a) => same(a, c)) &&
        contracts.findIndex((x) => same(x, c)) === i
    );
    if (add.length === 0) return h;
    const collections = [...h.collections, ...add];
    await chrome.storage.local.set({ [COLLS(networkId, wallet)]: collections });
    return { ...h, collections };
  });
}

export function setPieceHidden(
  networkId: string,
  wallet: string,
  contract: string,
  tokenId: string,
  hidden: boolean
): Promise<NftHidden> {
  return serial(async () => {
    const h = await readOrMigrate(networkId, wallet);
    const key = pieceId(contract, tokenId);
    const rest = h.pieces.filter((k) => k !== key);
    const pieces = hidden ? [...rest, key] : rest;
    await chrome.storage.local.set({ [PIECES(networkId, wallet)]: pieces });
    return { ...h, pieces };
  });
}
