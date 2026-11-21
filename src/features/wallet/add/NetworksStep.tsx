import type React from 'react';
import { useTranslation } from 'src/i18n/react';
import { PrimaryButton, Toggle } from 'src/shared/ui/primitives';
import { FlowCopy, FlowLayout, BIG_BUTTON } from './StepParts';

const NetworkRow = ({
  logo,
  name,
  right,
  onClick,
}: {
  logo: string;
  name: string;
  right: React.ReactNode;
  onClick?: () => void;
}) => (
  <div
    onClick={onClick}
    className={`flex! items-center! ${onClick ? 'cursor-pointer!' : ''}`}
    style={{ gap: '12px', minHeight: '60px', padding: '12px 0' }}
  >
    <img src={logo} alt="" width={28} height={28} className="rounded-full! shrink-0!" />
    <span
      className="min-w-0! flex-1!"
      style={{ fontSize: '14px', lineHeight: '18px', fontWeight: 600, color: 'var(--fg)' }}
    >
      {name}
    </span>
    <span onClick={(e) => e.stopPropagation()} className="flex! shrink-0!">
      {right}
    </span>
  </div>
);

export const NetworksStep = ({
  evm,
  onEvm,
  legacyPhrase,
  busy,
  onNext,
}: {
  evm: boolean;
  onEvm: (on: boolean) => void;
  legacyPhrase: boolean;
  busy: boolean;
  onNext: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <FlowLayout
      onSubmit={onNext}
      footer={
        <PrimaryButton onClick={onNext} loading={busy} style={BIG_BUTTON}>
          {t('common.continue', { defaultValue: 'Continue' })}
        </PrimaryButton>
      }
    >
      <FlowCopy
        focusTitle
        title={t('addWallet.networksTitle', { defaultValue: 'Choose your networks' })}
      />
      <div className="rounded-2xl! bg-(--bg-1)!" style={{ padding: '2px 14px' }}>
        <NetworkRow
          logo="/chains/octra/logo.webp"
          name="Octra"
          right={
            <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--fg-2)' }}>
              {t('addWallet.alwaysOn', { defaultValue: 'Always on' })}
            </span>
          }
        />
        <NetworkRow
          logo="/chains/evm/ethereum.webp"
          name="EVM"
          onClick={() => onEvm(!evm)}
          right={<Toggle checked={evm} onChange={() => onEvm(!evm)} label="EVM" />}
        />
      </div>
      <div style={{ marginTop: '14px', minHeight: '34px' }}>
        {legacyPhrase && evm && (
          <div
            className="rounded-xl! bg-(--bg-1)!"
            style={{ padding: '11px 13px', fontSize: '12px', lineHeight: 1.5 }}
          >
            <div style={{ fontWeight: 600, color: 'var(--fg)' }}>
              {t('addWallet.legacyPhraseTitle', {
                defaultValue: 'This phrase is from an older 0xio version',
              })}
            </div>
            <div style={{ marginTop: '4px', color: 'var(--fg-2)' }}>
              {t('addWallet.legacyPhraseBody', {
                defaultValue:
                  'Your EVM address works in 0xio, but this phrase is incompatible with other EVM wallets. Create a new phrase to use your wallet elsewhere.',
              })}
            </div>
          </div>
        )}
      </div>
    </FlowLayout>
  );
};
