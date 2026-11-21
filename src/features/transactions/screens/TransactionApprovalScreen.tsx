import { useState, useEffect, useRef } from 'react';
import { useParams } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { sanitizeText, sanitizeUrl } from 'src/lib/sanitize';
import { fromUnits } from 'src/utils/amount';
import {
  FEE_UNAVAILABLE,
  parseBaseUnits,
  parseOu,
  parsePrivateAmount,
  resolveTxMemo,
} from 'src/utils/octra/dappTx';
import { reviewArgs } from 'src/utils/octra/dappTxRequest';
import { isOctAddress } from 'src/utils/octra/address';
import FeeValue from 'src/shared/ui/FeeValue';
import { Database, Globe, AlertTriangle } from 'src/shared/ui/icons';
import { Mascot } from 'src/shared/ui/Mascot';
import Button from 'src/shared/ui/Button';
import SignerRow from 'src/features/dapp/components/SignerRow';
import DeployReview from 'src/features/transactions/components/DeployReview';
import { deployReviewError } from 'src/utils/octra/deployTx';
import { useWallet } from 'src/contexts/WalletContext';
import { unlockErrorMessage } from 'src/features/security/unlockError';
import { networkService } from 'src/services/network/NetworkService';
import { logger } from 'src/utils/logger';
import { isPasskeyEnabled, authenticateWithPasskey } from 'src/services/crypto/PasskeyService';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { isCustomNetworkId, peekNetwork } from 'src/utils/config';
import { getNetworkConfig } from 'src/utils/network';

const RECIPIENT_METHODS = new Set([
  'send_transaction',
  'sign_transaction',
  'call_contract',
  'send_private_transfer',
]);

