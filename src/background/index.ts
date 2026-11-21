import './polyfills';
import * as claimBudget from '../services/privacy/claimBudget';
import { markSingleWriterContext } from '../services/privacy/claimBudget';
// The worker is the single writer of the claim budget; this must run before any budget op.
markSingleWriterContext();

import { ZeroXIOConfig, hydrateCustomNetworks } from '../utils/config';
import { logger } from '../utils/logger';
import { walletStorage } from '../services/wallet/WalletStorage';
import { txQueue } from './services/txQueue';
import { checkPendingTransactionsConfirmation } from './services/pendingReconciler';
import {
  dappConnections,
  clearAllDAppConnections,
  checkExpiredDAppConnections,
  removeDAppConnection,
  sendEventToConnected,
  markOctraOrigin,
} from './services/dappConnections';
import { passwordManager } from '../services/crypto/PasswordManager';
import { pvacManager } from '../services/pvac/PvacManager';
import { privacyNetworkService } from '../services/network/NetworkService';
import {
  clearPrivateBalanceCache,
  stripPrivateFromLocalBalanceCache,
} from '../services/wallet/balanceCache';
import { appendSnapshot, stripPrivateFromSnapshots } from '../services/wallet/BalanceHistory';
import { clearSessionCaches } from '../utils/sessionCaches';
import { EXT_BASE_URL } from './constants';
import { noteWhatsNewOnInstalled } from '../services/wallet/whatsNew';

// The service worker resolves networks synchronously (explorer links, privacy gating), so the
// custom list has to be in the registry before anything asks. Restarts re-run this.
void hydrateCustomNetworks();
import { refreshAndBroadcastBalance } from './services/balance';
import { handleDAppRequest } from './handlers/dappRequest';
import { requestLifecycle } from './services/requestLifecycle';
import { moveSiteToBrowser } from './handlers/desktopRoute';
import { desktopRelay } from './services/desktopRelay';
import { rpcFetch } from '../services/network/rpcExchange';
import {
  connectSiteWallet,
  handleEvmRequest,
  isEvmMethod,
  pickSiteChain,
  setSiteWallet,
} from './handlers/evmRequest';
import { handleEvmApprovalMessage } from './services/evmApprovals';
import { disconnectEvmSite, initEvmSiteEvents, pushEvmState } from './services/evmSites';
import { initLockIcon } from './services/lockIcon';

initEvmSiteEvents();
initLockIcon();
import { handleNetworkRequest } from './handlers/network';

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      extension_version: chrome.runtime.getManifest().version,
      install_time: Date.now(),
      settings: {
        auto_refresh: true,
      },
    });
  }

  if (details.reason === 'update') {
    try {
      await noteWhatsNewOnInstalled(details);
    } catch {}

    // The queue is not rehydrated across an update; what was queued shows failed in History.
    try {
      const { tx_queue_state: queueState } = await chrome.storage.local.get('tx_queue_state');
      const queued: any[] = queueState?.queue || [];
      const now = Date.now();
      for (const tx of queued) {
        if (!['pending', 'processing', 'retrying'].includes(tx?.status)) continue;
        const key = `pending_tx_${tx.txId || tx.id}`;
        const { [key]: entry } = await chrome.storage.local.get(key);
        if (!entry) continue;
        await chrome.storage.local.set({
          [key]: {
            ...entry,
            status: 'failed',
            pending: false,
            failedAt: now,
            error: 'Wallet updated before this transaction was sent. Send it again.',
          },
        });
      }
    } catch {}
    await chrome.storage.local.remove('tx_queue_state');

    // Network URLs come from config only.
    const stored = await chrome.storage.local.get('settings');
    if (stored.settings?.rpc_url) {
      const { rpc_url: _, ...cleanSettings } = stored.settings;
      await chrome.storage.local.set({ settings: cleanSettings });
    }

    await chrome.storage.local.set({
      security_migration_completed: true,
      migration_timestamp: Date.now(),
      migration_from_version: details.previousVersion,
    });
  }

  chrome.storage.session.remove([
    'sessionKey',
    'wallet_unlocked',
    'lastActivityTime',
    'lastUnlockTime',
  ]);
  await stripPrivateFromLocalBalanceCache();
  await stripPrivateFromSnapshots();
});

