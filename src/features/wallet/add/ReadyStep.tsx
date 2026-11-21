import React from 'react';
import { useTranslation } from 'src/i18n/react';
import { Mascot } from 'src/shared/ui/Mascot';
import { PrimaryButton } from 'src/shared/ui/primitives';
import { FlowLayout, FlowHero, BIG_BUTTON } from './StepParts';
import { OctraGlyph, EvmGlyph } from 'src/shared/ui/ChainGlyph';
import { middleCut } from './format';

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div
    className="flex! items-center! justify-between!"
    style={{
      gap: '12px',
      minHeight: '44px',
      padding: '12px 0',
      fontSize: '13px',
      lineHeight: '18px',
    }}
  >
    <span style={{ color: 'var(--fg-2)', flexShrink: 0 }}>{label}</span>
    {children}
  </div>
);

const Address = ({ value, glyph }: { value: string; glyph: React.ReactNode }) => (
  <span
    title={value}
    className="flex! items-center! min-w-0!"
    style={{ gap: '6px', color: 'var(--fg)' }}
  >
    <span style={{ color: 'var(--fg-2)', display: 'inline-flex' }}>{glyph}</span>
    <span
      className="truncate!"
      style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', whiteSpace: 'nowrap' }}
    >
      {middleCut(value, 10, 8)}
    </span>
  </span>
);

export const ReadyStep = ({
  name,
  address,
  evmAddress = null,
  viewOnly,
  saved,
  onOpen,
}: {
  name: string;
  address: string | null;
  evmAddress?: string | null;
  viewOnly: boolean;
  saved: boolean;
  onOpen: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <FlowLayout
      footer={
        <PrimaryButton onClick={onOpen} disabled={!saved} style={BIG_BUTTON}>
          {t('addWallet.openWallet', { defaultValue: 'Open wallet' })}
        </PrimaryButton>
      }
    >
      <FlowHero
        art={<Mascot mood={saved ? 'still' : 'loading'} size={72} />}
        title={t('addWallet.readyTitle', { defaultValue: 'Your wallet is ready' })}
        visible={saved}
      >
        <div className="rounded-2xl! bg-(--bg-1)!" style={{ padding: '0 14px', marginTop: '18px' }}>
          <Row label={t('addWallet.nameRow', { defaultValue: 'Name' })}>
            <span className="truncate!" style={{ color: 'var(--fg)' }}>
              {name}
            </span>
          </Row>
          {address && (
            <Row label="Octra">
              <Address value={address} glyph={<OctraGlyph />} />
            </Row>
          )}
          {evmAddress && (
            <Row label="EVM">
              <Address value={evmAddress} glyph={<EvmGlyph />} />
            </Row>
          )}
          {viewOnly && (
            <Row label={t('addWallet.accessRow', { defaultValue: 'Access' })}>
              <span style={{ color: 'var(--fg)' }}>
                {t('addWallet.kindViewOnly', { defaultValue: 'Watch-only' })}
              </span>
            </Row>
          )}
        </div>
      </FlowHero>
    </FlowLayout>
  );
};
