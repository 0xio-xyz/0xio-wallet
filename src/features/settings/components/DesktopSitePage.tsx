import { useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import Header from 'src/shared/ui/Header';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import OutlineTag from 'src/shared/ui/OutlineTag';
import { OctraGlyph } from 'src/shared/ui/ChainGlyph';
import {
  Facts,
  ListRow,
  PrimaryButton,
  RuledList,
  SectionLabel,
  Sheet,
} from 'src/shared/ui/primitives';
import { useWallet } from 'src/contexts/WalletContext';
import { middleCut } from 'src/features/wallet/add/format';
import { sanitizeText } from 'src/lib/sanitize';
import DesktopMark from 'src/features/dapp/components/DesktopMark';
import { SiteMark } from 'src/features/dapp/components/ReviewParts';
import { desktopNetworkLabel, hostOf } from 'src/features/dapp/siteWallets';
import { desktopSiteMessage } from 'src/features/dapp/siteActions';
import type { DesktopSite } from 'src/background/services/desktopRelay';

const DesktopSitePage = ({ site, onDone }: { site: DesktopSite | null; onDone: () => void }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeWallet, showMessage } = useWallet();
  const [ending, setEnding] = useState(false);
  const [busy, setBusy] = useState(false);
  const origin = site?.origin ?? '';

  const disconnect = async () => {
    if (!site || busy) return;
    setBusy(true);
    const ok = await desktopSiteMessage('DESKTOP_SITE_DISCONNECT', site);
    setBusy(false);
    if (!ok) {
      showMessage(t('toast.revokeFailed'), 'error');
      return;
    }
    setEnding(false);
    onDone();
  };

  const moveHere = async () => {
    if (!site || busy) return;
    setBusy(true);
    const ok = await desktopSiteMessage('DESKTOP_SITE_MOVE', site);
    setBusy(false);
    if (!ok) {
      showMessage(
        t('desktopSites.moveFailed', { defaultValue: 'Could not move the site. Try again.' }),
        'error'
      );
      return;
    }
    navigate('/settings/connected-dapps', { replace: true });
  };

  return (
    <div className="h-full! overflow-hidden! flex! flex-col! bg-(--bg)! text-(--fg)!">
      <Header title={hostOf(origin)} showBack showSettings={false} onBack={onDone} />
      <div
        className="flex-1! overflow-y-auto! scrollbar-hide! flex! flex-col!"
        style={{ padding: '4px var(--gutter) 16px' }}
      >
        {site && (
          <>
            <SectionLabel first>
              {t('desktopSites.signsWith', { defaultValue: 'Signs with' })}
            </SectionLabel>
            <RuledList>
              <ListRow
                leading={<DesktopMark />}
                label={t('desktopSites.desktop', { defaultValue: '0xio Desktop' })}
                sub={
                  <Facts gap={8}>
                    <span className="flex! items-center! min-w-0!" style={{ gap: '5px' }}>
                      <WalletAvatar address={site.wallet.seed} size={12} />
                      <span className="truncate!">{sanitizeText(site.wallet.name)}</span>
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>
                      {middleCut(site.address, 8, 6)}
                    </span>
                  </Facts>
                }
                chevron={false}
              />
            </RuledList>

            <SectionLabel>{t('desktopSites.network', { defaultValue: 'Network' })}</SectionLabel>
            <RuledList>
              <ListRow
                leading={<OctraGlyph size={18} />}
                label={desktopNetworkLabel(site.network)}
                right={
                  site.network === 'devnet' ? (
                    <OutlineTag label={t('history.testnet', { defaultValue: 'Testnet' })} />
                  ) : undefined
                }
                chevron={false}
              />
            </RuledList>

            <div style={{ height: '18px' }} />
            <RuledList>
              <ListRow
                leading={
                  activeWallet ? <WalletAvatar address={activeWallet.address} size={22} /> : null
                }
                label={t('desktopSites.moveHere', { defaultValue: 'Move to this browser' })}
                onClick={busy ? undefined : () => void moveHere()}
              />
            </RuledList>
          </>
        )}
      </div>

      {site && (
        <div className="shrink-0!" style={{ padding: '8px var(--gutter) 20px' }}>
          <PrimaryButton secondary onClick={() => setEnding(true)} style={{ color: 'var(--neg)' }}>
            {t('evmDapp.disconnect', { defaultValue: 'Disconnect' })}
          </PrimaryButton>
        </div>
      )}

      <Sheet
        open={ending}
        onClose={() => setEnding(false)}
        dismissible={!busy}
        title={t('connectedSite.endTitle', { defaultValue: 'Disconnect this site' })}
        footer={
          <div className="flex!" style={{ gap: '10px' }}>
            <PrimaryButton secondary onClick={() => setEnding(false)} disabled={busy}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </PrimaryButton>
            <PrimaryButton danger onClick={() => void disconnect()} loading={busy}>
              {t('evmDapp.disconnect', { defaultValue: 'Disconnect' })}
            </PrimaryButton>
          </div>
        }
      >
        <div className="flex! items-center!" style={{ gap: '10px', padding: '4px' }}>
          <SiteMark origin={origin} size={28} />
          <span className="truncate! flex-1!" style={{ fontSize: '13px', color: 'var(--fg)' }}>
            {hostOf(origin)}
          </span>
          <DesktopMark size={18} />
        </div>
        <p
          style={{ margin: '12px 4px 0', fontSize: '12px', lineHeight: 1.5, color: 'var(--fg-2)' }}
        >
          {t('desktopSites.endNote', {
            defaultValue: '0xio Desktop forgets this site. Pending transactions stay on chain.',
          })}
        </p>
      </Sheet>
    </div>
  );
};

export default DesktopSitePage;
