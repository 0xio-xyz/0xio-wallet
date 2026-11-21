import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'src/i18n/react';
import { networkService, privacyNetworkService } from 'src/services/network/NetworkService';
import { pvacManager } from 'src/services/pvac/PvacManager';
import { bytesToBase64 } from 'src/services/crypto/PrivateCrypto';
import { freshStealthOutput, scanWaiting } from 'src/services/privacy/stealthWaiting';
import {
  dropFromScope,
  scopeKey as scanScopeKey,
  type MatchedStealthOutput,
} from 'src/services/privacy/stealthScan';
import {
  seedClaimBudget,
  seedClaimBudgetEmpty,
  remainingClaims,
  consumeClaimSlot,
  refundClaimSlot,
  plausibleLayers,
} from 'src/services/privacy/claimBudget';
import {
  assertTxScope,
  captureTxScope,
  resolveNetworkPin,
  type TxScope,
} from 'src/services/network/txScope';
import { logger } from 'src/utils/logger';
import { plainError, PlainError } from 'src/utils/plainError';
import type { NetworkId } from 'src/utils/config';
import { proveThenSubmit } from './proveThenSubmit';
import { proofPolicyFor, requireProofPolicy } from 'src/services/pvac/proofPolicy';
import {
  claimResendFor,
  claimSlotFor,
  readClaimOutput,
  sendClaim,
  type ClaimRow,
} from 'src/services/privacy/claimLedger';
import type { SignedTransaction } from 'src/types/transaction';
import type { Wallet } from 'src/types/wallet';

// Each claim tx adds TWO base layers to the balance cipher; past 6 layers even the compact
// (key-switch proof) is unprovable and the balance is unrecoverable. The budget is an
// in-flight COUNTER (claimBudget.ts) seeded from executed node state and decremented per
// broadcast - a fresh read during a burst sees stale pre-execution state and cannot be
// trusted on its own.
async function safeClaimBudget(
  wallet: Wallet,
  scope: TxScope
): Promise<{ budget: number | null; heldBlocked: boolean }> {
  const net = scope.networkId;
  try {
    // Read on the claim's own network: seeding one network's budget from the other's cipher
    // would corrupt it.
    const cipher = await privacyNetworkService.fetchCipherOnly(
      wallet.address,
      wallet.privateKey,
      wallet.publicKey || '',
      scope
    );
    if (!cipher) {
      // RPC succeeded, no cipher yet: a first-time claimer. True cap for B=0 is three claims.
      await seedClaimBudgetEmpty(wallet.address, net);
      return { budget: await remainingClaims(wallet.address, net), heldBlocked: false };
    }
    const bytes = pvacManager.getCipherBytes(cipher);
    const check = await pvacManager.checkBoundProvable(bytes);
    const layers = check ? check.baseLayers : await pvacManager.baseLayerCount(bytes);
    if (!plausibleLayers(layers)) return { budget: 0, heldBlocked: false }; // nonsense: fail CLOSED
    // Fresh held gate (webcli re-checks before every op): at >= 4 layers a claim walks the
    // balance toward the unrecoverable cap while the node refuses the compact that could fold
    // it back - block instead of offering a compact the node would reject.
    if (layers >= 4) {
      try {
        const mig = await networkService.getPvacMigrationStatus(wallet.address, scope);
        const isV3 = mig?.cipher_class === 'v3' || mig?.cipher_class === 'key_bound';
        if (isV3 && mig?.can_key_switch === false) return { budget: 0, heldBlocked: true };
      } catch {}
    }
    await seedClaimBudget(wallet.address, cipher, layers, net);
    return { budget: await remainingClaims(wallet.address, net), heldBlocked: false };
  } catch {
    return { budget: null, heldBlocked: false }; // transport failure only: single-claim fail-open
  }
}

export type PrivateOutput = MatchedStealthOutput;

const RESCAN_MS = 30_000;

