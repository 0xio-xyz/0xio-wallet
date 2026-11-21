import { useEffect, useRef, useState } from 'react';
import { networkService, privacyNetworkService } from 'src/services/network/NetworkService';
import {
  clearPendingKeySwitch,
  getPendingKeySwitch,
  recordPendingKeySwitch,
} from 'src/services/pvac/keySwitchService';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import {
  assertTxScope,
  captureTxScope,
  resolveNetworkPin,
  type NetworkPin,
} from 'src/services/network/txScope';
import type { NetworkId } from 'src/utils/config';
import { logger } from 'src/utils/logger';
import { plainError } from 'src/utils/plainError';
import { ProofPolicyError } from 'src/services/pvac/proofPolicy';
import i18n from 'src/i18n/core';

// Devnet drops an unincluded key_switch after ~10 min (TTL); past this window an unresolved
// pending migration record is treated as expired and Migrate is offered again.
export const MIGRATION_PENDING_WINDOW_MS = 30 * 60_000;

const SETTLED_STATUSES = new Set(['confirmed', 'rejected', 'failed', 'dropped', 'expired']);

interface WalletLike {
  address: string;
  privateKey?: string;
  publicKey?: string;
}

export function useMigrateBalance(params: {
  activeWallet: WalletLike | null;
  networkId: string;
  publicBalance: string | null;
  privateBalance: string | null;
  showMessage: (msg: string, type: string) => void;
  onMigrated?: () => void;
}) {
  const { activeWallet, networkId, publicBalance, showMessage, onMigrated } = params;

  const [showPopup, setShowPopup] = useState(false);
  const [feeOct, setFeeOct] = useState('');
  const [feeRaw, setFeeRaw] = useState('');
  const [feeShort, setFeeShort] = useState(false);
  const [feeFailed, setFeeFailed] = useState(false);
  const [reusing, setReusing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [progress, setProgress] = useState('');

  // An upgrade in flight belongs to one wallet on one network: results that land after a
  // switch must not paint the new scope's CTA.
  const scopeKey = `${networkId}:${activeWallet?.address ?? ''}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const [shownScope, setShownScope] = useState(scopeKey);
  if (shownScope !== scopeKey) {
    setShownScope(scopeKey);
    setUpgrading(false);
  }

  // chrome.storage.session: the popup page dies on every close, so an in-memory cache would
  // lose the 2-3 minutes of proof work a TTL-expired submit needs back. Session storage
  // survives popup reopens and clears on browser restart.
  const payloadKey = (addr: string) => `pvac_mig_payload_${networkId}_${addr}`;

  const resolvePendingRecord = async (): Promise<boolean> => {
    if (!activeWallet?.address) {
      setUpgrading(false);
      return false;
    }
    let inFlight = false;
    const pin = await resolveNetworkPin(networkId as NetworkId);
    const keyScope = { networkId, address: activeWallet.address };
    const rec = await getPendingKeySwitch(keyScope);
    if (rec) {
      const age = Date.now() - rec.submittedAt;
      let status = '';
      try {
        const detail = await networkService.jsonRpcCall(
          'octra_transaction',
          [rec.txId],
          undefined,
          pin
        );
        status = String(detail?.status ?? '').toLowerCase();
      } catch {}
      const settled = SETTLED_STATUSES.has(status);
      logger.debug(
        `[Migrate] pending record: tx=${rec.txId.slice(0, 8)}… status=${status || 'unknown'} age=${Math.round(age / 1000)}s -> ${settled ? 'settled, clearing' : age >= MIGRATION_PENDING_WINDOW_MS ? 'window elapsed, clearing' : 'staged, CTA=Upgrade in progress'}`
      );
      if (settled || age >= MIGRATION_PENDING_WINDOW_MS) {
        // Guarded: a resubmit may have replaced the record while this check awaited.
        await clearPendingKeySwitch(keyScope, rec.txId);
      } else {
        inFlight = true;
      }
    }
    if (scopeRef.current === `${keyScope.networkId}:${keyScope.address}`) setUpgrading(inFlight);
    return inFlight;
  };

  // effect:audited - every hook instance resolves the stored pending record on mount and on
  // address/network change. The popup page dies on every close, so this is what keeps a staged
  // key_switch showing "Upgrade in progress" after a reopen - and it covers instances (private
  // Send) whose screens never call resolvePendingRecord themselves.
  useEffect(() => {
    if (activeWallet?.address) void resolvePendingRecord();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWallet?.address, networkId]);

  const open = async () => {
    if (!activeWallet?.privateKey || verifying) return;
    // Fresh in-flight check: a key_switch already in staging means a second submit would just
    // burn a fee racing itself - flip to "Upgrade in progress" instead of opening the popup.
    const keyScope = { networkId, address: activeWallet.address };
    try {
      const rec = await getPendingKeySwitch(keyScope);
      if (rec && Date.now() - rec.submittedAt < MIGRATION_PENDING_WINDOW_MS) {
        let status = '';
        try {
          const detail = await networkService.jsonRpcCall(
            'octra_transaction',
            [rec.txId],
            undefined,
            await resolveNetworkPin(networkId as NetworkId)
          );
          status = String(detail?.status ?? '').toLowerCase();
        } catch (e: any) {
          logger.warn(
            `[Migrate] in-flight lookup failed for ${rec.txId.slice(0, 8)}… (${e?.message ?? e}) - assuming still staged`
          );
        }
        const settled = SETTLED_STATUSES.has(status);
        logger.info(
          `[Migrate] in-flight check: tx=${rec.txId.slice(0, 8)}… age=${Math.round((Date.now() - rec.submittedAt) / 1000)}s status=${status || 'unknown'} -> ${settled ? 'settled, offering Migrate' : 'staged, blocking'}`
        );
        if (!settled) {
          setUpgrading(true);
          showMessage(i18n.t('toast.migrateStaged'), 'info');
          return;
        }
        await clearPendingKeySwitch(keyScope, rec.txId);
      }
    } catch (e: any) {
      logger.warn(`[Migrate] in-flight check failed (${e?.message ?? e}) - continuing to popup`);
    }
    setShowPopup(true);
    setFeeOct('');
    setFeeRaw('');
    setFeeShort(false);
    setFeeFailed(false);
    const pin = await resolveNetworkPin(networkId as NetworkId);
    let reuse = false;
    try {
      const stored = (await chrome.storage.session.get(payloadKey(activeWallet.address)))?.[
        payloadKey(activeWallet.address)
      ] as { sourceHash: string; migration: Record<string, unknown>; policy?: number } | undefined;
      if (stored?.migration && typeof stored.policy === 'number') {
        const cipher = await privacyNetworkService.fetchCipherOnly(
          activeWallet.address,
          activeWallet.privateKey,
          activeWallet.publicKey || '',
          pin
        );
        const liveHash = cipher ? await privacyNetworkService.sourceCipherHash(cipher) : null;
        reuse = !!liveHash && liveHash === stored.sourceHash;
        logger.info(
          `[Migrate] cached payload: stored=${stored.sourceHash.slice(0, 8)}… live=${liveHash?.slice(0, 8) ?? 'none'} -> ${reuse ? 'REUSE (skip proofs)' : 'stale, discarding'}`
        );
        if (!reuse) await chrome.storage.session.remove(payloadKey(activeWallet.address));
      } else {
        logger.debug('[Migrate] no cached payload - full proof build on submit');
      }
    } catch (e: any) {
      logger.warn(`[Migrate] cached-payload check failed (${e?.message ?? e}) - will build fresh`);
      reuse = false;
    }
    setReusing(reuse);
    await quoteFee(reuse, pin);
  };

  const quoteFee = async (reuse: boolean, pin: NetworkPin) => {
    const tier = reuse ? 'fast' : 'recommended';
    const raw = await privacyNetworkService.getKeySwitchFeeQuote(tier, pin);
    if (scopeRef.current !== `${pin.networkId}:${activeWallet?.address ?? ''}`) return;
    if (!raw) {
      logger.warn(`[Migrate] fee quote failed (tier=${tier}) - Migrate stays blocked`);
      setFeeRaw('');
      setFeeOct('');
      setFeeShort(false);
      setFeeFailed(true);
      return;
    }
    const fee = Number(raw) / 1_000_000;
    const short = parseFloat(publicBalance || '0') < fee;
    logger.info(
      `[Migrate] fee quote: ${raw} raw (${fee} OCT, tier=${tier}) public=${publicBalance || '?'} OCT${short ? ' - INSUFFICIENT' : ''}`
    );
    setFeeRaw(raw);
    setFeeOct(String(parseFloat(fee.toFixed(6))));
    setFeeShort(short);
    setFeeFailed(false);
  };

  const retryFee = async () => {
    if (verifying) return;
    setFeeFailed(false);
    await quoteFee(reusing, await resolveNetworkPin(networkId as NetworkId));
  };

  const submit = async () => {
    if (!activeWallet?.privateKey || verifying) return;
    if (!feeRaw || feeShort) return;
    const addr = activeWallet.address;
    const pk = activeWallet.privateKey;
    const pub = activeWallet.publicKey || '';
    setVerifying(true);
    setProgress('Preparing migration');
    passwordManager.suppressAutoLock();
    try {
      // The balance being migrated is this network's: the key_switch must land there.
      const scope = await captureTxScope(addr, networkId as NetworkId);
      await assertTxScope(scope);
      logger.info(
        `[Migrate] starting for ${addr.slice(0, 8)}… reuse=${reusing} quotedFee=${feeRaw}`
      );
      let migration: Record<string, unknown> | undefined;
      let policy: number | undefined;
      let feeTier: 'recommended' | 'fast' = 'recommended';
      if (reusing) {
        try {
          const stored = (await chrome.storage.session.get(payloadKey(addr)))?.[
            payloadKey(addr)
          ] as { migration: Record<string, unknown>; policy?: number } | undefined;
          policy = stored?.policy;
          migration = typeof policy === 'number' ? stored?.migration : undefined;
        } catch (e: any) {
          logger.warn(`[Migrate] cached payload read failed (${e?.message ?? e}) - building fresh`);
          migration = undefined;
        }
        if (migration) {
          feeTier = 'fast';
          logger.info('[Migrate] reusing cached payload - skipping proof build, fast-tier fee');
          setProgress('Reusing prepared migration');
        }
      }
      if (!migration) {
        const buildT0 = Date.now();
        const built = await privacyNetworkService.buildKeyBoundMigrationPayload(
          addr,
          pk,
          pub,
          (m) => setProgress(m),
          scope
        );
        migration = built.migration;
        policy = built.policy;
        logger.info(
          `[Migrate] payload built + locally verified in ${Math.round((Date.now() - buildT0) / 1000)}s (source=${String(built.migration.source_cipher_hash).slice(0, 8)}…)`
        );
        try {
          await chrome.storage.session.set({
            [payloadKey(addr)]: {
              sourceHash: String(built.migration.source_cipher_hash),
              migration,
              policy,
            },
          });
          logger.debug('[Migrate] payload cached for TTL-expiry retry');
        } catch (e: any) {
          logger.warn(
            `[Migrate] payload cache write failed (${e?.message ?? e}) - an expiry will cost a rebuild`
          );
        }
      }
      const { txHash } = await privacyNetworkService.submitKeyBoundMigration(
        addr,
        pk,
        pub,
        migration,
        // Pay exactly the fee the popup displayed.
        { feeTier, ou: feeRaw, onProgress: (m) => setProgress(m), scope, policy }
      );
      logger.info(`[Migrate] submitted key_switch ${txHash.slice(0, 8)}… (tier=${feeTier})`);
      // Record the in-flight upgrade so the CTA shows "Upgrade in progress" even after the
      // popup closes and reopens - resolvePendingRecord re-reads it. Kind 'migration': a
      // same-key switch, so the background keys-match check must NOT clear it.
      await recordPendingKeySwitch(scope, txHash, 'migration');
      const here = () => scopeRef.current === `${scope.networkId}:${scope.address}`;
      if (here()) setUpgrading(true);
      setProgress('Confirming migration on chain');
      // The 4MB migration key_switch is slow to execute on devnet (minutes), so poll well past
      // the 45s default. Only a CONFIRMED status means migrated; pending must not claim success.
      const exec = await networkService.verifyTxExecution(txHash, 240000, undefined, scope);
      if (exec.status === 'rejected') {
        logger.error('[Migrate] Rejected on-chain:', exec.error);
        // A node rejection means the payload itself is bad - never resubmit it.
        await chrome.storage.session.remove(payloadKey(addr)).catch(() => {});
        await clearPendingKeySwitch(scope, txHash);
        if (here()) setUpgrading(false);
        showMessage(plainError(exec.error, i18n.t('toast.migrateFailed')), 'error');
        return;
      }
      if (exec.status === 'confirmed') {
        logger.info(`[Migrate] CONFIRMED on-chain: ${txHash.slice(0, 8)}… - balance migrated`);
        await chrome.storage.session.remove(payloadKey(addr)).catch(() => {});
        await clearPendingKeySwitch(scope, txHash);
        if (here()) setUpgrading(false);
        if (here()) onMigrated?.();
      } else {
        logger.info(
          `[Migrate] still pending after 240s confirm window: ${txHash.slice(0, 8)}… - record + cached payload kept, CTA stays Upgrade in progress`
        );
        showMessage(i18n.t('toast.migratePending'), 'info');
      }
    } catch (err: any) {
      logger.error(`[Migrate] failed: ${err?.message ?? err}`);
      // Proofs made under rules the network no longer uses are worthless: never reuse them.
      if (err instanceof ProofPolicyError) {
        await chrome.storage.session.remove(payloadKey(addr)).catch(() => {});
      }
      showMessage(plainError(err, i18n.t('toast.migrateFailed')), 'error');
    } finally {
      setVerifying(false);
      setProgress('');
      setShowPopup(false);
      passwordManager.resumeAutoLock();
    }
  };

  return {
    showPopup,
    closePopup: () => setShowPopup(false),
    open,
    submit,
    resolvePendingRecord,
    verifying,
    upgrading,
    progress,
    feeOct,
    feeShort,
    feeFailed,
    retryFee,
    reusing,
  };
}
