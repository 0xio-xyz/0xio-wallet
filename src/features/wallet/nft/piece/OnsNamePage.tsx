import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import Header from 'src/shared/ui/Header';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { PrimaryButton } from 'src/shared/ui/primitives';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { usePiece } from 'src/features/wallet/nft/piece/usePiece';
import { fmtDay, readOctUsd } from 'src/features/wallet/nft/piece/format';
import { NameStatusTag, NftArt } from 'src/features/wallet/nft/gallery/NftArt';
import { DotsMenu } from 'src/features/wallet/nft/gallery/DotsMenu';
import { NftFlowSheet } from 'src/features/wallet/nft/piece/NftFlowSheet';
import { PieceRow, PieceTraits } from 'src/features/wallet/nft/piece/PieceRow';
import { onsTraits } from 'src/features/wallet/nft/onsNames';
import type { PiecePageProps } from 'src/features/wallet/nft/piece/NftPiecePage';
import { writeClipboard } from 'src/utils/secretClipboard';

const Waiting = () => (
  <span className="name-dots" style={{ height: '1lh', verticalAlign: 'top' }}>
    <i />
    <i />
    <i />
  </span>
);

export function OnsNamePage({
  contract,
  tokenId,
  collection,
  onClose,
  onHidePiece,
  onHideCollection,
  onGone,
}: PiecePageProps) {
  const { t, i18n } = useTranslation();
  const { activeWallet } = useWallet();
  const piece = usePiece(contract, tokenId, { checkOwner: true });
  const [sending, setSending] = useState(false);
  const [octUsd, setOctUsd] = useState<number | null>(null);
  useMountEffect(() => {
    void readOctUsd().then(setOctUsd);
  });
  const ons = piece.ons;
  const loaded = !!ons?.loaded;
  const canTransfer = !!ons?.active && !!activeWallet?.privateKey;

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
                onSelect: () => {
                  writeClipboard(contract).catch(() => {});
                },
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
            className="relative! w-full! aspect-square! shrink-0! overflow-hidden! bg-(--bg-1)!"
            style={{
              borderRadius: '16px',
              opacity: piece.refreshing ? 0.55 : 1,
              transition: 'opacity 200ms ease-out',
            }}
          >
            <NftArt piece={piece} tokenId={tokenId} />
            <NameStatusTag ons={ons} />
          </div>

          <span
            style={{
              fontSize: '20px',
              fontWeight: 700,
              letterSpacing: '-0.01em',
              overflowWrap: 'anywhere',
              color: 'var(--fg)',
            }}
          >
            {piece.name}
          </span>

          <div>
            <PieceRow label={t('nft.collection', { defaultValue: 'Collection' })}>
              {collection}
            </PieceRow>
            <PieceRow label={t('nft.owner', { defaultValue: 'Owner' })}>
              <span className="inline-flex! items-center! justify-end!" style={{ gap: '8px' }}>
                <WalletAvatar address={activeWallet?.address} size={18} />
                {activeWallet?.name}
              </span>
            </PieceRow>
            {(!loaded || ons?.expired || ons?.active) && (
              <PieceRow label={t('nft.status', { defaultValue: 'Status' })}>
                {ons?.expired ? (
                  t('nft.expired', { defaultValue: 'Expired' })
                ) : ons?.active ? (
                  t('nft.active', { defaultValue: 'Active' })
                ) : (
                  <Waiting />
                )}
              </PieceRow>
            )}
            {(!loaded || ons?.expires != null) && (
              <PieceRow
                label={
                  ons?.expired
                    ? t('nft.expired', { defaultValue: 'Expired' })
                    : t('nft.expires', { defaultValue: 'Expires' })
                }
              >
                {ons?.expires != null ? fmtDay(ons.expires, i18n.language) : <Waiting />}
              </PieceRow>
            )}
          </div>

          <PieceTraits
            traits={onsTraits(piece.detail.attributes).map((a) => [a.trait_type, String(a.value)])}
          />
        </div>
      </div>

      {canTransfer && (
        <div
          className="absolute! inset-x-0! bottom-0! z-raised! animate-in! fade-in! duration-200!"
          style={{
            padding: '12px var(--gutter) 14px',
            background: 'linear-gradient(to top, var(--bg) 70%, transparent)',
          }}
        >
          <PrimaryButton onClick={() => setSending(true)}>
            {t('nft.transfer', { defaultValue: 'Transfer' })}
          </PrimaryButton>
        </div>
      )}

      {sending && (
        <NftFlowSheet
          mode="send"
          contract={contract}
          tokenId={tokenId}
          name={piece.name}
          collection={collection}
          thumb={<NftArt piece={piece} tokenId={tokenId} />}
          market={piece.market}
          listing={null}
          approved={false}
          octUsd={octUsd}
          onApproved={() => {}}
          onListing={() => {}}
          onSent={() => {
            setSending(false);
            onGone();
          }}
          onClose={() => setSending(false)}
        />
      )}
    </div>
  );
}
