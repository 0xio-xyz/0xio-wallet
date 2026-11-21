import type { TFunction } from 'src/i18n/core';
import { walletKind, type WalletKind } from 'src/features/wallet/walletKind';
import React, { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { Copy, MoreVertical, Pencil, Trash2 } from 'src/shared/ui/icons';
import type { Wallet } from 'src/types/wallet';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { EvmGlyph, OctraGlyph } from 'src/shared/ui/ChainGlyph';
import { middleCut } from 'src/features/wallet/add/format';
import useCopied from 'src/hooks/ui/useCopied';

interface WalletCardProps {
  wallet: Wallet;
  index: number;
  isLast: boolean;
  isActive: boolean;
  onSwitch: (address: string) => void;
  onMenuAction: (action: string, wallet: Wallet) => void;
  dropUp?: boolean;
  evmAddress?: string | null;
}

const AddressLine = ({
  glyph,
  address,
  head,
  label,
  copied,
  onCopy,
}: {
  glyph?: React.ReactNode;
  address: string;
  head: number;
  label: string;
  copied: boolean;
  onCopy: (e: React.MouseEvent) => void;
}) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={label}
      title={address}
      className="flex! items-center! max-w-full! hover:text-(--fg-2)!"
      style={{
        gap: '4px',
        padding: '1px 0',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: 'var(--fg-3)',
        fontSize: '9.5px',
        fontFamily: 'var(--font-mono, monospace)',
      }}
    >
      {glyph}
      <span className="relative! inline-flex! min-w-0!">
        <span className={copied ? 'invisible! truncate!' : 'truncate!'}>
          {middleCut(address, head, 4)}
        </span>
        {copied && (
          <span
            className="absolute! inset-0! flex! items-center!"
            role="status"
            style={{ fontFamily: 'var(--font-sans, inherit)', color: 'var(--fg-2)' }}
          >
            {t('receive.copied', { defaultValue: 'Copied' })}
          </span>
        )}
      </span>
      <Copy size={9} aria-hidden="true" style={{ flexShrink: 0, opacity: 0.7 }} />
    </button>
  );
};

const KIND_LABEL: Record<WalletKind, (t: TFunction) => string> = {
  phrase: (t) => t('wallet.kindPhrase', { defaultValue: 'Phrase' }),
  key: (t) => t('wallet.kindKey', { defaultValue: 'Private key' }),
  watch: (t) => t('wallet.kindWatch', { defaultValue: 'Watch-only' }),
};

const WalletCard = ({
  wallet,
  isActive,
  onSwitch,
  onMenuAction,
  dropUp,
  evmAddress,
}: WalletCardProps) => {
  const { t } = useTranslation();
  const { copied: copiedId, copy } = useCopied();
  const [showMenu, setShowMenu] = useState(false);

  const copyLine = (text: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    void copy(text, text);
  };

  const handleCopyClick = copyLine(wallet.address);

  return (
    <div
      onClick={() => !isActive && onSwitch(wallet.address)}
      className="relative! group! flex! items-center! transition-colors! hover:bg-(--bg-1)!"
      style={{
        padding: '12px',
        gap: '12px',
        borderRadius: '8px',
        cursor: isActive ? 'default' : 'pointer',
        background: 'transparent',
      }}
    >
      <span className="relative! flex! shrink-0!">
        <WalletAvatar address={wallet.address} size={36} />
        {isActive && (
          <span
            aria-hidden="true"
            className="absolute! rounded-full! bg-(--pos)!"
            style={{
              right: '-2px',
              bottom: '-2px',
              width: '10px',
              height: '10px',
              boxShadow: '0 0 0 2px var(--bg)',
            }}
          />
        )}
      </span>

      <div className="flex-1! min-w-0!">
        <div className="flex! items-center! gap-1.5!">
          <span
            style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}
            className="truncate!"
          >
            {wallet.name}
          </span>
          {isActive && (
            <span className="sr-only!">{t('wallet.active', { defaultValue: 'Open wallet' })}</span>
          )}
          <span
            className="shrink-0! rounded-full! bg-(--bg-2)!"
            style={{
              fontSize: '10px',
              lineHeight: '16px',
              padding: '0 7px',
              color: 'var(--fg-2)',
              whiteSpace: 'nowrap',
            }}
          >
            {KIND_LABEL[walletKind(wallet)](t)}
          </span>
        </div>
        <div className="flex! items-center! min-w-0!" style={{ marginTop: '2px', gap: '10px' }}>
          <AddressLine
            glyph={evmAddress ? <OctraGlyph size={9} /> : undefined}
            address={wallet.address}
            head={evmAddress ? 6 : 10}
            label={t('wallet.copyOctraAddress', { defaultValue: 'Copy Octra address' })}
            copied={copiedId === wallet.address}
            onCopy={copyLine(wallet.address)}
          />
          {evmAddress && (
            <AddressLine
              glyph={<EvmGlyph size={9} />}
              address={evmAddress}
              head={6}
              label={t('wallet.copyEvmAddress', { defaultValue: 'Copy EVM address' })}
              copied={copiedId === evmAddress}
              onCopy={copyLine(evmAddress)}
            />
          )}
        </div>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          setShowMenu(!showMenu);
        }}
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '6px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--fg-3)',
        }}
      >
        <MoreVertical size={14} />
      </button>

      {showMenu && (
        <>
          <div
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(false);
            }}
            className="fixed! inset-0! z-scrim!"
          />
          <div
            className="z-dropdown!"
            style={{
              position: 'absolute',
              right: '8px',
              ...(dropUp ? { bottom: '52px' } : { top: '52px' }),
              width: '200px',
              backgroundColor: 'var(--bg-1)',
              border: 'none',
              borderRadius: '10px',
              padding: '4px',
              boxShadow: dropUp ? '0 -8px 24px rgba(0,0,0,0.4)' : '0 8px 24px rgba(0,0,0,0.4)',
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleCopyClick(e);
                setShowMenu(false);
              }}
              className="flex! items-center! gap-2! w-full! hover:bg-(--bg-2)!"
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--fg)',
              }}
            >
              <Copy size={12} style={{ color: 'var(--fg-3)' }} />
              <span className="relative! inline-flex!">
                <span className={copiedId === wallet.address ? 'invisible!' : ''}>
                  Copy address
                </span>
                {copiedId === wallet.address && (
                  <span className="absolute! inset-0! flex! items-center!" role="status">
                    {t('receive.copied', { defaultValue: 'Copied' })}
                  </span>
                )}
              </span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(false);
                onMenuAction('rename', wallet);
              }}
              className="flex! items-center! gap-2! w-full! hover:bg-(--bg-2)!"
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--fg)',
              }}
            >
              <Pencil size={12} style={{ color: 'var(--fg-3)' }} />
              Rename
            </button>
            <div style={{ height: '6px' }} />
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(false);
                onMenuAction('delete', wallet);
              }}
              className="flex! items-center! gap-2! w-full! hover:bg-(--bg-2)!"
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--neg)',
              }}
            >
              <Trash2 size={12} style={{ color: 'var(--neg)' }} />
              Delete wallet
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default WalletCard;