chrome.runtime.onStartup.addListener(async () => {
  void stripPrivateFromLocalBalanceCache();
  void stripPrivateFromSnapshots();
  try {
    const storage = (await chrome.storage.local.get(null)) as unknown as Record<string, any>;
    for (const [key, value] of Object.entries(storage)) {
      if (key.startsWith('dapp_connection_') && value.connected) {
        const origin = value.origin || key.replace('dapp_connection_', '');
        dappConnections.set(origin, value);
      }
    }

    await txQueue.initialize();
  } catch (error) {
    logger.error('Error restoring state:', error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'NETWORK_REQUEST':
      handleNetworkRequest(message, sendResponse);
      return true;

    case 'DAPP_REQUEST':
      if (isEvmMethod(message.method)) handleEvmRequest(message, sender, sendResponse);
      else {
        void markOctraOrigin(sender);
        handleDAppRequest(message, sender, sendResponse);
      }
      return true;

    case 'EVM_APPROVAL_DATA':
    case 'EVM_APPROVAL_EXTEND':
    case 'EVM_APPROVAL_RESPONSE':
      handleEvmApprovalMessage(message, sender, sendResponse);
      return false;

    case 'EVM_SITE_DISCONNECT': {
      const own = sender.id === chrome.runtime.id && sender.url?.startsWith(EXT_BASE_URL);
      if (!own || typeof message.origin !== 'string') {
        sendResponse({ success: false });
        return false;
      }
      const walletId = typeof message.walletId === 'string' ? message.walletId : undefined;
      disconnectEvmSite(message.origin, walletId)
        .then(() => pushEvmState([message.origin]))
        .then(
          () => sendResponse({ success: true }),
          () => sendResponse({ success: false })
        );
      return true;
    }

    case 'EVM_SITE_CONNECT':
    case 'EVM_SITE_USE': {
      const own = sender.id === chrome.runtime.id && sender.url?.startsWith(EXT_BASE_URL);
      if (!own) {
        sendResponse({ success: false });
        return false;
      }
      (message.type === 'EVM_SITE_CONNECT' ? connectSiteWallet : setSiteWallet)(message).then(
        (success) => sendResponse({ success }),
        () => sendResponse({ success: false })
      );
      return true;
    }

    case 'EVM_SITE_SET_CHAIN': {
      const own = sender.id === chrome.runtime.id && sender.url?.startsWith(EXT_BASE_URL);
      if (!own) {
        sendResponse({ success: false });
        return false;
      }
      pickSiteChain(message).then(
        (success) => sendResponse({ success }),
        () => sendResponse({ success: false })
      );
      return true;
    }

    case 'SITE_PAGE_GONE': {
      if (sender.id === chrome.runtime.id && typeof sender.tab?.id === 'number') {
        desktopRelay.closeFrame(sender.tab.id, sender.frameId ?? 0);
        requestLifecycle.pageGone(sender.tab.id, sender.frameId ?? 0);
      }
      return false;
    }

    case 'DESKTOP_SITE_DISCONNECT':
    case 'DESKTOP_SITE_MOVE': {
      const own = sender.id === chrome.runtime.id && sender.url?.startsWith(EXT_BASE_URL);
      if (!own || typeof message.origin !== 'string' || typeof message.network !== 'string') {
        sendResponse({ success: false });
        return false;
      }
      (message.type === 'DESKTOP_SITE_MOVE'
        ? moveSiteToBrowser(message.origin, message.network)
        : desktopRelay.disconnectSite(message.origin, message.network)
      ).then(
        (success) => sendResponse({ success }),
        () => sendResponse({ success: false })
      );
      return true;
    }

    case 'REVOKE_DAPP_CONNECTION': {
      const revokeOrigin = message.origin as string;
      if (revokeOrigin) {
        dappConnections.delete(revokeOrigin);
        removeDAppConnection(revokeOrigin).catch(() => {});
        requestLifecycle.dropOrigin(revokeOrigin).catch(() => {});
      }
      sendResponse({ success: true, data: { revoked: !!revokeOrigin } });
      return true;
    }

    case 'CLAIM_BUDGET_OP': {
      // Every context delegates here so one per-address chain writes the claim budget. Static
      // imports only: a chunk that failed to load would answer undefined and fail open.
      (async () => {
        const addr = message.address as string;
        // The caller's network: a switch in flight must not move the op to another budget.
        const net = typeof message.networkId === 'string' ? message.networkId : undefined;
        switch (message.op) {
          case 'seed':
            await claimBudget.seedClaimBudget(
              addr,
              message.cipher as string,
              message.layers as number,
              net
            );
            return undefined;
          case 'seedEmpty':
            await claimBudget.seedClaimBudgetEmpty(addr, net);
            return undefined;
          case 'consume':
            return claimBudget.consumeClaimSlot(addr, net);
          case 'refund':
            await claimBudget.refundClaimSlot(addr, net);
            return undefined;
          case 'remaining':
            return claimBudget.remainingClaims(addr, net);
          case 'reset':
            await claimBudget.resetClaimBudget(addr, net);
            return undefined;
          default:
            return undefined;
        }
      })().then(sendResponse, (e) => {
        logger.error(`[ClaimBudget] background op '${message.op}' FAILED:`, e);
        sendResponse(undefined);
      });
      // undefined reads as blocked to callers: fail closed.
      return true;
    }
    case 'QUEUE_TRANSACTION':
      (async () => {
        try {
          const { txId, broadcastResult } = await txQueue.add(message.transaction);
          if (broadcastResult) {
            const result = await broadcastResult;
            sendResponse({
              success: result.success,
              txId,
              txHash: result.txHash,
              error: result.error,
              // Server verdicts only: the claim budget refund gates on this.
              errorType: result.errorType,
            });
          } else {
            sendResponse({ success: true, txId });
          }
          const txAddr = message.transaction?.from || message.transaction?.address;
          if (txAddr) {
            setTimeout(() => refreshAndBroadcastBalance(txAddr), 2000);
          }
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'CANCEL_QUEUED': {
      const own = sender.id === chrome.runtime.id && sender.url?.startsWith(EXT_BASE_URL);
      if (!own || typeof message.txId !== 'string') {
        sendResponse({ cancelled: false });
        return false;
      }
      txQueue.cancel(message.txId).then(
        (cancelled) => sendResponse({ cancelled }),
        () => sendResponse({ cancelled: false })
      );
      return true;
    }

    case 'QUEUE_BULK_TRANSACTIONS':
      (async () => {
        try {
          const txIds = [];
          for (const transaction of message.transactions) {
            const txId = await txQueue.add(transaction);
            txIds.push(txId);
          }
          sendResponse({ success: true, txIds, count: txIds.length });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'GET_QUEUE_STATUS':
      sendResponse({ success: true, status: txQueue.getStatus() });
      return false;

    case 'CLEAR_QUEUE_HISTORY':
      txQueue
        .clearHistory()
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'ENSURE_PVAC_OFFSCREEN':
      (async () => {
        try {
          const contexts = await (chrome.runtime as any).getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
          });
          if (contexts.length === 0) {
            await (chrome as any).offscreen.createDocument({
              url: chrome.runtime.getURL('pvac-offscreen.html'),
              reasons: ['WORKERS'],
              justification: 'PVAC cryptographic proof generation with parallel threads',
            });
            logger.debug('[Background] Created PVAC offscreen document');
          }
          sendResponse({ success: true });
        } catch (e: any) {
          if (e.message?.includes('single offscreen')) {
            logger.debug('[Background] Offscreen document already exists, reusing');
            sendResponse({ success: true });
          } else {
            logger.error('[Background] Failed to create offscreen document:', e);
            sendResponse({ success: false, error: e.message });
          }
        }
      })();
      return true;

    case 'CLOSE_PVAC_OFFSCREEN':
      (async () => {
        try {
          await (chrome as any).offscreen.closeDocument();
          logger.debug('[Background] Closed PVAC offscreen document');
          sendResponse({ success: true });
        } catch {
          sendResponse({ success: true });
        }
      })();
      return true;

    case 'GET_APPROVAL_DATA':
      (async () => {
        const reqId = message.approvalId as string;
        const result = await chrome.storage.local.get(`approval_${reqId}`);
        const data = result[`approval_${reqId}`];
        logger.debug(`[Approval] GET_APPROVAL_DATA ${reqId}: ${data ? 'found' : 'null'}`);
        sendResponse({ success: true, data: data ?? null });
      })();
      return true;

    case 'GET_ALL_WALLETS':
      (async () => {
        try {
          let allWallets = await walletStorage.loadAllWallets();

          if (allWallets.length === 0) {
            const fb = await chrome.storage.local.get([
              'activeWalletId',
              ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET,
            ]);
            const fbAddress = fb[ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET] || fb.activeWalletId;
            if (fbAddress) {
              allWallets = [
                { id: fbAddress, name: 'Wallet', address: fbAddress, isActive: true } as any,
              ];
            }
          }

          const minimal = allWallets.map((w) => ({
            id: w.id,
            name: w.name,
            address: w.address,
            isActive: w.isActive,
          }));
          sendResponse({ success: true, wallets: minimal });
        } catch (_e) {
          sendResponse({ success: false, wallets: [] });
        }
      })();
      return true;

    case 'BROADCAST_WALLET_LOCKED': {
      void sendEventToConnected({ type: 'extensionLocked' });
      sendResponse({ success: true });
      return false;
    }

    case 'BROADCAST_WALLET_UNLOCKED': {
      void sendEventToConnected({ type: 'extensionUnlocked' });
      sendResponse({ success: true });
      return false;
    }

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  desktopRelay.closeTab(tabId);
  requestLifecycle.pageGone(tabId);
});

// A popup lock clears session storage but not the worker's cached key: drop it, PVAC and the
// decrypted balances too, so nothing signs from a cached key after a lock.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !('wallet_unlocked' in changes)) return;
  if (changes.wallet_unlocked.newValue !== undefined) return;
  passwordManager.lockWallet().catch(() => {});
  pvacManager.destroy();
  privacyNetworkService.clearDecryptCache();
  clearSessionCaches();
  void clearPrivateBalanceCache();
});

if (chrome.alarms) {
  const ALARMS = {
    keepAlive: 0.5,
    checkPendingTx: 0.5,
    checkDAppExpiry: 5,
    balanceSnapshot: 2,
  };

  const createAlarms = async () => {
    for (const [name, period] of Object.entries(ALARMS)) {
      const alarm = await chrome.alarms.get(name);
      if (!alarm || alarm.periodInMinutes !== period) {
        chrome.alarms.create(name, { delayInMinutes: period, periodInMinutes: period });
      }
    }
  };

  createAlarms();
  chrome.runtime.onInstalled.addListener(createAlarms);

  // The worker may have been stopped while the lock timer ran out.
  (async () => {
    try {
      const localStorage = await chrome.storage.local.get([
        'autoLockDuration',
        'settings',
        'passwordSkipped',
        'hashedPassword',
        'lastActivityTime',
        'lastUnlockTime',
      ]);

      const startupActivityTime = localStorage.lastActivityTime ?? localStorage.lastUnlockTime;
      if (!localStorage.passwordSkipped && localStorage.hashedPassword && startupActivityTime) {
        let autoLockDuration = localStorage.autoLockDuration;
        if (
          autoLockDuration === undefined &&
          localStorage.settings?.autoLockMinutes !== undefined
        ) {
          autoLockDuration = localStorage.settings.autoLockMinutes * 60;
        } else if (autoLockDuration === undefined) {
          autoLockDuration = 300;
        }

        if (autoLockDuration === 0) return;

        const now = Date.now();
        const timeSinceActivity = now - startupActivityTime;
        const autoLockMs = autoLockDuration * 1000;

        if (timeSinceActivity >= autoLockMs) {
          logger.debug('[ServiceWorker] Auto-lock expired on startup, ensuring wallet is locked');
          await chrome.storage.session.remove([
            'wallet_unlocked',
            'sessionKey',
            'lastActivityTime',
            'lastUnlockTime',
          ]);
          await chrome.storage.local.remove(['lastActivityTime', 'lastUnlockTime']);
          await clearAllDAppConnections();
        }
      }
    } catch (error) {
      logger.error('[ServiceWorker] Error checking auto-lock on startup:', error);
    }
  })();

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'checkPendingTx') {
      await checkPendingTransactionsConfirmation();
      return;
    }

    if (alarm.name === 'checkDAppExpiry') {
      await checkExpiredDAppConnections();
      return;
    }

    if (alarm.name === 'balanceSnapshot') {
      try {
        const { wallet_unlocked: unlocked } = await chrome.storage.session.get('wallet_unlocked');
        if (!unlocked) return;
        const storage = await chrome.storage.local.get([
          ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET,
          'activeWalletId',
          ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK,
        ]);
        const addr = storage[ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET] || storage.activeWalletId;
        const network = storage[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet';
        if (!addr) return;

        const rpcUrl = `${await txQueue.getNetworkUrl()}/rpc`;
        const res = await rpcFetch(
          rpcUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'octra_balance',
              params: [addr],
            }),
          },
          { lane: 'poll' }
        );
        const data = await res.json();
        const publicBal = parseFloat(data?.result?.balance);
        if (!Number.isFinite(publicBal)) return;

        // The private half stays with the popup's own decrypts, in session storage only.
        await appendSnapshot(addr, network, publicBal, null);
      } catch {}
      return;
    }

    if (alarm.name === 'keepAlive') {
      try {
        const localStorage = await chrome.storage.local.get([
          'autoLockDuration',
          'settings',
          'passwordSkipped',
          'hashedPassword',
          'lastActivityTime',
          'lastUnlockTime',
          'activeOperation',
        ]);

        const sessionStorage = await chrome.storage.session.get([
          'wallet_unlocked',
          'lastActivityTime',
          'lastUnlockTime',
          'activeOperation',
        ]);

        // No auto-lock during a long operation (range proofs); a flag older than 30 min is stale.
        const activeOp = sessionStorage.activeOperation || localStorage.activeOperation;
        if (activeOp && Date.now() - activeOp < 30 * 60 * 1000) {
          return;
        }

        // Session storage may be cleared when the worker stops.
        const lastActivityTime =
          localStorage.lastActivityTime ??
          localStorage.lastUnlockTime ??
          sessionStorage.lastActivityTime ??
          sessionStorage.lastUnlockTime;

        if (!localStorage.passwordSkipped && localStorage.hashedPassword) {
          if (lastActivityTime) {
            let autoLockDuration = localStorage.autoLockDuration;
            if (
              autoLockDuration === undefined &&
              localStorage.settings?.autoLockMinutes !== undefined
            ) {
              autoLockDuration = localStorage.settings.autoLockMinutes * 60;
            } else if (autoLockDuration === undefined) {
              autoLockDuration = 300;
            }

            if (autoLockDuration === 0) {
              return;
            }

            const now = Date.now();
            const timeSinceActivity = now - lastActivityTime;
            const autoLockMs = autoLockDuration * 1000;

            if (timeSinceActivity >= autoLockMs) {
              logger.debug('[ServiceWorker] Auto-lock timer expired, locking wallet');
              await sendEventToConnected({ type: 'extensionLocked' });
              await chrome.storage.session.remove([
                'wallet_unlocked',
                'sessionKey',
                'lastActivityTime',
                'lastUnlockTime',
              ]);
              await chrome.storage.local.remove(['lastActivityTime', 'lastUnlockTime']);
              await clearAllDAppConnections();
            }
          }
        }
      } catch (error) {
        logger.error('[ServiceWorker] Error checking auto-lock:', error);
      }
    }
  });
}
