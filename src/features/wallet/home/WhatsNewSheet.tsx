import { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { ArrowUpDown, History } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import useWhatsNew from 'src/hooks/wallet/useWhatsNew';
import { walletStorage } from 'src/services/wallet/WalletStorage';
import { canUseEvm } from 'src/services/evm/walletEvm';
import { evmCandidates, turnOnEvmForAll } from 'src/services/wallet/whatsNew';
import { EvmGlyph } from 'src/shared/ui/ChainGlyph';
import { PrimaryButton, Sheet, TextButton } from 'src/shared/ui/primitives';
import { logger } from 'src/utils/logger';

const Row = ({ icon, title, line }: { icon: React.ReactNode; title: string; line: string }) => (
  <div className="flex! items-start!" style={{ gap: '12px' }}>
    <span
      className="grid! shrink-0! place-items-center! rounded-full! bg-(--bg-2)!"
      style={{ width: '34px', height: '34px', color: 'var(--fg)' }}
      aria-hidden="true"
    >
      {icon}
    </span>
    <span className="flex! min-w-0! flex-col!" style={{ gap: '3px', paddingTop: '1px' }}>
      <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>{title}</span>
      <span style={{ fontSize: '12px', lineHeight: 1.45, color: 'var(--fg-2)' }}>{line}</span>
    </span>
  </div>
);

const WhatsNewSheet = () => {
  const { t } = useTranslation();
  const { isInitialized, isLocked, wallets, refreshWallets, showMessage } = useWallet();
  const { show, dismiss } = useWhatsNew(isInitialized && !isLocked && wallets.length > 0);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const canTurnOn = evmCandidates(wallets).length > 0;
  const hasPhrase = wallets.some((w) => canUseEvm(w, wallets));

  const turnOn = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      const { failed } = await turnOnEvmForAll(wallets, (id) =>
        walletStorage.setEvmEnabled(id, true)
      );
      await refreshWallets().catch((e) => logger.warn('Wallet refresh after EVM on failed:', e));
      if (failed.length) {
        logger.warn(`EVM could not be turned on for ${failed.length} wallet(s)`);
        showMessage(
          t('whatsNew.evmFailed', {
            defaultValue: 'Could not turn on EVM for every wallet. Try again in Settings.',
          }),
          'error'
        );
      }
    } finally {
      working.current = false;
      setBusy(false);
      dismiss();
    }
  };

  return (
    <Sheet
      open={show}
      onClose={dismiss}
      dismissible={!busy}
      footer={
        <div className="flex! flex-col! items-center!" style={{ gap: '12px' }}>
          <PrimaryButton
            onClick={() => (canTurnOn ? void turnOn() : dismiss())}
            loading={busy}
            style={{ height: '46px', borderRadius: '23px', fontSize: '14px' }}
          >
            {canTurnOn
              ? t('whatsNew.turnOn', { defaultValue: 'Turn on EVM' })
              : t('whatsNew.gotIt', { defaultValue: 'Got it' })}
          </PrimaryButton>
          {canTurnOn && (
            <TextButton muted size={13} onClick={dismiss} disabled={busy}>
              {t('whatsNew.notNow', { defaultValue: 'Not now' })}
            </TextButton>
          )}
          {!canTurnOn && (
            <span
              className="text-center!"
              style={{ fontSize: '11px', lineHeight: 1.45, color: 'var(--fg-3)' }}
            >
              {hasPhrase
                ? t('whatsNew.alreadyOn', {
                    defaultValue: 'EVM is already on. Change it any time in Settings.',
                  })
                : t('whatsNew.noPhrase', {
                    defaultValue:
                      'EVM needs a recovery phrase. Wallets made from a private key stay on Octra.',
                  })}
            </span>
          )}
        </div>
      }
    >
      <div className="flex! flex-col!" style={{ padding: '2px 2px 4px' }}>
        <span
          style={{
            fontSize: '10.5px',
            fontWeight: 600,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-3)',
          }}
        >
          {t('whatsNew.kicker', { defaultValue: 'New in 0xio 3.0' })}
        </span>
        <span
          style={{
            marginTop: '6px',
            fontSize: '24px',
            fontWeight: 300,
            letterSpacing: '-0.4px',
            lineHeight: 1.2,
            color: 'var(--fg)',
          }}
        >
          {t('whatsNew.title', { defaultValue: 'EVM is here' })}
        </span>
        <div className="flex! flex-col!" style={{ gap: '16px', marginTop: '20px' }}>
          <Row
            icon={<EvmGlyph size={16} />}
            title={t('whatsNew.evmTitle', { defaultValue: 'EVM in the same wallet' })}
            line={t('whatsNew.evmLine', {
              defaultValue:
                'Your recovery phrase now makes a 0x address too. Ethereum is built in and you can add more networks.',
            })}
          />
          <Row
            icon={<ArrowUpDown size={15} />}
            title={t('whatsNew.bridgeTitle', { defaultValue: 'Bridge without leaving' })}
            line={t('whatsNew.bridgeLine', {
              defaultValue: 'Move OCT to wOCT and back or bridge in from any chain right here.',
            })}
          />
          <Row
            icon={<History size={15} />}
            title={t('whatsNew.historyTitle', { defaultValue: 'One history' })}
            line={t('whatsNew.historyLine', {
              defaultValue: 'Octra and EVM activity together in time order.',
            })}
          />
        </div>
      </div>
    </Sheet>
  );
};

export default WhatsNewSheet;
