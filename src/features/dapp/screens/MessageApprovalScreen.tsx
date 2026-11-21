import { useState, useEffect, useRef } from 'react';
import { useParams } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { sanitizeText, sanitizeUrl } from 'src/lib/sanitize';
import { MessageSquare, AlertTriangle, Globe } from 'src/shared/ui/icons';
import { Mascot } from 'src/shared/ui/Mascot';
import Button from 'src/shared/ui/Button';
import { useWallet } from 'src/contexts/WalletContext';
import { unlockErrorMessage } from 'src/features/security/unlockError';
import { logger } from 'src/utils/logger';
import { isPasskeyEnabled, authenticateWithPasskey } from 'src/services/crypto/PasskeyService';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import SignerRow from 'src/features/dapp/components/SignerRow';
import SiteWalletChoice, {
  type SiteWalletAnswer,
} from 'src/features/dapp/components/SiteWalletChoice';

const MessageApprovalScreen = () => {
  const { t } = useTranslation();
  const { approvalId } = useParams();
  const { isLocked, unlockWallet, passwordSkipped } = useWallet();
  const [msgInfo, setMsgInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [passkeyEnabled, setPasskeyEnabled] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [showPasswordFallback, setShowPasswordFallback] = useState(false);
  const [pickedSigner, setPickedSigner] = useState('');
  const responded = useRef(false);
  const approvingRef = useRef(false);

  // effect:audited - loads message from chrome.storage when approvalId changes
  useEffect(() => {
    loadMessageRequest();
  }, [approvalId]);

  useMountEffect(async () => {
    setPasskeyEnabled(await isPasskeyEnabled());
  });

  const handlePasskeyUnlock = async () => {
    setPasskeyLoading(true);
    setError('');
    try {
      const pw = await authenticateWithPasskey();
      if (pw) {
        await unlockWallet(pw);
      } else {
        setError(t('lock.passkeyFailed', { defaultValue: 'Passkey authentication failed' }));
      }
    } catch (err: any) {
      logger.error('[Passkey] Unlock failed:', err.message);
    } finally {
      setPasskeyLoading(false);
    }
  };

  // effect:audited - beforeunload DOM subscription depends on approvalId
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!responded.current && approvalId) {
        chrome.runtime.sendMessage({
          type: 'MESSAGE_APPROVAL_RESPONSE',
          approvalId,
          approved: false,
        });
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [approvalId]);

  const loadMessageRequest = async () => {
    try {
      const result = await chrome.storage.local.get(`msg_approval_${approvalId}`);
      const msg = result[`msg_approval_${approvalId}`];

      if (!msg) {
        window.close();
        return;
      }
      setMsgInfo(msg);
    } catch (error) {
      logger.error('Failed to load message request:', error);
      setError('Could not load the request');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    if (approvingRef.current) return;
    approvingRef.current = true;
    setError('');
    setApproving(true);

    try {
      // A network switch signs nothing, so it needs no unlock.
      if (msgInfo?.kind !== 'network_switch' && isLocked && !passwordSkipped) {
        try {
          // unlockWallet enforces the attempt limit, which this popup used to bypass.
          await unlockWallet(password);
        } catch (e) {
          setError(unlockErrorMessage(e, t));
          setApproving(false);
          approvingRef.current = false;
          return;
        }
        setPassword('');
      }

      // No password in the reply: this popup's unlock already wrote the session the background
      // reads. The background only ever passed it to a PasswordManager.unlock that does not exist.
      responded.current = true;
      await chrome.runtime.sendMessage({
        type: 'MESSAGE_APPROVAL_RESPONSE',
        approvalId,
        approved: true,
        selectedAddress:
          pickedSigner && pickedSigner !== msgInfo?.walletAddress ? pickedSigner : undefined,
      });

      setTimeout(() => {
        window.close();
      }, 500);
    } catch (error) {
      logger.error('Approval failed:', error);
      setError(error.message || t('approval.failedToApprove'));
      setApproving(false);
      approvingRef.current = false;
      responded.current = false;
    }
  };

  const handleChoice = async (choice: SiteWalletAnswer) => {
    responded.current = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'MESSAGE_APPROVAL_RESPONSE',
        approvalId,
        approved: !!choice,
        choice: choice ?? undefined,
      });
    } finally {
      window.close();
    }
  };

  const handleReject = async () => {
    responded.current = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'MESSAGE_APPROVAL_RESPONSE',
        approvalId,
        approved: false,
      });
      window.close();
    } catch (_error) {
      window.close();
    }
  };

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          backgroundColor: 'var(--bg)',
        }}
      >
        <Mascot mood="loading" size={48} />
      </div>
    );
  }

  if (!msgInfo) return null;
  if (msgInfo.kind === 'site_wallet_choice') {
    return <SiteWalletChoice info={msgInfo} onAnswer={handleChoice} />;
  }
  const isSwitch = msgInfo.kind === 'network_switch';
  const signerAddress: string = pickedSigner || msgInfo.walletAddress || '';
  const needsUnlock = !isSwitch && isLocked && !passwordSkipped;

  const domain = (() => {
    try {
      return new URL(msgInfo.origin).hostname;
    } catch {
      return msgInfo.origin;
    }
  })();

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
          overflowX: 'hidden',
          padding: '20px 0 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            borderRadius: '10px',
            backgroundColor: 'color-mix(in oklab, var(--color-accent) 8%, transparent)',
            border: 'none',
          }}
        >
          <div
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '999px',
              backgroundColor: 'color-mix(in oklab, var(--color-accent) 14%, transparent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {msgInfo.favicon ? (
              <img
                src={sanitizeUrl(msgInfo.favicon)}
                alt="DApp"
                style={{ width: '16px', height: '16px', objectFit: 'contain', borderRadius: '4px' }}
              />
            ) : (
              <Globe size={14} style={{ color: 'var(--color-accent)' }} />
            )}
          </div>
          <div>
            <p
              style={{
                fontSize: '11.5px',
                fontWeight: 600,
                color: 'var(--fg)',
                marginBottom: '1px',
              }}
            >
              {isSwitch
                ? t('approval.switchNetworkRequest', { defaultValue: 'Network switch request' })
                : t('message.signatureRequest')}
            </p>
            <p style={{ fontSize: '11px', color: 'var(--fg-3)' }}>{domain}</p>
          </div>
        </div>

        {isSwitch && (
          <p style={{ fontSize: '13px', lineHeight: 1.5, color: 'var(--fg)', margin: 0 }}>
            {t('approval.switchNetworkBody', {
              from: sanitizeText(msgInfo.fromName),
              to: sanitizeText(msgInfo.toName),
              defaultValue:
                'This site asks to switch 0xio from {{from}} to {{to}}. Your balances, history and every request after this use {{to}}.',
            })}
          </p>
        )}

        {!isSwitch && (
          <div>
            <div
              style={{
                fontSize: '10.5px',
                fontWeight: 600,
                color: 'var(--fg-3)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: '6px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
              }}
            >
              <MessageSquare size={10} />
              {t('message.message')}
            </div>
            <div
              style={{
                backgroundColor: 'var(--bg-1)',
                border: 'none',
                borderRadius: '10px',
                padding: '12px',
                maxHeight: '200px',
                overflowY: 'auto',
              }}
            >
              <pre
                style={{
                  fontSize: '11.5px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--fg)',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                {String(msgInfo.message ?? '')}
              </pre>
            </div>
          </div>
        )}

        {needsUnlock && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div
              style={{
                fontSize: '10.5px',
                fontWeight: 600,
                color: 'var(--color-accent)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
              }}
            >
              {t('approval.unlockToSign')}
            </div>
            {passkeyEnabled && !showPasswordFallback ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <button
                  onClick={handlePasskeyUnlock}
                  disabled={passkeyLoading}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    height: '44px',
                    borderRadius: '10px',
                    border: 'none',
                    backgroundColor: 'color-mix(in oklab, var(--color-accent) 10%, transparent)',
                    color: 'var(--color-accent)',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                    opacity: passkeyLoading ? 0.6 : 1,
                  }}
                >
                  {passkeyLoading
                    ? t('lock.verifying', { defaultValue: 'Verifying…' })
                    : t('lock.unlockWithPasskey', { defaultValue: 'Passkey' })}
                </button>
                <button
                  onClick={() => setShowPasswordFallback(true)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '11px',
                    color: 'var(--fg-3)',
                    textAlign: 'center',
                    padding: '4px 0',
                  }}
                >
                  {t('lock.usePasswordInstead', { defaultValue: 'Use password instead' })}
                </button>
              </div>
            ) : (
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && password) handleApprove();
                }}
                autoComplete="current-password"
                spellCheck={false}
                placeholder={t('approval.enterPassword')}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  backgroundColor: 'var(--bg-1)',
                  border: 'none',
                  borderRadius: '10px',
                  outline: 'none',
                  fontSize: '13px',
                  color: 'var(--fg)',
                  boxSizing: 'border-box',
                }}
                autoFocus
              />
            )}
          </div>
        )}

        {error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 12px',
              backgroundColor: 'color-mix(in oklab, var(--neg) 10%, transparent)',
              border: 'none',
              borderRadius: '10px',
            }}
          >
            <AlertTriangle size={14} style={{ color: 'var(--neg)', flexShrink: 0 }} />
            <span style={{ fontSize: '12px', color: 'var(--neg)' }}>{error}</span>
          </div>
        )}
      </div>

      {!isSwitch && signerAddress && (
        <div className="px-(--gutter)!" style={{ flexShrink: 0, paddingTop: '4px' }}>
          <SignerRow
            address={signerAddress}
            networkId={msgInfo.networkId}
            pickable
            disabled={approving}
            onPick={setPickedSigner}
          />
        </div>
      )}

      <div
        className="px-(--gutter)!"
        style={{
          flexShrink: 0,
          padding: '12px 0 20px',
          display: 'grid',
          gridTemplateColumns: '3fr 7fr',
          gap: '8px',
        }}
      >
        <Button onClick={handleReject} disabled={approving} variant="secondary">
          {isSwitch
            ? t('approval.keepNetwork', {
                name: sanitizeText(msgInfo.fromName),
                defaultValue: 'Keep {{name}}',
              })
            : t('common.reject')}
        </Button>
        <Button
          onClick={handleApprove}
          disabled={approving || (needsUnlock && !password)}
          variant="primary"
        >
          {approving ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Mascot mood="loading" size={20} hole="var(--accent)" className="text-current!" />
              {isSwitch
                ? t('approval.switching', { defaultValue: 'Switching' })
                : t('approval.signing')}
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {isSwitch
                ? t('approval.switchToNetwork', {
                    name: sanitizeText(msgInfo.toName),
                    defaultValue: 'Switch to {{name}}',
                  })
                : needsUnlock
                  ? t('approval.unlockAndSign')
                  : t('message.signMessage')}
            </span>
          )}
        </Button>
      </div>
    </div>
  );
};

export default MessageApprovalScreen;
