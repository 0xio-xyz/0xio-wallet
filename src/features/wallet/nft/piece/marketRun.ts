// A submit is only the mempool, so every step waits for its
// receipt, and a confirmed step is not an executed one, so the effect is read back from the chain.
import { networkService } from 'src/services/network/NetworkService';
import { TxScopeError } from 'src/services/network/txScope';
import { logger } from 'src/utils/logger';
import { getContractAbiMethods } from 'src/features/wallet/nft/abi';
import { approve, cancelListing, listNft, type XpectrumTxCtx } from '../xpectrum/tx';
import { getActiveListing, isApprovedFor, type Listing } from '../xpectrum/market';
import { waitForReceipt } from '../xpectrum/confirm';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type RunOutcome =
  | { status: 'done' }
  | { status: 'needsApproval' }
  | { status: 'pending'; message: string }
  | { status: 'failed'; error: string };

export async function readListingFresh(
  market: string,
  contract: string,
  tokenId: string
): Promise<Listing | null | undefined> {
  try {
    return await getActiveListing(market, contract, parseInt(tokenId));
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function settle(hash: string, ctx: XpectrumTxCtx, t: Translate): Promise<RunOutcome | null> {
  const rec = await waitForReceipt(hash, ctx.scope);
  if (rec.status === 'confirmed') return null;
  if (rec.status === 'timeout') {
    return {
      status: 'pending',
      message: t('nft.stillPending', {
        defaultValue: 'Pending. It may still confirm. Check again later.',
      }),
    };
  }
  return {
    status: 'failed',
    error: rec.reason || t('nft.rejected', { defaultValue: 'Rejected by the network.' }),
  };
}

async function verifyListing(
  read: () => Promise<Listing | null | undefined>,
  want: (l: Listing | null) => boolean,
  gapMs: number,
  attempts = 3
): Promise<boolean | undefined> {
  let last: boolean | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(gapMs);
    const l = await read();
    if (l === undefined) continue;
    last = want(l);
    if (last) return true;
  }
  return last;
}

const failed = (e: unknown, fallback: string): RunOutcome => {
  if (e instanceof TxScopeError) logger.info(`[NFT] refused: ${e.message}`);
  else logger.error(`[NFT] action failed: ${e}`);
  return { status: 'failed', error: e instanceof Error && e.message ? e.message : fallback };
};

const unverified = (t: Translate): RunOutcome => ({
  status: 'failed',
  error: t('nft.verifyUnavailable', {
    defaultValue: 'Confirmed, but the node has not indexed it yet. Check again later.',
  }),
});

interface MarketArgs {
  ctx: XpectrumTxCtx;
  market: string;
  contract: string;
  tokenId: string;
  t: Translate;
  gapMs?: number;
}

export async function runApprove({ ctx, market, contract, tokenId, t }: MarketArgs) {
  const id = parseInt(tokenId);
  try {
    try {
      if (await isApprovedFor(contract, id, market)) return { status: 'done' } as RunOutcome;
    } catch {}
    const bad = await settle(await approve(ctx, contract, market, id), ctx, t);
    if (bad) return bad;
    try {
      if (!(await isApprovedFor(contract, id, market))) {
        return {
          status: 'failed',
          error: t('nft.approveNotTaken', {
            defaultValue: 'Approval not confirmed on chain.',
          }),
        } as RunOutcome;
      }
    } catch {}
    return { status: 'done' } as RunOutcome;
  } catch (e) {
    return failed(e, t('nft.approveFailed', { defaultValue: 'Approval failed.' }));
  }
}

async function listAt(
  { ctx, market, contract, tokenId, t, gapMs = 2000 }: MarketArgs,
  micro: number
): Promise<RunOutcome | null> {
  const bad = await settle(await listNft(ctx, market, contract, parseInt(tokenId), micro), ctx, t);
  if (bad) return bad;
  const ok = await verifyListing(
    () => readListingFresh(market, contract, tokenId),
    (l) => !!l && l.price === micro,
    gapMs
  );
  if (ok === undefined) return unverified(t);
  if (!ok)
    return {
      status: 'failed',
      error: t('nft.listFailed', {
        defaultValue: 'Listing not confirmed on chain. Try again.',
      }),
    };
  return null;
}

/** Lists at the price; the approval is checked first, since a stale one makes the list revert. */
export async function runList(args: MarketArgs & { micro: number }): Promise<RunOutcome> {
  const { contract, tokenId, market, micro, t } = args;
  try {
    try {
      if (!(await isApprovedFor(contract, parseInt(tokenId), market))) {
        return { status: 'needsApproval' };
      }
    } catch {}
    return (await listAt(args, micro)) ?? { status: 'done' };
  } catch (e) {
    return failed(
      e,
      t('nft.listFailed', { defaultValue: 'Listing not confirmed on chain. Try again.' })
    );
  }
}

/**
 * Xpectrum has no price update: the listing comes down, the market is approved again (taking it
 * down clears the approval), and the piece is listed at the new price. Up to three transactions,
 * all named on the review. A listing already gone skips the first.
 */
export async function runChangePrice(
  args: MarketArgs & { listing: Listing | null; micro: number; onStage: (stage: number) => void }
): Promise<RunOutcome> {
  const { ctx, market, contract, tokenId, listing, micro, onStage, t, gapMs = 2000 } = args;
  let down = !listing;
  const partly = (out: RunOutcome): RunOutcome =>
    down && out.status === 'failed'
      ? {
          ...out,
          error: t('nft.cameDown', {
            defaultValue: 'Old listing removed. New listing failed. {{reason}}',
            reason: out.error,
          }),
        }
      : out;
  try {
    if (listing) {
      onStage(0);
      const bad = await settle(await cancelListing(ctx, market, listing.id), ctx, t);
      if (bad) return bad;
      const gone = await verifyListing(
        () => readListingFresh(market, contract, tokenId),
        (l) => !l,
        gapMs
      );
      if (gone === undefined) return unverified(t);
      if (!gone) {
        return {
          status: 'failed',
          error: t('nft.stillListed', { defaultValue: 'The listing is still active on chain.' }),
        };
      }
      down = true;
    }
    onStage(1);
    const approved = await runApprove(args);
    if (approved.status !== 'done') return partly(approved);
    onStage(2);
    return partly((await listAt(args, micro)) ?? { status: 'done' });
  } catch (e) {
    return partly(
      failed(e, t('nft.listFailed', { defaultValue: 'Listing not confirmed on chain. Try again.' }))
    );
  }
}

export async function runCancel(args: MarketArgs & { listing: Listing }): Promise<RunOutcome> {
  const { ctx, market, contract, tokenId, listing, t, gapMs = 2000 } = args;
  try {
    const bad = await settle(await cancelListing(ctx, market, listing.id), ctx, t);
    if (bad) return bad;
    const gone = await verifyListing(
      () => readListingFresh(market, contract, tokenId),
      (l) => !l,
      gapMs
    );
    if (gone === undefined) return unverified(t);
    if (!gone)
      return {
        status: 'failed',
        error: t('nft.cancelFailed', { defaultValue: 'Listing still active on chain. Try again.' }),
      };
    return { status: 'done' };
  } catch (e) {
    return failed(
      e,
      t('nft.cancelFailed', { defaultValue: 'Listing still active on chain. Try again.' })
    );
  }
}

/**
 * Sends with the collection's own transfer, read from its ABI: SNS-1 transfer(to, id), single-token
 * transfer_to(to), or ERC721-style safe_transfer_from(from, to, id). A listed piece sits with the
 * market, where a transfer would revert and still cost the fee, so that is refused first.
 */
export async function runSend(args: {
  ctx: XpectrumTxCtx;
  networkId: string;
  market: string | null;
  contract: string;
  tokenId: string;
  to: string;
  t: Translate;
}): Promise<RunOutcome> {
  const { ctx, networkId, market, contract, tokenId, to, t } = args;
  const id = parseInt(tokenId);
  try {
    if (to === ctx.from)
      return {
        status: 'failed',
        error: t('nft.ownAddress', {
          defaultValue: 'Cannot transfer to your own address',
        }),
      };
    if (market && (await readListingFresh(market, contract, tokenId))) {
      return {
        status: 'failed',
        error: t('nft.listedNoSend', {
          defaultValue: 'Listed for sale. Cancel the listing to transfer it.',
        }),
      };
    }
    const methods = await getContractAbiMethods(networkId, contract).catch(() => [] as string[]);
    let method = 'transfer';
    let params: (string | number)[] = [to, id];
    if (!methods.includes('transfer') && methods.includes('transfer_to')) {
      method = 'transfer_to';
      params = [to];
    } else if (!methods.includes('transfer') && methods.includes('safe_transfer_from')) {
      method = 'safe_transfer_from';
      params = [ctx.from, to, id];
    }
    logger.info(`[NFT Send] ${method}(${params.join(', ')})`);
    const hash = await networkService.contractCall(
      contract,
      method,
      params,
      ctx.from,
      ctx.privateKey,
      ctx.ou,
      ctx.scope
    );
    const bad = await settle(hash, ctx, t);
    if (bad) return bad;
    try {
      const owner = await networkService.contractCallView(contract, 'owner_of', [id], ctx.from);
      if (owner != null && String(owner) === ctx.from) {
        return {
          status: 'failed',
          error: t('nft.ownershipUnchanged', {
            defaultValue: 'Confirmed, but ownership did not change. Try again.',
          }),
        };
      }
    } catch {}
    return { status: 'done' };
  } catch (e) {
    return failed(e, t('nft.transferFailed', { defaultValue: 'Transfer failed' }));
  }
}
