// contractCall submits with amount = 0, so only NON-PAYMENT operations belong
// here - the sell side (list / cancel / approve / accept-offer) and proceeds claims.

import { networkService } from 'src/services/network/NetworkService';
import type { TxScope } from 'src/services/network/txScope';

export interface XpectrumTxCtx {
  from: string;
  privateKey: string;
  /** Captured when the review opened: the submit refuses once the wallet has moved off it. */
  scope: TxScope;
  /** The live fee the review showed, signed as shown. */
  ou: string;
}

function call(
  ctx: XpectrumTxCtx,
  contract: string,
  method: string,
  params: unknown[]
): Promise<string> {
  return networkService.contractCall(
    contract,
    method,
    params,
    ctx.from,
    ctx.privateKey,
    ctx.ou,
    ctx.scope
  );
}

export const transfer = (ctx: XpectrumTxCtx, collection: string, to: string, tokenId: number) =>
  call(ctx, collection, 'transfer', [to, tokenId]);
export const transferFrom = (
  ctx: XpectrumTxCtx,
  collection: string,
  from: string,
  to: string,
  tokenId: number
) => call(ctx, collection, 'transfer_from', [from, to, tokenId]);
export const approve = (ctx: XpectrumTxCtx, collection: string, spender: string, tokenId: number) =>
  call(ctx, collection, 'approve', [spender, tokenId]);
export const revokeApproval = (ctx: XpectrumTxCtx, collection: string, tokenId: number) =>
  call(ctx, collection, 'revoke_approval', [tokenId]);
export const setOperator = (
  ctx: XpectrumTxCtx,
  collection: string,
  operator: string,
  approved: boolean
) => call(ctx, collection, 'set_operator', [operator, approved ? 1 : 0]);
export const claimCollectionProceeds = (ctx: XpectrumTxCtx, collection: string) =>
  call(ctx, collection, 'claim_proceeds', []);

export const listNft = (
  ctx: XpectrumTxCtx,
  market: string,
  nftContract: string,
  tokenId: number,
  priceMicroOct: number
) => call(ctx, market, 'list_nft', [nftContract, tokenId, priceMicroOct]);
export const cancelListing = (ctx: XpectrumTxCtx, market: string, listingId: number) =>
  call(ctx, market, 'cancel_listing', [listingId]);
export const cancelOffer = (ctx: XpectrumTxCtx, market: string, offerId: number) =>
  call(ctx, market, 'cancel_offer', [offerId]);
export const acceptOffer = (ctx: XpectrumTxCtx, market: string, offerId: number) =>
  call(ctx, market, 'accept_offer', [offerId]);
export const acceptCollectionOffer = (
  ctx: XpectrumTxCtx,
  market: string,
  offerId: number,
  tokenId: number
) => call(ctx, market, 'accept_collection_offer', [offerId, tokenId]);
export const claimMarketProceeds = (ctx: XpectrumTxCtx, market: string) =>
  call(ctx, market, 'claim_proceeds', []);
