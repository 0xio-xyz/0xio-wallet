import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { Globe, AlertTriangle, X } from 'src/shared/ui/icons';
import Button from 'src/shared/ui/Button';
import IconButton from 'src/shared/ui/IconButton';
import { Mascot } from 'src/shared/ui/Mascot';
import { sanitizeText, sanitizeUrl } from 'src/lib/sanitize';

interface DAppConnectionApprovalProps {
  dappInfo: {
    origin: string;
    favicon?: string;
    title?: string;
    walletAddress?: string;
  };
  onApprove: () => void | Promise<void>;
  onReject: () => void;
  isOpen: boolean;
}

const DAppConnectionApproval = ({
  dappInfo,
  onApprove,
  onReject,
  isOpen,
}: DAppConnectionApprovalProps) => {
  const { t } = useTranslation();
  const [approving, setApproving] = useState(false);
  const [faviconError, setFaviconError] = useState(false);

  if (!isOpen) return null;

  const handleApprove = async () => {
    setApproving(true);
    try {
      await onApprove();
    } finally {
      setApproving(false);
    }
  };

  const handleReject = () => {
    onReject();
  };

  const getDomainName = () => {
    try {
      const url = new URL(dappInfo.origin);
      return url.hostname.replace('www.', '');
    } catch (_e) {
      return dappInfo.origin;
    }
  };

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-surface-overlay backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-surface-card rounded-2xl border border-edge max-w-md w-full shadow-2xl">
        <div className="p-6 border-b border-edge">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-content">{t('dapp.connectionRequest')}</h2>
            <IconButton onClick={handleReject} disabled={approving} aria-label="Reject">
              <X className="w-5 h-5 text-content-secondary" />
            </IconButton>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-surface-input flex items-center justify-center overflow-hidden">
              {dappInfo.favicon && !faviconError ? (
                <img
                  src={sanitizeUrl(dappInfo.favicon)}
                  alt={sanitizeText(dappInfo.title)}
                  className="w-full h-full object-cover"
                  onError={() => setFaviconError(true)}
                />
              ) : (
                <Globe className="w-6 h-6 text-content-secondary" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-content truncate">
                {sanitizeText(dappInfo.title) || getDomainName()}
              </h3>
              <p className="text-sm text-content-secondary truncate">{getDomainName()}</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="bg-accent/10 border border-accent/30 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-accent shrink-0 mt-0.5" />
              <div className="text-sm text-accent">
                <p className="font-medium mb-1">{t('dapp.trustWarning')}</p>
                <p className="text-accent/80">{t('dapp.trustWarningDesc')}</p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-content">{t('dapp.siteAbilities')}</h4>
            <div className="space-y-2">
              <p className="text-sm text-content">{t('dapp.viewAddressBalance')}</p>
              <p className="text-sm text-content">{t('dapp.requestTxApproval')}</p>
              <p className="text-sm text-content">{t('dapp.requestSignatures')}</p>
            </div>
          </div>

          {dappInfo.walletAddress && (
            <div className="bg-surface rounded-xl p-3 border border-edge">
              <div className="text-xs text-content-secondary mb-1">{t('dapp.connectingWith')}</div>
              <div className="font-mono text-sm text-content">
                {dappInfo.walletAddress.slice(0, 12)}...{dappInfo.walletAddress.slice(-10)}
              </div>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-edge flex gap-3">
          <Button
            onClick={handleReject}
            disabled={approving}
            className="flex-3 bg-surface-input! hover:bg-surface-highlight!"
          >
            {t('common.reject')}
          </Button>
          <Button
            onClick={handleApprove}
            disabled={approving}
            className="flex-7 bg-accent-fill! enabled:hover:bg-accent-fill/80! text-accent-fg!"
          >
            {approving ? (
              <>
                <Mascot
                  mood="loading"
                  size={20}
                  hole="var(--color-accent-fill)"
                  className="text-current!"
                />
                {t('dapp.connecting')}
              </>
            ) : (
              t('dapp.connect')
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default DAppConnectionApproval;
