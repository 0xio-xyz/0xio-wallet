import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { ChevronDown } from 'src/shared/ui/icons';
import Header from 'src/shared/ui/Header';
import { useWallet } from 'src/contexts/WalletContext';
import { networkService, privacyNetworkService } from 'src/services/network/NetworkService';
import { pvacManager } from 'src/services/pvac/PvacManager';
import { getPendingKeySwitch } from 'src/services/pvac/keySwitchService';
import {
  assertTxScope,
  captureTxScope,
  resolveNetworkPin,
  type TxScope,
} from 'src/services/network/txScope';
import { bytesToBase64 } from 'src/services/crypto/PrivateCrypto';
import { logger } from 'src/utils/logger';
import { plainError, PlainError } from 'src/utils/plainError';
import i18n from 'src/i18n/core';
import { networkCapabilities, getNetworkConfig } from 'src/utils/network';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import { useClaim, type PrivateOutput } from 'src/hooks/privacy/useClaim';
import { usePrivacyFees } from 'src/hooks/privacy/usePrivacyFees';
import { proveThenSubmit } from 'src/hooks/privacy/proveThenSubmit';
import { proofPolicyFor, requireProofPolicy } from 'src/services/pvac/proofPolicy';
import { usePvacBlocked } from 'src/hooks/privacy/usePvacBlocked';
import { requestKeySwitchDetails } from 'src/shared/ui/KeySwitchOverlay';
import ClaimSection, {
  ClaimBottomBar,
  ClaimReview,
} from 'src/features/privacy/components/ClaimSection';
import PrivacyReview from 'src/features/privacy/components/PrivacyReview';
import { Mascot } from 'src/shared/ui/Mascot';
import FeeSheet from 'src/features/transactions/components/FeeSheet';
import { maxSendable, trimAmount } from 'src/features/transactions/sendStage';
import FeeValue from 'src/shared/ui/FeeValue';
import { TextTab, RuledList, ListRow, FieldLabel, PrimaryButton } from 'src/shared/ui/primitives';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import SetupPrivateBalanceModal, {
  type SetupFee,
} from 'src/features/privacy/components/SetupPrivateBalanceModal';
import MigrateBalanceModal from 'src/features/privacy/components/MigrateBalanceModal';
import PrivacyOpsCta, {
  resolvePrivacyOpsState,
  outranksKeyGate,
} from 'src/features/privacy/components/PrivacyOpsCta';
import { useMigrateBalance } from 'src/features/privacy/hooks/useMigrateBalance';
import { cleanAmountInput } from 'src/utils/amount';

const MODE = { ENCRYPT: 'encrypt', DECRYPT: 'decrypt', CLAIM: 'claim' } as const;
type Mode = (typeof MODE)[keyof typeof MODE];

const ouToOct = (ou: string) => {
  const n = parseFloat(ou);
  if (isNaN(n)) return '0';
  return (n / 1_000_000).toFixed(6).replace(/\.?0+$/, '');
};

const canonicalAdvisoryShown = new Set<string>();

const mapExecError = (reason?: string): string => plainError(reason, i18n.t('toast.rejected'));

const PrivacyScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    showMessage,
    activeWallet,
    balance: publicBalance,
    privateBalance,
    refreshBalance,
    adjustBalanceOptimistic,
    networkId,
    pvacForeign,
    setPvacForeign,
    pvacLegacy,
    markPrivacyOp,
  } = useWallet();

  const isDevnet = networkId === 'devnet';
  const privacyHere = networkCapabilities(networkId).privacy;
  const isWatchOnly = activeWallet?.type === 'watch';
  // A blocked account (key update refused by the node) keeps ops gated even after the overlay is
  // acknowledged, which clears pvacForeign. Encrypt/decrypt must stay disabled on either signal.
  const pvacBlocked = usePvacBlocked();
  const opsGated = pvacForeign || pvacBlocked;
  const openBlockedDetails = () => {
    requestKeySwitchDetails();
    setPvacForeign(true);
  };
  const blockedBtnStyle = {
    width: '100%',
    height: '44px',
    borderRadius: '10px',
    background: 'color-mix(in oklab, var(--color-caution) 12%, var(--bg-2))',
    border: 'none',
    color: 'var(--color-caution)',
    fontSize: '13px',
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    cursor: 'pointer',
  } as const;
  const actionBtnStyle = {
    width: '100%',
    height: '44px',
    borderRadius: '10px',
    background: 'var(--color-accent)',
    border: 'none',
    color: 'var(--accent-fg, #fff)',
    fontSize: '13px',
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    cursor: 'pointer',
  } as const;

  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>(
    searchParams.get('compact') === '1' || searchParams.get('mode') === 'decrypt'
      ? MODE.DECRYPT
      : MODE.ENCRYPT
  );

  const [encryptAmount, setEncryptAmount] = useState('');
  const [isEncrypting, setIsEncrypting] = useState(false);
  const encryptInFlightRef = useRef(false);

  const [decryptAmount, setDecryptAmount] = useState('');
  const [isDecrypting, setIsDecrypting] = useState(false);
  const decryptInFlightRef = useRef(false);
  const [decryptProgress, setDecryptProgress] = useState('');

  const [pvacReady, setPvacReady] = useState(false);
  const [regState, setRegState] = useState<
    'checking' | 'unregistered' | 'pending' | 'registered' | 'failed'
  >('checking');
  const [showRegister, setShowRegister] = useState(false);
  const [setupFee, setSetupFee] = useState<SetupFee>({ state: 'loading' });
  const [regBusy, setRegBusy] = useState(false);
  const [regProgress, setRegProgress] = useState('');
  const [pvacLoading, setPvacLoading] = useState(false);

  const [showReview, setShowReview] = useState(false);
  const [showClaimReview, setShowClaimReview] = useState(false);
  const [claimPick, setClaimPick] = useState<PrivateOutput | null>(null);
  const [customOU, setCustomOU] = useState<string | null>(null);

  const [proofStep, setProofStep] = useState(-1);
  const [compactState, setCompactState] = useState<'checking' | 'needs-compact' | 'ready'>(
    'checking'
  );
  const [compactCheckTick, setCompactCheckTick] = useState(0);
  const compactResolvedRef = useRef<string | null>(null);
  const [held, setHeld] = useState(false);
  const [canMigrate, setCanMigrate] = useState(false);

  // Registration, layer and hold state describe one wallet on one network. A switch resets them
  // (and closes an open review) so nothing read for the previous scope shows or gets confirmed.
  const scopeKey = `${networkId}:${activeWallet?.address ?? ''}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const [viewScope, setViewScope] = useState(scopeKey);
  if (viewScope !== scopeKey) {
    setViewScope(scopeKey);
    setRegState('checking');
    setCompactState('checking');
    setHeld(false);
    setCanMigrate(false);
    setShowReview(false);
    setShowClaimReview(false);
    setClaimPick(null);
    setShowRegister(false);
    setCustomOU(null);
  }

  const migrate = useMigrateBalance({
    activeWallet,
    networkId,
    publicBalance,
    privateBalance,
    showMessage,
    onMigrated: () => {
      setHeld(false);
      setCanMigrate(false);
      setCompactState('ready');
    },
  });

  const opsState = resolvePrivacyOpsState({
    upgrading: migrate.upgrading,
    migrating: migrate.verifying,
    legacy: pvacLegacy,
    heldNoMigration: held && !canMigrate,
    needsMigrate: held || compactState === 'needs-compact',
    checking: compactState === 'checking',
  });
  const opsBlocking = outranksKeyGate(opsState) ? opsState : null;

  const migrateCta = (
    <PrivacyOpsCta state={opsState === 'ready' ? 'migrate' : opsState} onMigrate={migrate.open}>
      <></>
    </PrivacyOpsCta>
  );
  const [proofElapsed, setProofElapsed] = useState(0);
  const proofTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [showOUSheet, setShowOUSheet] = useState(false);
  // Live per-op quotes. A failed read leaves the op without a fee: it is blocked, never guessed.
  const privacyFees = usePrivacyFees(networkId, showReview && mode !== MODE.CLAIM ? mode : null);
  const liveFee = (op: Mode) => privacyFees.fees?.[op] ?? null;
  const feeFor = (op: Mode): string | null => customOU ?? liveFee(op)?.recommended ?? null;
  const feeLoading = privacyFees.fees === null;
  const feeUnreadText = t('privacy.feeUnread', {
    defaultValue: 'Network fee unavailable. Try again.',
  });

  const {
    claimStatus,
    setClaimStatus,
    privateOutputs,
    rewardAmount,
    claimProgress,
    claimingOutputId,
    checkClaimEligibility,
    handleClaim,
    handleClaimSingle,
  } = useClaim({
    activeWallet,
    networkId,
    isDevnet,
    showMessage,
    refreshBalance,
    adjustBalanceOptimistic,
    feeRaw: feeFor(MODE.CLAIM),
    publicBalance,
  });

  const handleClaimWithOverlay = async () => {
    setProofStep(0);
    setProofElapsed(0);
    proofTimerRef.current = setInterval(() => setProofElapsed((e) => e + 1), 1000);
    try {
      await handleClaim();
    } finally {
      if (proofTimerRef.current) {
        clearInterval(proofTimerRef.current);
        proofTimerRef.current = null;
      }
      setProofStep(-1);
    }
  };

  // effect:audited - async PVAC network init; reacts to wallet/pvac state changes
  useEffect(() => {
    let cancelled = false;
    const checkNetwork = async () => {
      if (activeWallet?.privateKey && !pvacLoading) {
        if (pvacManager.isReady && pvacReady && pvacManager.currentKey === activeWallet.privateKey)
          return;
        setPvacLoading(true);
        setPvacReady(false);
        try {
          await pvacManager.initialize(activeWallet.privateKey);
          if (cancelled) return;
          setPvacReady(true);
          setPvacLoading(false);
        } catch (err) {
          logger.error('Failed to initialize PVAC:', err);
          if (!cancelled) {
            setPvacReady(false);
            showMessage(i18n.t('toast.err.engine'), 'error');
          }
        } finally {
          if (!cancelled) setPvacLoading(false);
        }
      }
    };
    checkNetwork();
    return () => {
      cancelled = true;
    };
  }, [activeWallet?.privateKey]);

  // effect:audited - registration is per network: checked once PVAC is ready, and again for each
  // wallet or network the screen moves to (the scope reset above puts regState back to checking).
  useEffect(() => {
    if (!pvacReady || regState !== 'checking' || !activeWallet?.privateKey) return;
    let cancelled = false;
    (async () => {
      try {
        // Check-only (allowRegister defaults to false): does not submit a key_switch.
        const registered = await pvacManager.verifyRegistration(
          activeWallet.address,
          activeWallet.privateKey,
          activeWallet.publicKey,
          privacyNetworkService,
          false,
          networkId
        );
        if (cancelled) return;
        setPvacForeign(pvacManager.pvacForeign);
        if (registered) {
          setRegState('registered');
        } else {
          const pending = await getPendingKeySwitch({ networkId, address: activeWallet.address });
          if (!cancelled) setRegState(pending ? 'pending' : 'unregistered');
        }
        logger.debug('[PrivacyScreen] PVAC registration checked in background');
      } catch (regErr) {
        logger.warn('[PrivacyScreen] Background PVAC registration check failed:', regErr);
        // A failed read is not "registered": the ops stay blocked until a retry answers.
        if (!cancelled) setRegState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pvacReady, regState, networkId, activeWallet?.address, activeWallet?.privateKey]);

  // effect:audited - schedules claim eligibility check via rAF when mode/status changes
  useEffect(() => {
    if (mode === MODE.CLAIM && claimStatus === 'idle') {
      const id = requestAnimationFrame(() => checkClaimEligibility());
      return () => cancelAnimationFrame(id);
    }
  }, [mode, claimStatus]);

  // effect:audited - when the Decrypt tab is open, detect whether the private balance is over-layered
  // (>= 4 base layers) so the button can offer "Compact balance" before allowing a decrypt.
  useEffect(() => {
    // Proactive: runs on EVERY tab (not just Decrypt) so the layer banner warns before an op
    // is attempted - each private op adds two layers and past six the balance is unrecoverable.
    if (!pvacReady || regState !== 'registered') return;
    let cancelled = false;
    if (compactResolvedRef.current !== scopeKey) setCompactState('checking');
    (async () => {
      if (!activeWallet?.privateKey) return;
      try {
        const scope = await captureTxScope(activeWallet.address, networkId);
        const cipher = await privacyNetworkService.fetchCipherOnly(
          activeWallet.address,
          activeWallet.privateKey,
          activeWallet.publicKey || '',
          scope
        );
        if (cancelled) return;
        if (!cipher) {
          setCompactState('ready');
          compactResolvedRef.current = scopeKey;
          return;
        }
        const cipherBytes = pvacManager.getCipherBytes(cipher);
        // Gate on base-layer count only. webcli (main.cpp:2550-2564) also refreshes a non-canonical
        // balance, but the devnet v3 bound-migration can't currently produce a canonical cipher, so
        // blocking on it strands the user in a compact loop.
        const check = await pvacManager.checkBoundProvable(cipherBytes);
        if (cancelled) return;
        const layers = check ? check.baseLayers : await pvacManager.baseLayerCount(cipherBytes);
        logger.debug(`[Compact] base layers = ${layers}`);
        if (!cancelled) {
          const nc = check ? check.provable && !check.canonical : false;
          if (nc && layers < 4 && activeWallet?.address && !canonicalAdvisoryShown.has(scopeKey)) {
            canonicalAdvisoryShown.add(scopeKey);
            showMessage(i18n.t('toast.networkUpgrading'), 'info');
          }
        }
        try {
          const mig = await networkService.getPvacMigrationStatus(activeWallet.address, scope);
          if (!cancelled) {
            const isV3 = mig?.cipher_class === 'v3' || mig?.cipher_class === 'key_bound';
            const stuck = isV3 && layers >= 4 && mig?.can_key_switch === false;
            setHeld(stuck);
            setCanMigrate(stuck && mig?.can_v3_migrate === true);
            setCompactState(layers >= 4 ? 'needs-compact' : 'ready');
            compactResolvedRef.current = scopeKey;
            await migrate.resolvePendingRecord();
          }
        } catch {
          if (!cancelled) {
            setHeld(false);
            setCanMigrate(false);
            setCompactState(layers >= 4 ? 'needs-compact' : 'ready');
            compactResolvedRef.current = scopeKey;
          }
        }
      } catch {
        if (!cancelled) {
          setCompactState('ready');
          compactResolvedRef.current = scopeKey;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    mode,
    pvacReady,
    regState,
    activeWallet?.address,
    activeWallet?.privateKey,
    networkId,
    privateBalance,
    compactCheckTick,
  ]);

  // effect:audited - webcli parity: re-check the upgrade/compact state on a gentle interval while
  // the screen is open, so a change made in another client flips the button without a reopen.
  // Paused while an op is in flight - a mid-op flip would fight the progress UI.
  useEffect(() => {
    if (!pvacReady || regState !== 'registered') return;
    if (isEncrypting || isDecrypting || migrate.verifying) return;
    const id = setInterval(() => {
      if (!document.hidden) setCompactCheckTick((t) => t + 1);
    }, 60_000);
    return () => clearInterval(id);
  }, [pvacReady, regState, isEncrypting, isDecrypting, migrate.verifying]);

  if (!privacyHere) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg)',
        }}
      >
        <Header title="Privacy" showBack={true} showSettings={false} showMenu={false} />
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '14px',
            padding: '32px',
            textAlign: 'center',
          }}
        >
          <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg)', margin: 0 }}>
            {t('privacy.noPrivacyHere', { defaultValue: 'Not available on this network' })}
          </h3>
          <span
            className="flex! max-w-full! items-center! rounded-full! bg-(--bg-1)!"
            style={{ gap: '6px', height: '30px', padding: '0 12px', fontSize: '12px' }}
          >
            <span
              aria-hidden="true"
              className="shrink-0! rounded-full! bg-(--fg-3)!"
              style={{ width: '6px', height: '6px' }}
            />
            <span className="truncate!" style={{ color: 'var(--fg-2)' }}>
              {getNetworkConfig(networkId).name}
            </span>
          </span>
        </div>
        <div
          className="flex! shrink-0!"
          style={{ padding: '12px var(--gutter) 16px', gap: '10px' }}
        >
          <PrimaryButton
            secondary
            onClick={() => navigate('/settings/network', { state: { editNetwork: networkId } })}
            style={{ ...BIG_BUTTON, flex: 1 }}
          >
            {t('privacy.editNetwork', { defaultValue: 'Edit network' })}
          </PrimaryButton>
          <PrimaryButton
            onClick={() => navigate('/settings/network')}
            style={{ ...BIG_BUTTON, flex: 1 }}
          >
            {t('privacy.switchNetwork', { defaultValue: 'Switch network' })}
          </PrimaryButton>
        </div>
      </div>
    );
  }

  if (isWatchOnly) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg)',
        }}
      >
        <Header title="Privacy" showBack={true} showSettings={false} showMenu={false} />
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '32px',
            textAlign: 'center',
            opacity: 0.5,
          }}
        >
          <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg)', margin: 0 }}>
            {t('privacy.viewOnly')}
          </h3>
        </div>
      </div>
    );
  }

  const preOpCheck = async (op: 'encrypt' | 'decrypt', scope: TxScope): Promise<boolean> => {
    if (!activeWallet?.privateKey) return false;
    try {
      const cipher = await privacyNetworkService.fetchCipherOnly(
        activeWallet.address,
        activeWallet.privateKey,
        activeWallet.publicKey || '',
        scope
      );
      if (!cipher) return op === 'encrypt';
      const bytes = pvacManager.getCipherBytes(cipher);
      const check = await pvacManager.checkBoundProvable(bytes);
      const layers = check ? check.baseLayers : await pvacManager.baseLayerCount(bytes);
      if (layers < 4) return true;
      // Over the cap: this op would walk the balance toward unrecoverable. Resolve held fresh
      // so the block message and the button agree.
      let stuck = false;
      let canMig = false;
      try {
        const mig = await networkService.getPvacMigrationStatus(activeWallet.address, scope);
        const isV3 = mig?.cipher_class === 'v3' || mig?.cipher_class === 'key_bound';
        stuck = isV3 && mig?.can_key_switch === false;
        canMig = stuck && mig?.can_v3_migrate === true;
      } catch {}
      setHeld(stuck);
      setCanMigrate(canMig);
      setCompactState('needs-compact');
      compactResolvedRef.current = scopeKey;
      showMessage(t('toast.migrateFirst'), 'error');
      return false;
    } catch {
      return true;
    }
  };

  // The key an op uses must be registered on the op's network. Check-only: an op never submits a
  // key_switch behind its own review; setup has its own review with the fee it signs.
  const ensureRegistered = async (scope: TxScope): Promise<boolean> => {
    if (!activeWallet?.privateKey) return false;
    const registered = await pvacManager.verifyRegistration(
      activeWallet.address,
      activeWallet.privateKey,
      activeWallet.publicKey,
      privacyNetworkService,
      false,
      scope.networkId
    );
    if (pvacManager.pvacForeign) {
      setPvacForeign(true);
      return false;
    }
    if (registered) return true;
    const pending = await getPendingKeySwitch(scope);
    setRegState(pending ? 'pending' : 'unregistered');
    showMessage(
      pending
        ? t('privacy.setupStillConfirming', {
            defaultValue: 'Private balance setup is still confirming. Try again shortly.',
          })
        : t('privacy.setupFirst', { defaultValue: 'Set up your private balance first.' }),
      'info'
    );
    return false;
  };

  const handleEncrypt = async () => {
    if (encryptInFlightRef.current) return;
    if (!activeWallet || !activeWallet.privateKey) {
      showMessage(t('toast.noWallet'), 'error');
      return;
    }
    const amount = parseFloat(encryptAmount);
    if (isNaN(amount) || amount <= 0) {
      showMessage(t('toast.amountInvalid'), 'error');
      return;
    }
    if (amount < 0.001) {
      showMessage(t('privacy.minimumAmount', { min: '0.001' }), 'error');
      return;
    }
    encryptInFlightRef.current = true;
    setIsEncrypting(true);
    setShowReview(false);
    setProofStep(0);
    setProofElapsed(0);
    proofTimerRef.current = setInterval(() => setProofElapsed((e) => e + 1), 1000);
    await passwordManager.suppressAutoLock();
    try {
      const feeRaw = feeFor(MODE.ENCRYPT);
      if (!feeRaw || (customOU == null && !(await privacyFees.fresh(MODE.ENCRYPT)))) {
        throw new PlainError(feeUnreadText);
      }
      const feeNum = Number(feeRaw);
      const currentPublicRaw = Math.round(parseFloat(publicBalance ?? '0') * 1000000);
      const amountRaw = Math.round(amount * 1000000);
      logger.debug(
        `[Encrypt] Starting: amount=${amount} OCT (${amountRaw} raw), fee=${feeRaw}, publicBalance=${publicBalance} (${currentPublicRaw} raw), isDevnet=${isDevnet}, pvacReady=${pvacReady}`
      );
      if (amountRaw > currentPublicRaw) {
        throw new PlainError(t('privacy.insufficientPublic'));
      }
      if (amountRaw + feeNum > currentPublicRaw) {
        throw new PlainError(
          t('privacy.amountFeeNotCovered', {
            defaultValue: 'Insufficient public balance for amount and network fee',
          })
        );
      }
      if (!pvacReady) {
        throw new PlainError(t('toast.engineLoading'));
      }
      // The network and wallet this review was shown for; every step below stays on them.
      const scope = await captureTxScope(activeWallet.address, networkId);
      await assertTxScope(scope);
      if (!(await preOpCheck('encrypt', scope))) return;
      if (!(await ensureRegistered(scope))) return;
      const policy = await proofPolicyFor(activeWallet.address, scope);
      const txId = crypto.randomUUID();
      const { result: response } = await proveThenSubmit({
        prove: async () => {
          setProofStep(1);
          logger.debug('[Encrypt] PVAC encrypting amount...');
          const { cipherBytes } = await pvacManager.encryptRawAsync(amountRaw);
          const cipherStr = 'hfhe_v1|' + bytesToBase64(cipherBytes);
          const blinding = crypto.getRandomValues(new Uint8Array(32));
          const amountCommitment = await pvacManager.pedersenCommitAsync(amountRaw, blinding);
          setProofStep(2);
          logger.debug('[Encrypt] Generating bound proof...');
          const zeroProof = await pvacManager.makeBoundProof(
            cipherBytes,
            amountRaw,
            blinding,
            policy
          );
          const encryptedData = JSON.stringify({
            cipher: cipherStr,
            amount_commitment: amountCommitment,
            zero_proof: zeroProof,
            blinding: bytesToBase64(blinding),
          });
          logger.debug(`[Encrypt] PVAC encrypt done: encryptedData=${encryptedData.length} chars`);
          return encryptedData;
        },
        takeNonce: async () => {
          await assertTxScope(scope);
          await requireProofPolicy(policy, activeWallet.address, scope);
          return networkService.getNextNonce(activeWallet.address, scope);
        },
        releaseNonce: (n) => networkService.releaseNonce(activeWallet.address, n, scope.networkId),
        sign: async (encryptedData, nonce) => {
          setProofStep(3);
          logger.debug(`[Encrypt] nonce=${nonce}, txId=${txId}, building signed HFHE transaction`);
          return privacyNetworkService.buildHfheTransaction({
            from: activeWallet.address,
            to: activeWallet.address,
            amount: amountRaw.toString(),
            amountInOCT: amount,
            nonce,
            privateKey: activeWallet.privateKey,
            publicKey: activeWallet.publicKey,
            opType: 'encrypt',
            encryptedData,
            ou: feeRaw,
          });
        },
        send: (signedTx) => {
          markPrivacyOp();
          logger.debug('[Encrypt] Queuing transaction via background...');
          return chrome.runtime.sendMessage({
            type: 'QUEUE_TRANSACTION',
            transaction: {
              txId,
              opType: 'encrypt',
              type: 'broadcast_only',
              signedTransaction: signedTx,
              from: activeWallet.address,
              to: activeWallet.address,
              amount: amount,
              scope,
            },
          });
        },
        refused: (r) => !r?.success && !!r?.errorType,
      });
      logger.debug('[Encrypt] Queue response:', response);
      if (response.success) {
        // Broadcast OK != executed - confirm the node didn't reject it (e.g. fhe_epoch_cap).
        if (response.txHash) {
          const exec = await networkService.verifyTxExecution(
            response.txHash,
            undefined,
            undefined,
            scope
          );
          if (exec.status === 'rejected') {
            logger.error('[Encrypt] Rejected on-chain:', exec.error);
            showMessage(mapExecError(exec.error), 'error');
            return;
          }
        }
        setEncryptAmount('');
        privacyNetworkService.clearDecryptCache();
        adjustBalanceOptimistic(-(amount + feeNum / 1_000_000), amount);
      } else {
        logger.error('[Encrypt] Queue failed:', response.error);
        showMessage(plainError(response.error, t('toast.encryptFailed')), 'error');
      }
    } catch (error) {
      logger.error('[Encrypt] Error:', error);
      showMessage(plainError(error, t('toast.encryptFailed')), 'error');
    } finally {
      encryptInFlightRef.current = false;
      setIsEncrypting(false);
      if (proofTimerRef.current) {
        clearInterval(proofTimerRef.current);
        proofTimerRef.current = null;
      }
      setProofStep(-1);
      passwordManager.resumeAutoLock();
    }
  };

  // First-time setup: the review shows the live key_switch fee, and the setup signs exactly it.
  const quoteSetupFee = async () => {
    const forScope = scopeKey;
    setSetupFee({ state: 'loading' });
    const raw = await privacyNetworkService.getKeySwitchFeeQuote(
      'recommended',
      await resolveNetworkPin(networkId)
    );
    if (scopeKeyRef.current !== forScope) return;
    setSetupFee(raw ? { state: 'ready', raw, oct: ouToOct(raw) } : { state: 'failed' });
  };

  const openRegister = () => {
    setShowRegister(true);
    void quoteSetupFee();
  };

  const setupFeeShort =
    setupFee.state === 'ready' &&
    Math.round(parseFloat(publicBalance ?? '0') * 1_000_000) < Number(setupFee.raw);

  const handleRegister = async () => {
    if (!activeWallet?.privateKey) return;
    if (setupFee.state !== 'ready' || setupFeeShort) return;
    const { address, privateKey, publicKey } = activeWallet;
    const feeRaw = setupFee.raw;
    setRegBusy(true);
    setRegProgress('Preparing setup');
    await passwordManager.suppressAutoLock();
    try {
      setRegProgress('Submitting key switch');
      try {
        await pvacManager.verifyRegistration(
          address,
          privateKey,
          publicKey,
          privacyNetworkService,
          true,
          networkId,
          feeRaw
        );
        setRegState('registered');
        setShowRegister(false);
        return;
      } catch (err: any) {
        if (err?.name !== 'PvacSetupPending') throw err;
        setRegState('pending');
      }
      setRegProgress('Waiting for confirmation');
      let confirmed = false;
      for (let i = 0; i < 36 && !confirmed; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        setRegProgress(`Waiting for chain confirmation (${i + 1})...`);
        privacyNetworkService.clearPvacPubkeyCache(address);
        confirmed = await pvacManager
          .verifyRegistration(
            address,
            privateKey,
            publicKey,
            privacyNetworkService,
            false,
            networkId
          )
          .catch(() => false);
      }
      if (confirmed) {
        setRegState('registered');
        setShowRegister(false);
      } else {
        setShowRegister(false);
        showMessage(t('privacy.setupStillConfirming'), 'info');
      }
    } catch (err: any) {
      setShowRegister(false);
      showMessage(plainError(err, t('toast.setupFailed')), 'error');
    } finally {
      setRegBusy(false);
      setRegProgress('');
      passwordManager.resumeAutoLock();
    }
  };

  const refreshRegistration = async () => {
    if (!activeWallet?.privateKey) return;
    setRegBusy(true);
    try {
      privacyNetworkService.clearPvacPubkeyCache(activeWallet.address);
      const registered = await pvacManager.verifyRegistration(
        activeWallet.address,
        activeWallet.privateKey,
        activeWallet.publicKey,
        privacyNetworkService,
        false,
        networkId
      );
      if (registered) {
        setRegState('registered');
      } else {
        showMessage(t('privacy.setupStillConfirming'), 'info');
      }
    } catch (err) {
      logger.warn('Setup check failed:', err);
      showMessage(t('toast.setupCheckFailed'), 'error');
    } finally {
      setRegBusy(false);
    }
  };

  const handleDecrypt = async () => {
    if (decryptInFlightRef.current) return;
    if (!activeWallet || !activeWallet.privateKey) {
      showMessage(t('toast.noWallet'), 'error');
      return;
    }
    const amount = parseFloat(decryptAmount);
    if (isNaN(amount) || amount <= 0) {
      showMessage(t('toast.amountInvalid'), 'error');
      return;
    }
    if (amount < 0.001) {
      showMessage(t('privacy.minimumAmount', { min: '0.001' }), 'error');
      return;
    }
    decryptInFlightRef.current = true;
    setIsDecrypting(true);
    setShowReview(false);
    setProofStep(0);
    setProofElapsed(0);
    proofTimerRef.current = setInterval(() => setProofElapsed((e) => e + 1), 1000);
    setDecryptProgress('Verifying registration');
    await passwordManager.suppressAutoLock();
    try {
      if (privateBalance === null) {
        showMessage(t('toast.privateLoading'), 'error');
        return;
      }
      const feeRaw = feeFor(MODE.DECRYPT);
      if (!feeRaw || (customOU == null && !(await privacyFees.fresh(MODE.DECRYPT)))) {
        throw new PlainError(feeUnreadText);
      }
      const feeNum = Number(feeRaw);
      if (Math.round(parseFloat(publicBalance ?? '0') * 1000000) < feeNum) {
        throw new PlainError(
          t('privacy.feeNotCovered', {
            defaultValue: 'Insufficient public balance for network fee',
          })
        );
      }
      const currentEncryptedRaw = Math.round(parseFloat(privateBalance) * 1000000);
      const amountRaw = Math.round(amount * 1000000);
      logger.debug(
        `[Decrypt] Starting: amount=${amount} OCT (${amountRaw} raw), privateBalance=${privateBalance} (${currentEncryptedRaw} raw), isDevnet=${isDevnet}, pvacReady=${pvacReady}`
      );
      if (currentEncryptedRaw < amountRaw) {
        throw new PlainError(t('privacy.insufficientPrivate'));
      }
      if (!pvacReady) {
        throw new PlainError(t('toast.engineLoading'));
      }
      const scope = await captureTxScope(activeWallet.address, networkId);
      await assertTxScope(scope);
      setDecryptProgress('Checking balance state');
      if (!(await preOpCheck('decrypt', scope))) return;
      setDecryptProgress('Verifying registration');
      if (!(await ensureRegistered(scope))) return;
      setDecryptProgress('Verifying on-chain balance');
      logger.debug(
        `[Decrypt] Fetching fresh cipher - addr=${activeWallet.address?.slice(0, 8)}, hasPK=${!!activeWallet.privateKey}, hasPub=${!!activeWallet.publicKey}, pubLen=${activeWallet.publicKey?.length || 0}`
      );
      let freshCipherStr: string | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        freshCipherStr = await privacyNetworkService.fetchCipherOnly(
          activeWallet.address,
          activeWallet.privateKey,
          activeWallet.publicKey || '',
          scope
        );
        if (freshCipherStr) break;
        if (attempt < 4) {
          logger.debug(
            `[Decrypt] No cipher on-chain yet (attempt ${attempt + 1}/5), waiting 3s...`
          );
          setDecryptProgress(`Waiting for encrypt to confirm (${attempt + 1}/5)...`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (!freshCipherStr) {
        throw new PlainError(t('toast.privateNotYet'));
      }
      const actualOnChainBalance = await pvacManager.decryptAsync(freshCipherStr);
      logger.debug(
        `[Decrypt] On-chain cipher decrypted: actual=${actualOnChainBalance}, optimistic=${currentEncryptedRaw}`
      );
      if (actualOnChainBalance < amountRaw) {
        throw new PlainError(t('toast.privateNotConfirmed'));
      }

      const policy = await proofPolicyFor(activeWallet.address, scope);
      const txId = crypto.randomUUID();
      const proofCipher = freshCipherStr;
      const { result: response } = await proveThenSubmit({
        prove: async () => {
          setProofStep(1);
          setDecryptProgress('Preparing Decrypt proof');
          logger.debug('[Decrypt] PVAC preparing Decrypt proof cipher...');
          const { cipherBytes } = await pvacManager.encryptRawAsync(amountRaw);
          const cipherStr = 'hfhe_v1|' + bytesToBase64(cipherBytes);
          const blinding = crypto.getRandomValues(new Uint8Array(32));
          const amountCommitment = await pvacManager.pedersenCommitAsync(amountRaw, blinding);
          setDecryptProgress('Generating bound proof');
          logger.debug('[Decrypt] Generating bound proof...');
          const zeroProofPending = pvacManager.makeBoundProof(
            cipherBytes,
            amountRaw,
            blinding,
            policy
          );
          zeroProofPending.catch(() => {});
          const rpT0 = Date.now();
          setProofStep(2);
          setDecryptProgress('Computing range proof');
          logger.debug(`[Decrypt] [Range Proof] [${rpT0}] Starting range proof phase...`);
          const currentCipherBytes = pvacManager.getCipherBytes(proofCipher);
          const subT0 = Date.now();
          const remainingCipherBytes = await pvacManager.ctSubRawAsync(
            currentCipherBytes,
            cipherBytes
          );
          logger.debug(
            `[Decrypt] [Range Proof] [${Date.now()}] ctSubRawAsync finished in ${Date.now() - subT0}ms`
          );
          const remainingValue = actualOnChainBalance - amountRaw;
          // Key-bound range proof (rp_v1 envelope with the TAG_BOUND_RANGE header); the old
          // per-bit range proof is rejected by the updated chain.
          setDecryptProgress(
            pvacManager.hasDesktopApp
              ? 'Computing range proof via 0xio Desktop'
              : 'Computing range proof (takes a few minutes)'
          );
          const rangeProofBalance = await pvacManager.makeBoundRangeProof(
            remainingCipherBytes,
            remainingValue,
            policy
          );
          const zeroProof = await zeroProofPending;
          logger.debug(
            `[Decrypt] [Range Proof] [${Date.now()}] Core range proof done. Length: ${rangeProofBalance.length} chars. Total RP Phase Time: ${Date.now() - rpT0}ms`
          );
          return JSON.stringify({
            cipher: cipherStr,
            amount_commitment: amountCommitment,
            zero_proof: zeroProof,
            blinding: bytesToBase64(blinding),
            range_proof_balance: rangeProofBalance,
          });
        },
        takeNonce: async () => {
          await assertTxScope(scope);
          await requireProofPolicy(policy, activeWallet.address, scope);
          return networkService.getNextNonce(activeWallet.address, scope);
        },
        releaseNonce: (n) => networkService.releaseNonce(activeWallet.address, n, scope.networkId),
        sign: async (encryptedData, nonce) => {
          setProofStep(3);
          setDecryptProgress('Building transaction');
          logger.debug(`[Decrypt] nonce=${nonce}, txId=${txId}, building signed HFHE transaction`);
          return privacyNetworkService.buildHfheTransaction({
            from: activeWallet.address,
            to: activeWallet.address,
            amount: amountRaw.toString(),
            amountInOCT: amount,
            nonce,
            privateKey: activeWallet.privateKey,
            publicKey: activeWallet.publicKey,
            opType: 'decrypt',
            encryptedData,
            ou: feeRaw,
          });
        },
        send: (signedTx) => {
          markPrivacyOp();
          setDecryptProgress('Submitting');
          logger.debug('[Decrypt] Queuing transaction via background...');
          return chrome.runtime.sendMessage({
            type: 'QUEUE_TRANSACTION',
            transaction: {
              txId,
              opType: 'decrypt',
              type: 'broadcast_only',
              signedTransaction: signedTx,
              from: activeWallet.address,
              to: activeWallet.address,
              amount: amount,
              scope,
            },
          });
        },
        refused: (r) => !r?.success && !!r?.errorType,
      });
      logger.debug('[Decrypt] Queue response:', response);
      if (response.success) {
        // Broadcast OK != executed - confirm the node didn't reject it (e.g. fhe_epoch_cap).
        if (response.txHash) {
          setDecryptProgress('Confirming on chain');
          const exec = await networkService.verifyTxExecution(
            response.txHash,
            undefined,
            undefined,
            scope
          );
          if (exec.status === 'rejected') {
            logger.error('[Decrypt] Rejected on-chain:', exec.error);
            showMessage(mapExecError(exec.error), 'error');
            return;
          }
        }
        setDecryptAmount('');
        privacyNetworkService.clearDecryptCache();
        adjustBalanceOptimistic(amount - feeNum / 1_000_000, -amount);
      } else {
        logger.error('[Decrypt] Queue failed:', response.error);
        showMessage(plainError(response.error, t('toast.decryptFailed')), 'error');
      }
    } catch (error) {
      logger.error('[Decrypt] Error:', error);
      const msg = error?.message || String(error);
      if (msg.includes('unreachable')) {
        showMessage(t('toast.decryptTooDeep'), 'error');
      } else {
        showMessage(plainError(error, t('toast.decryptFailed')), 'error');
      }
    } finally {
      decryptInFlightRef.current = false;
      setIsDecrypting(false);
      setDecryptProgress('');
      if (proofTimerRef.current) {
        clearInterval(proofTimerRef.current);
        proofTimerRef.current = null;
      }
      setProofStep(-1);
      passwordManager.resumeAutoLock();
    }
  };

  const publicBalNum = parseFloat(publicBalance || '0');
  const privateBalNum = privateBalance !== null ? parseFloat(privateBalance) : null;
  const encryptAmtNum = parseFloat(encryptAmount) || 0;
  const decryptAmtNum = parseFloat(decryptAmount) || 0;
  const busy = isEncrypting || isDecrypting;

  const opFeeRaw = mode === MODE.CLAIM ? null : feeFor(mode);
  const opFeeView = privacyFees.view(mode);
  const opQuote = liveFee(mode);
  const feePresets = opQuote
    ? [
        { label: 'Slow', ou: opQuote.minimum, eta: '~30s' },
        { label: 'Normal', ou: opQuote.recommended, eta: '~12s' },
        ...(opQuote.fast ? [{ label: 'Fast', ou: opQuote.fast, eta: '~5s' }] : []),
      ]
    : [];
  const opFeeOct = opFeeRaw ? Number(opFeeRaw) / 1_000_000 : 0;
  const feeUnread = mode !== MODE.CLAIM && !opFeeRaw && !feeLoading;
  const encryptOver = !!encryptAmount && encryptAmtNum + opFeeOct > publicBalNum;
  const feeOver = mode === MODE.DECRYPT && !!opFeeRaw && opFeeOct > publicBalNum;
  const decryptOver = !!decryptAmount && privateBalNum !== null && decryptAmtNum > privateBalNum;
  const isEncryptMode = mode === MODE.ENCRYPT;
  const amountValue = isEncryptMode ? encryptAmount : decryptAmount;
  const amountNum = isEncryptMode ? encryptAmtNum : decryptAmtNum;
  const amountOver = isEncryptMode ? encryptOver : decryptOver;
  const amountUnit = isEncryptMode ? 'OCT' : 'pOCT';
  const availableText = isEncryptMode
    ? `${publicBalance ? parseFloat(publicBalance).toString() : '0'} OCT`
    : `${privateBalance !== null ? parseFloat(privateBalance).toString() : '---'} pOCT`;
  // Encrypt pays its fee from the same public balance: Max waits for the live fee.
  const encryptMax = opFeeRaw ? maxSendable('public', publicBalance, 6, opFeeRaw) : null;
  const maxDisabled = isEncryptMode
    ? encryptMax === null
    : privateBalNum === null || privateBalNum <= 0;
  const receiveText =
    amountValue && !isNaN(amountNum)
      ? `You will receive ${amountNum.toString()} ${isEncryptMode ? 'pOCT' : 'OCT (public)'}`
      : `You will receive 0 ${isEncryptMode ? 'pOCT' : 'OCT (public)'}`;
  const proofSteps = isDecrypting
    ? [
        { id: 'verify', label: 'Verify registration and on-chain balance' },
        { id: 'encrypt', label: 'FHE encrypt and bound proof' },
        { id: 'range', label: 'Range proof' },
        { id: 'submit', label: 'Submitting and confirming' },
      ]
    : claimStatus === 'claiming'
      ? [
          { id: 'init', label: 'Initialize PVAC and verify' },
          {
            id: 'claim',
            label:
              claimProgress ||
              t('privacy.claimingCount', {
                count: 1,
                defaultValue: 'Claiming {{count}} transfer',
              }),
          },
        ]
      : [
          { id: 'verify', label: 'Verify registration' },
          { id: 'encrypt', label: 'FHE encrypt' },
          { id: 'proof', label: 'Bound proof' },
          { id: 'submit', label: 'Submitting and confirming' },
        ];
  const proofStatus = isEncrypting
    ? proofStep === 2
      ? 'Bound proof, the heaviest step.'
      : proofStep === 1
        ? 'FHE encrypting the amount.'
        : ''
    : isDecrypting && (proofStep === 1 || proofStep === 2)
      ? pvacManager.hasDesktopApp
        ? 'Computing the proof via 0xio Desktop. Keep this window open.'
        : proofStep === 2
          ? 'Range proof, a single heavy circuit of about two minutes. Keep this window open.'
          : 'FHE encrypt and bound proof. Keep this window open.'
      : '';

  return (
    <div className="w-full! h-full! flex! flex-col! bg-(--bg)! relative! overflow-hidden!">
      <Header title="Privacy" showBack showSettings={false} showMenu={false} />

      <div
        className="shrink-0! flex! items-center!"
        style={{ padding: '0 var(--gutter) 6px', gap: '14px' }}
      >
        <TextTab active={mode === MODE.ENCRYPT} onClick={() => setMode(MODE.ENCRYPT)}>
          Encrypt
        </TextTab>
        <TextTab active={mode === MODE.DECRYPT} onClick={() => setMode(MODE.DECRYPT)}>
          Decrypt
        </TextTab>
        <TextTab active={mode === MODE.CLAIM} onClick={() => setMode(MODE.CLAIM)}>
          <span className="flex! items-center!" style={{ gap: '5px' }}>
            Claim
            {privateOutputs.length > 0 && (
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 400,
                  color: 'var(--fg-3)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {privateOutputs.length}
              </span>
            )}
          </span>
        </TextTab>
      </div>

      <div
        className="flex-1! overflow-y-auto! scrollbar-hide! min-h-0!"
        style={{ padding: '4px var(--gutter) 16px' }}
      >
        <RuledList>
          {mode !== MODE.CLAIM ? (
            <>
              <ListRow
                label="Public"
                right={
                  <span
                    style={{
                      fontSize: '13px',
                      fontWeight: 600,
                      color: 'var(--fg)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {publicBalance ? parseFloat(publicBalance).toString() : '0'} OCT
                  </span>
                }
                chevron={false}
              />
              <ListRow
                label="Private"
                right={
                  <span
                    style={{
                      fontSize: '13px',
                      fontWeight: 600,
                      color: 'var(--fg)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {privateBalance !== null ? parseFloat(privateBalance).toString() : '---'} pOCT
                  </span>
                }
                chevron={false}
              />
            </>
          ) : (
            <ListRow
              label={`Pending claims${
                claimStatus !== 'checking' && privateOutputs.length > 0
                  ? ` (${privateOutputs.length})`
                  : ''
              }`}
              right={
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--fg)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {claimStatus === 'checking'
                    ? '-'
                    : rewardAmount
                      ? `${parseFloat(rewardAmount).toString()} pOCT`
                      : '-'}
                </span>
              }
              chevron={false}
            />
          )}
        </RuledList>

        {mode !== MODE.CLAIM && (
          <div style={{ marginTop: '16px' }}>
            <div className="flex! items-center! justify-between!" style={{ marginBottom: '6px' }}>
              <FieldLabel>Amount</FieldLabel>
              <div className="flex! items-center!" style={{ gap: '8px' }}>
                <span
                  style={{
                    fontSize: '11px',
                    color: amountOver ? 'var(--neg)' : 'var(--fg-3)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {availableText}
                </span>
                <button
                  onClick={() => {
                    if (isEncryptMode) {
                      if (encryptMax !== null) setEncryptAmount(trimAmount(encryptMax));
                    } else if (privateBalNum !== null && privateBalNum > 0) {
                      setDecryptAmount(String(parseFloat(privateBalNum.toFixed(6))));
                    }
                  }}
                  disabled={maxDisabled}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: maxDisabled ? 'not-allowed' : 'pointer',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: 'var(--accent)',
                    opacity: maxDisabled ? 0.4 : 1,
                  }}
                >
                  {t('send.max')}
                </button>
              </div>
            </div>
            <div
              className={`flex! items-center! rounded-[10px]! bg-(--bg-1)! border! ${
                amountOver ? 'border-(--neg)!' : 'border-transparent!'
              }`}
              style={{ height: '56px', padding: '0 12px' }}
            >
              <input
                type="text"
                inputMode="decimal"
                value={amountValue}
                onChange={(e) => {
                  const v = cleanAmountInput(e.target.value, 6);
                  if (v === null) return;
                  if (isEncryptMode) setEncryptAmount(v);
                  else setDecryptAmount(v);
                }}
                placeholder="0.00"
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  fontSize: '26px',
                  fontWeight: 600,
                  color: 'var(--fg)',
                  letterSpacing: '-0.01em',
                  fontVariantNumeric: 'tabular-nums',
                }}
              />
              <span
                style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg-2)', flexShrink: 0 }}
              >
                {amountUnit}
              </span>
            </div>
            <div
              style={{
                fontSize: '11px',
                color: amountOver ? 'var(--neg)' : 'var(--fg-3)',
                marginTop: '6px',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {amountOver
                ? t('send.insufficientBalance')
                : feeOver
                  ? t('privacy.feeNotCovered', {
                      defaultValue: 'Insufficient public balance for network fee',
                    })
                  : receiveText}
            </div>
            {!isEncryptMode && (
              <p
                style={{
                  fontSize: '11px',
                  color: 'var(--fg-3)',
                  lineHeight: 1.5,
                  margin: '14px 0 0',
                }}
              >
                Decrypting reveals the amount on-chain. Your address stays private.
              </p>
            )}
          </div>
        )}

        {mode === MODE.CLAIM && (
          <div style={{ marginTop: '12px' }}>
            <ClaimSection
              claimStatus={claimStatus}
              rewardAmount={rewardAmount}
              claimProgress={claimProgress}
              claimingOutputId={claimingOutputId}
              privateOutputs={privateOutputs}
              handleClaim={handleClaim}
              onReviewSingle={setClaimPick}
              setClaimStatus={setClaimStatus}
              onRefresh={checkClaimEligibility}
            />
          </div>
        )}
      </div>

      <div
        className="shrink-0! flex! flex-col!"
        style={{ padding: '8px var(--gutter) 16px', gap: '10px' }}
      >
        {mode !== MODE.CLAIM && (
          <button
            onClick={() => {
              if (busy) return;
              if (feeUnread) privacyFees.retry();
              else if (liveFee(mode)) setShowOUSheet(true);
            }}
            disabled={busy || feeLoading}
            className="group! flex! items-center! justify-between! w-full!"
            style={{
              background: 'none',
              border: 'none',
              padding: '4px 0 2px',
              cursor: busy || feeLoading ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.5 : 1,
            }}
          >
            <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
              {t('privacy.networkFee', { defaultValue: 'Network fee' })}
            </span>
            <span
              className="flex! items-center! text-content-secondary! group-hover:text-(--fg)! transition-colors!"
              style={{
                gap: '4px',
                fontSize: '12px',
                fontWeight: 500,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {opFeeRaw ? (
                <>
                  {customOU != null ? (
                    `${ouToOct(opFeeRaw)} OCT`
                  ) : (
                    <FeeValue
                      state={opFeeView.state}
                      text={`${ouToOct(opFeeRaw)} OCT`}
                      ageMs={opFeeView.ageMs}
                    />
                  )}
                  <ChevronDown size={12} />
                </>
              ) : (
                <FeeValue
                  state={
                    opFeeView.state === 'unsupported'
                      ? 'unsupported'
                      : feeUnread
                        ? 'failed'
                        : 'loading'
                  }
                  retry
                />
              )}
            </span>
          </button>
        )}

        {regState === 'checking' && (
          <PrivacyOpsCta state="checking" onMigrate={migrate.open}>
            <></>
          </PrivacyOpsCta>
        )}

        {(mode === MODE.ENCRYPT || mode === MODE.DECRYPT) && regState === 'unregistered' && (
          <button
            onClick={openRegister}
            disabled={pvacLoading || regBusy}
            style={{
              width: '100%',
              height: '44px',
              borderRadius: '10px',
              background: 'var(--color-accent)',
              border: 'none',
              color: 'var(--accent-fg, #fff)',
              fontSize: '13px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              cursor: 'pointer',
              opacity: pvacLoading || regBusy ? 0.4 : 1,
            }}
          >
            Set up private balance
          </button>
        )}

        {(mode === MODE.ENCRYPT || mode === MODE.DECRYPT) && regState === 'pending' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button
              onClick={refreshRegistration}
              disabled={regBusy}
              style={{
                width: '100%',
                height: '44px',
                borderRadius: '10px',
                background: 'var(--bg-2)',
                border: 'none',
                color: 'var(--fg)',
                fontSize: '13px',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                cursor: regBusy ? 'default' : 'pointer',
                opacity: regBusy ? 0.6 : 1,
              }}
            >
              {regBusy ? (
                <>
                  <Mascot mood="loading" size={20} hole="var(--bg-2)" className="text-current!" />
                  Checking…
                </>
              ) : (
                <>Check setup status</>
              )}
            </button>
          </div>
        )}

        {(mode === MODE.ENCRYPT || mode === MODE.DECRYPT) && regState === 'failed' && (
          <button
            onClick={() => setRegState('checking')}
            style={{ ...actionBtnStyle, background: 'var(--bg-2)', color: 'var(--fg)' }}
          >
            {t('privacy.accountStateUnread', {
              defaultValue: 'Account state unavailable. Try again.',
            })}
          </button>
        )}

        {mode === MODE.ENCRYPT &&
          regState === 'registered' &&
          (opsBlocking ? (
            migrateCta
          ) : opsGated ? (
            <button onClick={openBlockedDetails} style={blockedBtnStyle}>
              Encrypt paused
            </button>
          ) : compactState === 'checking' ? (
            <PrivacyOpsCta state="checking" onMigrate={migrate.open}>
              <></>
            </PrivacyOpsCta>
          ) : compactState === 'needs-compact' ? (
            migrateCta
          ) : (
            <button
              onClick={() => setShowReview(true)}
              disabled={isEncrypting || !encryptAmount || encryptOver || !opFeeRaw || pvacLoading}
              style={{
                ...actionBtnStyle,
                opacity: !encryptAmount || encryptOver || !opFeeRaw || pvacLoading ? 0.4 : 1,
              }}
            >
              Review encrypt
            </button>
          ))}

        {mode === MODE.DECRYPT &&
          regState === 'registered' &&
          (opsBlocking ? (
            migrateCta
          ) : opsGated ? (
            <button onClick={openBlockedDetails} style={blockedBtnStyle}>
              Decrypt paused
            </button>
          ) : compactState === 'checking' ? (
            <PrivacyOpsCta state="checking" onMigrate={migrate.open}>
              <></>
            </PrivacyOpsCta>
          ) : compactState === 'needs-compact' ? (
            migrateCta
          ) : (
            <button
              onClick={() => setShowReview(true)}
              disabled={
                isDecrypting ||
                !decryptAmount ||
                privateBalance === null ||
                decryptAmtNum > (privateBalNum ?? 0) ||
                !opFeeRaw ||
                feeOver ||
                pvacLoading
              }
              style={{
                ...actionBtnStyle,
                opacity:
                  !decryptAmount ||
                  privateBalance === null ||
                  decryptAmtNum > (privateBalNum ?? 0) ||
                  !opFeeRaw ||
                  feeOver ||
                  pvacLoading
                    ? 0.4
                    : 1,
              }}
            >
              Review decrypt
            </button>
          ))}

        {mode === MODE.CLAIM && regState === 'registered' && opsState !== 'ready' && migrateCta}
        {mode === MODE.CLAIM &&
          regState !== 'checking' &&
          !(regState === 'registered' && opsState !== 'ready') && (
            <ClaimBottomBar
              claimStatus={claimStatus}
              claimingOutputId={claimingOutputId}
              privateOutputs={privateOutputs}
              setClaimStatus={setClaimStatus}
              onRefresh={checkClaimEligibility}
              onReviewClaim={() => setShowClaimReview(true)}
            />
          )}
      </div>

      <PrivacyReview
        isOpen={showReview}
        onClose={() => setShowReview(false)}
        type={mode === MODE.ENCRYPT ? 'encrypt' : 'decrypt'}
        amount={mode === MODE.ENCRYPT ? encryptAmount : decryptAmount}
        fromBalance={mode === MODE.ENCRYPT ? publicBalance || '0' : privateBalance || '0'}
        toBalance={mode === MODE.ENCRYPT ? privateBalance || '0' : publicBalance || '0'}
        networkId={networkId}
        fee={opFeeRaw ? ouToOct(opFeeRaw) : '-'}
        isBusy={busy}
        progressLabel={isDecrypting ? decryptProgress : undefined}
        onConfirm={() => {
          if (mode === MODE.ENCRYPT) handleEncrypt();
          else handleDecrypt();
        }}
      />

      <SetupPrivateBalanceModal
        show={showRegister}
        onClose={() => setShowRegister(false)}
        onSubmit={handleRegister}
        submitting={regBusy}
        progress={regProgress}
        fee={setupFee}
        feeShort={setupFeeShort}
        publicOct={publicBalance ?? ''}
        onRetryFee={() => void quoteSetupFee()}
      />

      <MigrateBalanceModal
        show={migrate.showPopup}
        onClose={migrate.closePopup}
        onSubmit={migrate.submit}
        submitting={migrate.verifying}
        progress={migrate.progress}
        encryptedOct={privateBalance ?? ''}
        feeOct={migrate.feeOct}
        publicOct={publicBalance ?? ''}
        feeShort={migrate.feeShort}
        feeFailed={migrate.feeFailed}
        onRetryFee={() => void migrate.retryFee()}
        reusingPayload={migrate.reusing}
      />

      <ClaimReview
        isOpen={showClaimReview || claimPick !== null}
        onClose={() => {
          setShowClaimReview(false);
          setClaimPick(null);
        }}
        privateOutputs={claimPick ? [claimPick] : privateOutputs.slice(0, 1)}
        networkId={networkId}
        fee={feeFor(MODE.CLAIM) ? ouToOct(feeFor(MODE.CLAIM) as string) : null}
        feeLoading={feeLoading}
        isBusy={claimStatus === 'claiming' || claimingOutputId !== null}
        progressLabel={claimProgress}
        onConfirm={() => {
          const pick = claimPick;
          setShowClaimReview(false);
          setClaimPick(null);
          if (pick) void handleClaimSingle(pick);
          else handleClaimWithOverlay();
        }}
      />

      {proofStep >= 0 && (
        <div className="absolute! inset-0! z-blocking! bg-surface-overlay! backdrop-blur-sm! flex! flex-col! items-center! justify-center! px-6!">
          <div
            className="w-full! max-w-sm! bg-(--bg)! rounded-2xl!"
            style={{ padding: '18px 18px 16px' }}
          >
            <div className="flex! justify-center!" style={{ marginBottom: '12px' }}>
              <Mascot mood={isDecrypting ? 'decrypt' : 'encrypt'} size={64} />
            </div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
              {isEncrypting
                ? 'Encrypting balance'
                : claimStatus === 'claiming'
                  ? 'Claiming transfers'
                  : 'Generating privacy proofs'}
            </div>
            <div
              style={{
                fontSize: '11px',
                color: 'var(--fg-3)',
                marginTop: '2px',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {proofElapsed > 0
                ? `${Math.floor(proofElapsed / 60)}:${String(proofElapsed % 60).padStart(2, '0')} elapsed`
                : 'Starting'}
            </div>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '14px' }}
            >
              {proofSteps.map((step, i) => {
                const isDone = i < proofStep;
                const isActive = i === proofStep;
                return (
                  <div key={step.id} className="flex! items-center!" style={{ gap: '10px' }}>
                    {isActive ? (
                      <Mascot mood="loading" size={12} className="text-(--accent)!" />
                    ) : (
                      <span
                        style={{
                          width: '6px',
                          height: '6px',
                          borderRadius: '999px',
                          background: isDone ? 'var(--pos)' : 'var(--line-2)',
                          margin: '0 3px',
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span
                      style={{
                        fontSize: '12px',
                        color: isDone ? 'var(--fg-2)' : isActive ? 'var(--fg)' : 'var(--fg-3)',
                      }}
                    >
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>
            <p
              style={{ fontSize: '11px', color: 'var(--fg-3)', marginTop: '14px', lineHeight: 1.4 }}
            >
              {proofStatus || 'Keep this window open.'}
            </p>
          </div>
        </div>
      )}

      <FeeSheet
        open={showOUSheet}
        value={opFeeRaw ?? ''}
        presets={feePresets}
        defaultOu={liveFee(mode)?.recommended}
        minOu={liveFee(mode)?.minimum}
        onSave={setCustomOU}
        onClose={() => setShowOUSheet(false)}
      />
    </div>
  );
};

export default PrivacyScreen;
