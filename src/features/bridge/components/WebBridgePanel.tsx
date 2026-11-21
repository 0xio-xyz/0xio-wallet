import { useTranslation } from 'src/i18n/react';
import { PrimaryButton } from 'src/shared/ui/primitives';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import { middleCut } from 'src/features/wallet/add/format';
import { WEB_BRIDGE_URL } from 'src/features/bridge/transfersView';
import useCopied from 'src/hooks/ui/useCopied';

const HOST = new URL(WEB_BRIDGE_URL).host;

const WebBridgePanel = ({ kind, octAddress }: { kind: 'burn' | 'any'; octAddress: string }) => {
  const { t } = useTranslation();
  const { copy, isCopied } = useCopied();
  const burn = kind === 'burn';

  return (
    <div className="flex! min-h-0! flex-1! flex-col!" style={{ marginTop: burn ? '14px' : 0 }}>
      <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
        {burn
          ? t('bridge.webBurnTitle', { defaultValue: 'Bridge with another wallet' })
          : t('bridge.webAnyTitle', { defaultValue: 'Bridge with another wallet' })}
      </span>
      <p
        style={{
          margin: '6px 2px 0',
          fontSize: '12.5px',
          lineHeight: 1.5,
          color: 'var(--fg-2)',
        }}
      >
        {burn
          ? t('bridge.webBurnBody', {
              defaultValue:
                'No EVM wallet detected. Use an Ethereum wallet holding wOCT at {{host}} to bridge OCT to this Octra address.',
              host: HOST,
            })
          : t('bridge.webAnyBody', {
              defaultValue:
                'No EVM wallet detected. Use any EVM wallet at {{host}} to bridge OCT to this Octra address.',
              host: HOST,
            })}
      </p>
      <span className="tab-caps" style={{ color: 'var(--fg-3)', marginTop: '14px' }}>
        {t('anyChain.receiveOn', { defaultValue: 'OCT arrives at' })}
      </span>
      <button
        type="button"
        onClick={() => void copy(octAddress)}
        aria-label={t('bridge.copyAddress', { defaultValue: 'Copy address' })}
        className="press flex! shrink-0! items-center! bg-(--bg-1)! text-left! transition-colors! hover:bg-(--bg-2)!"
        style={{
          marginTop: '6px',
          height: '44px',
          padding: '0 14px',
          borderRadius: '16px',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            fontSize: '12.5px',
            color: isCopied() ? 'var(--fg-2)' : 'var(--fg)',
            fontFamily: isCopied() ? 'inherit' : 'var(--font-mono)',
          }}
        >
          {isCopied()
            ? t('bridge.copied', { defaultValue: 'Copied' })
            : middleCut(octAddress, 10, 8)}
        </span>
      </button>
      <p
        className="line-clamp-2! shrink-0!"
        style={{
          margin: '10px 2px 0',
          height: '32px',
          fontSize: '11.5px',
          lineHeight: '16px',
          color: 'var(--fg-3)',
        }}
      >
        {burn
          ? t('bridge.webBurnAfter', {
              defaultValue:
                'Add its Ethereum transaction hash on the Claim page to follow it here.',
            })
          : t('bridge.webAnyAfter', {
              defaultValue: 'OCT arrives on Octra, usually within minutes.',
            })}
      </p>
      <div className="mt-auto! shrink-0!" style={{ paddingTop: '21px' }}>
        <PrimaryButton
          onClick={() => window.open(WEB_BRIDGE_URL, '_blank', 'noopener')}
          style={BIG_BUTTON}
        >
          {t('bridge.openHost', { defaultValue: 'Open {{host}}', host: HOST })}
        </PrimaryButton>
      </div>
    </div>
  );
};

export default WebBridgePanel;
