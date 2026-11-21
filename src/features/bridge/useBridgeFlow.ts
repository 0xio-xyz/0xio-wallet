import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import { useEvmBalances } from 'src/hooks/wallet/useEvmBalances';
import { useBridgeTransfers } from 'src/hooks/wallet/useBridgeTransfers';
import { networkCapabilities } from 'src/utils/network';
import { logger } from 'src/utils/logger';
import { toUnits } from 'src/utils/amount';
import { burnToOctraData } from 'src/services/bridge/abi';
import { BRIDGE } from 'src/services/bridge/constants';
import {
  LockFeeRaisedError,
  cachedBridgeHealth,
  cachedLockFee,
  claimCheck,
  ethereumMainnet,
  forgetBridgeHealth,
  lockToEth,
} from 'src/services/bridge/bridge';
import {
  CLAIM_DROPPED,
  NOT_FOUND,
  UNANSWERED,
  advance,
  claimCheckPatch,
  toLock,
  type BridgeDirection,
  type BridgeTransfer,
} from 'src/services/bridge/transfers';
import { applyFeeChoice, stillCovers, type FeeChoice } from 'src/services/evm/feeChoice';
import { estimateFees, type PreparedTransfer } from 'src/services/evm/send';
import { reportBridge } from 'src/services/bridge/track';
import { prepareCall, signAndSubmit } from 'src/services/evm/signer';
import { canUseEvm } from 'src/services/evm/walletEvm';
import { mayHaveBroadcast } from 'src/services/network/txOutcome';
import {
  bridgeScope,
  burnsWaiting,
  claimCount,
  fmtRaw,
  groupTransfers,
  latestActive,
  resumableBurn,
  transferCount,
} from './transfersView';
import { bridgeErrorText, type BridgeSide } from './bridgeErrors';
import { checkNewTransfer, type BridgeAction, type BridgePending } from './reviewCheck';

export type { BridgeAction, BridgePending } from './reviewCheck';

function useBridgeReadsAhead(enabled: boolean): bigint | null {
  const [lockFeeRaw, setLockFeeRaw] = useState<bigint | null>(null);
  // effect:audited - reads both chains (external systems) ahead of Review; the reads are kept 30s and shared, a late answer after unmount is dropped
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    cachedBridgeHealth().catch(() => {});
    cachedLockFee()
      .then((fee) => {
        if (live && fee) setLockFeeRaw(fee.recommended);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled]);
  return lockFeeRaw;
}

const ALLOWANCE_WATCH_MS = 4_000;

