import React, { useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { ArrowLeft, Menu, ChevronDown, Settings, Copy } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import ExpandViewToggle from 'src/shared/ui/ExpandViewToggle';
import IconButton from 'src/shared/ui/IconButton';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import HomeNetworkSwitch from 'src/shared/ui/HomeNetworkSwitch';
import { OctraGlyph, EvmGlyph } from 'src/shared/ui/ChainGlyph';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import { useDismiss } from 'src/hooks/ui/useDismiss';
import useCopied from 'src/hooks/ui/useCopied';
import { middleCut } from 'src/features/wallet/add/format';
import PrimaryName from 'src/shared/ui/PrimaryName';
import { usePrimaryName } from 'src/hooks/wallet/usePrimaryName';

interface HeaderProps {
  title?: string;
  showBack?: boolean;
  showSettings?: boolean;
  onBack?: (() => void) | null;
  showMenu?: boolean;
  showWalletSelector?: boolean;
  rightAction?: React.ReactNode;
}

const Header = ({
  title = '0xio Wallet',
  showBack = false,
  showSettings = true,
  onBack = null,
  showMenu = true,
  showWalletSelector = false,
  rightAction,
}: HeaderProps) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { activeWallet, networkId } = useWallet();
  const { copy: copyText, isCopied } = useCopied();
  const { view, setView, evmOn, evmAddress } = useHomeView();
  const [addressMenu, setAddressMenu] = useState(false);
  const menuRef = useDismiss<HTMLDivElement>(addressMenu, () => setAddressMenu(false));

  const truncateAddress = (address: string) =>
    address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';

  const copy = (value: string | null | undefined) => {
    if (value) void copyText(value);
  };

  const shownAddress = view === 'evm' ? evmAddress : activeWallet?.address;
  const primary = usePrimaryName(
    showWalletSelector && view !== 'evm' ? activeWallet?.address : null,
    networkId
  );
  const handleCopyAddress = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (view === 'all' && evmOn) setAddressMenu((open) => !open);
    else copy(shownAddress);
  };

  const menuRows = [
    {
      id: 'oct',
      name: 'Octra',
      value: activeWallet?.address ?? '',
      glyph: <OctraGlyph size={14} />,
    },
    { id: 'evm', name: 'EVM', value: evmAddress ?? '', glyph: <EvmGlyph size={14} /> },
  ];

  return (
    <header
      className="flex items-center justify-between w-full px-(--gutter)! gap-2! relative z-sticky bg-transparent isolate"
      style={{ height: 'var(--header-height)' }}
    >
      <div className={`${showWalletSelector ? 'flex-auto' : 'flex-1'} flex justify-start min-w-0`}>
        {showBack ? (
          <IconButton
            onClick={() => (onBack ? onBack() : navigate(-1))}
            title={t('common.back')}
            aria-label={t('common.back')}
          >
            <ArrowLeft size={16} />
          </IconButton>
        ) : showWalletSelector ? (
          <div className="flex items-center min-w-0" style={{ gap: '10px' }}>
            <button
              onClick={() => navigate('/walletlist')}
              className="press flex shrink-0 cursor-pointer rounded-lg transition-opacity hover:opacity-80"
              aria-label={t('common.walletList')}
            >
              <WalletAvatar address={activeWallet?.address} size={28} />
            </button>
            <div className="flex flex-col min-w-0" style={{ gap: '1px' }}>
              <button
                onClick={() => navigate('/walletlist')}
                className="flex items-center cursor-pointer hover:opacity-70 transition-opacity min-w-0"
                style={{ gap: '4px' }}
                aria-label={t('common.switchWallet')}
              >
                <span
                  className="truncate"
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--fg)',
                  }}
                >
                  {activeWallet?.name || t('common.wallet')}
                </span>
                {activeWallet?.type === 'watch' && (
                  <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                    {t('common.watch')}
                  </span>
                )}
                <ChevronDown size={12} style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
              </button>
              <div ref={menuRef} className="relative self-start max-w-full">
                <button
                  ref={primary.ref}
                  onClick={handleCopyAddress}
                  className="flex items-center cursor-pointer hover:opacity-70 transition-opacity max-w-full"
                  style={{ gap: '4px', color: 'var(--fg-3)' }}
                  title={
                    view === 'all' && evmOn
                      ? t('home.addresses', { defaultValue: 'Addresses' })
                      : t('common.copyAddress')
                  }
                  aria-label={
                    view === 'all' && evmOn
                      ? t('home.addresses', { defaultValue: 'Addresses' })
                      : t('common.copyAddress')
                  }
                  aria-expanded={view === 'all' && evmOn ? addressMenu : undefined}
                >
                  {isCopied() ? (
                    <span style={{ fontSize: '11px' }}>{t('toast.copied')}</span>
                  ) : view === 'all' && evmOn ? (
                    <>
                      <OctraGlyph size={10} />
                      <EvmGlyph size={10} />
                      <ChevronDown size={10} />
                    </>
                  ) : (
                    <span
                      className="flex items-center min-w-0"
                      style={{ gap: '8px', fontSize: '11px' }}
                    >
                      <PrimaryName name={primary.name} />
                      <span className="truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {truncateAddress(shownAddress ?? '')}
                      </span>
                    </span>
                  )}
                </button>
                {addressMenu && view === 'all' && evmOn && (
                  <div
                    className="absolute z-dropdown bg-(--bg-1) animate-in! fade-in! duration-150!"
                    style={{
                      left: 0,
                      top: 'calc(100% + 8px)',
                      width: '250px',
                      padding: '4px',
                      borderRadius: '14px',
                      boxShadow: '0 20px 44px rgba(0, 0, 0, 0.45)',
                    }}
                  >
                    {menuRows.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => {
                          copy(r.value);
                          setAddressMenu(false);
                        }}
                        className="press flex w-full items-center hover:bg-(--bg-2)"
                        style={{
                          gap: '10px',
                          padding: '9px 10px',
                          borderRadius: '10px',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span
                          className="grid place-items-center bg-(--bg)"
                          style={{
                            width: '26px',
                            height: '26px',
                            borderRadius: '13px',
                            color: 'var(--fg)',
                            flexShrink: 0,
                          }}
                        >
                          {r.glyph}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg)' }}>
                            {r.name}
                          </span>
                          <span
                            style={{
                              fontSize: '10.5px',
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--fg-3)',
                            }}
                          >
                            {middleCut(r.value, 8, 6)}
                          </span>
                        </span>
                        <Copy size={14} style={{ color: 'var(--fg-2)' }} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : showMenu ? (
          <IconButton onClick={() => navigate('/walletlist')} aria-label={t('common.walletList')}>
            <Menu size={16} />
          </IconButton>
        ) : (
          <div style={{ width: '32px' }} />
        )}
      </div>

      {!showWalletSelector && (
        <div className="flex-2 flex justify-center">
          {title && (
            <span className="font-semibold" style={{ fontSize: '13px', color: 'var(--fg)' }}>
              {title}
            </span>
          )}
        </div>
      )}

      <div className={`${showWalletSelector ? 'shrink-0' : 'flex-1'} flex justify-end`}>
        {rightAction ? (
          rightAction
        ) : showSettings ? (
          <div className="flex items-center gap-1">
            {showWalletSelector && evmOn && activeWallet && (
              <span style={{ marginRight: '4px' }}>
                <HomeNetworkSwitch
                  view={view}
                  onChange={setView}
                  octraAddress={activeWallet.address}
                  evmAddress={evmAddress}
                />
              </span>
            )}
            <ExpandViewToggle />
            <IconButton
              onClick={() => navigate('/settings')}
              aria-label={t('common.settings')}
              className="-mr-2"
            >
              <Settings size={16} />
            </IconButton>
          </div>
        ) : (
          <div style={{ width: '32px' }} />
        )}
      </div>
    </header>
  );
};

export default Header;
