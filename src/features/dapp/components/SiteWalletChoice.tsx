import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { Globe } from 'src/shared/ui/icons';
import Button from 'src/shared/ui/Button';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { sanitizeText, sanitizeUrl } from 'src/lib/sanitize';

export interface SiteWalletChoiceInfo {
  origin: string;
  method: string;
  favicon?: string;
  siteAddress: string;
  siteName: string;
  activeAddress: string;
  activeName: string;
}

export type SiteWalletAnswer = 'switch' | 'move' | null;

const host = (origin: string) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
};

const SiteWalletChoice = ({
  info,
  onAnswer,
}: {
  info: SiteWalletChoiceInfo;
  onAnswer: (answer: SiteWalletAnswer) => void;
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [faviconError, setFaviconError] = useState(false);
  const siteName = sanitizeText(info.siteName);
  const activeName = sanitizeText(info.activeName);
  const op = t(`dapp.privateOp.${info.method}`, {
    defaultValue: t('dapp.privateOp.request', { defaultValue: 'request' }),
  });

  const answer = (a: SiteWalletAnswer) => {
    if (busy) return;
    setBusy(true);
    onAnswer(a);
  };

  const option = (
    address: string,
    label: string,
    name: string,
    sub: string,
    onClick: () => void
  ) => (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        width: '100%',
        padding: '12px 14px',
        borderRadius: '14px',
        border: 'none',
        backgroundColor: 'var(--bg-1)',
        textAlign: 'left',
        cursor: busy ? 'default' : 'pointer',
        color: 'var(--fg)',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <WalletAvatar address={address} size={28} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
          {label}
        </span>
        <span
          style={{
            fontSize: '13.5px',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{sub}</span>
      </span>
    </button>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: 'var(--bg)',
        overflow: 'hidden',
      }}
    >
      <div
        className="px-(--gutter)!"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '16px 0 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '9px',
              backgroundColor: 'var(--bg-1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {info.favicon && !faviconError ? (
              <img
                src={sanitizeUrl(info.favicon)}
                alt=""
                style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                onError={() => setFaviconError(true)}
              />
            ) : (
              <Globe size={14} style={{ color: 'var(--fg-3)' }} />
            )}
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
              {host(info.origin)}
            </span>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '12px',
                color: 'var(--fg-3)',
                minWidth: 0,
              }}
            >
              <WalletAvatar address={info.siteAddress} size={12} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {siteName}
              </span>
            </span>
          </span>
        </div>

        <div>
          <h1
            style={{
              fontSize: '20px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--fg)',
              margin: 0,
            }}
          >
            {t('dapp.privateTitle', { op, defaultValue: 'Private {{op}}' })}
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--fg-2)', margin: '4px 0 0', lineHeight: 1.5 }}>
            {t('dapp.privateLeadPlain', {
              defaultValue:
                'Private requests use the open wallet, and this site is on another one. Pick where it runs.',
            })}
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {option(
            info.siteAddress,
            t('dapp.siteWalletLabel', { defaultValue: 'Open the site wallet' }),
            siteName,
            t('dapp.siteStays', { defaultValue: 'The site stays where it is' }),
            () => answer('switch')
          )}
          {option(
            info.activeAddress,
            t('dapp.openWalletLabel', { defaultValue: 'Move the site to the open wallet' }),
            activeName,
            t('dapp.siteLearns', { defaultValue: "The site learns this wallet's address" }),
            () => answer('move')
          )}
        </div>
      </div>

      <div className="px-(--gutter)!" style={{ flexShrink: 0, padding: '12px 0 20px' }}>
        <Button onClick={() => answer(null)} disabled={busy} variant="secondary" fullWidth>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};

export default SiteWalletChoice;
