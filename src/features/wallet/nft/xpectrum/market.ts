import { callView, callViewStrict, splitPipe, toNum, isTruthy } from './read';

export async function isApprovedFor(
  nftContract: string,
  tokenId: number,
  operator: string
): Promise<boolean> {
  const spender = await callViewStrict(nftContract, 'get_approved', [tokenId]);
  return !!spender && spender.trim() === operator;
}

export interface Listing {
  id: number;
  seller: string;
  contract: string;
  tokenId: number;
  price: number;
  status: number;
  epoch: number;
}

export interface Offer {
  offerId: number;
  offerer: string;
  nftContract: string;
  tokenId: number;
  isCollection: boolean;
  amount: number;
  expiry: number;
  active: boolean;
}

export interface MarketInfo {
  listingCount: number;
  offerCount: number;
  activeCount: number;
  totalVolume: number;
  feeBalance: number;
  eventLogCount: number;
}

// get_listing -> id|seller|contract|tokenId|price|status|epoch
export async function getListing(market: string, listingId: number): Promise<Listing | null> {
  const f = splitPipe(await callViewStrict(market, 'get_listing', [listingId]));
  if (f.length < 7) return null;
  return {
    id: toNum(f[0]),
    seller: f[1],
    contract: f[2],
    tokenId: toNum(f[3]),
    price: toNum(f[4]),
    status: toNum(f[5]),
    epoch: toNum(f[6]),
  };
}

// get_token_listing -> listing_id + 1 (0 = unlisted). Resolve to the active Listing or null.
export async function getActiveListing(
  market: string,
  nftContract: string,
  tokenId: number
): Promise<Listing | null> {
  // Strict: on a node timeout this throws (so the caller keeps last-known) instead of reading
  // idPlus1=0 -> "not listed"
  const idPlus1 = toNum(
    (await callViewStrict(market, 'get_token_listing', [nftContract, tokenId])) ?? undefined
  );
  if (!idPlus1) return null;
  const listing = await getListing(market, idPlus1 - 1);
  return listing && listing.status === 1 ? listing : null;
}

// get_offer -> offerId|offerer|nftContract|tokenId|is_collection|amount|expiry|active
export async function getOffer(market: string, offerId: number): Promise<Offer | null> {
  const f = splitPipe(await callView(market, 'get_offer', [offerId]));
  if (f.length < 8) return null;
  return {
    offerId: toNum(f[0]),
    offerer: f[1],
    nftContract: f[2],
    tokenId: toNum(f[3]),
    isCollection: isTruthy(f[4]),
    amount: toNum(f[5]),
    expiry: toNum(f[6]),
    active: isTruthy(f[7]),
  };
}

// get_market_info -> listing_count|offer_count|active_count|total_volume|fee_balance|event_log_count
export async function getMarketInfo(market: string): Promise<MarketInfo | null> {
  const f = splitPipe(await callView(market, 'get_market_info', []));
  if (f.length < 6) return null;
  return {
    listingCount: toNum(f[0]),
    offerCount: toNum(f[1]),
    activeCount: toNum(f[2]),
    totalVolume: toNum(f[3]),
    feeBalance: toNum(f[4]),
    eventLogCount: toNum(f[5]),
  };
}

export async function getPendingProceeds(contract: string, addr: string): Promise<number> {
  return toNum((await callView(contract, 'get_pending_proceeds', [addr])) ?? undefined);
}
