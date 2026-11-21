import { useState, useEffect } from 'react';
import { useParams } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { AlertTriangle, ChevronRight } from 'src/shared/ui/icons';
import { Mascot } from 'src/shared/ui/Mascot';
import Button from 'src/shared/ui/Button';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { sanitizeText, sanitizeUrl } from 'src/lib/sanitize';
import { logger } from 'src/utils/logger';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import SignWithCard, { type SignWith } from '../components/SignWithCard';
import DesktopMark from '../components/DesktopMark';
import { Note, ReviewHeading, Row, SiteHead } from '../components/ReviewParts';
import { PrimaryButton } from 'src/shared/ui/primitives';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';

const SENSITIVE_PERMISSION_LABELS: Record<string, { label: string; desc: string }> = {
  private_balance_read: {
    label: 'Read your private balance',
    desc: 'Decrypt and read your shielded (private) balance and pending transfers, and decrypt private values this site submits. Uses your key, repeatedly and without another prompt while connected.',
  },
  private_proofs: {
    label: 'Generate private proofs',
    desc: 'Create zero-knowledge and range proofs from your private data.',
  },
  private_transfers: {
    label: 'Private transfers',
    desc: 'Initiate shielded (private) transfers.',
  },
  private_claims: {
    label: 'Claim private transfers',
    desc: 'Claim incoming private transfers to your wallet.',
  },
};

interface SignWithOffer {
  available: boolean;
  pick: SignWith;
  network: string;
}

type Stage = 'review' | 'waiting' | 'unreachable';

const networkLabel = (id: string) => (id === 'devnet' ? 'Devnet' : 'Mainnet');

interface WalletEntry {
  id: string;
  name: string;
  address: string;
  isActive: boolean;
}

