import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import FeeValue from 'src/shared/ui/FeeValue';
import { useWallet } from 'src/contexts/WalletContext';
import { Mascot } from 'src/shared/ui/Mascot';
import { networkService, privacyNetworkService } from 'src/services/network/NetworkService';
import { pvacManager } from 'src/services/pvac/PvacManager';
import { base64ToBytes, bytesToBase64, bytesToHex } from 'src/lib/encoding';
import { logger } from 'src/utils/logger';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import {
  ACCOUNT_STATE_UNREAD,
  recordPendingKeySwitch,
  resolveKeySwitchMode,
  type KeySwitchMode,
} from 'src/services/pvac/keySwitchService';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import {
  assertTxScope,
  captureTxScope,
  resolveNetworkPin,
  type NetworkPin,
} from 'src/services/network/txScope';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { proveThenSubmit } from 'src/hooks/privacy/proveThenSubmit';

const fmtOct = (micro: number) => `${parseFloat((micro / 1_000_000).toFixed(6))} OCT`;

import { blockedAckKey } from 'src/services/pvac/keySwitchService';
import { proofPolicyFor, requireProofPolicy } from 'src/services/pvac/proofPolicy';
export { blockedAckKey };

let manualOpenRequested = false;
export const requestKeySwitchDetails = () => {
  manualOpenRequested = true;
};

