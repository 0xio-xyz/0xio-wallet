import React, { useState } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { ChevronRight, Lock } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import { useTheme } from 'src/contexts/ThemeContext';
import { getNetworkConfig } from 'src/utils/network';
import useRebackupNeeded from 'src/hooks/wallet/useRebackupNeeded';
import Header from 'src/shared/ui/Header';
import ActiveWalletCard from 'src/features/settings/components/ActiveWalletCard';
import { RuledList } from 'src/shared/ui/primitives';
import { isEvmOn } from 'src/services/evm/walletEvm';
import { VIS_PREFIX } from 'src/services/tokens/tokenVisibility';

interface Summary {
  password: boolean;
  sites: number;
  hidden: number;
}

const HubRow = ({
  label,
  summary,
  warning,
  onClick,
}: {
  label: string;
  summary: string;
  warning?: string;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className="flex! w-full! items-center! rounded-[14px]! text-left! transition-colors! duration-150! hover:bg-(--bg-2)!"
    style={{ gap: '12px', padding: '12px 12px', background: 'transparent', cursor: 'pointer' }}
  >
    <span className="flex! min-w-0! flex-1! flex-col!" style={{ gap: '3px' }}>
      <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg)' }}>{label}</span>
      <span className="truncate!" style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
        {summary}
      </span>
    </span>
    {warning && (
      <span
        className="flex! shrink-0! items-center!"
        style={{ gap: '6px', fontSize: '11.5px', fontWeight: 600, color: 'var(--neg)' }}
      >
        <span
          style={{ width: '6px', height: '6px', borderRadius: '3px', background: 'var(--neg)' }}
        />
        {warning}
      </span>
    )}
    <ChevronRight size={14} style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
  </button>
);

const SettingsScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { passwordManager, lockWallet, activeWallet, wallets, networkId } = useWallet();
  const { theme } = useTheme();
  const [passwordSkipped, setPasswordSkipped] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [info, setInfo] = useState<Summary | null>(null);

  useMountEffect(() => {
    setAppVersion(chrome.runtime.getManifest().version);
    passwordManager.isPasswordSkipped().then(setPasswordSkipped);
    void (async () => {
      try {
        const stored = (await chrome.storage.local.get(null)) as unknown as Record<string, any>;
        const sites = Object.entries(stored).filter(
          ([key, value]) => key.startsWith('dapp_connection_') && value?.connected
        ).length;
        const mine = [activeWallet?.address, activeWallet?.metadata?.evm?.address]
          .filter((a): a is string => !!a)
          .map((a) => a.toLowerCase());
        const hidden = Object.entries(stored)
          .filter(
            ([key]) =>
              key.startsWith(VIS_PREFIX) &&
              mine.some((a) => key.toLowerCase().endsWith(`_${a}`)) &&
              (key.includes('_evm_') || key.startsWith(`${VIS_PREFIX}oct_${networkId}_`))
          )
          .reduce(
            (n, [, map]) =>
              n +
              (map && typeof map === 'object'
                ? Object.values(map as Record<string, unknown>).filter((v) => v === false).length
                : 0),
            0
          );
        setInfo({
          password: !!stored.hashedPassword && !stored.passwordSkipped,
          sites,
          hidden,
        });
      } catch {
        setInfo(null);
      }
    })();
  });

  const security = !info
    ? ''
    : info.password
      ? t('settings.sumPasswordOn', { defaultValue: 'Password on' })
      : t('settings.sumNoPassword', { defaultValue: 'No password set' });

  const rebackup = useRebackupNeeded(activeWallet);
  const backup =
    activeWallet?.type === 'watch'
      ? t('settings.sumWatchBackup', { defaultValue: 'Nothing to back up (watch-only)' })
      : t('settings.sumBackup', { defaultValue: 'Recovery phrase and private key' });

  const connections = info
    ? t('settings.sumSites', {
        count: info.sites,
        defaultValue_one: '1 site',
        defaultValue_other: '{{count}} sites',
      })
    : '';

  const appearance =
    theme === 'light'
      ? t('preferences.light')
      : theme === 'octra'
        ? t('preferences.octra')
        : t('preferences.dim');

  const network = getNetworkConfig(networkId).name;

  const tokensNfts = info
    ? info.hidden > 0
      ? t('settings.sumHidden', {
          count: info.hidden,
          defaultValue_one: '1 hidden by you',
          defaultValue_other: '{{count}} hidden by you',
        })
      : t('settings.sumNoneHidden', { defaultValue: 'Nothing hidden by you' })
    : '';

  const open = (path: string) => () => navigate(path);

  return (
    <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)! text-(--fg)!">
      <Header title={t('settings.title')} showBack showSettings={false} />

      <div
        className="flex! flex-1! flex-col! overflow-y-auto! scrollbar-hide!"
        style={{ padding: '14px var(--gutter) 20px' }}
      >
        {activeWallet && (
          <ActiveWalletCard
            name={activeWallet.name}
            address={activeWallet.address}
            onClick={open('/walletlist')}
            trailing={
              <span style={{ fontSize: '12.5px', color: 'var(--fg-3)', flexShrink: 0 }}>
                {t('settings.walletCount', {
                  count: wallets.length,
                  defaultValue_one: '1 wallet',
                  defaultValue_other: '{{count}} wallets',
                })}
              </span>
            }
          />
        )}

        <RuledList style={{ marginTop: '14px' }}>
          <HubRow
            label={t('settings.security', { defaultValue: 'Security' })}
            summary={security}
            onClick={open('/settings/security')}
          />
          <HubRow
            label={t('settings.backup', { defaultValue: 'Backup' })}
            summary={backup}
            warning={
              rebackup ? t('settings.backUpAgain', { defaultValue: 'Back up again' }) : undefined
            }
            onClick={open('/settings/backup')}
          />
          <HubRow
            label={t('settings.connections', { defaultValue: 'Connections' })}
            summary={connections}
            onClick={open('/settings/connections')}
          />
          <HubRow
            label={t('settings.appearance', { defaultValue: 'Appearance' })}
            summary={appearance}
            onClick={open('/settings/appearance')}
          />
          <HubRow
            label={t('networks.title', { defaultValue: 'Networks' })}
            summary={network}
            onClick={open('/settings/networks')}
          />
          <HubRow
            label={t('settings.tokensNfts', { defaultValue: 'Tokens and NFTs' })}
            summary={tokensNfts}
            onClick={open('/settings/tokens-nfts')}
          />
          <HubRow
            label="EVM"
            summary={
              isEvmOn(activeWallet, wallets) ? '' : t('settings.evmOff', { defaultValue: 'Off' })
            }
            onClick={open('/settings/evm')}
          />
        </RuledList>

        <div
          className="flex! flex-col!"
          style={{ marginTop: 'auto', paddingTop: '24px', gap: '16px' }}
        >
          {!passwordSkipped && (
            <button
              onClick={async () => {
                await lockWallet();
                navigate('/lock', { replace: true });
              }}
              className="press flex! w-full! items-center! justify-center! rounded-xl! transition-colors! hover:bg-(--bg-1)!"
              style={{
                height: '46px',
                gap: '8px',
                border: 'none',
                background: 'transparent',
                color: 'var(--fg)',
                fontSize: '13.5px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Lock size={15} />
              {t('settings.lockWallet', { defaultValue: 'Lock wallet' })}
            </button>
          )}
          <div className="flex! flex-col! items-center!" style={{ gap: '6px' }}>
            <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
              0xio Wallet{appVersion ? ` ${appVersion}` : ''}
            </span>
            <div className="flex!" style={{ gap: '18px' }}>
              {[
                ['https://docs.0xio.xyz/', t('settings.docs', { defaultValue: 'Docs' })],
                ['https://0xio.xyz/terms', t('settings.terms', { defaultValue: 'Terms' })],
                ['https://0xio.xyz/privacy', t('settings.privacy', { defaultValue: 'Privacy' })],
              ].map(([href, label]) => (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors! hover:text-(--fg)!"
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: 'var(--fg-2)',
                    textDecoration: 'none',
                  }}
                >
                  {label}
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default React.memo(SettingsScreen);
