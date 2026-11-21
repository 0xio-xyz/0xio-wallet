import { useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { Mascot } from 'src/shared/ui/Mascot';
import Header from 'src/shared/ui/Header';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { OctraGlyph } from 'src/shared/ui/ChainGlyph';
import { RuledList, ListRow, Facts, SectionLabel } from 'src/shared/ui/primitives';
import OutlineTag from 'src/shared/ui/OutlineTag';
import { sanitizeText } from 'src/lib/sanitize';
import { useWallet } from 'src/contexts/WalletContext';
import { useSiteConnections } from 'src/hooks/dapp/useSiteConnections';
import { allNetworks, type ManagedEvmNetwork } from 'src/services/evm/registry';
import { NetworkLogo } from 'src/features/wallet/components/EvmNetworkPicker';
import { SiteMark } from 'src/features/dapp/components/ReviewParts';
import DesktopMark from 'src/features/dapp/components/DesktopMark';
import {
  desktopNetworkLabel,
  hostOf,
  siteDisplayWallets,
  siteChainFor,
} from 'src/features/dapp/siteWallets';
import type { Wallet } from 'src/types/wallet';

interface SiteRow {
  key: string;
  origin: string;
  kind: 'evm' | 'octra';
  first: Wallet | null;
  more: number;
  network: { name: string; logo: React.ReactNode };
  at: number;
}

const ConnectedDappsScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { wallets, activeWallet, networkId } = useWallet();
  const sites = useSiteConnections();
  const [networks, setNetworks] = useState<ManagedEvmNetwork[]>([]);
  const side = networkId === 'devnet' ? 'testnet' : 'mainnet';

  useMountEffect(() => {
    let live = true;
    allNetworks()
      .then((list) => live && setNetworks(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  const rows: SiteRow[] = [];
  for (const site of Object.values(sites.evm)) {
    const list = siteDisplayWallets(site, activeWallet?.id ?? null, wallets);
    const chainId = siteChainFor(site, side);
    const net = networks.find((n) => n.chainId === chainId);
    rows.push({
      key: `evm:${site.origin}`,
      origin: site.origin,
      kind: 'evm',
      first: list[0] ?? null,
      more: Math.max(0, list.length - 1),
      network: {
        name: net?.name ?? t('networks.chainLabel', { id: chainId, defaultValue: 'Chain {{id}}' }),
        logo: net ? <NetworkLogo network={net} size={12} /> : null,
      },
      at: Math.max(0, ...Object.values(site.accounts).map((a) => a.connectedAt)),
    });
  }
  for (const site of sites.octra) {
    rows.push({
      key: site.key,
      origin: site.origin,
      kind: 'octra',
      first: site.address ? (wallets.find((w) => w.address === site.address) ?? null) : null,
      more: 0,
      network: { name: 'Octra', logo: <OctraGlyph size={12} /> },
      at: site.connectedAt,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  const desktop = sites.desktop;
  const grouped = desktop.length > 0;

  const siteRow = (row: SiteRow) => (
    <ListRow
      key={row.key}
      leading={<SiteMark origin={row.origin} size={30} />}
      label={hostOf(row.origin)}
      sub={
        <Facts gap={8}>
          {row.first && (
            <span className="flex! items-center! min-w-0!" style={{ gap: '5px' }}>
              <WalletAvatar address={row.first.address} size={12} />
              <span className="truncate!">{sanitizeText(row.first.name)}</span>
            </span>
          )}
          {row.more > 0 && <span>+{row.more}</span>}
          <span className="flex! items-center! shrink-0!" style={{ gap: '5px' }}>
            {row.network.logo}
            {row.network.name}
          </span>
        </Facts>
      }
      onClick={() =>
        navigate('/settings/connected-site', {
          state: { origin: row.origin, kind: row.kind },
        })
      }
    />
  );

  return (
    <div className="h-full! overflow-hidden! flex! flex-col! bg-(--bg)! text-(--fg)!">
      <Header title={t('connectedDapps.title')} showBack showSettings={false} />

      <div
        className="flex-1! overflow-y-auto! scrollbar-hide! flex! flex-col!"
        style={{ padding: '4px var(--gutter) 24px' }}
      >
        {!sites.loaded ? (
          <div className="flex! items-center! justify-center! h-full!">
            <Mascot mood="loading" size={24} />
          </div>
        ) : rows.length === 0 && !grouped ? (
          <div
            className="flex! flex-col! items-center! justify-center! h-full! text-center!"
            style={{ gap: '4px', padding: '24px 0' }}
          >
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
              {t('connectedDapps.noSessions')}
            </span>
          </div>
        ) : (
          <>
            {grouped && rows.length > 0 && (
              <SectionLabel first>
                {t('desktopSites.thisBrowser', { defaultValue: 'This browser' })}
              </SectionLabel>
            )}
            {rows.length > 0 && <RuledList>{rows.map(siteRow)}</RuledList>}
            {grouped && (
              <>
                <SectionLabel first={rows.length === 0}>
                  <span className="inline-flex! items-center!" style={{ gap: '6px' }}>
                    <DesktopMark size={14} />
                    {t('desktopSites.desktop', { defaultValue: '0xio Desktop' })}
                  </span>
                </SectionLabel>
                <RuledList>
                  {desktop.map((d) => (
                    <ListRow
                      key={`desktop:${d.network}|${d.origin}`}
                      leading={<SiteMark origin={d.origin} size={30} />}
                      label={hostOf(d.origin)}
                      sub={
                        <Facts gap={8}>
                          <span className="flex! items-center! min-w-0!" style={{ gap: '5px' }}>
                            <WalletAvatar address={d.wallet.seed} size={12} />
                            <span className="truncate!">{sanitizeText(d.wallet.name)}</span>
                          </span>
                          <span className="flex! items-center! shrink-0!" style={{ gap: '5px' }}>
                            <OctraGlyph size={12} />
                            {desktopNetworkLabel(d.network)}
                          </span>
                          {d.network === 'devnet' && (
                            <OutlineTag label={t('history.testnet', { defaultValue: 'Testnet' })} />
                          )}
                        </Facts>
                      }
                      onClick={() =>
                        navigate('/settings/connected-site', {
                          state: { origin: d.origin, kind: 'desktop', network: d.network },
                        })
                      }
                    />
                  ))}
                </RuledList>
              </>
            )}
          </>
        )}

        {(rows.length > 0 || grouped) && (
          <p
            style={{
              fontSize: '11px',
              color: 'var(--fg-3)',
              lineHeight: 1.5,
              marginTop: 'auto',
              paddingTop: '20px',
            }}
          >
            <span style={{ color: 'var(--fg-2)' }}>{t('connectedDapps.securityNote')}</span>{' '}
            {t('connectedDapps.securityNoteDesc')}
          </p>
        )}
      </div>
    </div>
  );
};

export default ConnectedDappsScreen;