const TransactionApprovalScreen = () => {
  const { t } = useTranslation();
  const { approvalId } = useParams();
  const { isLocked, unlockWallet, passwordSkipped } = useWallet();
  const [txInfo, setTxInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const approvingRef = useRef(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [faviconError, setFaviconError] = useState(false);
  const [contractParamNames, setContractParamNames] = useState<string[] | null>(null);
  const [passkeyEnabled, setPasskeyEnabled] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [showPasswordFallback, setShowPasswordFallback] = useState(false);
  const [pickedSigner, setPickedSigner] = useState('');
  const responded = useRef(false);

  // effect:audited - loads tx from chrome.storage when approvalId changes
  useEffect(() => {
    loadTransactionRequest();
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
          type: 'TRANSACTION_APPROVAL_RESPONSE',
          approvalId,
          approved: false,
        });
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [approvalId]);

  const loadTransactionRequest = async () => {
    try {
      const result = await chrome.storage.local.get(`tx_approval_${approvalId}`);
      const tx = result[`tx_approval_${approvalId}`];

      if (!tx) {
        window.close();
        return;
      }
      setTxInfo(tx);

      const _p = Array.isArray(tx.params) ? (tx.params[0] ?? {}) : (tx.params ?? {});
      if (_p.op_type === 'call' && _p.to) {
        const rawM = _p.method || '';
        const parts = rawM.split('_');
        const baseName =
          parts.length > 1 && /^[a-f0-9]{16,}$/i.test(parts[parts.length - 1])
            ? parts.slice(0, -1).join('_')
            : rawM;
        const names = await networkService.getContractParamNames(_p.to, baseName);
        if (names) setContractParamNames(names);
      }
    } catch (error) {
      logger.error('Failed to load transaction request:', error);
      setError('Could not load the request');
    } finally {
      setLoading(false);
    }
  };

  const getDomainName = () => {
    if (!txInfo?.origin) return '';
    try {
      const url = new URL(txInfo.origin);
      return url.hostname.replace('www.', '');
    } catch (_e) {
      return txInfo.origin;
    }
  };

  const handleApprove = async () => {
    if (approvingRef.current || requestError) return;
    approvingRef.current = true;
    setError('');
    setApproving(true);

    try {
      if (isLocked && !passwordSkipped) {
        try {
          await unlockWallet(password);
        } catch (e) {
          setError(unlockErrorMessage(e, t));
          setApproving(false);
          approvingRef.current = false;
          return;
        }
        setPassword('');
      }

      // No password in the reply: this popup's unlock already wrote the session the worker reads.
      responded.current = true;
      await chrome.runtime.sendMessage({
        type: 'TRANSACTION_APPROVAL_RESPONSE',
        approvalId,
        approved: true,
        selectedAddress:
          pickedSigner && pickedSigner !== txInfo?.walletAddress ? pickedSigner : undefined,
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

  const handleReject = async () => {
    responded.current = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'TRANSACTION_APPROVAL_RESPONSE',
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

  if (!txInfo) return null;

  const _txParams = Array.isArray(txInfo.params) ? (txInfo.params[0] ?? {}) : (txInfo.params ?? {});
  // Writes arrive normalized by the worker: these fields are what it signs.
  const isContractCall = _txParams.op_type === 'call';
  const PRIVATE_METHODS = new Set([
    'send_private_transfer',
    'claim_private_transfer',
    'register_private_view_key',
  ]);
  const isPrivateOp = PRIVATE_METHODS.has(txInfo.methods);
  const isSequence = txInfo.methods === 'send_contract_transaction_sequence';
  const seqSteps: any[] =
    isSequence && Array.isArray(_txParams.transactions) ? _txParams.transactions : [];
  const fmtOct = (units: bigint) => {
    const [int, frac] = fromUnits(units).split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${grouped}.${frac}` : grouped;
  };
  const ouUnits = parseOu(_txParams.ou);
  const feeOct = ouUnits != null ? fmtOct(ouUnits) : null;
  const isClaim = txInfo.methods === 'claim_private_transfer';
  const claimUnits = isClaim ? parseBaseUnits(_txParams.amount_raw) : null;
  const claimCount = isClaim ? Number(_txParams.count) || 1 : 0;
  const amountUnits = parseBaseUnits(_txParams.amount);
  const privateUnits =
    txInfo.methods === 'send_private_transfer' ? parsePrivateAmount(_txParams) : null;
  const memoResult =
    !isContractCall && !isPrivateOp && !isSequence ? resolveTxMemo(_txParams) : null;
  const shownMemo = memoResult && 'memo' in memoResult ? memoResult.memo : '';
  const seqInvalid = seqSteps.some(
    (st) =>
      parseBaseUnits(st?.amount) == null ||
      parseOu(st?.ou) == null ||
      typeof st?.message !== 'string' ||
      !isOctAddress(st?.to)
  );
  const isDevnet = txInfo.networkId === 'devnet';
  const networkLabel =
    !txInfo.networkId || isCustomNetworkId(txInfo.networkId)
      ? (txInfo.networkId && peekNetwork(txInfo.networkId)?.name) || t('approval.customNetwork')
      : getNetworkConfig(txInfo.networkId).name;
  const domain = getDomainName() || 'Unknown site';
  // Private requests run on the open wallet only: no other wallet is offered for them.
  const signerAddress: string = (!isPrivateOp && pickedSigner) || txInfo.walletAddress || '';

  const rawMethod = isContractCall ? String(_txParams.method ?? '') : '';
  const methodParts = rawMethod.split('_');
  const methodName =
    methodParts.length > 1 && /^[a-f0-9]{16,}$/i.test(methodParts[methodParts.length - 1])
      ? methodParts.slice(0, -1).join('_')
      : rawMethod;
  const methodDisplay = methodName.charAt(0).toUpperCase() + methodName.slice(1);

  const parsedParams = (() => {
    if (isContractCall) {
      return typeof _txParams.message === 'string' ? reviewArgs(_txParams.message) : null;
    }
    return _txParams.params ?? null;
  })();

  const contractOctAmount =
    isContractCall && amountUnits != null && amountUnits > 0n ? fmtOct(amountUnits) : null;

  const toAddr: string = typeof _txParams.to === 'string' ? _txParams.to : '';
  const isDeploy = txInfo.methods === 'deploy_contract';
  const needsRecipient = RECIPIENT_METHODS.has(txInfo.methods);
  const requestError = isDeploy
    ? deployReviewError(_txParams)
    : (needsRecipient && !isOctAddress(toAddr)) ||
        (isContractCall && (!rawMethod || typeof _txParams.message !== 'string'))
      ? t('approval.invalidRequest', { defaultValue: 'Invalid request' })
      : !isSequence && ouUnits == null
        ? FEE_UNAVAILABLE
        : txInfo.methods === 'send_private_transfer'
          ? privateUnits == null
            ? 'Invalid amount'
            : null
          : isClaim
            ? claimUnits == null || claimUnits === 0n
              ? 'Invalid amount'
              : null
            : isPrivateOp
              ? null
              : isSequence
                ? seqInvalid
                  ? 'Invalid amount or fee'
                  : null
                : amountUnits == null || (!isContractCall && amountUnits === 0n)
                  ? 'Invalid amount'
                  : memoResult && 'error' in memoResult
                    ? memoResult.error
                    : null;
  const actionTitle =
    txInfo.methods === 'send_private_transfer'
      ? `Send ${fmtOct(privateUnits ?? 0n)} OCT privately`
      : isClaim
        ? t('approval.claimTitle', {
            amount: fmtOct(claimUnits ?? 0n),
            defaultValue: 'Claim {{amount}} OCT privately',
          })
        : txInfo.methods === 'register_private_view_key'
          ? 'Register private view key'
          : isSequence
            ? `${seqSteps.length} contract calls`
            : isContractCall
              ? methodDisplay || 'Contract call'
              : `Send ${fmtOct(amountUnits ?? 0n)} OCT`;

  // A step's arguments exactly as signed: big integers keep every digit.
  const stepArgs = (message: string): string => {
    const args = reviewArgs(message);
    if (!Array.isArray(args)) return typeof args === 'string' ? args : message;
    return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('\n');
  };

  const inferParamLabel = (value: unknown, index: number): string => {
    const s = String(value);
    if (/^0x[a-fA-F0-9]{40}$/.test(s)) return 'EVM addr';
    if (/^0x[a-fA-F0-9]{64}$/.test(s)) return 'Transaction hash';
    if (
      [
        'mainnet',
        'sepolia',
        'goerli',
        'mumbai',
        'polygon',
        'bsc',
        'devnet',
        'testnet',
        'arbitrum',
        'optimism',
        'avalanche',
        'fantom',
      ].includes(s.toLowerCase())
    )
      return 'Network';
    if (/_[a-f0-9]{8,}$/i.test(s)) return 'Method';
    if (/^0x[a-fA-F0-9]+$/.test(s)) return 'Data';
    if (/^[A-Z]{2,8}$/.test(s)) return 'Token';
    // Unrecognized values: never claim to know the unit.
    return `#${index}`;
  };

  const formatParamValue = (value: unknown): string => {
    const s = String(value);
    if (/^\d{5,}$/.test(s)) {
      const n = BigInt(s);
      return n.toLocaleString();
    }
    return s;
  };

  const ETH_LIKE_18 = new Set(['ETH', 'WETH', 'MATIC', 'BNB', 'AVAX', 'ARB', 'OP']);
  const WEI_PARAM_NAMES = new Set(['min_receive', 'amount_sent', 'new_amount']);

  const destToken = (() => {
    if (!contractParamNames || !Array.isArray(parsedParams)) return null;
    const idx = contractParamNames.indexOf('dest_token');
    return idx >= 0 ? String(parsedParams[idx]).toUpperCase() : null;
  })();

  const weiToTokenHint = (paramLabel: string, rawValue: unknown): string | null => {
    if (!WEI_PARAM_NAMES.has(paramLabel) || !destToken || !ETH_LIKE_18.has(destToken)) return null;
    const s = String(rawValue);
    if (!/^\d+$/.test(s)) return null;
    try {
      const n = BigInt(s);
      if (n < BigInt('1000000000000')) return null;
      return `${fromUnits(n, 18)} ${destToken}`;
    } catch {
      return null;
    }
  };

  if (isDeploy) {
    return (
      <DeployReview
        req={txInfo}
        networkLabel={networkLabel}
        needsUnlock={isLocked && !passwordSkipped}
        password={password}
        onPassword={setPassword}
        passkey={
          passkeyEnabled
            ? { enabled: true, loading: passkeyLoading, onUse: handlePasskeyUnlock }
            : null
        }
        error={error}
        busy={approving}
        onApprove={handleApprove}
        onReject={handleReject}
      />
    );
  }

  const DetailRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        padding: '9px 0',
      }}
    >
      <span
        style={{
          fontSize: '11.5px',
          color: 'var(--fg-3)',
          flexShrink: 0,
          marginRight: '12px',
          paddingTop: '1px',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: '12px',
          color: 'var(--fg)',
          textAlign: 'right',
          fontFamily: 'inherit',
          minWidth: 0,
        }}
      >
        {children}
      </span>
    </div>
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
          overflowX: 'hidden',
          padding: '16px 0 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            paddingBottom: '4px',
          }}
        >
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '12px',
              backgroundColor: 'var(--bg-1)',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              marginBottom: '10px',
            }}
          >
            {txInfo.favicon && !faviconError ? (
              <img
                src={sanitizeUrl(txInfo.favicon)}
                alt="DApp"
                style={{ width: '28px', height: '28px', objectFit: 'contain' }}
                onError={() => setFaviconError(true)}
              />
            ) : (
              <Globe size={18} style={{ color: 'var(--fg-3)' }} />
            )}
          </div>
          <div
            style={{
              fontSize: '20px',
              fontWeight: 700,
              color: 'var(--fg)',
              letterSpacing: '-0.02em',
              marginBottom: '4px',
            }}
          >
            {actionTitle}
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
            <span>{domain} is requesting your signature</span>
          </div>
        </div>

        {txInfo.networkMismatch && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              padding: '10px 12px',
              borderRadius: '10px',
              border: 'none',
              backgroundColor: 'color-mix(in oklab, var(--fg-3) 8%, transparent)',
            }}
          >
            <AlertTriangle
              size={14}
              style={{ color: 'var(--fg-3)', flexShrink: 0, marginTop: '1px' }}
            />
            <div>
              <p
                style={{
                  fontSize: '11.5px',
                  fontWeight: 600,
                  color: 'var(--fg-3)',
                  marginBottom: '2px',
                }}
              >
                Network mismatch. The transaction may fail.
              </p>
              <p style={{ fontSize: '11px', color: 'var(--fg-3)', lineHeight: 1.4 }}>
                DApp is on <strong style={{ color: 'var(--fg-2)' }}>{txInfo.dappNetwork}</strong>,
                wallet is on{' '}
                <strong style={{ color: 'var(--fg-2)' }}>{txInfo.extensionNetwork}</strong>.
              </p>
            </div>
          </div>
        )}

        <div
          style={{
            backgroundColor: 'var(--bg-1)',
            border: 'none',
            borderRadius: '10px',
            padding: '0 12px',
          }}
        >
          <DetailRow label="Network">
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '999px',
                  backgroundColor: isDevnet ? 'var(--fg-3)' : 'var(--pos)',
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '180px',
                }}
              >
                {networkLabel}
              </span>
            </span>
          </DetailRow>
          {isClaim && (
            <DetailRow label={t('approval.transfers', { defaultValue: 'Transfers' })}>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{claimCount}</span>
            </DetailRow>
          )}
          {!isSequence && (
            <DetailRow label={t('send.networkFee', { defaultValue: 'Network fee' })}>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {feeOct != null ? `${feeOct} OCT` : <FeeValue state="failed" />}
              </span>
            </DetailRow>
          )}
          {toAddr && (
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                padding: '9px 0',
              }}
            >
              <span
                style={{
                  fontSize: '11.5px',
                  color: 'var(--fg-3)',
                  flexShrink: 0,
                  marginRight: '12px',
                  paddingTop: '1px',
                }}
              >
                {isContractCall ? 'Contract' : 'To'}
              </span>
              <span
                style={{
                  fontSize: '10.5px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--fg)',
                  wordBreak: 'break-all',
                  textAlign: 'right',
                }}
              >
                {toAddr}
              </span>
            </div>
          )}
        </div>

        {isSequence && seqSteps.length > 0 && (
          <div
            style={{
              backgroundColor: 'var(--bg-1)',
              border: 'none',
              borderRadius: '10px',
              padding: '0 12px',
            }}
          >
            {seqSteps.map((s, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  padding: '9px 0',
                  borderBottom: 'none',
                }}
              >
                <span style={{ fontSize: '12px', color: 'var(--fg)' }}>
                  {i + 1}. {String(s?.method ?? '')}
                </span>
                <span
                  style={{
                    fontSize: '10.5px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--fg-3)',
                    wordBreak: 'break-all',
                  }}
                >
                  {String(s?.to ?? '')}
                </span>
                {typeof s?.message === 'string' && (
                  <span
                    style={{
                      fontSize: '10.5px',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--fg-2)',
                      wordBreak: 'break-all',
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.5,
                    }}
                  >
                    {stepArgs(s.message)}
                  </span>
                )}
                <span style={{ fontSize: '10.5px', color: 'var(--fg-3)' }}>
                  {(parseBaseUnits(s?.amount) ?? 0n) > 0n
                    ? `Attaching ${fmtOct(parseBaseUnits(s.amount) ?? 0n)} OCT and fee `
                    : 'Fee '}
                  {fmtOct(parseOu(s?.ou) ?? 0n)} OCT
                </span>
              </div>
            ))}
          </div>
        )}

        {contractOctAmount && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              backgroundColor: 'var(--bg-1)',
              border: 'none',
              borderRadius: '10px',
            }}
          >
            <span style={{ fontSize: '11.5px', color: 'var(--fg-3)' }}>Attaching value</span>
            <span
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--fg)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {contractOctAmount} OCT
            </span>
          </div>
        )}

        {parsedParams !== null && !(Array.isArray(parsedParams) && parsedParams.length === 0) && (
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
              <Database size={10} /> Parameters
            </div>
            <div
              style={{
                backgroundColor: 'var(--bg-1)',
                border: 'none',
                borderRadius: '10px',
                overflow: 'hidden',
              }}
            >
              {Array.isArray(parsedParams) ? (
                parsedParams.map((item, i) => {
                  const paramLabel =
                    sanitizeText(contractParamNames?.[i]) || inferParamLabel(item, i);
                  const weiHint = weiToTokenHint(contractParamNames?.[i] ?? '', item);
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '3px',
                        padding: '8px 12px',
                        borderBottom: 'none',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 600,
                          color: 'var(--fg-3)',
                          letterSpacing: '0.02em',
                        }}
                      >
                        {paramLabel}
                      </span>
                      <span
                        style={{
                          fontSize: '11.5px',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--fg)',
                          wordBreak: 'break-all',
                          lineHeight: 1.5,
                        }}
                      >
                        {formatParamValue(item)}
                        {weiHint && (
                          <span
                            style={{
                              fontSize: '10.5px',
                              color: 'var(--fg-3)',
                              marginLeft: '8px',
                              fontFamily: 'inherit',
                            }}
                          >
                            {weiHint}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })
              ) : typeof parsedParams === 'object' ? (
                Object.entries(parsedParams).map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '10px',
                      padding: '8px 12px',
                      borderBottom: 'none',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '10.5px',
                        color: 'var(--fg-3)',
                        minWidth: '60px',
                        flexShrink: 0,
                      }}
                    >
                      {k}
                    </span>
                    <span
                      style={{
                        fontSize: '11.5px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--fg)',
                        wordBreak: 'break-all',
                        lineHeight: 1.5,
                      }}
                    >
                      {String(v)}
                    </span>
                  </div>
                ))
              ) : (
                <div style={{ padding: '10px 12px' }}>
                  <span
                    style={{
                      fontSize: '11.5px',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--fg-2)',
                      wordBreak: 'break-all',
                      lineHeight: 1.5,
                    }}
                  >
                    {String(parsedParams)}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {shownMemo && (
          <div>
            <div
              style={{
                fontSize: '10.5px',
                fontWeight: 600,
                color: 'var(--fg-3)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: '6px',
              }}
            >
              Memo
            </div>
            <div
              style={{
                backgroundColor: 'var(--bg-1)',
                border: 'none',
                borderRadius: '10px',
                padding: '10px 12px',
              }}
            >
              <p
                style={{
                  fontSize: '12px',
                  color: 'var(--fg-2)',
                  lineHeight: 1.5,
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}
              >
                {shownMemo}
              </p>
            </div>
          </div>
        )}

        {isLocked && !passwordSkipped && (
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

        {(requestError || error) && (
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
            <span style={{ fontSize: '12px', color: 'var(--neg)' }}>{requestError || error}</span>
          </div>
        )}
      </div>

      {signerAddress && (
        <div className="px-(--gutter)!" style={{ flexShrink: 0, paddingTop: '4px' }}>
          <SignerRow
            address={signerAddress}
            networkId={txInfo.networkId}
            pickable={!isPrivateOp}
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
          {t('common.reject')}
        </Button>
        <Button
          onClick={handleApprove}
          disabled={approving || !!requestError || (isLocked && !passwordSkipped && !password)}
          variant="primary"
        >
          {approving ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Mascot mood="loading" size={20} hole="var(--accent)" className="text-current!" />
              {t('approval.signing')}
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {isLocked && !passwordSkipped ? t('approval.unlockAndSign') : t('common.confirm')}
            </span>
          )}
        </Button>
      </div>
    </div>
  );
};

export default TransactionApprovalScreen;