const KeySwitchOverlay = () => {
  const { t } = useTranslation();
  const {
    pvacForeign,
    setPvacForeign,
    activeWallet,
    showMessage,
    refreshBalance,
    networkId,
    balance,
  } = useWallet();
  const [isKeySwitching, setIsKeySwitching] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<KeySwitchMode | null>(null);
  const [feeRaw, setFeeRaw] = useState<string | null>(null);
  const [pin, setPin] = useState<NetworkPin | null>(null);
  const [manualOpen] = useState(() => {
    const m = manualOpenRequested;
    manualOpenRequested = false;
    return m;
  });
  const [ack, setAck] = useState<string | null | undefined>(undefined);

  useMountEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeWallet?.address || !activeWallet.privateKey) return;
      const ackKey = blockedAckKey(networkId ?? '', activeWallet.address);
      let stored: string | null = null;
      try {
        const r = await chrome.storage.local.get(ackKey);
        stored = typeof r[ackKey] === 'string' ? (r[ackKey] as string) : null;
      } catch {}
      if (cancelled) return;
      setAck(stored);
      try {
        const at = await resolveNetworkPin(networkId);
        if (cancelled) return;
        setPin(at);
        const m = await resolveKeySwitchMode(
          activeWallet.address,
          activeWallet.privateKey,
          activeWallet.publicKey ?? undefined,
          at
        );
        if (cancelled) return;
        const unactionable = m.mode === 'blocked' || m.mode === 'key_bound_unavailable';
        if (unactionable && stored != null && !manualOpen) {
          logger.debug('[KeySwitch] unactionable state already acknowledged - staying quiet');
          pvacManager.pvacForeign = false;
          setPvacForeign(false);
          return;
        }
        if (stored != null && !unactionable) {
          chrome.storage.local.remove(ackKey);
          setAck(null);
        }
        setMode(m);
        if (m.mode !== 'blocked' && m.mode !== 'key_bound_unavailable') {
          const quote = await privacyNetworkService.getKeySwitchFeeQuote('recommended', at);
          if (!cancelled) setFeeRaw(quote ?? '');
        }
      } catch (e: any) {
        logger.warn(`[KeySwitch] mode resolution failed: ${e.message}`);
        // Never fall back to offering a rotation we could not vet - webcli refuses to
        // submit when upgrade_status cannot be read (can_submit=false).
        if (!cancelled) {
          setMode({
            mode: 'blocked',
            reason: `could not determine what a key update would do (${e.message}); retry later`,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  if (!pvacForeign) return null;
  if (ack === undefined || (mode == null && !manualOpen)) return null;

  const blocked = mode?.mode === 'blocked';
  const migrationUnavailable = mode?.mode === 'key_bound_unavailable';
  const keyCurrent = mode?.mode === 'key_bound_unavailable' && mode.keyCurrent;
  const migrating = mode?.mode === 'legacy_public_migration' || mode?.mode === 'legacy_zero_reset';
  const migrationAmount = mode?.mode === 'legacy_public_migration' ? mode.amount : 0;
  const canAct = mode != null && !blocked && !migrationUnavailable;
  const publicRaw = Math.round((parseFloat(balance ?? '0') || 0) * 1_000_000);
  const feeUnread = feeRaw === '';
  const feeShort = !!feeRaw && publicRaw < Number(feeRaw);
  const canSubmit = canAct && !!feeRaw && !feeShort;

  const retryFee = async () => {
    if (!pin) return;
    setFeeRaw(null);
    setFeeRaw((await privacyNetworkService.getKeySwitchFeeQuote('recommended', pin)) ?? '');
  };

  const handleDismiss = async () => {
    if (isKeySwitching) return;
    logger.debug('[KeySwitch] User dismissed overlay - clearing corruption cache');
    pvacManager.pvacForeign = false;
    setPvacForeign(false);
    try {
      if (networkId && activeWallet?.address) {
        await chrome.storage.local.remove(`pvac_corrupted_${networkId}_${activeWallet.address}`);
      }
    } catch {}
    refreshBalance(undefined, undefined, true);
  };

  /** webcli build_pvac_migration_payload, legacy public branch: re-encrypt under the new key
   *  with a fresh blinding, prove it, reveal the blinding for the node's replay check. */
  const buildLegacyMigration = async (
    amount: number,
    policy: number
  ): Promise<Record<string, unknown>> => {
    const blindingBytes = crypto.getRandomValues(new Uint8Array(32));
    const enc = await pvacManager.encrypt(
      amount,
      bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
      Math.floor(Date.now() / 1000),
      'migration'
    );
    const cipherBytes = pvacManager.getCipherBytes(enc.cipher);
    const commitment = pvacManager.pedersenCommit(amount, blindingBytes);
    const newZp = await pvacManager.makeBoundProof(cipherBytes, amount, blindingBytes, policy);
    const payload: Record<string, unknown> = {
      new_cipher: enc.cipher,
      new_zero_proof: newZp,
      amount_commitment: commitment,
      amount_blinding: bytesToBase64(blindingBytes),
    };
    if (amount === 0) payload.legacy_zero_reset = true;
    else payload.legacy_public_migration = true;
    return payload;
  };

  const handleKeySwitch = async () => {
    if (!activeWallet?.privateKey) {
      showMessage(t('toast.noWallet'), 'error');
      return;
    }
    if (!feeRaw || feeShort) return;
    const ou = feeRaw;

    const t0 = Date.now();
    setIsKeySwitching(true);
    setError(null);
    await passwordManager.suppressAutoLock();
    try {
      // The key being replaced is this network's: the switch must land there or nowhere.
      const scope = await captureTxScope(activeWallet.address, networkId);
      await assertTxScope(scope);
      if (pin && (pin.networkId !== scope.networkId || pin.rpcUrl !== scope.rpcUrl)) {
        throw new Error(ACCOUNT_STATE_UNREAD);
      }
      if (!pvacManager.isReady) {
        await pvacManager.initialize(activeWallet.privateKey);
      }

      const pubB64 = await pvacManager.getPublicKeyAsync();
      const rawPubBytes = base64ToBytes(pubB64);
      const hashBuf = await crypto.subtle.digest('SHA-256', rawPubBytes.buffer as ArrayBuffer);
      const pubkeyHashPrefix = bytesToHex(new Uint8Array(hashBuf).slice(0, 8));
      const aesKat = await pvacManager.computeAesKat();
      const policy = await proofPolicyFor(scope.address, scope);

      let migration: Record<string, unknown> | undefined;
      if (mode?.mode === 'legacy_public_migration') {
        logger.debug(`[KeySwitch] building legacy_public_migration for ${mode.amount}...`);
        migration = await buildLegacyMigration(mode.amount, policy);
      } else if (mode?.mode === 'legacy_zero_reset') {
        migration = await buildLegacyMigration(0, policy);
      }

      const txId = crypto.randomUUID();
      const { result: response } = await proveThenSubmit({
        prove: async () => migration,
        takeNonce: async () => {
          await assertTxScope(scope);
          await requireProofPolicy(policy, scope.address, scope);
          return networkService.getNextNonce(scope.address, scope);
        },
        releaseNonce: (n) => networkService.releaseNonce(scope.address, n, scope.networkId),
        sign: (payload, nonce) =>
          privacyNetworkService.buildKeySwitchTransaction({
            from: scope.address,
            nonce,
            privateKey: activeWallet.privateKey,
            publicKey: activeWallet.publicKey ?? undefined,
            newPubkeyB64: pubB64,
            aesKat,
            pubkeyHashPrefix,
            migration: payload,
            policy,
            ou,
            at: scope,
          }),
        send: (signedTx) =>
          chrome.runtime.sendMessage({
            type: 'QUEUE_TRANSACTION',
            transaction: {
              txId,
              opType: 'key_switch',
              type: 'broadcast_only',
              signedTransaction: signedTx,
              from: scope.address,
              to: scope.address,
              amount: 0,
              scope,
            },
          }),
        refused: (r) => !r?.success && !!r?.errorType,
      });

      if (response.success) {
        // octra_transaction looks the rotation up by its on-chain hash, never the queue handle.
        const txHash: string = response.txHash || txId;
        logger.debug(`[KeySwitch] SUCCESS - tx=${txHash}, total=${Date.now() - t0}ms`);
        pvacManager.clearRegistrationCache();
        pvacManager.lastDecryptCorrupted = false;
        setPvacForeign(false);
        await recordPendingKeySwitch(scope, txHash);
        try {
          chrome.storage.local.remove(`pvac_corrupted_${scope.networkId}_${scope.address}`);
        } catch {}
        setTimeout(() => refreshBalance(undefined, undefined, true), 8000);
      } else {
        logger.error(`[KeySwitch] Queue FAILED: ${response.error}`);
        setError(response.error || t('privacy.keySwitchFailed'));
      }
    } catch (err: any) {
      logger.error(`[KeySwitch] Error after ${Date.now() - t0}ms:`, err);
      setError(err.message ?? String(err));
    } finally {
      setIsKeySwitching(false);
      passwordManager.resumeAutoLock();
    }
  };

  return (
    <div className="fixed inset-0 z-critical flex items-center justify-center bg-surface-overlay backdrop-blur-sm animate-in fade-in duration-200 p-4">
      <div className="w-full max-w-90 bg-surface-card border border-edge rounded-2xl p-5 shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex flex-col gap-4">
          <div>
            <h3
              className={`text-[15px] font-bold ${blocked || migrationUnavailable ? 'text-caution' : 'text-content'}`}
            >
              {keyCurrent
                ? t('privacy.keySwitchBalanceHoldTitle', {
                    defaultValue: 'Private balance awaiting migration',
                  })
                : blocked || migrationUnavailable
                  ? t('privacy.keySwitchOnHoldTitle', {
                      defaultValue: 'Encryption key update on hold',
                    })
                  : t('privacy.keySwitchTitle', { defaultValue: 'Encryption key update required' })}
            </h3>
            <p className="text-[11px] text-content-muted leading-relaxed mt-1.5">
              {keyCurrent
                ? t('privacy.keySwitchBalanceHoldBody', {
                    defaultValue:
                      "Your encryption key is fine. This account's private balance was sealed under the network's previous scheme and waits for a network migration.",
                  })
                : blocked || migrationUnavailable
                  ? t('privacy.keySwitchOnHoldBody', {
                      defaultValue:
                        'The network moved to a new encryption scheme, but this account cannot be updated yet.',
                    })
                  : t('privacy.keySwitchBody', {
                      defaultValue:
                        'The network upgraded its encryption scheme. Your key must be re-registered before you can encrypt or decrypt.',
                    })}
            </p>
          </div>

          {activeWallet?.address && (
            <span className="self-start inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface-highlight text-[10px] font-mono text-content-muted">
              <WalletAvatar address={activeWallet.address} size={14} />
              {activeWallet.address.slice(0, 10)}…{activeWallet.address.slice(-6)}
            </span>
          )}

          {mode == null && (
            <div className="flex items-center gap-2 text-[11px] text-content-muted">
              <Mascot mood="loading" size={14} hole="var(--bg-1)" className="text-current!" />
              {t('privacy.keySwitchChecking', {
                defaultValue: 'Checking update requirements',
              })}
            </div>
          )}

          {blocked && mode?.mode === 'blocked' && (
            <div className="w-full p-3 rounded-xl bg-caution/8 border border-caution/25 text-left">
              <p className="text-[11px] font-bold text-caution mb-1">
                {t('privacy.keySwitchBlockedTitle', {
                  defaultValue: 'Key update unavailable',
                })}
              </p>
              <p className="text-[10px] text-caution/80 leading-relaxed">{mode.reason}</p>
              <p className="text-[10px] text-content-muted leading-relaxed mt-1.5">
                {t('privacy.keySwitchBlockedBody', {
                  defaultValue:
                    'Your balances remain readable and nothing is lost. Check back later.',
                })}
              </p>
            </div>
          )}

          {migrationUnavailable && mode?.mode === 'key_bound_unavailable' && (
            <div className="w-full p-3 rounded-xl bg-caution/8 border border-caution/25 text-left">
              <p className="text-[11px] font-bold text-caution mb-1">
                {keyCurrent
                  ? t('privacy.keySwitchWaitNetworkTitle', {
                      defaultValue: 'Waiting for the network',
                    })
                  : t('privacy.keySwitchUnavailableTitle', {
                      defaultValue: 'Not supported yet',
                    })}
              </p>
              <p className="text-[10px] text-content-muted leading-relaxed">
                {keyCurrent
                  ? t('privacy.keySwitchWaitNetworkBody', {
                      defaultValue:
                        'Your key is registered and current. The private balance needs a key-bound migration (equality proofs) that the network has not opened to wallets yet, and the node refuses key updates for this account until then. Your public balance is unaffected and nothing is lost.',
                    })
                  : t('privacy.keySwitchUnavailableBody', {
                      defaultValue:
                        "This account's private balance is locked to the network's previous encryption scheme and needs a key-bound migration to move to the new one. 0xio does not support that migration yet, including 0xio Desktop. It is planned for a future update. Your public balance is unaffected and nothing is lost.",
                    })}
              </p>
            </div>
          )}

          {migrating && (
            <div className="w-full p-3 rounded-xl bg-accent/8 border border-accent/25 text-left">
              <p className="text-[11px] font-bold text-accent mb-1">
                {t('privacy.keySwitchMigrateTitle', {
                  defaultValue: 'Private balance is migrated',
                })}
              </p>
              <p className="text-[10px] text-content-muted leading-relaxed">
                {mode?.mode === 'legacy_public_migration'
                  ? t('privacy.keySwitchMigrateBody', {
                      defaultValue:
                        'Your private balance of {{amount}} is re-encrypted under the new key inside the same transaction. Nothing is lost.',
                      amount: fmtOct(migrationAmount),
                    })
                  : t('privacy.keySwitchZeroResetBody', {
                      defaultValue:
                        'The network verified this balance is zero; the update simply re-registers your key.',
                    })}
              </p>
            </div>
          )}

          {canAct && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-content-muted">
                  {t('privacy.networkFee', { defaultValue: 'Network fee' })}
                </span>
                <span className="font-semibold text-content tabular-nums">
                  {feeRaw ? (
                    fmtOct(Number(feeRaw))
                  ) : (
                    <FeeValue state={feeUnread ? 'failed' : 'loading'} />
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-content-muted">
                  {t('privacy.publicBalance', { defaultValue: 'Public balance' })}
                </span>
                <span className="font-semibold text-content tabular-nums">{fmtOct(publicRaw)}</span>
              </div>
              {(feeUnread || feeShort) && (
                <p className="text-[10px] text-danger leading-relaxed">
                  {feeUnread
                    ? t('privacy.feeUnread', {
                        defaultValue: 'Network fee unavailable. Try again.',
                      })
                    : t('privacy.feeNotCovered', {
                        defaultValue: 'Insufficient public balance for network fee',
                      })}
                </p>
              )}
            </div>
          )}

          {canAct && (
            <label className="flex items-start gap-2 w-full text-left cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 accent-caution cursor-pointer"
                disabled={isKeySwitching}
              />
              <span className="text-[10px] text-content-muted leading-relaxed">
                {migrating && mode?.mode === 'legacy_public_migration'
                  ? t('privacy.keySwitchConfirmMigrate', {
                      defaultValue:
                        'I understand my key will be re-registered and my private balance migrated in one transaction.',
                    })
                  : t('privacy.keySwitchConfirmSimple', {
                      defaultValue:
                        'I understand my encryption key will be re-registered on-chain.',
                    })}
              </span>
            </label>
          )}

          {canAct && feeUnread && !isKeySwitching && (
            <button
              onClick={retryFee}
              className="w-full h-11 rounded-xl text-xs font-bold bg-surface-highlight text-content cursor-pointer"
            >
              {t('privacy.tryAgain', { defaultValue: 'Try again' })}
            </button>
          )}

          {canAct && !(feeUnread && !isKeySwitching) && (
            <button
              onClick={handleKeySwitch}
              disabled={isKeySwitching || !confirmed || !canSubmit}
              className={`w-full h-11 rounded-xl text-xs font-bold transition-all ${
                isKeySwitching
                  ? 'bg-accent text-accent-fg cursor-wait'
                  : !confirmed || !canSubmit
                    ? 'bg-asset-private-border text-accent/60 cursor-not-allowed'
                    : 'bg-accent text-accent-fg hover:brightness-110 cursor-pointer'
              }`}
            >
              {isKeySwitching ? (
                <span className="flex items-center justify-center gap-2">
                  <Mascot
                    mood="encrypt"
                    size={20}
                    hole="var(--color-accent)"
                    className="text-current!"
                  />
                  {mode?.mode === 'legacy_public_migration'
                    ? t('privacy.keySwitchMigrating', {
                        defaultValue: 'Migrating and updating key',
                      })
                    : t('privacy.keySwitchInProgress')}
                </span>
              ) : mode?.mode === 'legacy_public_migration' ? (
                t('privacy.keySwitchMigrateAction', {
                  defaultValue: 'Migrate balance and update key',
                })
              ) : (
                t('privacy.keySwitchAction', { defaultValue: 'Update encryption key' })
              )}
            </button>
          )}

          <button
            onClick={async () => {
              if ((blocked || migrationUnavailable) && activeWallet?.address) {
                const ackVal =
                  mode?.mode === 'blocked'
                    ? mode.reason
                    : 'key-bound migration not available in-app';
                try {
                  await chrome.storage.local.set({
                    [blockedAckKey(networkId ?? '', activeWallet.address)]: ackVal,
                  });
                } catch {}
              }
              handleDismiss();
            }}
            disabled={isKeySwitching}
            className="w-full h-9 rounded-xl text-[10px] font-bold text-content-muted hover:text-content transition-colors cursor-pointer"
          >
            {blocked || migrationUnavailable
              ? t('common.close', { defaultValue: 'Close' })
              : t('privacy.keySwitchLater', { defaultValue: 'Not now' })}
          </button>

          {error && (
            <div className="w-full p-3 rounded-xl bg-danger/8 border border-danger/25 text-left">
              <p className="text-[11px] font-bold text-danger mb-1">
                {t('privacy.keySwitchFailed')}
              </p>
              <p className="text-[10px] text-danger/80 leading-relaxed break-all">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default KeySwitchOverlay;