export const useClaim = (params: {
  activeWallet: Wallet | null;
  networkId: NetworkId;
  isDevnet: boolean;
  showMessage: (msg: string, type: string) => void;
  refreshBalance: (address?: string, walletObj?: unknown, force?: boolean) => void;
  adjustBalanceOptimistic: (pubDeltaOCT: number, privDeltaOCT: number) => void;
  feeRaw?: string | null;
  publicBalance?: string | null;
}) => {
  const {
    activeWallet,
    networkId,
    showMessage,
    refreshBalance,
    adjustBalanceOptimistic,
    feeRaw = null,
    publicBalance = null,
  } = params;
  const { t } = useTranslation();

  const [claimStatus, setClaimStatus] = useState('idle');
  const [rewardAmount, setRewardAmount] = useState<string>('0');
  const [privateOutputs, setPrivateOutputs] = useState<PrivateOutput[]>([]);
  const [claimProgress, setClaimProgress] = useState('');
  const [claimingOutputId, setClaimingOutputId] = useState<number | string | null>(null);

  const scopeKey = activeWallet?.address ? `${networkId}:${activeWallet.address}` : '';
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const scanGenRef = useRef(0);
  const [stateKey, setStateKey] = useState(scopeKey);
  if (stateKey !== scopeKey) {
    setStateKey(scopeKey);
    setClaimStatus('idle');
    setPrivateOutputs([]);
    setRewardAmount('0');
    setClaimProgress('');
  }
  const busyRef = useRef(false);
  busyRef.current = claimStatus === 'claiming' || claimingOutputId !== null;

  const runScan = useCallback(
    async (quiet: boolean) => {
      if (!activeWallet || !activeWallet.privateKey) return;
      const key = `${networkId}:${activeWallet.address}`;
      const gen = ++scanGenRef.current;
      const live = () => scanGenRef.current === gen && scopeKeyRef.current === key;
      const privateKey = activeWallet.privateKey;
      if (!quiet) {
        setClaimStatus('checking');
        setClaimProgress(t('claim.fetchingOutputs', { defaultValue: 'Fetching outputs' }));
      }
      try {
        const t0 = Date.now();
        const mine = await scanWaiting({
          address: activeWallet.address,
          privateKey,
          pin: await resolveNetworkPin(networkId),
          stillHere: live,
          prepare: () => pvacManager.initialize(privateKey),
        });
        if (!live() || mine === null) {
          logger.debug('[CheckClaim] wallet or network changed during the scan - result dropped');
          return;
        }
        const outputs = [...mine].sort((x, y) => x.id - y.id);
        logger.debug(`[CheckClaim] ${outputs.length} claimable in ${Date.now() - t0}ms`);
        if (quiet && busyRef.current) return;
        setClaimProgress('');
        setPrivateOutputs(outputs);
        const totalRaw = outputs.reduce((sum, o) => sum + o.amount, 0);
        setRewardAmount((totalRaw / 1000000).toFixed(6));
        if (!quiet || outputs.length > 0)
          setClaimStatus(outputs.length > 0 ? 'eligible' : 'no_rewards');
      } catch (error) {
        logger.error('[CheckClaim] Error:', error);
        if (live() && !quiet) setClaimStatus('no_rewards');
      }
    },
    [activeWallet, networkId, t]
  );

  const checkClaimEligibility = useCallback(() => runScan(false), [runScan]);

  // effect:audited - looks again every 30 s while the popup is open and no claim runs; the scan
  // is incremental, so a quiet network costs one small read.
  const runScanRef = useRef(runScan);
  runScanRef.current = runScan;
  useEffect(() => {
    if (!scopeKey) return;
    const id = setInterval(() => {
      if (busyRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void runScanRef.current(true);
    }, RESCAN_MS);
    return () => clearInterval(id);
  }, [scopeKey]);

  /**
   * The output as the node holds it now, opened and checked again (webcli reads by id before a
   * claim). Null with a message shown when it cannot be claimed.
   */
  const freshForClaim = async (
    output: PrivateOutput,
    scope: TxScope,
    privateKey: string
  ): Promise<PrivateOutput | null> => {
    const fresh = await freshStealthOutput({
      id: output.id,
      epoch: output.epoch,
      privateKey,
      pin: scope,
      prepare: () => pvacManager.initialize(privateKey),
    });
    if (!fresh) {
      showMessage(t('toast.err.offline'), 'error');
      return null;
    }
    if (fresh.kind === 'ready') return fresh.output;
    dropFromScope(scanScopeKey(scope.networkId, scope.address), [output.id]);
    if (scopeKeyRef.current === `${scope.networkId}:${scope.address}`) {
      setPrivateOutputs((list) => list.filter((o) => o.id !== output.id));
    }
    showMessage(
      fresh.kind === 'claimed' ? t('toast.alreadyClaimed') : t('toast.cannotClaim'),
      'info'
    );
    return null;
  };

  const savedClaimDecides = async (
    output: PrivateOutput,
    scope: TxScope,
    ou: string
  ): Promise<'fresh' | 'done' | ClaimRow> => {
    const slot = await claimSlotFor(scope, scope.address, output.id, output.epoch);
    if (slot.kind === 'fresh') return 'fresh';
    if (slot.kind === 'blocked' || (slot.kind === 'previous' && slot.row.status === 'unknown')) {
      showMessage(t('toast.claimSettling'), 'error');
      return 'done';
    }
    if (slot.kind === 'recovery') {
      const resend = await claimResendFor(scope, scope.address, slot.row, ou, output.epoch);
      if (resend === 'resend') return slot.row;
      if (resend === 'fresh') return 'fresh';
      if (resend === 'unreadable') {
        showMessage(t('toast.err.offline'), 'error');
        return 'done';
      }
    }
    dropFromScope(scanScopeKey(scope.networkId, scope.address), [output.id]);
    if (scopeKeyRef.current === `${scope.networkId}:${scope.address}`) {
      setPrivateOutputs((list) => list.filter((o) => o.id !== output.id));
    }
    showMessage(t('toast.alreadyClaimed'), 'info');
    return 'done';
  };

  const requireUnspent = async (output: PrivateOutput, scope: TxScope) => {
    const state = await readClaimOutput(scope, output.id, output.epoch);
    if (state === 'unspent') return;
    throw new PlainError(state === 'spent' ? t('toast.alreadyClaimed') : t('toast.err.offline'));
  };

  const queueClaim = (output: PrivateOutput, signedTx: SignedTransaction, scope: TxScope) =>
    sendClaim(scope, scope.address, output.id, signedTx, (tx) =>
      chrome.runtime.sendMessage({
        type: 'QUEUE_TRANSACTION',
        transaction: {
          txId: crypto.randomUUID(),
          opType: 'claim',
          type: 'broadcast_only',
          signedTransaction: tx,
          from: scope.address,
          to: scope.address,
          amount: output.amount / 1000000,
          scope,
        },
      })
    );

  /** The saved bytes again, same nonce and hash: the slot and nonce were spent the first time. */
  const resendSaved = (row: ClaimRow, output: PrivateOutput, scope: TxScope) =>
    queueClaim(output, row.tx as SignedTransaction, scope);

  const claimFeeProblem = (): string | null => {
    if (!feeRaw) {
      return t('privacy.feeUnread', { defaultValue: 'Network fee unavailable. Try again.' });
    }
    const publicRaw = Math.round(parseFloat(publicBalance ?? '0') * 1_000_000);
    if (!(publicRaw >= Number(feeRaw))) {
      return t('privacy.feeNotCovered', {
        defaultValue: 'Insufficient public balance for network fee',
      });
    }
    return null;
  };

  const handleClaim = useCallback(async () => {
    if (!activeWallet || !activeWallet.privateKey) {
      showMessage(t('toast.noWallet'), 'error');
      return;
    }
    if (privateOutputs.length === 0) {
      showMessage(t('toast.nothingToClaim'), 'error');
      return;
    }
    const feeProblem = claimFeeProblem();
    if (feeProblem || !feeRaw) {
      showMessage(feeProblem ?? t('toast.claimFailed'), 'error');
      return;
    }
    const ou = feeRaw;
    // A claim folds into the balance cipher - claiming onto a legacy (pre-canonical-parity)
    // cipher would corrupt it beyond either keyset. Block honestly.
    if (pvacManager.lastDecryptLegacy) {
      showMessage(t('toast.legacyPaused'), 'error');
      return;
    }
    setClaimStatus('claiming');
    logger.debug(
      `[Claim] Starting: address=${activeWallet.address}, privateOutputs=${privateOutputs.length}`
    );
    const key = `${networkId}:${activeWallet.address}`;
    try {
      const scope = await captureTxScope(activeWallet.address, networkId);
      await assertTxScope(scope);
      const net = scope.networkId;
      logger.debug('[Claim] Initializing PVAC...');
      await pvacManager.initialize(activeWallet.privateKey);
      logger.debug('[Claim] PVAC initialized');

      await pvacManager.verifyRegistration(
        activeWallet.address,
        activeWallet.privateKey,
        activeWallet.publicKey,
        privacyNetworkService,
        false,
        net
      );

      // Brick preventer: never let a batch push the balance past the compactable limit.
      const { budget, heldBlocked } = await safeClaimBudget(activeWallet, scope);
      if (heldBlocked || (budget !== null && budget === 0)) {
        if (scopeKeyRef.current === key) setClaimStatus('eligible');
        showMessage(t('toast.migrateThenClaim'), 'error');
        return;
      }
      // ONE claim per pass: every claim adds two layers, so even a two-claim batch lands the
      // balance at the migrate threshold mid-batch. Claim the oldest, let the user migrate,
      // then claim the next - same explicit rhythm as the compact/migrate CTA.
      const saved = await savedClaimDecides(privateOutputs[0], scope, ou);
      if (saved === 'done') {
        if (scopeKeyRef.current === key) setClaimStatus('eligible');
        return;
      }
      const recovering = saved === 'fresh' ? null : saved;
      const first = recovering
        ? privateOutputs[0]
        : await freshForClaim(privateOutputs[0], scope, activeWallet.privateKey);
      if (!first) {
        if (scopeKeyRef.current === key) setClaimStatus('eligible');
        return;
      }
      const toClaim = [first];
      if (privateOutputs.length > 1) {
        logger.debug(
          `[Claim] claiming 1 of ${privateOutputs.length} outputs (single-claim policy)`
        );
      }

      let claimed = 0;
      const succeeded: PrivateOutput[] = [];
      let lastError: unknown = null;

      for (let i = 0; i < toClaim.length; i++) {
        const output = toClaim[i];
        if (scopeKeyRef.current === key) setClaimProgress(`Claiming ${i + 1}/${toClaim.length}...`);
        logger.debug(
          `[Claim] Processing output ${i + 1}/${toClaim.length}: id=${output.id}, amount=${output.amount} raw (${(output.amount / 1000000).toFixed(6)} OCT)`
        );

        let budgetStop: string | null = null;
        try {
          const policy = await proofPolicyFor(activeWallet.address, scope);
          const { result: response } = recovering
            ? { result: await resendSaved(recovering, output, scope) }
            : await proveThenSubmit({
                prove: async () => {
                  logger.debug(`[Claim] [${i + 1}] PVAC encrypt (amount=${output.amount})...`);
                  const { cipherBytes: ctClaim, commitmentBytes: claimCommitBytes } =
                    await pvacManager.encryptRawAsync(output.amount);
                  const claimCipherStr = pvacManager.encodeCipher(ctClaim);
                  const commitmentB64 = bytesToBase64(claimCommitBytes);
                  logger.debug(
                    `[Claim] [${i + 1}] PVAC encrypt done: ctClaim=${ctClaim.length}B, cipher=${claimCipherStr.length} chars, commitment=${commitmentB64.length} chars`
                  );

                  logger.debug(
                    `[Claim] [${i + 1}] Making bound proof (blinding=${output.blinding.length}B)...`
                  );
                  const zeroProofStr = await pvacManager.makeBoundProof(
                    ctClaim,
                    output.amount,
                    output.blinding,
                    policy
                  );
                  logger.debug(`[Claim] [${i + 1}] Bound proof done: ${zeroProofStr.length} chars`);

                  try {
                    const zpBytes = pvacManager.getZeroProofBytes(zeroProofStr);
                    const commitPoint = await pvacManager.pedersenCommitRawAsync(
                      output.amount,
                      output.blinding
                    );
                    const selfValid = await pvacManager.verifyBoundProof(
                      ctClaim,
                      zpBytes,
                      commitPoint,
                      policy
                    );
                    if (!selfValid) {
                      const diag = await pvacManager.diagnoseProof(zpBytes);
                      const cdiag = await pvacManager.diagnoseCipher(ctClaim);
                      logger.error(`[PrivateClaim] Bound proof self-verify FAILED!`);
                      logger.error(`[PrivateClaim] Proof diag: ${diag}`);
                      logger.error(`[PrivateClaim] Cipher diag: ${cdiag}`);
                      logger.error(
                        `[PrivateClaim] amount=${output.amount} zpBytes=${zpBytes.length}B ctClaim=${ctClaim.length}B commit=${commitPoint.length}B`
                      );
                      throw new Error(
                        'Bound proof failed local verification - aborting claim to prevent server rejection'
                      );
                    }
                    logger.debug(
                      `[PrivateClaim] Bound proof self-verify OK (zpBytes=${zpBytes.length}B)`
                    );
                  } catch (verifyErr) {
                    if (verifyErr.message?.includes('aborting claim')) throw verifyErr;
                    logger.warn(
                      `[PrivateClaim] Self-verify skipped (non-fatal):`,
                      verifyErr.message
                    );
                  }

                  return JSON.stringify({
                    version: 5,
                    output_id: output.id,
                    claim_cipher: claimCipherStr,
                    commitment: commitmentB64,
                    claim_secret: output.claimSecret,
                    zero_proof: zeroProofStr,
                  });
                },
                takeNonce: async () => {
                  await assertTxScope(scope);
                  await requireProofPolicy(policy, activeWallet.address, scope);
                  await requireUnspent(output, scope);
                  return networkService.getNextNonce(activeWallet.address, scope);
                },
                releaseNonce: (n) => networkService.releaseNonce(activeWallet.address, n, net),
                sign: async (claimData, nonce) => {
                  logger.debug(`[Claim] [${i + 1}] Building claim transaction (nonce=${nonce})...`);
                  const signedTx = await privacyNetworkService.buildClaimTransaction({
                    from: activeWallet.address,
                    nonce,
                    privateKey: activeWallet.privateKey,
                    publicKey: activeWallet.publicKey,
                    claimData,
                    ou,
                  });
                  if (!(await consumeClaimSlot(activeWallet.address, net))) {
                    const left = await remainingClaims(activeWallet.address, net);
                    budgetStop =
                      left === null ? t('toast.claimLimitUnknown') : t('toast.migrateThenClaim');
                    logger.warn(
                      `[Claim] consume blocked (remaining=${left === null ? 'unknown' : left}) - stopping batch`
                    );
                    throw new PlainError(budgetStop);
                  }
                  return signedTx;
                },
                send: (signedTx) => {
                  logger.debug(`[Claim] [${i + 1}] Queuing claim transaction via background...`);
                  return queueClaim(output, signedTx, scope);
                },
                refused: (r) => !r?.success && !!r?.errorType,
              });
          logger.debug(`[Claim] [${i + 1}] Queue response:`, response);

          if (response.success) {
            claimed++;
            succeeded.push(output);
            logger.debug(`[Claim] [${i + 1}] Queued successfully (claimed so far: ${claimed})`);
          } else {
            // Refund only on a positive node verdict (errorType). A timeout/transport failure
            // after octra_submit is AMBIGUOUS - the claim may have executed; slot stays consumed.
            if (response.errorType) await refundClaimSlot(activeWallet.address, net);
            lastError = response.error;
            logger.error(`[Claim] [${i + 1}] Queue failed:`, response.error);
          }
        } catch (err) {
          logger.error(`[PrivateClaim] Failed to claim output ${output.id}:`, err);
          lastError = err;
        }
        if (budgetStop) break;
      }

      logger.debug(
        `[Claim] Complete: claimed=${claimed}/${toClaim.length}, lastError=${lastError}`
      );
      if (scopeKeyRef.current !== key) {
        if (claimed === 0 && lastError)
          showMessage(plainError(lastError, t('toast.claimFailed')), 'error');
        return;
      }
      setClaimProgress('');
      if (claimed > 0) {
        setClaimStatus('success');
        // Account ONLY broadcast successes - a budget break or per-output failure must not mark
        // untouched outputs claimed or inflate the optimistic balance.
        const totalClaimedOCT = succeeded.reduce((s, o) => s + o.amount, 0) / 1_000_000;
        if (lastError) showMessage(plainError(lastError, t('toast.claimFailed')), 'info');
        dropFromScope(
          key,
          succeeded.map((o) => o.id)
        );
        const remainingOutputs = privateOutputs.filter(
          (o) => !succeeded.some((c) => c.id === o.id)
        );
        if (remainingOutputs.length > 0) {
          showMessage(t('toast.claimNext'), 'info');
        }
        setPrivateOutputs(remainingOutputs);
        setRewardAmount(
          (remainingOutputs.reduce((s, o) => s + o.amount, 0) / 1_000_000).toFixed(6)
        );
        adjustBalanceOptimistic(0, totalClaimedOCT);
        setTimeout(() => refreshBalance(undefined, undefined, true), 30000);
      } else {
        setClaimStatus('eligible');
        showMessage(plainError(lastError, t('toast.claimFailed')), 'error');
      }
    } catch (error) {
      logger.error('[Claim] Unhandled error:', error);
      if (scopeKeyRef.current === key) {
        setClaimProgress('');
        setClaimStatus('eligible');
      }
      showMessage(plainError(error, t('toast.claimFailed')), 'error');
    }
  }, [
    activeWallet,
    networkId,
    privateOutputs,
    showMessage,
    refreshBalance,
    feeRaw,
    publicBalance,
    t,
  ]);

  const handleClaimSingle = useCallback(
    async (picked: PrivateOutput) => {
      let output = picked;
      if (!activeWallet || !activeWallet.privateKey) return;
      const feeProblem = claimFeeProblem();
      if (feeProblem || !feeRaw) {
        showMessage(feeProblem ?? t('toast.claimFailed'), 'error');
        return;
      }
      const ou = feeRaw;
      if (pvacManager.lastDecryptLegacy) {
        showMessage(t('toast.legacyPaused'), 'error');
        return;
      }
      setClaimingOutputId(output.id);
      logger.debug(`[Claim] Single claim: output id=${output.id}, amount=${output.amount}`);
      const key = `${networkId}:${activeWallet.address}`;
      try {
        const scope = await captureTxScope(activeWallet.address, networkId);
        await assertTxScope(scope);
        const net = scope.networkId;
        await pvacManager.initialize(activeWallet.privateKey);
        await pvacManager.verifyRegistration(
          activeWallet.address,
          activeWallet.privateKey,
          activeWallet.publicKey,
          privacyNetworkService,
          false,
          net
        );

        // Brick preventer: a claim past the compactable limit is unrecoverable.
        const { budget, heldBlocked } = await safeClaimBudget(activeWallet, scope);
        if (heldBlocked) {
          showMessage(t('toast.migrateThenClaim'), 'error');
          return;
        }
        if (budget === 0) {
          showMessage(t('toast.migrateThenClaim'), 'error');
          return;
        }

        const saved = await savedClaimDecides(output, scope, ou);
        if (saved === 'done') return;
        let response: any;
        if (saved !== 'fresh') {
          response = await resendSaved(saved, output, scope);
        } else {
          const checked = await freshForClaim(output, scope, activeWallet.privateKey);
          if (!checked) return;
          output = checked;
          const claimed = output;
          const policy = await proofPolicyFor(activeWallet.address, scope);
          ({ result: response } = await proveThenSubmit({
            prove: async () => {
              const { cipherBytes: ctClaim, commitmentBytes: claimCommitBytes } =
                await pvacManager.encryptRawAsync(claimed.amount);
              const claimCipherStr = pvacManager.encodeCipher(ctClaim);
              const commitmentB64 = bytesToBase64(claimCommitBytes);
              const zeroProofStr = await pvacManager.makeBoundProof(
                ctClaim,
                claimed.amount,
                claimed.blinding,
                policy
              );

              try {
                const zpBytes = pvacManager.getZeroProofBytes(zeroProofStr);
                const commitPoint = await pvacManager.pedersenCommitRawAsync(
                  claimed.amount,
                  claimed.blinding
                );
                const selfValid = await pvacManager.verifyBoundProof(
                  ctClaim,
                  zpBytes,
                  commitPoint,
                  policy
                );
                if (!selfValid) {
                  throw new Error('Bound proof failed local verification - aborting claim');
                }
                logger.debug(`[Claim] Single claim self-verify OK`);
              } catch (verifyErr) {
                if (verifyErr.message?.includes('aborting claim')) throw verifyErr;
                logger.warn(`[Claim] Self-verify skipped:`, verifyErr.message);
              }

              return JSON.stringify({
                version: 5,
                output_id: claimed.id,
                claim_cipher: claimCipherStr,
                commitment: commitmentB64,
                claim_secret: claimed.claimSecret,
                zero_proof: zeroProofStr,
              });
            },
            takeNonce: async () => {
              await assertTxScope(scope);
              await requireProofPolicy(policy, activeWallet.address, scope);
              await requireUnspent(claimed, scope);
              return networkService.getNextNonce(activeWallet.address, scope);
            },
            releaseNonce: (n) => networkService.releaseNonce(activeWallet.address, n, net),
            sign: async (claimData, nonce) => {
              const signedTx = await privacyNetworkService.buildClaimTransaction({
                from: activeWallet.address,
                nonce,
                privateKey: activeWallet.privateKey,
                publicKey: activeWallet.publicKey,
                claimData,
                ou,
              });
              if (!(await consumeClaimSlot(activeWallet.address, net))) {
                const left = await remainingClaims(activeWallet.address, net);
                throw new PlainError(
                  left === null ? t('toast.claimLimitUnknown') : t('toast.migrateThenClaim')
                );
              }
              return signedTx;
            },
            send: (signedTx) => queueClaim(claimed, signedTx, scope),
            refused: (r) => !r?.success && !!r?.errorType,
          }));
        }

        if (!response.success) {
          // Refund only on a positive node verdict - ambiguous failures stay consumed.
          if (response.errorType) await refundClaimSlot(activeWallet.address, net);
          throw new Error(response.error || 'Queue failed');
        }

        dropFromScope(key, [output.id]);
        if (scopeKeyRef.current !== key) return;
        const remaining = privateOutputs.filter((o) => o.id !== output.id);
        setPrivateOutputs(remaining);
        if (remaining.length === 0) {
          setClaimStatus('success');
          setRewardAmount('0');
          adjustBalanceOptimistic(0, output.amount / 1_000_000);
          setTimeout(() => refreshBalance(undefined, undefined, true), 30000);
        } else {
          const totalRaw = remaining.reduce((sum, o) => sum + o.amount, 0);
          setRewardAmount((totalRaw / 1000000).toFixed(6));
          adjustBalanceOptimistic(0, output.amount / 1_000_000);
        }
      } catch (error) {
        logger.error(`[Claim] Single claim failed:`, error);
        showMessage(plainError(error, t('toast.claimFailed')), 'error');
      } finally {
        setClaimingOutputId(null);
      }
    },
    [
      activeWallet,
      networkId,
      privateOutputs,
      showMessage,
      refreshBalance,
      adjustBalanceOptimistic,
      feeRaw,
      publicBalance,
      t,
    ]
  );

  return {
    claimStatus,
    setClaimStatus,
    privateOutputs,
    rewardAmount,
    claimProgress,
    claimingOutputId,
    checkClaimEligibility,
    handleClaim,
    handleClaimSingle,
  };
};