function useAllowanceWatch(
  waiting: BridgeTransfer | null,
  update: (id: string, patch: Partial<BridgeTransfer>) => void
) {
  const latest = useRef(waiting);
  latest.current = waiting;
  const id = waiting?.status === 'approving' ? waiting.id : null;
  // effect:audited - follows the allowance tx on Ethereum (external system) while step 2 waits; cleanup stops it
  useEffect(() => {
    if (!id) return;
    let live = true;
    let running = false;
    const timer = setInterval(async () => {
      const t = latest.current;
      if (running || document.hidden || t?.id !== id || t.status !== 'approving') return;
      running = true;
      try {
        const patch = await advance(t);
        if (live && patch && latest.current?.status === 'approving') update(id, patch);
      } catch (e) {
        logger.warn('[Bridge] could not check the allowance', e);
      } finally {
        running = false;
      }
    }, ALLOWANCE_WATCH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, update]);
}

export function useBridgeFlow(options: { onSent?: () => void } = {}) {
  const { t } = useTranslation();
  const { activeWallet, wallets, networkId, balance, showMessage } = useWallet();
  const { evmOn, evmAddress } = useHomeView();
  const isMainnet = networkCapabilities(networkId).bridge;
  const watchOnly = activeWallet?.type === 'watch';
  const keyless = !evmAddress;
  const needsEvm = keyless && canUseEvm(activeWallet, wallets);
  const ready = isMainnet && !!activeWallet && !watchOnly && !needsEvm;
  const lockFeeRaw = useBridgeReadsAhead(ready);
  const scope = bridgeScope(networkId, activeWallet?.address);
  const evm = useEvmBalances(evmAddress, networkId, evmOn && isMainnet);
  const { transfers, loaded, add, update, recover, addByHash, scanning } = useBridgeTransfers(
    scope,
    evmAddress
  );
  const [pending, setPending] = useState<BridgePending | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const waiting =
    pending?.action === 'burn' && !pending.prepared && pending.transferId
      ? (transfers.find((x) => x.id === pending.transferId) ?? null)
      : null;
  useAllowanceWatch(waiting, update);

  const ethRow = evm.rows.find((r) => r.chainId === 1 && r.token.address === null);
  const wOctRow = evm.rows.find(
    (r) => r.chainId === 1 && r.token.address?.toLowerCase() === BRIDGE.wOCT.toLowerCase()
  );
  const ethRaw = ethRow ? BigInt(ethRow.raw || '0') : 0n;
  const wOctRaw = wOctRow ? BigInt(wOctRow.raw || '0') : 0n;
  const octRaw = (() => {
    try {
      return toUnits(balance || '0', 6);
    } catch {
      return 0n;
    }
  })();

  const evmWallet = () => ({
    id: activeWallet!.id,
    evmIndex: activeWallet!.metadata?.evm?.index ?? 0,
    evmAddress: evmAddress!,
  });

  const toastError = (e: unknown, side: BridgeSide, fallback: string) => {
    logger.warn('[Bridge]', e);
    showMessage(bridgeErrorText(e, t, side, fallback), 'error');
  };

  const prepareFailed = () =>
    t('bridge.prepareFailed', {
      defaultValue: 'Could not prepare the bridge transaction. Try again.',
    });

  const sendFailed = () =>
    t('bridge.sendFailed', { defaultValue: 'Transaction not sent. Try again.' });

  const noEth = () =>
    t('bridge.noEth', { defaultValue: 'Insufficient ETH on Ethereum for network fee' });

  const sentText: Record<BridgeAction, () => string> = {
    lock: () => t('bridge.sent.lock', { defaultValue: 'Bridging to Ethereum' }),
    approve: () => t('bridge.sent.approve', { defaultValue: 'Allowing wOCT' }),
    burn: () => t('bridge.sent.burn', { defaultValue: 'Bridging to Octra' }),
    claim: () => t('bridge.sent.claim', { defaultValue: 'Claiming on Ethereum' }),
  };

  const needGas = (p: PreparedTransfer) => {
    if (p.totalNative <= ethRaw) return false;
    showMessage(noEth(), 'error');
    return true;
  };

  const stepTwo = useRef({ waiting, evmAddress, ethRaw, toastError, showMessage, t });
  stepTwo.current = { waiting, evmAddress, ethRaw, toastError, showMessage, t };
  const waitingKey = waiting ? `${waiting.id}:${waiting.status}` : null;
  // effect:audited - step 2 unlocks once Ethereum confirms the allowance: the burn is prepared with live nonce, fees and gas (external reads); a failed allowance ends the review
  useEffect(() => {
    const { waiting: tr, evmAddress: from } = stepTwo.current;
    if (!waitingKey || !tr || !from) return;
    const ours = (p: BridgePending | null) => !!p && p.transferId === tr.id && !p.prepared;
    if (tr.status === 'failed') {
      setPending((p) => (ours(p) ? null : p));
      stepTwo.current.showMessage(
        stepTwo.current.t('bridge.s.allowFailed', {
          defaultValue: 'Allowance did not go through. Your wOCT stayed in your wallet.',
        }),
        'error'
      );
      return;
    }
    if (tr.status !== 'ready_to_burn') return;
    let live = true;
    ethereumMainnet()
      .then((net) =>
        prepareCall(net, {
          from,
          to: BRIDGE.ethBridge,
          data: burnToOctraData(tr.recipient, BigInt(tr.amountRaw)),
        })
      )
      .then((prepared) => {
        if (!live) return;
        if (prepared.totalNative > stepTwo.current.ethRaw) {
          setPending((p) => (ours(p) ? null : p));
          stepTwo.current.showMessage(
            stepTwo.current.t('bridge.noEth', {
              defaultValue: 'Insufficient ETH on Ethereum for network fee',
            }),
            'error'
          );
          return;
        }
        setPending((p) => (ours(p) ? { ...p!, prepared } : p));
      })
      .catch((e: unknown) => {
        if (!live) return;
        setPending((p) => (ours(p) ? null : p));
        stepTwo.current.toastError(
          e,
          'Ethereum',
          stepTwo.current.t('bridge.prepareFailed', {
            defaultValue: 'Could not prepare the bridge transaction. Try again.',
          })
        );
      });
    return () => {
      live = false;
    };
  }, [waitingKey]);

  const openNew = async (direction: BridgeDirection, amountRaw: bigint, recipient: string) => {
    if (direction !== 'o2e' && !evmAddress) return;
    const resume =
      direction === 'e2o' && evmAddress
        ? resumableBurn(transfers, scope, evmAddress, amountRaw, recipient)
        : null;
    if (resume) {
      await openBurn(resume);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const check = await checkNewTransfer({
        direction,
        amountRaw,
        recipient,
        evmAddress,
        ethRaw,
        octRaw,
      });
      if ('pending' in check) setPending(check.pending);
      else if ('maxRaw' in check)
        setProblem(
          t('bridge.cap', {
            defaultValue: 'Exceeds the bridge limit (max {{max}} OCT).',
            max: fmtRaw(check.maxRaw, 6, 2),
          })
        );
      else if (check.problem === 'paused')
        setProblem(t('bridge.paused', { defaultValue: 'Bridge paused. Try again later.' }));
      else if (check.problem === 'feeUnavailable')
        showMessage(
          t('bridge.feeUnavailable', { defaultValue: 'Network fee unavailable. Try again.' }),
          'error'
        );
      else if (check.problem === 'noOct')
        showMessage(
          t('bridge.err.noOct', { defaultValue: 'Insufficient OCT for the amount and fee.' }),
          'error'
        );
      else showMessage(noEth(), 'error');
    } catch (e) {
      toastError(e, direction === 'o2e' ? 'Octra' : 'Ethereum', prepareFailed());
    } finally {
      setBusy(false);
    }
  };

  const openForTransfer = async (
    tr: BridgeTransfer,
    action: 'burn' | 'claim',
    call: { data: string; gasLimit?: bigint },
    step?: 2
  ) => {
    if (!evmAddress) return;
    setBusy(true);
    setPreparing(tr.id);
    setProblem(null);
    try {
      const prepared = await prepareCall(await ethereumMainnet(), {
        from: evmAddress,
        to: BRIDGE.ethBridge,
        ...call,
      });
      if (needGas(prepared)) return;
      setPending({
        action,
        transferId: tr.id,
        prepared,
        amountRaw: BigInt(tr.amountRaw),
        recipient: tr.recipient,
        ...(step ? { step } : {}),
      });
    } catch (e) {
      toastError(e, 'Ethereum', prepareFailed());
    } finally {
      setBusy(false);
      setPreparing(null);
    }
  };

  const waitFor = (tr: BridgeTransfer): BridgePending => ({
    action: 'burn',
    step: 2,
    transferId: tr.id,
    amountRaw: BigInt(tr.amountRaw),
    recipient: tr.recipient,
  });

  const openBurn = async (tr: BridgeTransfer) => {
    if (tr.status === 'approving') {
      setProblem(null);
      setPending(waitFor(tr));
      return;
    }
    await openForTransfer(
      tr,
      'burn',
      { data: burnToOctraData(tr.recipient, BigInt(tr.amountRaw)) },
      tr.approveHash ? 2 : undefined
    );
  };

  const openClaim = async (tr: BridgeTransfer) => {
    if (!evmAddress) return;
    let data = tr.claimData;
    if (tr.locked) {
      setBusy(true);
      setPreparing(tr.id);
      setProblem(null);
      try {
        const c = await claimCheck(toLock(tr.locked), evmAddress);
        if (c.state !== 'claimable') {
          update(tr.id, claimCheckPatch(c));
          if (c.state === 'claimed') {
            showMessage(
              t('bridge.alreadyClaimed', {
                defaultValue: 'Already claimed. The wOCT is at the receiving address.',
              }),
              'info'
            );
          } else if (c.state === 'waiting') {
            showMessage(statusText({ ...tr, status: 'waiting' }), 'info');
          } else {
            showMessage(statusText({ ...tr, status: 'blocked', note: c.reason }), 'error');
          }
          return;
        }
        data = c.data;
        if (data !== tr.claimData) update(tr.id, { claimData: data });
      } catch (e) {
        toastError(e, 'Ethereum', prepareFailed());
        return;
      } finally {
        setBusy(false);
        setPreparing(null);
      }
    }
    if (!data) return;
    await openForTransfer(tr, 'claim', { data, gasLimit: BRIDGE.claimGas });
  };

  const confirm = async () => {
    if (!pending || !activeWallet || (pending.action !== 'lock' && !evmAddress)) return;
    setBusy(true);
    setProblem(null);
    const now = Date.now();
    const base = {
      amountRaw: pending.amountRaw.toString(),
      octAddress: activeWallet.address,
      evmAddress: evmAddress ?? pending.recipient,
      recipient: pending.recipient,
      createdAt: now,
      updatedAt: now,
    };
    const sent = () => {
      setPending(null);
      forgetBridgeHealth();
      showMessage(sentText[pending.action](), 'info');
    };
    try {
      if (pending.action === 'lock') {
        if (!activeWallet.privateKey) throw new Error('Wallet locked');
        if (!pending.ouRaw) throw new Error('Network fee unavailable');
        let hash: string;
        try {
          hash = await lockToEth({
            from: activeWallet.address,
            privateKey: activeWallet.privateKey,
            publicKey: activeWallet.publicKey ?? undefined,
            amountRaw: pending.amountRaw,
            ethRecipient: pending.recipient,
            ouRaw: pending.ouRaw,
          });
        } catch (e) {
          if (e instanceof LockFeeRaisedError) {
            if (pending.amountRaw + e.ouRaw > octRaw) {
              setPending(null);
              showMessage(
                t('bridge.err.noOct', { defaultValue: 'Insufficient OCT for the amount and fee.' }),
                'error'
              );
              return;
            }
            setPending({ ...pending, ouRaw: e.ouRaw, feeRaised: true });
            return;
          }
          if (!mayHaveBroadcast(e)) throw e;
          logger.warn('[Bridge] lock sent without an answer', e);
          add({ ...base, id: `o2e-${now}`, direction: 'o2e', status: 'locking', note: UNANSWERED });
          options.onSent?.();
          setPending(null);
          forgetBridgeHealth();
          showMessage(
            t('bridge.maybeSent', {
              defaultValue: 'It may have gone through. Check Claim before you try again.',
            }),
            'warning'
          );
          return;
        }
        add({ ...base, id: `o2e-${now}`, direction: 'o2e', status: 'locking', lockHash: hash });
        reportBridge(
          {
            kind: 'lock',
            txHash: hash,
            amountRaw: pending.amountRaw,
            octraAddr: activeWallet.address,
            ethAddr: pending.recipient,
          },
          networkId
        );
        options.onSent?.();
      } else if (pending.prepared && evmAddress) {
        const net = await ethereumMainnet();
        const signs = applyFeeChoice(pending.prepared, pending.fee);
        if (signs.totalNative > ethRaw) {
          showMessage(noEth(), 'error');
          return;
        }
        const fresh = await estimateFees(net).catch((e: unknown): null => {
          logger.warn('[Bridge] fee check before signing failed, signing the reviewed fee', e);
          return null;
        });
        if (fresh && !stillCovers(signs.tx, fresh)) {
          setPending({
            ...pending,
            prepared: { ...pending.prepared, fees: fresh },
            fee: pending.fee && 'speed' in pending.fee ? pending.fee : undefined,
            feeRaised: true,
          });
          return;
        }
        const sentTx = await signAndSubmit(net, signs.tx, evmWallet());
        const at = Date.now();
        if (pending.action === 'approve') {
          const id = `e2o-${now}`;
          add({
            ...base,
            id,
            direction: 'e2o',
            status: 'approving',
            approveHash: sentTx.hash,
            approveNonce: sentTx.nonce,
            approveRaw: sentTx.raw,
            approveSentAt: at,
          });
          options.onSent?.();
          setPending(waitFor({ ...base, id, direction: 'e2o', status: 'approving' }));
          return;
        }
        const burnSent = {
          status: 'burning' as const,
          burnHash: sentTx.hash,
          burnNonce: sentTx.nonce,
          burnRaw: sentTx.raw,
          burnedAt: at,
        };
        if (pending.action === 'burn' || pending.action === 'claim') {
          reportBridge(
            pending.action === 'burn'
              ? {
                  kind: 'burn',
                  txHash: sentTx.hash,
                  amountRaw: pending.amountRaw,
                  octraAddr: pending.recipient,
                  ethAddr: evmAddress,
                }
              : {
                  kind: 'claim',
                  txHash: sentTx.hash,
                  amountRaw: pending.amountRaw,
                  ethAddr: evmAddress,
                },
            networkId
          );
        }
        if (pending.action === 'burn') {
          if (pending.transferId) {
            update(pending.transferId, burnSent);
          } else {
            add({ ...base, ...burnSent, id: `e2o-${now}`, direction: 'e2o' });
            options.onSent?.();
          }
        } else if (pending.action === 'claim' && pending.transferId) {
          update(pending.transferId, {
            status: 'claiming',
            claimHash: sentTx.hash,
            claimNonce: sentTx.nonce,
            claimRaw: sentTx.raw,
            claimSentAt: at,
            note: undefined,
          });
        }
      }
      sent();
    } catch (e) {
      setPending(null);
      toastError(e, pending.action === 'lock' ? 'Octra' : 'Ethereum', sendFailed());
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (!busy) setPending(null);
  };

  const setFee = (fee: FeeChoice) => setPending((p) => (p ? { ...p, fee } : p));

  const statusText = (tr: BridgeTransfer): string => {
    switch (tr.status) {
      case 'locking':
        return tr.note === UNANSWERED
          ? t('bridge.s.unanswered', { defaultValue: 'Checking Octra for this transfer' })
          : t('bridge.s.locking', { defaultValue: 'Confirming on Octra' });
      case 'waiting':
        return t('bridge.s.waiting', {
          defaultValue: "Waiting for Octra's proof on Ethereum",
        });
      case 'claimable':
        return tr.note === 'claim_failed'
          ? t('bridge.s.claimRetry', { defaultValue: 'Claim failed. Claim again.' })
          : tr.note === CLAIM_DROPPED
            ? t('bridge.s.claimDropped', {
                defaultValue: 'Claim did not go through. Claim again.',
              })
            : t('bridge.s.claimable', { defaultValue: 'Ready to claim on Ethereum' });
      case 'claiming':
        return t('bridge.s.claiming', { defaultValue: 'Claiming on Ethereum' });
      case 'approving':
        return t('bridge.s.approving', { defaultValue: 'Allowing wOCT' });
      case 'ready_to_burn':
        return t('bridge.s.readyBurn', { defaultValue: 'Allowed. Bridge to Octra next.' });
      case 'burning':
        return t('bridge.s.burning', { defaultValue: 'Bridging to Octra' });
      case 'swapping':
        return t('bridge.s.swapping', {
          defaultValue: 'Relay is buying wOCT and bridging it to Octra, usually within minutes',
        });
      case 'unlocking':
        return t('bridge.s.unlocking', {
          defaultValue: 'Arriving on Octra, usually within a minute',
        });
      case 'blocked':
        return tr.note === 'cap'
          ? t('bridge.s.cap', {
              defaultValue: 'Daily bridge limit reached. Claimable tomorrow.',
            })
          : t('bridge.s.blocked', {
              defaultValue: 'Not claimable yet. 0xio checks again automatically.',
            });
      case 'done':
        return t('bridge.s.done', { defaultValue: 'Completed' });
      case 'failed':
        return /paused/i.test(tr.note ?? '')
          ? t('bridge.s.paused', {
              defaultValue: 'Bridge paused. Your OCT stayed in your wallet.',
            })
          : tr.note === NOT_FOUND
            ? t('bridge.s.notFound', {
                defaultValue: 'Not found on Octra. Check your OCT balance before you bridge again.',
              })
            : tr.note === 'approve_dropped' || tr.note === 'approve_failed'
              ? t('bridge.s.allowFailed', {
                  defaultValue: 'Allowance did not go through. Your wOCT stayed in your wallet.',
                })
              : t('bridge.s.failed', { defaultValue: 'Failed' });
      default:
        return t('bridge.s.failed', { defaultValue: 'Failed' });
    }
  };

  return {
    ready,
    isMainnet,
    networkId,
    watchOnly,
    needsEvm,
    keyless,
    evmAddress,
    activeWallet,
    balance,
    octRaw,
    lockFeeRaw,
    ethRaw,
    wOctRaw,
    evmWallet,
    transfers,
    loaded,
    transferCount: transferCount(transfers, scope),
    groups: groupTransfers(transfers, scope),
    burnsWaiting: burnsWaiting(transfers, scope),
    readyCount: claimCount(transfers, scope),
    active: {
      o2e: latestActive(transfers, scope, 'o2e'),
      e2o: latestActive(transfers, scope, 'e2o'),
    },
    add,
    recover,
    addByHash,
    scanning,
    statusText,
    pending,
    waiting: !!waiting,
    busy,
    preparing,
    problem,
    setProblem,
    openNew,
    openClaim,
    openBurn,
    confirm,
    cancel,
    setFee,
  };
}

export type BridgeFlow = ReturnType<typeof useBridgeFlow>;
