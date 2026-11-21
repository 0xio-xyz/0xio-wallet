import { useMemo, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { Info, QrCode } from 'src/shared/ui/icons';
import { useLocation } from 'src/lib/router';
import { useWallet } from 'src/contexts/WalletContext';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import { TextTab } from 'src/shared/ui/primitives';
import Header from 'src/shared/ui/Header';
import Button from 'src/shared/ui/Button';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { logger } from 'src/utils/logger';
import useCopied from 'src/hooks/ui/useCopied';
import { qrDataUrl } from 'src/lib/qr';

const receiveQr = (address: string) => {
  try {
    return qrDataUrl(address, { level: 'H', margin: 2, width: 300 });
  } catch (err) {
    logger.error('QR Generation failed', err);
    return '';
  }
};

const ReceiveScreen = () => {
  const { t } = useTranslation();
  const { activeWallet, showMessage } = useWallet();
  const location = useLocation();
  const { view, evmOn, evmAddress } = useHomeView();
  const [tab, setTab] = useState<'oct' | 'evm'>(() =>
    evmOn && (location.state?.tab === 'evm' || view === 'evm') ? 'evm' : 'oct'
  );
  const onEvm = evmOn && tab === 'evm' && !!evmAddress;
  const address = onEvm ? (evmAddress as string) : (activeWallet?.address ?? '');
  const { copy, isCopied } = useCopied();
  const copied = isCopied();

  const qrCodeUrl = useMemo(() => (address ? receiveQr(address) : ''), [address]);

  const handleCopyAddress = async () => {
    if (!address) return;
    if (!(await copy(address))) showMessage(t('toast.copyFailed'), 'error');
  };

  if (!activeWallet) return null;

  return (
    <div className="w-full! h-full! flex! flex-col! bg-(--bg-main)! text-(--text-main)! font-sans!">
      <Header title={t('receive.title')} showBack={true} showSettings={false} />

      <div className="flex-1! py-4! px-(--gutter)! flex! flex-col! items-center! gap-4! overflow-y-auto! scrollbar-hide!">
        {evmOn && (
          <div className="flex! w-full! items-center!" style={{ gap: '16px' }}>
            <TextTab active={tab === 'oct'} onClick={() => setTab('oct')}>
              Octra
            </TextTab>
            <TextTab active={tab === 'evm'} onClick={() => setTab('evm')}>
              EVM
            </TextTab>
          </div>
        )}
        <div className="w-full! bg-(--bg-card)! border! border-(--border-color)! rounded-2xl! p-5! flex! flex-col! items-center! shadow-xl! relative! overflow-hidden! shrink-0!">
          <div className="absolute! top-0! inset-x-0! h-px! bg-linear-to-r! from-transparent! via-(--primary)! to-transparent! opacity-50!" />
          <div className="text-center! mb-4!">
            <h3 className="text-sm! font-black! text-(--text-main)! uppercase! tracking-widest!">
              {t('receive.scanToAddress')}
            </h3>
            <p className="flex! items-center! justify-center! gap-1.5! text-[10px]! font-bold! text-content-muted! mt-1! uppercase! tracking-wide!">
              <WalletAvatar address={activeWallet.address} size={18} />
              <span className="truncate! max-w-50!">{activeWallet.name}</span>
            </p>
          </div>

          <div className="bg-white! p-2! rounded-xl! shadow-inner! mb-4!">
            {qrCodeUrl ? (
              <img
                src={qrCodeUrl}
                alt="Wallet QR code"
                className="w-36! h-36! object-contain! mix-blend-multiply!"
              />
            ) : (
              <div className="w-36! h-36! bg-surface-input! flex! items-center! justify-center! rounded-lg! animate-pulse!">
                <QrCode className="w-8! h-8! text-content!" />
              </div>
            )}
          </div>

          <div className="w-full! space-y-3!">
            <div
              onClick={handleCopyAddress}
              className="bg-(--bg-input)! border! border-(--border-color)! p-3! rounded-xl! text-center! cursor-pointer! hover:border-(--primary)! transition-colors! group!"
            >
              <p className="text-[10px]! font-mono! text-content-secondary! group-hover:text-(--text-main)! break-all! leading-relaxed!">
                {address}
              </p>
            </div>

            <div className="flex! gap-2!">
              <Button
                variant={copied ? 'secondary' : 'primary'}
                fullWidth
                onClick={handleCopyAddress}
                className={`h-10! text-xs! font-bold! uppercase! rounded-xl! ${copied ? 'bg-(--success)! text-accent-fg! border-none!' : ''}`}
              >
                <div className="flex! items-center! justify-center! gap-2!">
                  {copied ? t('receive.copied') : t('common.copyAddress')}
                </div>
              </Button>
            </div>
          </div>
        </div>

        <div className="w-full! space-y-3! shrink-0!">
          <div className="bg-(--bg-card)! border! border-(--border-color)! rounded-xl! p-4! flex! gap-3!">
            <div className="bg-(--bg-input)! p-1.5! rounded-lg! h-fit!">
              <Info className="w-4! h-4! text-(--info)!" />
            </div>
            <div className="space-y-1!">
              <h4 className="text-xs! font-bold! text-(--text-main)!">{t('receive.network')}</h4>
              <p className="text-[10px]! text-content-muted! leading-relaxed!">
                {onEvm
                  ? t('receive.evmNetworkWarning', {
                      defaultValue:
                        'This 0x address works on every EVM network. Send only EVM assets to it.',
                    })
                  : t('receive.networkWarning')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReceiveScreen;
