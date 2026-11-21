import { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { logger } from 'src/utils/logger';
import Header from 'src/shared/ui/Header';
import { Mascot } from 'src/shared/ui/Mascot';
import { PrimaryButton } from 'src/shared/ui/primitives';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { isApprovedFor, type Listing } from 'src/features/wallet/nft/xpectrum/market';
import { LivingNftFrame } from 'src/features/wallet/nft/euint/LivingNftFrame';
import { isMutableToken } from 'src/features/wallet/nft/euint/chainState';
import { getContractAbiMethods } from 'src/features/wallet/nft/abi';
import {
  type Listability,
  collectionStdCache,
  deriveListability,
  deriveStandard,
  hydrateStdCache,
  isFullXns1,
  marketActionsOn,
  marketStandardMode,
  persistStdVerdict,
} from 'src/features/wallet/nft/nftData';
import { usePiece } from 'src/features/wallet/nft/piece/usePiece';
import { readListing } from 'src/features/wallet/nft/piece/pieceData';
import { fmtMicro, fmtUsd, readOctUsd } from 'src/features/wallet/nft/piece/format';
import { MICRO_OCT } from 'src/features/wallet/nft/xpectrum/config';
import { NftArt } from 'src/features/wallet/nft/gallery/NftArt';
import { DotsMenu } from 'src/features/wallet/nft/gallery/DotsMenu';
import { NftFlowSheet, type FlowMode } from 'src/features/wallet/nft/piece/NftFlowSheet';
import { PieceRow, PieceTraits } from 'src/features/wallet/nft/piece/PieceRow';
import { OnsNamePage } from 'src/features/wallet/nft/piece/OnsNamePage';
import { useOnsContract } from 'src/hooks/wallet/useOnsContract';
import { writeClipboard } from 'src/utils/secretClipboard';

export interface PiecePageProps {
  contract: string;
  tokenId: string;
  collection: string;
  onClose: () => void;
  onHidePiece: (name: string) => void;
  onHideCollection: () => void;
  onGone: () => void;
}

export function NftPiecePage(props: PiecePageProps) {
  const { networkId } = useWallet();
  return useOnsContract(networkId) === props.contract ? (
    <OnsNamePage {...props} />
  ) : (
    <PiecePage {...props} />
  );
}

function PiecePage({
  contract,
  tokenId,
  collection,
  onClose,
  onHidePiece,
  onHideCollection,
  onGone,
}: PiecePageProps) {
  const { t } = useTranslation();
  const { networkId, activeWallet } = useWallet();
  const piece = usePiece(contract, tokenId, { onGone });
  const { market, listing, detail } = piece;
  const [octUsd, setOctUsd] = useState<number | null>(null);
  const [listable, setListable] = useState<Listability>(
    () => collectionStdCache.get(`${networkId}:${contract}`)?.listability ?? 'unknown'
  );
  const [verdictIn, setVerdictIn] = useState(
    () => !!collectionStdCache.get(`${networkId}:${contract}`)
  );
  // The listing read did not answer: listed or not is unknown, so no market action (no double list).
  const [listingUnknown, setListingUnknown] = useState(false);
  const [liveErrorAt, setLiveErrorAt] = useState<number | null>(null);
  const liveError = liveErrorAt === piece.revision;
  const [flow, setFlow] = useState<FlowMode | null>(null);
  const readSeq = useRef(0);

  const applyListing = (l: Listing | null) => {
    piece.setListing(l);
    piece.cacheMarketState({ listing: l });
  };

  // effect:audited via useMountEffect - the open-time reads: metadata that moves is read again,
  // the OCT price, whether the collection can trade on Xpectrum, the listing and the approval.
  useMountEffect(() => {
    if (isMutableToken(detail)) piece.refresh();
    void readOctUsd().then(setOctUsd);
    const stdKey = `${networkId}:${contract}`;
    if (!collectionStdCache.get(stdKey)) {
      void hydrateStdCache().then(() => {
        const hit = collectionStdCache.get(stdKey);
        if (hit) {
          setListable(hit.listability);
          setVerdictIn(true);
        }
      });
    }
    void getContractAbiMethods(networkId, contract)
      .then(async (methods) => {
        if (methods.length === 0) {
          setVerdictIn(true);
          return;
        }
        const standard = deriveStandard(methods);
        let verdict = deriveListability(methods);
        if (verdict === 'ready' && !isFullXns1(methods)) {
          const mode = await marketStandardMode(networkId, contract);
          if (mode != null && mode <= 0) verdict = 'incompatible';
        }
        setListable(verdict);
        setVerdictIn(true);
        collectionStdCache.set(stdKey, { standard, listability: verdict });
        persistStdVerdict(stdKey, { standard, listability: verdict });
      })
      .catch(() => setVerdictIn(true));
    if (!market) return;
    const seq = ++readSeq.current;
    readListing(market, contract, tokenId)
      .then((l) => seq === readSeq.current && applyListing(l))
      .catch(() => seq === readSeq.current && setListingUnknown(true));
    isApprovedFor(contract, parseInt(tokenId), market)
      .then((ok) => {
        if (seq !== readSeq.current) return;
        piece.setMarketApproved(ok);
        piece.cacheMarketState({ marketApproved: ok });
      })
      .catch(() => {});
  });

  const openFlow = (m: FlowMode) => {
    readSeq.current++;
    setFlow(m);
  };

  const living = piece.isLiving;
  const canSign = !!activeWallet?.privateKey;
  const marketOn = marketActionsOn({
    market: !!market,
    verdictIn,
    listable,
    listed: !!listing,
    listingUnknown,
  });
  const shortContract = `${contract.slice(0, 8)}…${contract.slice(-6)}`;

  const traits: [string, string][] = [];
  if (piece.biontAttrs?.isAlive !== undefined) {
    traits.push([
      t('nft.status', { defaultValue: 'Status' }),
      piece.biontAttrs.isAlive
        ? t('nft.alive', { defaultValue: 'Alive' })
        : t('nft.dead', { defaultValue: 'Dead' }),
    ]);
  }
  if (piece.biontAttrs?.archetype !== undefined && !isNaN(piece.biontAttrs.archetype)) {
    traits.push([
      t('nft.archetype', { defaultValue: 'Archetype' }),
      t('nft.archetypeN', { n: piece.biontAttrs.archetype, defaultValue: 'Type {{n}}' }),
    ]);
  }
  if (detail.rarity?.rank != null) {
    traits.push([
      t('nft.rarity', { defaultValue: 'Rarity' }),
      detail.rarity.total
        ? t('nft.rankOf', {
            rank: detail.rarity.rank,
            total: detail.rarity.total,
            defaultValue: '{{rank}} of {{total}}',
          })
        : String(detail.rarity.rank),
    ]);
  }
  for (const a of detail.attributes ?? []) traits.push([a.trait_type, String(a.value)]);

  const listedUsd = listing ? fmtUsd(listing.price / MICRO_OCT, octUsd) : null;
  const row = (k: string, v: React.ReactNode, onClick?: () => void) => (
    <PieceRow key={k} label={k} onClick={onClick}>
      {v}
    </PieceRow>
  );

  const copyContract = (): void => {
    writeClipboard(contract).catch(() => {});
  };

  return (
    <div className="fixed! inset-0! z-nested! bg-(--bg)! flex! flex-col!">
      <Header
        title={collection}
        showBack
        onBack={onClose}
        showSettings={false}
        rightAction={
          <DotsMenu
            label={t('common.moreOptions', { defaultValue: 'More options' })}
            items={[
              {
                label: t('nft.hidePiece', { defaultValue: 'Hide this piece' }),
                onSelect: () => onHidePiece(piece.name),
              },
              {
                label: t('nft.hideAll', { name: collection, defaultValue: 'Hide all {{name}}' }),
                onSelect: onHideCollection,
              },
              {
                label: t('nft.copyContractAddress', { defaultValue: 'Copy contract address' }),
                onSelect: copyContract,
              },
              {
                label: piece.refreshing
                  ? t('nft.refreshingMetadata', { defaultValue: 'Refreshing metadata' })
                  : t('nft.refreshMetadata', { defaultValue: 'Refresh metadata' }),
                onSelect: (): void => void piece.refreshMetadata(),
              },
            ]}
          />
        }
      />

      <div className="flex-1! min-h-0! overflow-y-auto! scrollbar-hide!">
        <div className="flex! flex-col!" style={{ gap: '14px', padding: '2px var(--gutter) 84px' }}>
          <div
            aria-busy={piece.refreshing}
            className="relative! w-full! aspect-square! shrink-0! overflow-hidden! bg-(--bg-1)! flex! items-center! justify-center!"
            style={{
              borderRadius: '16px',
              opacity: piece.refreshing ? 0.55 : 1,
              transition: 'opacity 200ms ease-out',
            }}
          >
            {!detail.metaFetched ? (
              <Mascot mood="loading" size={24} hole="var(--bg-1)" />
            ) : living && !liveError ? (
              <LivingNftFrame
                key={piece.revision}
                uri={detail.animationUrl!}
                networkId={networkId}
                inputs={{ token: tokenId, contract }}
                onError={() => {
                  logger.debug(`[NFT Piece] live frame failed #${tokenId}, showing the image`);
                  setLiveErrorAt(piece.revision);
                }}
                onSnapshot={piece.cachePoster}
                className="w-full! h-full! border-0!"
              />
            ) : (
              <NftArt piece={piece} tokenId={tokenId} />
            )}
          </div>

          <div className="flex! flex-col!" style={{ gap: '2px' }}>
            <span
              style={{
                fontSize: '20px',
                fontWeight: 700,
                letterSpacing: '-0.01em',
                color: 'var(--fg)',
              }}
            >
              {piece.name}
            </span>
            <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{collection}</span>
          </div>

          {detail.metaDescription && (
            <p style={{ margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--fg-2)' }}>
              {detail.metaDescription}
            </p>
          )}

          <PieceTraits traits={traits} />

          <div>
            {market &&
              row(
                t('nft.status', { defaultValue: 'Status' }),
                listing ? (
                  <>
                    {t('nft.listedAtPrice', {
                      price: fmtMicro(listing.price),
                      defaultValue: 'Listed at {{price}} OCT',
                    })}
                    {listedUsd && (
                      <span style={{ color: 'var(--fg-3)', marginLeft: '6px' }}>{listedUsd}</span>
                    )}
                  </>
                ) : listingUnknown ? (
                  <span style={{ color: 'var(--fg-3)' }}>
                    {t('nft.listingUnavailable', { defaultValue: 'Could not check the listing' })}
                  </span>
                ) : (
                  t('nft.notListed', { defaultValue: 'Not listed' })
                )
              )}
            {row(
              t('nft.heldBy', { defaultValue: 'Held by' }),
              listing
                ? t('nft.heldByMarket', { defaultValue: 'Xpectrum' })
                : t('nft.heldByYou', { defaultValue: 'You' })
            )}
            {living &&
              row(
                t('nft.living', { defaultValue: 'Living' }),
                t('nft.changesOnChain', { defaultValue: 'Changes on chain' })
              )}
            {row(
              t('nft.contract', { defaultValue: 'Contract' }),
              <span className="font-mono!" style={{ fontSize: '12px' }}>
                {shortContract}
              </span>,
              copyContract
            )}
          </div>
        </div>
      </div>

      {canSign && (
        <div
          key={marketOn ? (listing ? 'listed' : 'market') : 'send'}
          className="absolute! inset-x-0! bottom-0! z-raised! grid! grid-cols-2! animate-in! fade-in! duration-200!"
          style={{
            gap: '10px',
            padding: '12px var(--gutter) 14px',
            background: 'linear-gradient(to top, var(--bg) 70%, transparent)',
          }}
        >
          {marketOn && listing ? (
            <>
              <PrimaryButton onClick={() => openFlow('change')}>
                {t('nft.changePrice', { defaultValue: 'Change price' })}
              </PrimaryButton>
              <PrimaryButton
                secondary
                onClick={() => openFlow('cancel')}
                style={{ color: 'var(--neg)' }}
              >
                {t('nft.cancelListing', { defaultValue: 'Cancel listing' })}
              </PrimaryButton>
            </>
          ) : marketOn ? (
            <>
              <PrimaryButton onClick={() => openFlow('list')}>
                {t('nft.listForSale', { defaultValue: 'List for sale' })}
              </PrimaryButton>
              <PrimaryButton secondary onClick={() => openFlow('send')}>
                {t('nft.transfer', { defaultValue: 'Transfer' })}
              </PrimaryButton>
            </>
          ) : (
            <div className="col-span-2!">
              <PrimaryButton onClick={() => openFlow('send')} disabled={!!listing}>
                {t('nft.transfer', { defaultValue: 'Transfer' })}
              </PrimaryButton>
            </div>
          )}
        </div>
      )}

      {flow && (
        <NftFlowSheet
          key={flow}
          mode={flow}
          contract={contract}
          tokenId={tokenId}
          name={piece.name}
          collection={collection}
          thumb={<NftArt piece={piece} tokenId={tokenId} />}
          market={market}
          listing={listing}
          approved={piece.marketApproved}
          octUsd={octUsd}
          onApproved={() => {
            piece.setMarketApproved(true);
            piece.cacheMarketState({ marketApproved: true });
          }}
          onListing={(l) => {
            if (l === undefined) return;
            setListingUnknown(false);
            applyListing(l);
            if (l) {
              piece.setMarketApproved(false);
              piece.cacheMarketState({ marketApproved: false });
            }
          }}
          onSent={() => {
            setFlow(null);
            onGone();
          }}
          onClose={() => setFlow(null)}
        />
      )}
    </div>
  );
}
