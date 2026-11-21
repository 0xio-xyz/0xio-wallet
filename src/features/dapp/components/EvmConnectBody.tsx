import { useTranslation } from 'src/i18n/react';
import { RuledList } from 'src/shared/ui/primitives';
import type { Wallet } from 'src/types/wallet';
import { Caps, KindChip, Note, Row, WalletRow, WalletValue } from './ReviewParts';
import { hostOf, mono, type ConnectMode, type EvmChoice } from '../siteWallets';
import { middleCut } from 'src/features/wallet/add/format';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { sanitizeText } from 'src/lib/sanitize';

const EvmConnectBody = ({
  origin,
  chainName,
  mode,
  open,
  choices,
  pick,
  onPick,
  connected = [],
  wallets,
}: {
  origin: string;
  chainName: string;
  mode: ConnectMode;
  open: Wallet | null;
  choices: EvmChoice[];
  pick: string | null;
  onPick: (walletId: string) => void;
  connected?: EvmChoice[];
  wallets: Wallet[];
}) => {
  const { t } = useTranslation();
  const network = <Row label={t('evmDapp.network', { defaultValue: 'Network' })}>{chainName}</Row>;

  if (mode.kind === 'empty') {
    const own = wallets.filter((w) => w.type !== 'watch');
    return (
      <>
        <p style={{ margin: '0 4px', fontSize: '12.5px', lineHeight: 1.5, color: 'var(--fg-2)' }}>
          {t('evmDapp.emptyBody', {
            host: hostOf(origin),
            defaultValue:
              '{{host}} needs an EVM address. Wallets imported with an Octra private key have none.',
          })}
        </p>
        {own.length > 0 && (
          <>
            <Caps>{t('evmDapp.yourWallets', { defaultValue: 'Your wallets' })}</Caps>
            <div className="flex! flex-col!" style={{ gap: '2px' }}>
              {own.map((w) => (
                <WalletRow key={w.id} wallet={w} address={w.address} evm={false} />
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  if (mode.kind === 'pick') {
    return (
      <>
        {open && (
          <RuledList>
            <Row label={t('evmDapp.noEvmAddress', { defaultValue: 'No EVM address' })}>
              <WalletValue
                name={open.name}
                avatar={open.address}
                chip={<KindChip wallet={open} />}
              />
            </Row>
          </RuledList>
        )}
        <Caps>{t('evmDapp.withEvm', { defaultValue: 'Wallets with an EVM address' })}</Caps>
        <div className="flex! flex-col!" style={{ gap: '2px' }}>
          {choices.map((c) => (
            <WalletRow
              key={c.wallet.id}
              wallet={c.wallet}
              address={c.address}
              evm
              selected={pick === c.wallet.id}
              onClick={() => onPick(c.wallet.id)}
            />
          ))}
        </div>
        <div style={{ marginTop: '12px' }}>
          <RuledList>{network}</RuledList>
        </div>
      </>
    );
  }

  const { choice } = mode;
  return (
    <>
      <Caps>{t('evmDapp.connectWith', { defaultValue: 'Connect with' })}</Caps>
      <RuledList>
        <Row label={t('evmDapp.wallet', { defaultValue: 'Wallet' })}>
          <WalletValue
            name={choice.wallet.name}
            avatar={choice.wallet.address}
            address={choice.address}
          />
        </Row>
        {network}
      </RuledList>
      {connected.length > 0 && (
        <>
          <Caps>{t('evmDapp.alreadyConnected', { defaultValue: 'Already connected' })}</Caps>
          <RuledList>
            {connected.map((c) => (
              <div
                key={c.wallet.id}
                className="flex! items-center!"
                style={{ padding: '8px 10px', gap: '10px' }}
              >
                <WalletAvatar address={c.wallet.address} size={20} />
                <span
                  className="truncate! flex-1!"
                  style={{ fontSize: '13px', color: 'var(--fg)' }}
                >
                  {sanitizeText(c.wallet.name)}
                </span>
                <span style={{ ...mono, fontSize: '11px', color: 'var(--fg-3)' }}>
                  {middleCut(c.address, 6, 4)}
                </span>
              </div>
            ))}
          </RuledList>
        </>
      )}
      <div style={{ marginTop: '12px' }}>
        <Note>
          {connected.length > 0
            ? t('evmDapp.connectMoreNote', {
                defaultValue:
                  'The site will see this address too. Every transaction and signature needs your approval.',
              })
            : t('evmDapp.connectNote', {
                defaultValue:
                  'The site can view this address and its balances. Every transaction and signature needs your approval.',
              })}
        </Note>
      </div>
    </>
  );
};

export default EvmConnectBody;