const DAppApprovalScreen = () => {
  const { t } = useTranslation();
  const { approvalId } = useParams();
  const [dappInfo, setDappInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [faviconError, setFaviconError] = useState(false);
  const [allWallets, setAllWallets] = useState<WalletEntry[]>([]);
  const [selectedAddress, setSelectedAddress] = useState('');
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [signWith, setSignWith] = useState<SignWith>('browser');
  const [stage, setStage] = useState<Stage>('review');
  const [desktopOff, setDesktopOff] = useState(false);
  const offer: SignWithOffer | null = dappInfo?.signWith ?? null;

  useMountEffect(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_ALL_WALLETS' });
      if (res?.wallets) setAllWallets(res.wallets);
    } catch {}
  });

  // effect:audited - loads approval data from chrome.storage when approvalId changes
  useEffect(() => {
    loadApprovalRequest();
  }, [approvalId]);

  const loadApprovalRequest = async () => {
    logger.debug(`[DAppApproval] loadApprovalRequest approvalId=${approvalId}`);
    try {
      let approval = null;
      try {
        const swResponse = await chrome.runtime.sendMessage({
          type: 'GET_APPROVAL_DATA',
          approvalId,
        });
        logger.debug(`[DAppApproval] SW response: ${swResponse?.data ? 'found' : 'null'}`);
        approval = swResponse?.data ?? null;
      } catch (msgErr) {
        logger.warn('[DAppApproval] SW message failed, falling back to storage:', msgErr);
      }

      if (!approval) {
        for (let i = 0; i < 5; i++) {
          const result = await chrome.storage.local.get(`approval_${approvalId}`);
          approval = result[`approval_${approvalId}`] ?? null;
          logger.debug(`[DAppApproval] storage attempt ${i + 1}: ${approval ? 'found' : 'null'}`);
          if (approval) break;
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      if (!approval) {
        logger.error(`[DAppApproval] no approval data found - closing`);
        window.close();
        return;
      }

      setDappInfo(approval);
      setSelectedAddress(approval.walletAddress || '');
      const sw = approval.signWith as SignWithOffer | undefined;
      if (sw?.pick === 'desktop' && sw.available) setSignWith('desktop');
      if (sw?.pick === 'desktop' && !sw.available) {
        setDesktopOff(true);
        setStage('unreachable');
      }
    } catch (error) {
      logger.error('[DAppApproval] Failed to load approval request:', error);
      window.close();
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      await chrome.runtime.sendMessage({
        type: 'DAPP_APPROVAL_RESPONSE',
        approvalId,
        approved: true,
        selectedAddress,
      });
      setTimeout(() => {
        window.close();
      }, 300);
    } catch (error) {
      logger.error('Failed to send approval:', error);
      setApproving(false);
    }
  };

  const handleReject = async () => {
    try {
      await chrome.runtime.sendMessage({
        type: 'DAPP_APPROVAL_RESPONSE',
        approvalId,
        approved: false,
      });
      window.close();
    } catch (error) {
      logger.error('Failed to send rejection:', error);
      window.close();
    }
  };

  const routeToDesktop = async () => {
    setStage('waiting');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'DAPP_APPROVAL_DESKTOP', approvalId });
      if (res?.status !== 'done') {
        setDesktopOff(true);
        setStage('unreachable');
      }
    } catch (error) {
      logger.error('Routing the connect request to 0xio Desktop failed:', error);
      setDesktopOff(true);
      setStage('unreachable');
    }
  };

  const signHere = () => {
    setSignWith('browser');
    setStage('review');
  };

  const getDomainName = () => {
    if (!dappInfo?.origin) return '';
    try {
      const url = new URL(dappInfo.origin);
      return url.hostname.replace('www.', '');
    } catch (_e) {
      return dappInfo.origin;
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
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <Mascot mood="loading" size={48} />
        <p style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{t('dapp.securingConnection')}</p>
      </div>
    );
  }

  if (!dappInfo) {
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
        <div
          style={{
            textAlign: 'center',
            padding: '24px',
            backgroundColor: 'var(--bg-1)',
            borderRadius: '12px',
            border: 'none',
          }}
        >
          <AlertTriangle size={32} style={{ color: 'var(--neg)', margin: '0 auto 12px' }} />
          <p style={{ fontSize: '13px', color: 'var(--fg-2)' }}>{t('dapp.requestExpired')}</p>
        </div>
      </div>
    );
  }

  const pickedAddress = selectedAddress || dappInfo.walletAddress || '';
  const pickedName =
    allWallets.find((w) => w.address === pickedAddress)?.name || t('dapp.connectingAs');
  const toDesktop = !!offer && signWith === 'desktop';

  if (stage !== 'review') {
    const waiting = stage === 'waiting';
    return (
      <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
        <div
          className="flex! flex-1! flex-col! overflow-y-auto! scrollbar-hide!"
          style={{ padding: '20px var(--gutter) 12px' }}
        >
          <div className="tab-caps" style={{ color: 'var(--fg-3)' }}>
            {t('evmDapp.connectCaps', { defaultValue: 'Connection request' })}
          </div>
          <SiteHead origin={dappInfo.origin} favicon={dappInfo.favicon} />
          {waiting ? (
            <div
              className="flex! flex-1! flex-col! items-center! justify-center! text-center!"
              style={{ gap: '14px' }}
            >
              <DesktopMark size={52} />
              <div style={{ fontSize: '15px', color: 'var(--fg)' }}>
                {t('desktopSites.waiting', { defaultValue: 'Waiting for 0xio Desktop' })}
              </div>
              <div
                className="flex! items-center!"
                style={{
                  gap: '6px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  color: 'var(--fg-3)',
                }}
              >
                <DesktopMark size={16} />
                {t('desktopSites.reviewInMenuBar', { defaultValue: 'Review in the menu bar' })}
              </div>
            </div>
          ) : (
            <>
              <ReviewHeading>
                {t('desktopSites.notReachable', {
                  defaultValue: '0xio Desktop is not reachable',
                })}
              </ReviewHeading>
              <Note>
                {t('desktopSites.notReachableBody', {
                  defaultValue: 'Open 0xio Desktop on this computer, or sign in this browser.',
                })}
              </Note>
              <div style={{ height: '18px' }} />
              <SignWithCard
                value="browser"
                onChange={(v) => v === 'browser' && signHere()}
                walletName={pickedName}
                walletAddress={pickedAddress}
                desktopOff
              />
            </>
          )}
        </div>
        <div
          className="flex!"
          style={{ flexShrink: 0, gap: '10px', padding: '8px var(--gutter) 20px' }}
        >
          {waiting ? (
            <PrimaryButton secondary onClick={() => void handleReject()} style={BIG_BUTTON}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </PrimaryButton>
          ) : (
            <>
              <PrimaryButton secondary onClick={() => void routeToDesktop()} style={BIG_BUTTON}>
                {t('desktopSites.tryAgain', { defaultValue: 'Try again' })}
              </PrimaryButton>
              <PrimaryButton onClick={signHere} style={BIG_BUTTON}>
                {t('desktopSites.signHere', { defaultValue: 'Use this browser' })}
              </PrimaryButton>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: 'var(--bg)',
        overflow: 'hidden',
        position: 'relative',
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
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            marginBottom: '20px',
          }}
        >
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '14px',
              backgroundColor: 'var(--bg-1)',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              marginBottom: '12px',
              flexShrink: 0,
            }}
          >
            {dappInfo.favicon && !faviconError ? (
              <img
                src={sanitizeUrl(dappInfo.favicon)}
                alt={sanitizeText(dappInfo.title)}
                style={{ width: '32px', height: '32px', objectFit: 'contain' }}
                onError={() => setFaviconError(true)}
              />
            ) : (
              <span
                style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  color: 'var(--fg)',
                  textTransform: 'uppercase',
                }}
              >
                {(sanitizeText(dappInfo.title) || getDomainName()).slice(0, 2)}
              </span>
            )}
          </div>

          <h2
            style={{
              fontSize: '16px',
              fontWeight: 600,
              color: 'var(--fg)',
              marginBottom: '4px',
              maxWidth: '90%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sanitizeText(dappInfo.title) || getDomainName()}
          </h2>

          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--fg-3)' }}>
            <span style={{ fontSize: '11px' }}>{getDomainName()}</span>
          </div>
        </div>

        {offer && (
          <SignWithCard
            value={toDesktop ? 'desktop' : 'browser'}
            onChange={setSignWith}
            walletName={pickedName}
            walletAddress={pickedAddress}
            desktopOff={desktopOff || !offer.available}
            disabled={approving}
          />
        )}

        {toDesktop && (
          <div className="rounded-[18px]! bg-(--bg-1)!" style={{ padding: '4px' }}>
            <Row label={t('desktopSites.network', { defaultValue: 'Network' })}>
              {networkLabel(offer.network)}
            </Row>
            <Row label={t('desktopSites.review', { defaultValue: 'Review' })}>
              {t('desktopSites.menuBar', { defaultValue: 'Menu bar' })}
            </Row>
          </div>
        )}

        {!toDesktop && dappInfo.networkMismatch && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              padding: '10px 12px',
              borderRadius: '10px',
              border: 'none',
              backgroundColor: 'color-mix(in oklab, var(--fg-3) 8%, transparent)',
              marginBottom: '12px',
            }}
          >
            <AlertTriangle
              size={14}
              style={{ color: 'var(--fg-3)', flexShrink: 0, marginTop: '2px' }}
            />
            <div>
              <p
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--fg-3)',
                  marginBottom: '2px',
                }}
              >
                Network mismatch
              </p>
              <p style={{ fontSize: '10.5px', color: 'var(--fg-3)', lineHeight: 1.4 }}>
                DApp uses <strong style={{ color: 'var(--fg-2)' }}>{dappInfo.dappNetwork}</strong>{' '}
                but wallet is on{' '}
                <strong style={{ color: 'var(--fg-2)' }}>{dappInfo.extensionNetwork}</strong>.
                Transactions may fail.
              </p>
            </div>
          </div>
        )}

        {!toDesktop &&
          dappInfo.walletAddress &&
          (() => {
            const displayAddr = selectedAddress || dappInfo.walletAddress;
            const picked = allWallets.find((w) => w.address === displayAddr);
            const walletName = picked?.name || t('dapp.connectingAs');
            return (
              <button
                onClick={() => setShowWalletPicker(true)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: '10px',
                  border: 'none',
                  backgroundColor: 'var(--bg-1)',
                  marginBottom: '12px',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <WalletAvatar address={displayAddr} size={32} />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--fg)' }}>
                      {walletName}
                    </span>
                    <span
                      style={{
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--fg-3)',
                      }}
                    >
                      {displayAddr.slice(0, 10)}…{displayAddr.slice(-6)}
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    color: 'var(--fg-3)',
                    fontSize: '11px',
                  }}
                >
                  {allWallets.length > 1 && <span>Switch</span>}
                  <ChevronRight size={14} />
                </div>
              </button>
            );
          })()}

        <div
          hidden={toDesktop}
          style={{
            backgroundColor: 'var(--bg-1)',
            border: 'none',
            borderRadius: '10px',
            padding: '12px',
          }}
        >
          <div
            style={{
              fontSize: '10px',
              fontWeight: 600,
              color: 'var(--fg-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: '10px',
            }}
          >
            {t('dapp.permissionsRequested')}
          </div>

          <div style={{ marginBottom: '10px' }}>
            <p
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--fg)',
                marginBottom: '2px',
              }}
            >
              {t('dapp.viewWallet')}
            </p>
            <p style={{ fontSize: '10.5px', color: 'var(--fg-3)', lineHeight: 1.4 }}>
              {t('dapp.viewWalletDesc')}
            </p>
          </div>

          <div style={{ height: '12px' }} />

          <div>
            <p
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--fg)',
                marginBottom: '2px',
              }}
            >
              {t('dapp.requestTx')}
            </p>
            <p style={{ fontSize: '10.5px', color: 'var(--fg-3)', lineHeight: 1.4 }}>
              {t('dapp.requestTxDesc')}
            </p>
          </div>

          {Array.isArray(dappInfo.permissions) &&
            dappInfo.permissions.some((p: string) => SENSITIVE_PERMISSION_LABELS[p]) && (
              <>
                <div style={{ height: '12px' }} />
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    marginBottom: '10px',
                    color: 'var(--neg)',
                    fontSize: '10px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  <AlertTriangle size={11} />
                  Sensitive access requested
                </div>
                {dappInfo.permissions
                  .filter((p: string) => SENSITIVE_PERMISSION_LABELS[p])
                  .map((perm: string) => (
                    <div key={perm} style={{ marginBottom: '10px' }}>
                      <p
                        style={{
                          fontSize: '12px',
                          fontWeight: 600,
                          color: 'var(--neg)',
                          marginBottom: '2px',
                        }}
                      >
                        {SENSITIVE_PERMISSION_LABELS[perm].label}
                      </p>
                      <p style={{ fontSize: '10.5px', color: 'var(--fg-3)', lineHeight: 1.4 }}>
                        {SENSITIVE_PERMISSION_LABELS[perm].desc}
                      </p>
                    </div>
                  ))}
              </>
            )}
        </div>
      </div>

      {showWalletPicker && (
        <div
          onClick={() => setShowWalletPicker(false)}
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'var(--overlay)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: 'var(--bg-1)',
              borderRadius: '16px 16px 0 0',
              padding: '12px 0 20px',
              maxHeight: '70%',
              overflowY: 'auto',
            }}
          >
            <div
              style={{
                width: '32px',
                height: '3px',
                borderRadius: '999px',
                backgroundColor: 'var(--line)',
                margin: '0 auto 16px',
              }}
            />
            <div
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--fg-3)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '0 16px 10px',
              }}
            >
              {t('dapp.connectingAs')}
            </div>
            {allWallets.map((w) => {
              const isSelected = w.address === selectedAddress;
              return (
                <button
                  key={w.id}
                  onClick={() => {
                    setSelectedAddress(w.address);
                    setShowWalletPicker(false);
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 16px',
                    background: isSelected
                      ? 'color-mix(in oklab, var(--color-accent) 8%, transparent)'
                      : 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <WalletAvatar address={w.address} size={36} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: 'var(--fg)',
                        marginBottom: '2px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {w.name}
                    </div>
                    <div
                      style={{
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--fg-3)',
                      }}
                    >
                      {w.address.slice(0, 10)}…{w.address.slice(-6)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
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
          {t('common.reject')}
        </Button>
        {toDesktop ? (
          <Button onClick={() => void routeToDesktop()} variant="primary">
            {t('desktopSites.continue', { defaultValue: 'Continue' })}
          </Button>
        ) : (
          <Button onClick={handleApprove} loading={approving} variant="primary">
            {approving ? t('dapp.connecting') : t('dapp.connect')}
          </Button>
        )}
      </div>
    </div>
  );
};

export default DAppApprovalScreen;
