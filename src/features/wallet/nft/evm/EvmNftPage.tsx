import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import Header from 'src/shared/ui/Header';
import { PrimaryButton, TextButton } from 'src/shared/ui/primitives';
import { middleCut } from 'src/features/wallet/add/format';
import { chainLogoUrl } from 'src/services/evm/chains';
import type { EvmNetwork } from 'src/services/evm/networks';
import type { EvmNft } from 'src/services/evm/nfts';
import { networkTokenUrl } from 'src/services/evm/registry';
import { NetworkLogo } from 'src/features/wallet/components/EvmNetworkPicker';
import { ChainBadge, CountTag, EvmNftArt } from 'src/features/wallet/nft/evm/EvmNftParts';
import { evmNftName } from 'src/features/wallet/nft/evm/deriveEvmGallery';
import { EvmNftSendSheet } from 'src/features/wallet/nft/evm/EvmNftSendSheet';
import { writeClipboard } from 'src/utils/secretClipboard';

export function EvmNftPage({
  nft,
  network,
  canSend,
  onClose,
  onHide,
  onSent,
}: {
  nft: EvmNft;
  network: EvmNetwork;
  canSend: boolean;
  onClose: () => void;
  onHide: () => void;
  onSent: (sent: bigint) => void;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const explorer = networkTokenUrl(network, nft.contract, nft.tokenId);
  const name = evmNftName(nft);

  const copy = (text: string): void => {
    writeClipboard(text).catch(() => {});
  };

  const row = (k: string, v: React.ReactNode, onClick?: () => void) => (
    <div
      key={k}
      onClick={onClick}
      className="flex! items-center! justify-between!"
      style={{
        gap: '14px',
        padding: '11px 0',
        fontSize: '13px',
        cursor: onClick ? 'pointer' : undefined,
      }}
    >
      <span style={{ color: 'var(--fg-3)', flexShrink: 0 }}>{k}</span>
      <span
        className="flex! items-center! justify-end! text-right! min-w-0!"
        style={{ gap: '8px', color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}
      >
        {v}
      </span>
    </div>
  );

  return (
    <div className="fixed! inset-0! z-nested! bg-(--bg)! flex! flex-col! animate-in! fade-in! duration-200!">
      <Header
        title=""
        showBack
        onBack={onClose}
        showSettings={false}
        rightAction={
          explorer ? (
            <TextButton muted size={12} onClick={() => window.open(explorer, '_blank', 'noopener')}>
              {t('evmNft.explorer', { defaultValue: 'Explorer' })}
            </TextButton>
          ) : (
            <div style={{ width: '32px' }} />
          )
        }
      />

      <div className="flex-1! min-h-0! overflow-y-auto! scrollbar-hide!">
        <div className="flex! flex-col!" style={{ gap: '14px', padding: '2px var(--gutter) 84px' }}>
          <div
            className="relative! w-full! aspect-square! shrink-0! overflow-hidden! bg-(--bg-1)!"
            style={{ borderRadius: '16px' }}
          >
            <EvmNftArt nft={nft} />
            {nft.standard === 'ERC-1155' && <CountTag amount={nft.amount} />}
            <ChainBadge logo={chainLogoUrl(network.logoChainId)} size={22} />
          </div>

          <div className="flex! flex-col!" style={{ gap: '4px' }}>
            {nft.collection && (
              <span className="tab-caps truncate!" style={{ color: 'var(--fg-3)' }}>
                {nft.collection}
              </span>
            )}
            <span
              className="truncate!"
              style={{
                fontSize: '20px',
                fontWeight: 700,
                letterSpacing: '-0.01em',
                color: 'var(--fg)',
              }}
            >
              {name}
            </span>
          </div>

          <div
            className="bg-(--bg-1)!"
            style={{ borderRadius: '16px', padding: '2px 14px', boxShadow: 'var(--raise-shadow)' }}
          >
            {row(
              t('evmSend.network', { defaultValue: 'Network' }),
              <>
                <NetworkLogo network={network} size={16} />
                <span className="truncate!">{network.name}</span>
              </>
            )}
            {row(t('evmNft.standard', { defaultValue: 'Standard' }), nft.standard)}
            {nft.standard === 'ERC-1155' &&
              row(t('evmNft.held', { defaultValue: 'Held' }), nft.amount)}
            {row(
              t('nft.contract', { defaultValue: 'Contract' }),
              <span className="font-mono!" style={{ fontSize: '12px' }}>
                {middleCut(nft.contract, 6, 4)}
              </span>,
              () => copy(nft.contract)
            )}
            {row(
              t('evmNft.tokenId', { defaultValue: 'Token ID' }),
              <span className="font-mono! truncate!" style={{ fontSize: '12px' }}>
                {middleCut(nft.tokenId, 8, 6)}
              </span>,
              () => copy(nft.tokenId)
            )}
          </div>
        </div>
      </div>

      <div
        className="absolute! inset-x-0! bottom-0! z-raised! grid! grid-cols-2!"
        style={{
          gap: '10px',
          padding: '12px var(--gutter) 14px',
          background: 'linear-gradient(to top, var(--bg) 70%, transparent)',
        }}
      >
        <PrimaryButton onClick={() => setSending(true)} disabled={!canSend}>
          {t('nft.transfer', { defaultValue: 'Transfer' })}
        </PrimaryButton>
        <PrimaryButton secondary onClick={onHide}>
          {t('common.hide', { defaultValue: 'Hide' })}
        </PrimaryButton>
      </div>

      {sending && (
        <EvmNftSendSheet
          nft={nft}
          network={network}
          onClose={() => setSending(false)}
          onSent={(sent) => {
            setSending(false);
            onSent(sent);
          }}
        />
      )}
    </div>
  );
}
