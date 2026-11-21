import { ZeroXIOConfig, isCustomNetworkId, resolveCustomNetwork } from '../../utils/config';
import { logger } from '../../utils/logger';
import { bytesToBase64 } from 'src/lib/encoding';
import { networkService, privacyNetworkService } from 'src/services/network/NetworkService';
import { rpcFetch } from 'src/services/network/rpcExchange';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import { walletStorage } from 'src/services/wallet/WalletStorage';
import { pvacManager } from 'src/services/pvac/PvacManager';
import { readPrivateBalanceCache } from 'src/services/wallet/balanceCache';
import { KNOWN_DAPP_PERMISSIONS, RPC_CALL_ALLOWED_METHODS } from '../constants';
import { txQueue, type TxSite } from '../services/txQueue';
import { txApprovalQueue, msgApprovalQueue, hasPendingApproval } from '../services/approvals';
import {
  dappConnections,
  resolveDappPvacKey,
  dappRawInt,
  getConnection,
  loadDAppConnection,
  persistDAppConnection,
  removeDAppConnection,
  sendEventToConnected,
  showConnectionApproval,
} from '../services/dappConnections';
import { getActiveWallet, waitForWalletUnlock } from '../services/wallet';
import {
  GONE_ERROR,
  choosePrivateWallet,
  prepareSigner,
  privateRequestRoute,
  settleSigner,
  walletForOrigin,
  type SiteWalletResult,
} from '../services/siteWallet';
import { refreshAndBroadcastBalance } from '../services/balance';
import {
  WATCH_ONLY_ERROR,
  canSignAddress,
  keyRefusal,
  walletCanSign,
} from '../services/signingKey';
import { takeSiteBudget } from '../services/siteBudget';
import { activeNetworkHasPrivacy } from '../services/networkPrivacy';
import { FEE_UNAVAILABLE, reviewedFeeError, siteFeeOu } from '../../utils/octra/dappTx';
import { toUnits } from '../../utils/amount';
import {
  clearPendingKeySwitch,
  getPendingKeySwitch,
  recordPendingKeySwitch,
} from 'src/services/pvac/keySwitchService';
import { waitForReceipt } from '../../features/wallet/nft/xpectrum/confirm';
import {
  normalizeSiteCall,
  normalizeSitePrivateTransfer,
  normalizeSiteTx,
  type SiteTx,
} from '../../utils/octra/dappTxRequest';
import { localTxHash } from '../../utils/octra/txHash';
import { isSubmitVerdict } from 'src/services/network/txOutcome';
import { proofPolicyFor } from 'src/services/pvac/proofPolicy';
import {
  FEE_UNAVAILABLE_REFUSAL,
  paramsWithFee,
  reviewedFeeRefusal,
  siteFee,
} from '../services/siteFee';
import { parseDeployRequest } from '../../utils/octra/deployTx';
import {
  DeployChangedError,
  deployFeeError,
  liveDeployOu,
  previewDeploy,
  submitDeploy,
  type DeployPreview,
} from 'src/services/contracts/contractDeploy';
import {
  SCOPE_CHANGED,
  TxScopeError,
  captureTxScope,
  resolveNetworkPin,
  txScopeMismatch,
  type TxScope,
} from 'src/services/network/txScope';
import type { ApprovalAnswer, ConnectAnswer } from '../services/approvals';
import { desktopRelay, type RelayAnswer } from '../services/desktopRelay';
import { setSiteSigner } from '../services/siteSigner';
import {
  REVIEW_METHODS,
  requestLifecycle,
  walletHello,
  type RequestReview,
} from '../services/requestLifecycle';
import {
  desktopConnectOffer,
  offerAvailable,
  relayResponse,
  routeSiteToDesktop,
} from './desktopRoute';

const httpOnly = (u: unknown): string =>
  typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '';

const unlockPromptAt = new Map<string, number>();

/** Once a minute per origin, so a page cannot keep popping the wallet open. */
async function waitForUnlock(
  origin: string,
  review: RequestReview | undefined,
  tooSoon: string
): Promise<
  | { ok: true; wallet: NonNullable<Awaited<ReturnType<typeof getActiveWallet>>> }
  | { ok: false; error: { code: string; message: string } }
> {
  if (Date.now() - (unlockPromptAt.get(origin) ?? 0) < 60_000) {
    return { ok: false, error: { code: 'WALLET_LOCKED', message: tooSoon } };
  }
  unlockPromptAt.set(origin, Date.now());
  await review?.locked();
  try {
    await chrome.action.openPopup();
  } catch {
    try {
      await chrome.windows.create({
        url: 'index.html',
        type: 'popup',
        width: 400,
        height: 600,
        focused: true,
      });
    } catch (windowError) {
      logger.error('[Background] Failed to open extension window:', windowError);
    }
  }
  const wallet = await waitForWalletUnlock(60_000);
  if (wallet) return { ok: true, wallet };
  review?.expire();
  return {
    ok: false,
    error: {
      code: 'WALLET_LOCKED',
      message: 'Wallet unlock timed out. Please unlock your wallet and try again.',
    },
  };
}

function reviewPending(message: { v?: unknown; rid?: unknown }, origin: string) {
  const blocking = requestLifecycle.openRequest(origin, message.rid);
  const details = { reason: 'review_pending', ...(blocking ?? {}) };
  const text = 'Finish or reject the open request first.';
  return message.v === 2
    ? { code: 'RATE_LIMIT_EXCEEDED', message: text, details }
    : { code: 'REQUEST_PENDING', message: text, ...(blocking ? { details } : {}) };
}

async function readBalanceRaw(address: string, at: TxScope): Promise<bigint> {
  const r = await networkService.jsonRpcCall('octra_balance', [address], true, at);
  if (r?.balance_raw != null && /^\d+$/.test(String(r.balance_raw))) return BigInt(r.balance_raw);
  return toUnits(String(r?.balance ?? ''), 6);
}

async function clearKeySwitchWhenFinal(scope: TxScope, hash: string): Promise<void> {
  const receipt = await waitForReceipt(hash, scope, { intervalMs: 2500, timeoutMs: 600_000 });
  if (['confirmed', 'rejected', 'dropped'].includes(receipt.status)) {
    await clearPendingKeySwitch(scope, hash);
  }
}

/** Strict: a node error is an error, never "no view key". */
async function readViewPubkey(address: string, at: TxScope): Promise<string | null> {
  const result = await networkService.jsonRpcCall('octra_viewPubkey', [address], true, at);
  return typeof result?.view_pubkey === 'string' && result.view_pubkey ? result.view_pubkey : null;
}

const PRIVATE_METHODS = new Set([
  'get_private_balance_info',
  'get_private_balance',
  'encrypt_value',
  'decrypt_value',
  'make_zero_proof',
  'make_range_proof',
  'register_private_view_key',
  'send_private_transfer',
  'get_pending_private_transfers',
  'claim_private_transfer',
]);

const WALLET_AGNOSTIC_METHODS = new Set([
  'ping',
  'connect',
  'disconnect',
  'register_dapp',
  'getConnectionStatus',
  'getNetworkInfo',
  'get_network_info',
  'contract_call_view',
  'contractCallView',
  'get_contract_storage',
  'getContractStorage',
  'rpc_call',
]);

const txSiteOf = (sender: chrome.runtime.MessageSender): TxSite => ({
  origin: sender.origin || sender.url || '',
  tabId: sender.tab?.id,
  frameId: sender.frameId,
});

/** A persisted connection counts too: the in-memory map is empty after a worker restart. */
async function requireConnection(
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): Promise<any | null> {
  const origin = sender.origin || sender.url || '';
  let conn = dappConnections.get(origin);
  if (!conn) {
    const persisted = await loadDAppConnection(origin);
    if (persisted?.connected) {
      dappConnections.set(origin, persisted);
      conn = persisted;
    }
  }
  if (!conn?.connected) {
    sendResponse({
      success: false,
      error: { code: 'NOT_CONNECTED', message: 'Connect before this request.' },
    });
    return null;
  }
  return conn;
}

async function requireUnlocked(sendResponse: (response?: any) => void): Promise<boolean> {
  if (await passwordManager.getSessionKey()) return true;
  sendResponse({
    success: false,
    error: { code: 'WALLET_LOCKED', message: 'Unlock the 0xio extension, then try again.' },
  });
  return false;
}

/**
 * Signing after the user left the approved network or wallet would put a chain-id-less tx on a
 * network nobody approved.
 */
async function approvedScopeStillCurrent(
  scope: TxScope,
  sendResponse: (response?: any) => void
): Promise<boolean> {
  const why = await txScopeMismatch(scope);
  if (!why) return true;
  sendResponse({ success: false, error: { code: 'NETWORK_CHANGED', message: why } });
  return false;
}

async function tabInfoFor(sender: chrome.runtime.MessageSender): Promise<Record<string, string>> {
  const origin = sender.origin || sender.url || '';
  try {
    const tab = await chrome.tabs.get(sender.tab.id);
    return { title: tab.title, favicon: tab.favIconUrl, url: tab.url };
  } catch (_e) {
    let title = origin;
    try {
      title = new URL(origin).hostname;
    } catch {}
    return { title, favicon: `${origin}/favicon.ico`, url: origin };
  }
}

/** Private requests sign with the open wallet only: a wallet picked on approval is refused. */
function refusesPick(
  answer: ApprovalAnswer,
  address: string,
  sendResponse: (response?: any) => void
): boolean {
  if (!answer.selectedAddress || answer.selectedAddress === address) return false;
  sendResponse({
    success: false,
    error: { code: 'INVALID_PARAMS', message: 'Private requests sign with the open wallet.' },
  });
  return true;
}

function offSiteWallet(
  origin: string,
  address: string,
  sendResponse: (response?: any) => void
): boolean {
  const bound = dappConnections.get(origin)?.address;
  if (!bound || bound === address) return false;
  sendResponse({
    success: false,
    error: { code: 'WALLET_CHANGED', message: 'This site is on another wallet. Send it again.' },
  });
  return true;
}

const NO_KEY_ERROR = { code: 'WALLET_LOCKED', message: 'Private key not available.' };

type QueueOutcome = {
  success: boolean;
  error?: string;
  errorType?: string;
  outcomeUnknown?: boolean;
};

/**
 * A tx the queue refused or the node rejected never gets a server hash, so the hash polls must
 * report it as failed, not as sent.
 */
function watchQueueFailure(addResult: { broadcastResult?: Promise<QueueOutcome> } | undefined) {
  const state: { failed: QueueOutcome | null } = { failed: null };
  addResult?.broadcastResult?.then((r) => {
    if (!r.success) state.failed = r;
  });
  return state;
}

/** An unclear result is never an error: the site gets the local hash and the chain decides. */
function unclearSubmitResponse(localHash: string, data: Record<string, unknown> = {}) {
  return {
    success: true,
    data: { ...data, txHash: localHash, hash: localHash, status: 'submitted', outcome: 'unknown' },
  };
}

function queueFailureResponse(failed: QueueOutcome, localHash?: string | null) {
  if (failed.outcomeUnknown && localHash) return unclearSubmitResponse(localHash);
  return {
    success: false,
    error: {
      code: failed.errorType === SCOPE_CHANGED ? 'NETWORK_CHANGED' : 'TRANSACTION_FAILED',
      message: failed.error || 'Transaction failed',
    },
  };
}

export async function handleDAppRequest(
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
) {
  const { method } = message;

  try {
    if (method === 'request_status' || method === 'cancel_request') {
      if ((await routeSiteToDesktop(message, sender, sendResponse)) === 'answered') return;
      sendResponse(
        method === 'request_status'
          ? await requestLifecycle.status(sender, message.params)
          : await requestLifecycle.cancel(sender, message.params)
      );
      return;
    }

    if (method !== 'ping' && !takeSiteBudget(sender.origin || sender.url || '')) {
      sendResponse({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests from this site. Retry shortly.',
        },
      });
      return;
    }

    const route = await routeSiteToDesktop(message, sender, sendResponse);
    if (route === 'answered') return;
    const desktopDown = route === 'desktop-down';

    if (method === 'wallet_hello') {
      sendResponse({ success: true, data: walletHello(chrome.runtime.getManifest().version) });
      return;
    }

    // A stranger learns nothing about the wallet or its lock: refused at once, before any read.
    if (
      !WALLET_AGNOSTIC_METHODS.has(method) &&
      !(await getConnection(sender.origin || sender.url || ''))
    ) {
      sendResponse({
        success: false,
        error: { code: 'NOT_CONNECTED', message: 'Connect before this request.' },
      });
      return;
    }

    // A repeated request id joins the open review or reuses its answer, never opens a second one.
    let review: RequestReview | undefined;
    if (REVIEW_METHODS.has(method)) {
      const entry = await requestLifecycle.begin(message, sender);
      if (entry.kind === 'answer') {
        sendResponse(entry.response);
        return;
      }
      if (entry.kind === 'join') {
        sendResponse(await entry.response);
        return;
      }
      review = entry.review;
      const answer = sendResponse;
      sendResponse = (response?: any) => answer(review!.settle(response));
    }

    const requestOrigin = sender.origin || sender.url || '';
    if (
      review &&
      method !== 'connect' &&
      !(await getActiveWallet()) &&
      (await getConnection(requestOrigin))
    ) {
      const unlocked = await waitForUnlock(
        requestOrigin,
        review,
        'Unlock the 0xio extension, then try again.'
      );
      if (unlocked.ok === false) {
        sendResponse({ success: false, error: unlocked.error });
        return;
      }
    }
    // A site acts through the wallet it was connected with, active or not.
    let site: SiteWalletResult | null = null;
    if (!WALLET_AGNOSTIC_METHODS.has(method)) {
      site = await walletForOrigin(requestOrigin);
      if (site.status === 'gone') {
        sendResponse({ success: false, error: GONE_ERROR });
        return;
      }
    }

    if (PRIVATE_METHODS.has(method) && !(await activeNetworkHasPrivacy())) {
      sendResponse({
        success: false,
        error: {
          code: 'NOT_AVAILABLE',
          message: 'Private operations are not available on this network.',
        },
      });
      return;
    }

    if (PRIVATE_METHODS.has(method) && site && privateRequestRoute(site) === 'choose') {
      const chosen = await choosePrivateWallet(
        requestOrigin,
        method,
        site as Extract<SiteWalletResult, { status: 'ok' }>,
        await tabInfoFor(sender),
        review?.chooser()
      );
      if (chosen.ok === false) {
        sendResponse({
          success: false,
          error:
            chosen.error.code === 'REQUEST_PENDING'
              ? reviewPending(message, requestOrigin)
              : chosen.error,
        });
        return;
      }
    }

    switch (method) {
      case 'ping': {
        // Only connected origins learn whether a wallet is unlocked.
        const pingConnected = !!dappConnections.get(sender.origin || sender.url || '');
        const hasActiveWallet = pingConnected ? !!(await getActiveWallet()) : false;
        sendResponse({ success: true, data: { available: true, hasActiveWallet } });
        break;
      }

      case 'connect': {
        const offer = await desktopConnectOffer(sender);
        const toDesktop = (signal?: AbortSignal) =>
          desktopRelay.request(
            offer!.site,
            offer!.network,
            { method: 'connect', params: message.params, rid: message.rid },
            signal
          );
        const desktopAnswered = async (answer: RelayAnswer) => {
          if (answer.ok) {
            await setSiteSigner(offer!.site.origin, offer!.network, 'desktop');
            dappConnections.delete(offer!.site.origin);
            await removeDAppConnection(offer!.site.origin);
          }
          sendResponse(relayResponse(answer));
        };
        if (offer?.pick === 'desktop' && offer.available) {
          const answer = await toDesktop();
          if (!('error' in answer && answer.error.code === 'NETWORK_ERROR')) {
            await desktopAnswered(answer);
            return;
          }
          offer.available = false;
        }

        let connectWallet = await getActiveWallet();

        if (!connectWallet) {
          const unlocked = await waitForUnlock(
            requestOrigin,
            review,
            'Unlock the 0xio extension, then connect.'
          );
          if (unlocked.ok === false) {
            sendResponse({ success: false, error: unlocked.error });
            return;
          }
          connectWallet = unlocked.wallet;
        }

        const origin = sender.origin || sender.url;

        const existingConnection = await loadDAppConnection(origin);
        // A site already connected stays on its own wallet, whichever one is open.
        const connectedSite =
          existingConnection?.connected && offer?.pick !== 'desktop'
            ? await walletForOrigin(origin)
            : null;

        if (connectedSite?.status === 'ok' && connectedSite.bound) {
          const siteWallet = connectedSite.wallet;
          dappConnections.set(origin, existingConnection);
          const reconNetStorage = await chrome.storage.local.get([
            ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK,
          ]);
          const reconNetId =
            reconNetStorage[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet';
          const reconNetCfg =
            ZeroXIOConfig.NETWORKS[reconNetId as keyof typeof ZeroXIOConfig.NETWORKS] ||
            ZeroXIOConfig.NETWORKS.mainnet;
          sendResponse({
            success: true,
            data: {
              address: siteWallet.address,
              publicKey: siteWallet.publicKey,
              canSign: await canSignAddress(siteWallet.address, siteWallet.publicKey),
              balance: siteWallet.balance || '0.00',
              networkInfo: {
                id: reconNetId,
                name: reconNetCfg.name,
                rpcUrl: reconNetCfg.rpc_url,
                explorerUrl: httpOnly(reconNetCfg.explorer_url),
                explorerAddressUrl: reconNetCfg.explorer_address_url,
                indexerUrl: reconNetCfg.indexer_url,
                supportsPrivacy: reconNetCfg.supports_privacy,
                color: reconNetCfg.color,
                isTestnet: reconNetId === 'devnet',
              },
              permissions: existingConnection.permissions || [],
            },
          });
          return;
        }

        let tabInfo: Record<string, any> = {};
        try {
          const tab = await chrome.tabs.get(sender.tab.id);
          tabInfo = {
            title: tab.title,
            favicon: tab.favIconUrl,
            url: tab.url,
          };
        } catch (_e) {
          tabInfo = {
            title: new URL(origin).hostname,
            favicon: `${origin}/favicon.ico`,
            url: origin,
          };
        }

        const connNetStorage = await chrome.storage.local.get([
          ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK,
        ]);
        const connExtNetwork =
          connNetStorage[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet';
        const connDappNetwork = message.params?.networkId || null;

        logger.debug(
          `[Background] connect: showing approval popup - origin=${origin} addr=${connectWallet.address.slice(0, 10)}… network=${connExtNetwork}`
        );

        const rawReqPerms = message.params?.permissions || message.params?.requestPermissions || [];
        const requestedPermissions = Array.isArray(rawReqPerms)
          ? [
              ...new Set(
                rawReqPerms.filter(
                  (p: unknown): p is string =>
                    typeof p === 'string' && KNOWN_DAPP_PERMISSIONS.has(p)
                )
              ),
            ]
          : [];

        const offerDesktop = await offerAvailable(offer);
        const approvalResult = (await showConnectionApproval({
          review,
          origin,
          walletAddress: connectWallet.address,
          extensionNetwork: connExtNetwork,
          dappNetwork: connDappNetwork,
          networkMismatch: connDappNetwork && connDappNetwork !== connExtNetwork,
          permissions: requestedPermissions,
          ...tabInfo,
          ...(offerDesktop
            ? {
                signWith: {
                  available: offer!.available,
                  pick: offer!.pick === 'desktop' ? 'desktop' : 'browser',
                  network: offer!.network,
                },
                routeDesktop: toDesktop,
              }
            : {}),
        })) as ConnectAnswer;

        if (approvalResult && approvalResult.desktop) {
          await desktopAnswered(approvalResult.desktop);
          return;
        }

        if (!approvalResult || !approvalResult.approved) {
          logger.debug(`[Background] connect: rejected - origin=${origin}`);
          sendResponse({
            success: false,
            error: { code: 'USER_REJECTED', message: 'User rejected connection' },
          });
          return;
        }

        if (
          approvalResult.selectedAddress &&
          approvalResult.selectedAddress !== connectWallet.address
        ) {
          const allWallets = await walletStorage.loadAllWallets();
          const picked = allWallets.find((w) => w.address === approvalResult.selectedAddress);
          if (picked) {
            logger.debug(
              `[Background] connect: user switched wallet to ${picked.address.slice(0, 10)}…`
            );
            connectWallet = {
              id: picked.id,
              address: picked.address,
              publicKey: picked.publicKey,
              balance: '0.00',
              privateBalance: 0,
              name: picked.name,
            };
          }
        }

        const switchTo =
          connectWallet.address !== (await getActiveWallet())?.address ? connectWallet.id : null;

        const grantedPermissions = requestedPermissions;
        const connectionData = {
          address: connectWallet.address,
          publicKey: connectWallet.publicKey,
          connectedAt: Date.now(),
          connected: true,
          origin,
          appName: tabInfo.title,
          favicon: tabInfo.favicon,
          dappNetworkId: message.params?.networkId || null,
          permissions: grantedPermissions,
        };

        dappConnections.set(origin, connectionData);
        await persistDAppConnection(origin, connectionData);
        if (offerDesktop) await setSiteSigner(offer!.site.origin, offer!.network, 'browser');
        if (switchTo) await walletStorage.setActiveWallet(switchTo);

        logger.debug(
          `[Background] connect: approved - origin=${origin} addr=${connectWallet.address.slice(0, 10)}… network=${connExtNetwork} permissions=${JSON.stringify(grantedPermissions)}`
        );

        const connNetCfg =
          ZeroXIOConfig.NETWORKS[connExtNetwork as keyof typeof ZeroXIOConfig.NETWORKS] ||
          ZeroXIOConfig.NETWORKS.mainnet;

        sendResponse({
          success: true,
          data: {
            address: connectWallet.address,
            publicKey: connectWallet.publicKey,
            public_key: connectWallet.publicKey,
            canSign: await canSignAddress(connectWallet.address, connectWallet.publicKey),
            balance: connectWallet.balance || '0.00',
            networkInfo: {
              id: connExtNetwork,
              name: connNetCfg.name,
              rpcUrl: connNetCfg.rpc_url,
              explorerUrl: httpOnly(connNetCfg.explorer_url),
              explorerAddressUrl: connNetCfg.explorer_address_url,
              indexerUrl: connNetCfg.indexer_url,
              supportsPrivacy: connNetCfg.supports_privacy,
              color: connNetCfg.color,
              isTestnet: connExtNetwork === 'devnet',
            },
            permissions: grantedPermissions,
            wallet: 'oxio',
            version: chrome.runtime.getManifest().version,
          },
        });
        break;
      }

      case 'disconnect': {
        const disconnectOrigin = sender.origin || sender.url;
        dappConnections.delete(disconnectOrigin);
        await removeDAppConnection(disconnectOrigin);
        await requestLifecycle.dropOrigin(disconnectOrigin);
        sendResponse({
          success: true,
          data: { disconnected: true },
        });
        break;
      }

      case 'getAddress': {
        const addressOrigin = sender.origin || sender.url;
        if (!dappConnections.has(addressOrigin)) {
          sendResponse({
            success: false,
            error: 'Not connected. Call connect() first.',
          });
          return;
        }

        const conn = dappConnections.get(addressOrigin);
        sendResponse({
          success: true,
          data: { address: conn.address },
        });
        break;
      }

      case 'getBalance': {
        try {
          const balanceOrigin = sender.origin || sender.url;
          const balanceConn = dappConnections.get(balanceOrigin);
          if (!balanceConn || !balanceConn.address) {
            sendResponse({ success: false, error: 'Not connected' });
            break;
          }
          if (!(await requireUnlocked(sendResponse))) break;
          const balanceNetworkUrl = await txQueue.getNetworkUrl();
          const balanceResponse = await rpcFetch(`${balanceNetworkUrl}/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'octra_balance',
              params: [balanceConn.address],
              id: Date.now(),
            }),
            cache: 'no-store',
            credentials: 'omit',
          });

          if (balanceResponse.ok) {
            const rpc = await balanceResponse.json();

            let privateBalance = 0;
            try {
              const networkIdForCache =
                (await chrome.storage.local.get('0xio_current_network'))['0xio_current_network'] ||
                'mainnet';
              const cached = await readPrivateBalanceCache(networkIdForCache, balanceConn.address);
              if (cached?.privateBalance != null) {
                privateBalance = parseFloat(cached.privateBalance) || 0;
              } else {
                const walletInfo = await getActiveWallet();
                if (walletInfo && walletInfo.address === balanceConn.address) {
                  privateBalance = walletInfo.privateBalance || 0;
                  if (walletInfo.balance && typeof walletInfo.balance === 'object') {
                    privateBalance = walletInfo.balance.private || privateBalance;
                  }
                }
              }
            } catch (err) {
              logger.warn('Failed to fetch private balance context', err);
            }

            if (rpc.error) {
              sendResponse({
                success: true,
                data: {
                  balance: '0',
                  nonce: 0,
                  privateBalance: privateBalance,
                },
              });
            } else {
              const balanceData = rpc.result;
              sendResponse({
                success: true,
                data: {
                  balance: balanceData.balance || '0',
                  nonce: balanceData.nonce || 0,
                  privateBalance: privateBalance,
                },
              });
            }
          } else {
            logger.error(
              'Extension Fetch Failed:',
              balanceResponse.status,
              balanceResponse.statusText
            );
            const text = await balanceResponse.text();
            logger.error('Response Body:', text);
            sendResponse({
              success: false,
              error: `Failed to fetch balance: ${balanceResponse.status} ${balanceResponse.statusText}`,
            });
          }
        } catch (balanceError) {
          logger.error('DApp getBalance error:', balanceError);
          sendResponse({ success: false, error: balanceError.message });
        }
        break;
      }

      case 'getNetworkInfo':
      case 'get_network_info': {
        const networkStorage = await chrome.storage.local.get([
          ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK,
          ZeroXIOConfig.STORAGE.KEYS.CUSTOM_NETWORK,
        ]);

        const currentNetwork =
          networkStorage[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet';
        const networkConfig =
          ZeroXIOConfig.NETWORKS[currentNetwork as keyof typeof ZeroXIOConfig.NETWORKS] ||
          ZeroXIOConfig.NETWORKS.mainnet;
        let networkInfo = {
          id: currentNetwork,
          name: networkConfig.name,
          network: currentNetwork,
          rpc_url: networkConfig.rpc_url || ZeroXIOConfig.NETWORKS.mainnet.rpc_url,
          rpcUrl: networkConfig.rpc_url || ZeroXIOConfig.NETWORKS.mainnet.rpc_url,
          explorerUrl: httpOnly(networkConfig.explorer_url),
          explorerAddressUrl: networkConfig.explorer_address_url || '',
          indexerUrl: networkConfig.indexer_url || '',
          color: networkConfig.color,
          supportsPrivacy: true,
          isTestnet: currentNetwork === 'devnet',
        };

        if (isCustomNetworkId(currentNetwork)) {
          const net = await resolveCustomNetwork(currentNetwork);
          if (net) {
            networkInfo.name = net.name;
            networkInfo.rpc_url = net.rpc_url;
            networkInfo.rpcUrl = net.rpc_url;
            networkInfo.explorerUrl = httpOnly(net.explorer_url);
            networkInfo.explorerAddressUrl = net.explorer_address_url;
            networkInfo.indexerUrl = net.indexer_url;
            networkInfo.supportsPrivacy = net.supports_privacy;
          }
        }

        sendResponse({
          success: true,
          data: networkInfo,
        });
        break;
      }

      case 'switch_network': {
        if (!(await requireConnection(sender, sendResponse))) return;
        const requestedNetwork = message.params?.networkId;
        logger.info(`[Background] switch_network requested: ${requestedNetwork}`);
        const known =
          requestedNetwork &&
          (['mainnet', 'devnet'].includes(requestedNetwork) ||
            (isCustomNetworkId(requestedNetwork) &&
              (await resolveCustomNetwork(requestedNetwork)) !== null));
        if (!known) {
          logger.warn(
            `[Background] switch_network rejected: unsupported network ${requestedNetwork}`
          );
          sendResponse({ success: false, error: `Unsupported network: ${requestedNetwork}` });
          break;
        }
        const prevNetStorage = await chrome.storage.local.get([
          ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK,
        ]);
        const prevNetwork = prevNetStorage[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet';
        if (prevNetwork === requestedNetwork) {
          logger.debug(`[Background] switch_network: already on ${requestedNetwork}`);
          sendResponse({ success: true, data: { network: requestedNetwork, switched: false } });
          break;
        }
        // A site never moves the wallet to another network on its own: the user confirms it, and
        // never while one of the site's requests is waiting, which would then land on the other one.
        const swOrigin = sender.origin || sender.url;
        if (hasPendingApproval(swOrigin)) {
          sendResponse({ success: false, error: reviewPending(message, swOrigin) });
          break;
        }
        const networkName = async (id: string) =>
          id === 'mainnet' || id === 'devnet'
            ? ZeroXIOConfig.NETWORKS[id].name
            : ((await resolveCustomNetwork(id))?.name ?? id);
        let swTabInfo = {};
        try {
          const tab = await chrome.tabs.get(sender.tab.id);
          swTabInfo = { title: tab.title, favicon: tab.favIconUrl, url: tab.url };
        } catch (_e) {
          swTabInfo = { url: swOrigin };
        }
        const switchApproval = (await msgApprovalQueue.add({
          review,
          kind: 'network_switch',
          origin: swOrigin,
          fromName: await networkName(prevNetwork),
          toName: await networkName(requestedNetwork),
          ...swTabInfo,
        })) as { approved: boolean };
        if (!switchApproval.approved) {
          sendResponse({
            success: false,
            error: { code: 'USER_REJECTED', message: 'User rejected the network switch.' },
          });
          break;
        }
        await chrome.storage.local.set({
          [ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK]: requestedNetwork,
        });
        logger.info(`[Background] network switched: ${prevNetwork} -> ${requestedNetwork}`);
        // networkChanged goes to the connected sites only.
        const newNetCfg =
          ZeroXIOConfig.NETWORKS[requestedNetwork as keyof typeof ZeroXIOConfig.NETWORKS] ||
          ZeroXIOConfig.NETWORKS.mainnet;
        const newNetworkInfo = {
          id: requestedNetwork,
          name: newNetCfg.name,
          rpcUrl: newNetCfg.rpc_url,
          explorerUrl: httpOnly(newNetCfg.explorer_url),
          explorerAddressUrl: newNetCfg.explorer_address_url,
          indexerUrl: newNetCfg.indexer_url,
          supportsPrivacy: newNetCfg.supports_privacy,
          color: newNetCfg.color,
          isTestnet: requestedNetwork === 'devnet',
        };
        await sendEventToConnected({
          type: 'networkChanged',
          data: { networkInfo: newNetworkInfo },
        });
        sendResponse({ success: true, data: { network: requestedNetwork, switched: true } });
        break;
      }

      case 'getWalletInfo': {
        const walletInfo = site?.status === 'ok' ? site.wallet : null;
        if (!walletInfo) {
          sendResponse({
            success: false,
            error: 'No active wallet found',
          });
          return;
        }

        sendResponse({
          success: true,
          data: {
            address: walletInfo.address,
            canSign: await canSignAddress(walletInfo.address, walletInfo.publicKey),
            balance: walletInfo.balance || '0.00',
            privateBalance: walletInfo.privateBalance || 0,
          },
        });
        break;
      }

      case 'get_balance': {
        const balanceWallet = site?.status === 'ok' ? site.wallet : null;
        if (!balanceWallet) {
          sendResponse({
            success: false,
            error: 'No active wallet found',
          });
          return;
        }

        sendResponse({
          success: true,
          data: { balance: balanceWallet.balance || '0.00' },
        });
        break;
      }

      case 'register_dapp': {
        // The SDK registers before any connection exists, so this skips the connection gate;
        // nothing reads a registration record, so nothing is stored.
        const str = (v: unknown, max: number, fallback = '') =>
          typeof v === 'string' ? v.slice(0, max) : fallback;
        const rawPerms = message.params?.requiredPermissions;
        const registeredPermissions = Array.isArray(rawPerms)
          ? rawPerms.filter((p: unknown) => typeof p === 'string' && KNOWN_DAPP_PERMISSIONS.has(p))
          : [];
        sendResponse({
          success: true,
          data: {
            registered: true,
            appName: str(message.params?.appName, 64, 'Unknown DApp'),
            permissions: registeredPermissions,
            supportedFeatures: [
              'connect',
              'disconnect',
              'getBalance',
              'getWalletInfo',
              'ping',
              'send_transaction',
            ],
          },
        });
        break;
      }

      case 'getConnectionStatus': {
        const statusOrigin = sender.origin || sender.url || '';
        const found = desktopDown ? null : await getConnection(statusOrigin);
        // A connection whose wallet left the list is no connection: the site connects again.
        const connection =
          found && (await walletForOrigin(statusOrigin)).status !== 'gone' ? found : null;
        const isConn = !!connection;
        logger.debug(
          `[Background] getConnectionStatus: origin=${statusOrigin} connected=${isConn}${found && !isConn ? ' (wallet removed)' : ''}`
        );
        const statusNetStorage = await chrome.storage.local.get([
          ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK,
        ]);
        const currentNetworkId =
          statusNetStorage[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet';

        let statusBalance: any = null;
        if (isConn && connection?.address) {
          try {
            const netCfg =
              ZeroXIOConfig.NETWORKS[currentNetworkId as keyof typeof ZeroXIOConfig.NETWORKS] ||
              ZeroXIOConfig.NETWORKS.mainnet;
            const balResp = await rpcFetch(`${netCfg.rpc_url}/rpc`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'octra_balance',
                params: [connection.address],
                id: Date.now(),
              }),
              cache: 'no-store',
            });
            if (balResp.ok) {
              const rpc = await balResp.json();
              if (rpc.result) {
                statusBalance = {
                  public: parseFloat(rpc.result.balance || '0'),
                  private: 0,
                  total: parseFloat(rpc.result.balance || '0'),
                  currency: 'OCT',
                };
              }
            }
          } catch {}
        }

        const statusNetCfg =
          ZeroXIOConfig.NETWORKS[currentNetworkId as keyof typeof ZeroXIOConfig.NETWORKS] ||
          ZeroXIOConfig.NETWORKS.mainnet;
        const statusNetworkInfo = {
          id: currentNetworkId,
          name: statusNetCfg.name,
          rpcUrl: statusNetCfg.rpc_url,
          explorerUrl: httpOnly(statusNetCfg.explorer_url),
          explorerAddressUrl: statusNetCfg.explorer_address_url,
          indexerUrl: statusNetCfg.indexer_url,
          supportsPrivacy: statusNetCfg.supports_privacy,
          color: statusNetCfg.color,
          isTestnet: currentNetworkId === 'devnet',
        };

        sendResponse({
          success: true,
          data: isConn
            ? {
                connected: true,
                isConnected: true,
                address: connection.address || null,
                publicKey: connection.publicKey || null,
                canSign: connection.address
                  ? await canSignAddress(connection.address, connection.publicKey)
                  : undefined,
                connectedAt: connection.connectedAt || null,
                networkId: currentNetworkId,
                networkInfo: statusNetworkInfo,
                balance: statusBalance,
                permissions: connection.permissions || [],
              }
            : {
                connected: false,
                isConnected: false,
                networkId: currentNetworkId,
                networkInfo: statusNetworkInfo,
                permissions: [],
              },
        });
        break;
      }

      case 'send_transaction':
      case 'sendTransaction': {
        if (!(await requireConnection(sender, sendResponse))) return;
        const txPrep = await prepareSigner(requestOrigin, site);
        if (txPrep.ok === false) {
          sendResponse({ success: false, error: txPrep.error });
          return;
        }
        const txSigner = txPrep.signer;
        const networkUrl = txSigner.scope.rpcUrl;

        let txTabInfo: Record<string, string> = {};
        try {
          const tab = await chrome.tabs.get(sender.tab.id);
          txTabInfo = { title: tab.title, favicon: tab.favIconUrl, url: tab.url };
        } catch (_e) {
          const txOriginUrl = sender.origin || sender.url;
          txTabInfo = {
            title: new URL(txOriginUrl).hostname,
            favicon: `${txOriginUrl}/favicon.ico`,
            url: txOriginUrl,
          };
        }

        const _rawTxRequest = message.params || message.transaction;
        const _txRequest = (
          Array.isArray(_rawTxRequest) ? (_rawTxRequest[0] ?? {}) : (_rawTxRequest ?? {})
        ) as Record<string, any>;
        const txReq = normalizeSiteTx(_rawTxRequest);
        if (txReq.ok === false) {
          sendResponse({ success: false, error: { code: 'INVALID_PARAMS', message: txReq.error } });
          return;
        }
        const txFeeOp = txReq.tx.op_type === 'call' ? 'call' : 'transfer';
        const txFee = await siteFee(txFeeOp, _txRequest.ou, txSigner.scope);
        if (txFee.ok === false) {
          sendResponse({ success: false, error: txFee.error });
          return;
        }

        const txOrigin = sender.origin || sender.url;
        const txDappConn = dappConnections.get(txOrigin);
        const extensionNetwork = txSigner.scope.networkId;
        const dappNetwork = txDappConn?.dappNetworkId || message.params?.networkId || null;
        if (dappNetwork && dappNetwork !== extensionNetwork) {
          logger.warn(
            `[Background] network mismatch on send_transaction: dapp=${dappNetwork}, extension=${extensionNetwork}, origin=${txOrigin}`
          );
        }

        const approvalResult = (await txApprovalQueue.add({
          review,
          methods: 'send_transaction',
          origin: txOrigin,
          walletAddress: txSigner.address,
          networkUrl,
          params: { ...txReq.tx, ou: txFee.ou.toString() },
          extensionNetwork,
          networkId: txSigner.scope.networkId,
          dappNetwork,
          networkMismatch: dappNetwork && dappNetwork !== extensionNetwork,
          ...txTabInfo,
        })) as ApprovalAnswer;

        if (!approvalResult.approved) {
          sendResponse({
            success: false,
            error: {
              code: 'USER_REJECTED',
              message: 'User rejected the transaction.',
            },
          });
          return;
        }
        const txSettled = await settleSigner(
          requestOrigin,
          txSigner,
          approvalResult.selectedAddress
        );
        if (txSettled.ok === false) {
          sendResponse({ success: false, error: txSettled.error });
          return;
        }
        const txScope = txSettled.scope;

        const sessionKey = await passwordManager.getSessionKey();
        if (!sessionKey) {
          const skipped = await chrome.storage.local
            .get('passwordSkipped')
            .then((r) => r.passwordSkipped);
          if (!skipped) {
            sendResponse({
              success: false,
              error: { code: 'WALLET_LOCKED', message: 'Failed to unlock wallet.' },
            });
            return;
          }
        }

        try {
          const allWallets = await walletStorage.loadVault(sessionKey);
          const unlockedWallet = allWallets.find((w) => w.address === txSettled.address);
          if (!walletCanSign(unlockedWallet)) {
            sendResponse({ success: false, error: keyRefusal(unlockedWallet, GONE_ERROR) });
            return;
          }

          const txParams = txReq.tx;
          const txTo = txParams.to;
          const isContractSendTx = txParams.op_type === 'call';
          const amountUnits = BigInt(txParams.amount);
          const txOu = txFee.ou;
          const amountMicroOCT = txParams.amount;
          const amountOCT = Number(amountUnits) / 1_000_000;
          const txFeeRefusal = await reviewedFeeRefusal(txFeeOp, txOu, txScope);
          if (txFeeRefusal) {
            sendResponse({ success: false, error: txFeeRefusal });
            return;
          }

          const nonceInt = await networkService.getNextNonce(unlockedWallet.address, txScope);

          let signedTx: any;
          if (isContractSendTx) {
            signedTx = await networkService.buildContractCallTransaction({
              from: unlockedWallet.address,
              contract: txTo,
              method: txParams.method!,
              callParams: [],
              rawMessage: txParams.message!,
              amount: amountMicroOCT,
              nonce: nonceInt,
              ou: txOu.toString(),
              privateKey: unlockedWallet.privateKey,
              publicKey: unlockedWallet.publicKey,
            });
          } else {
            signedTx = await networkService.buildAndSignTransaction({
              from: unlockedWallet.address,
              to: txTo,
              amount: amountMicroOCT,
              amountInOCT: amountOCT,
              nonce: nonceInt,
              privateKey: unlockedWallet.privateKey,
              publicKey: unlockedWallet.publicKey,
              message: txParams.memo ?? '',
              ou: txOu.toString(),
            });
          }

          const txHash = localTxHash(signedTx) ?? '';

          const txUuid = crypto.randomUUID();
          const queueItem = {
            id: txUuid,
            txId: txUuid, // Must match so add() reuses same ID for pending_tx storage
            type: 'broadcast_only',
            opType: 'transfer' as const,
            signedTransaction: signedTx as unknown as Record<string, unknown>,

            from: signedTx.from,
            to: (signedTx as any).to || signedTx.to_,
            amount: amountOCT,
            nonce: signedTx.nonce,
            message: signedTx.message,
            timestamp: Date.now(),
            hash: txHash,
            txHash: txHash,
            scope: txScope,
          };

          txQueue
            .add(queueItem, txSiteOf(sender))
            .then(async (addResult) => {
              const txId = typeof addResult === 'string' ? addResult : addResult?.txId || addResult;
              const outcome = watchQueueFailure(addResult);
              // Wait for the broadcast outcome: a refusal must reach the site, not a hash
              let attempts = 0;
              const maxAttempts = 60;
              let finalHash = txHash;

              const checkHash = async () => {
                try {
                  const key = `pending_tx_${txId}`;
                  const result = await chrome.storage.local.get(key);
                  const txData = result[key];

                  if (txData && txData.serverHash) {
                    logger.debug(
                      `[Background] call_contract: found serverHash on attempt ${attempts}: ${txData.serverHash.slice(0, 16)}...`
                    );
                    return txData.serverHash;
                  }

                  if (
                    txData &&
                    (txData.status === 'completed' ||
                      txData.status === 'failed' ||
                      txData.confirmed)
                  ) {
                    return txData.hash;
                  }

                  if (txData && txData.hash && txData.hash !== txHash) {
                    return txData.hash;
                  }
                } catch (_e) {}
                return null;
              };

              while (attempts < maxAttempts && !outcome.failed) {
                const updatedHash = await checkHash();
                if (updatedHash) {
                  finalHash = updatedHash;
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
                attempts++;
              }
              if (outcome.failed) {
                sendResponse(queueFailureResponse(outcome.failed, txHash));
                return;
              }

              if (finalHash === txHash) {
                logger.warn(
                  `[Background] call_contract: server hash not found after ${attempts} attempts for txId=${txId}, using computed hash`
                );
              } else {
                logger.debug(
                  `[Background] call_contract: resolved real hash ${finalHash.slice(0, 16)}... (computed was ${txHash.slice(0, 16)}...)`
                );
              }
              sendResponse({
                success: true,
                data: { txId: { txId }, txHash: finalHash, success: true },
              });

              const connOrigin = sender.origin || sender.url;
              const connData = dappConnections.get(connOrigin);
              if (connData?.address) {
                setTimeout(() => refreshAndBroadcastBalance(connData.address), 2000);
              }
            })
            .catch((error) => {
              sendResponse({
                success: false,
                error: {
                  code: 'TRANSACTION_FAILED',
                  message: error.message,
                },
              });
            });
        } catch (err) {
          logger.error('[Background] Signing failed:', err);
          sendResponse({
            success: false,
            error: {
              code: 'TRANSACTION_FAILED',
              message: `Signing failed: ${err.message}`,
            },
          });
        }
        return true;
      }

      case 'contract_call_view':
      case 'contractCallView': {
        // Read only: nothing is signed, so no approval.
        const cvParams = message.params || {};
        if (!cvParams.contract || !cvParams.method) {
          sendResponse({
            success: false,
            error: { code: 'INVALID_PARAMS', message: 'contract and method are required' },
          });
          return;
        }
        try {
          // A connected origin's own wallet is the default caller, never another one.
          const cvConn = await getConnection(sender.origin || sender.url || '');
          const caller = cvParams.caller || cvConn?.address || '';
          const cvResult = await networkService.contractCallView(
            cvParams.contract,
            cvParams.method,
            cvParams.params || [],
            caller
          );
          sendResponse({
            success: true,
            data: {
              contract: cvParams.contract,
              method: cvParams.method,
              result: cvResult,
              stale: false,
            },
          });
        } catch (err) {
          sendResponse({
            success: false,
            error: { code: 'NETWORK_ERROR', message: err.message },
          });
        }
        return;
      }

      case 'get_contract_storage':
      case 'getContractStorage': {
        const csParams = message.params || {};
        if (!csParams.contract || !csParams.key) {
          sendResponse({
            success: false,
            error: { code: 'INVALID_PARAMS', message: 'contract and key are required' },
          });
          return;
        }
        try {
          const csResult = await networkService.getContractStorage(csParams.contract, csParams.key);
          sendResponse({ success: true, data: csResult });
        } catch (err) {
          sendResponse({
            success: false,
            error: { code: 'NETWORK_ERROR', message: err.message },
          });
        }
        return;
      }

      case 'call_contract':
      case 'callContract': {
        if (!(await requireConnection(sender, sendResponse))) return;
        const ccPrep = await prepareSigner(requestOrigin, site);
        if (ccPrep.ok === false) {
          sendResponse({ success: false, error: ccPrep.error });
          return;
        }
        const ccSigner = ccPrep.signer;

        const _rawCcParams = message.params || {};
        const ccRequest = Array.isArray(_rawCcParams) ? (_rawCcParams[0] ?? {}) : _rawCcParams;
        const ccReq = normalizeSiteCall(ccRequest);
        if (ccReq.ok === false) {
          sendResponse({ success: false, error: { code: 'INVALID_PARAMS', message: ccReq.error } });
          return;
        }
        const ccParams = ccReq.tx;

        const ccFee = await siteFee('call', ccRequest.ou, ccSigner.scope);
        if (ccFee.ok === false) {
          sendResponse({ success: false, error: ccFee.error });
          return;
        }
        const ccNetworkUrl = ccSigner.scope.rpcUrl;

        let ccTabInfo: Record<string, string> = {};
        try {
          const tab = await chrome.tabs.get(sender.tab.id);
          ccTabInfo = { title: tab.title, favicon: tab.favIconUrl, url: tab.url };
        } catch (_e) {
          const ccOriginUrl = sender.origin || sender.url;
          ccTabInfo = {
            title: new URL(ccOriginUrl).hostname,
            favicon: `${ccOriginUrl}/favicon.ico`,
            url: ccOriginUrl,
          };
        }

        const ccOrigin = sender.origin || sender.url;
        const ccDappConn = dappConnections.get(ccOrigin);
        const ccExtNetwork = ccSigner.scope.networkId;
        const ccDappNetwork = ccDappConn?.dappNetworkId || message.params?.networkId || null;
        if (ccDappNetwork && ccDappNetwork !== ccExtNetwork) {
          logger.warn(
            `[Background] network mismatch on call_contract: dapp=${ccDappNetwork}, extension=${ccExtNetwork}, origin=${ccOrigin}`
          );
        }

        const ccApprovalResult = (await txApprovalQueue.add({
          review,
          methods: 'call_contract',
          origin: ccOrigin,
          walletAddress: ccSigner.address,
          networkUrl: ccNetworkUrl,
          params: { ...ccParams, ou: ccFee.ou.toString() },
          extensionNetwork: ccExtNetwork,
          networkId: ccSigner.scope.networkId,
          dappNetwork: ccDappNetwork,
          networkMismatch: ccDappNetwork && ccDappNetwork !== ccExtNetwork,
          ...ccTabInfo,
        })) as ApprovalAnswer;

        if (!ccApprovalResult.approved) {
          sendResponse({
            success: false,
            error: { code: 'USER_REJECTED', message: 'User rejected the contract call.' },
          });
          return;
        }
        const ccSettled = await settleSigner(
          requestOrigin,
          ccSigner,
          ccApprovalResult.selectedAddress
        );
        if (ccSettled.ok === false) {
          sendResponse({ success: false, error: ccSettled.error });
          return;
        }
        const ccScope = ccSettled.scope;

        const ccSessionKey = await passwordManager.getSessionKey();
        if (!ccSessionKey) {
          const skipped = await chrome.storage.local
            .get('passwordSkipped')
            .then((r) => r.passwordSkipped);
          if (!skipped) {
            sendResponse({
              success: false,
              error: { code: 'WALLET_LOCKED', message: 'Failed to unlock wallet.' },
            });
            return;
          }
        }

        try {
          const allCcWallets = await walletStorage.loadVault(ccSessionKey);
          const unlockedCcWallet = allCcWallets.find((w) => w.address === ccSettled.address);
          if (!walletCanSign(unlockedCcWallet)) {
            sendResponse({ success: false, error: keyRefusal(unlockedCcWallet, GONE_ERROR) });
            return;
          }

          const ccOu = ccFee.ou;
          const ccFeeRefusal = await reviewedFeeRefusal('call', ccOu, ccScope);
          if (ccFeeRefusal) {
            sendResponse({ success: false, error: ccFeeRefusal });
            return;
          }
          const nonceInt = await networkService.getNextNonce(unlockedCcWallet.address, ccScope);

          const signedTx = await networkService.buildContractCallTransaction({
            from: unlockedCcWallet.address,
            contract: ccParams.to,
            method: ccParams.method!,
            callParams: [],
            rawMessage: ccParams.message!,
            amount: ccParams.amount,
            nonce: nonceInt,
            ou: ccOu.toString(),
            privateKey: unlockedCcWallet.privateKey,
            publicKey: unlockedCcWallet.publicKey,
          });

          const ccLocalHash = localTxHash(signedTx) ?? '';

          const ccTxUuid = crypto.randomUUID();
          const ccQueueItem = {
            id: ccTxUuid,
            txId: ccTxUuid,
            type: 'broadcast_only',
            opType: 'transfer' as const,
            signedTransaction: signedTx as unknown as Record<string, unknown>,
            from: signedTx.from,
            to: (signedTx as any).to_ || (signedTx as any).to,
            amount: 0,
            nonce: signedTx.nonce,
            message: `contract:${ccParams.method}`,
            timestamp: Date.now(),
            hash: ccLocalHash,
            txHash: ccLocalHash,
            scope: ccScope,
          };

          txQueue
            .add(ccQueueItem, txSiteOf(sender))
            .then(async (addResult) => {
              const txId = typeof addResult === 'string' ? addResult : addResult?.txId || addResult;
              const outcome = watchQueueFailure(addResult);
              // Wait for the broadcast outcome: a refusal must reach the site, not a hash
              let attempts = 0;
              const maxAttempts = 60;
              let finalHash = ccLocalHash;

              while (attempts < maxAttempts && !outcome.failed) {
                try {
                  const key = `pending_tx_${txId}`;
                  const result = await chrome.storage.local.get(key);
                  const txData = result[key];
                  if (txData?.serverHash) {
                    finalHash = txData.serverHash;
                    logger.debug(
                      `[Background] call_contract got serverHash: ${finalHash.slice(0, 16)}… (attempt ${attempts})`
                    );
                    break;
                  }
                  if (txData && (txData.status === 'completed' || txData.status === 'failed')) {
                    finalHash = txData.hash || ccLocalHash;
                    break;
                  }
                  if (txData?.hash && txData.hash !== ccLocalHash) {
                    finalHash = txData.hash;
                    break;
                  }
                } catch (_e) {}
                await new Promise((resolve) => setTimeout(resolve, 500));
                attempts++;
              }

              if (outcome.failed) {
                sendResponse(queueFailureResponse(outcome.failed, ccLocalHash));
                return;
              }
              if (finalHash === ccLocalHash) {
                logger.warn(
                  `[Background] call_contract: server hash not available after ${attempts} attempts, using computed hash`
                );
              }

              sendResponse({
                success: true,
                data: { txId, txHash: finalHash, success: true },
              });

              const ccOrigin = sender.origin || sender.url;
              const ccConn = dappConnections.get(ccOrigin);
              if (ccConn?.address) {
                setTimeout(() => refreshAndBroadcastBalance(ccConn.address), 2000);
              }
            })
            .catch((error) => {
              sendResponse({
                success: false,
                error: { code: 'CONTRACT_CALL_FAILED', message: error.message },
              });
            });
        } catch (err) {
          logger.error('[Background] Contract call signing failed:', err);
          sendResponse({
            success: false,
            error: {
              code: 'CONTRACT_CALL_FAILED',
              message: `Contract call failed: ${err.message}`,
            },
          });
        }
        return true;
      }

      case 'deploy_contract':
      case 'deployContract': {
        if (!(await requireConnection(sender, sendResponse))) return;
        const dpPrep = await prepareSigner(requestOrigin, site);
        if (dpPrep.ok === false) {
          sendResponse({ success: false, error: dpPrep.error });
          return;
        }
        const dpSigner = dpPrep.signer;

        const _rawDpParams = message.params || {};
        const dpParsed = parseDeployRequest(
          Array.isArray(_rawDpParams) ? (_rawDpParams[0] ?? {}) : _rawDpParams
        );
        if (dpParsed.ok === false) {
          sendResponse({
            success: false,
            error: { code: 'INVALID_PARAMS', message: dpParsed.error },
          });
          return;
        }
        const dpReq = dpParsed.request;

        const dpLiveOu = await liveDeployOu(dpReq.bytecodeB64, dpSigner.scope, dpReq.ou);
        if (dpLiveOu == null) {
          sendResponse({ success: false, error: FEE_UNAVAILABLE_REFUSAL });
          return;
        }
        const dpOu = dpLiveOu;
        let dpPreview: DeployPreview;
        try {
          dpPreview = await previewDeploy(dpReq.bytecodeB64, dpSigner.scope);
        } catch (err) {
          sendResponse({
            success: false,
            error: {
              code: 'DEPLOY_FAILED',
              message:
                `Could not prepare the deploy. Nothing was sent. ${err instanceof Error ? err.message : ''}`.trim(),
            },
          });
          return;
        }

        const dpConn = dappConnections.get(requestOrigin);
        const dpDappNetwork = dpConn?.dappNetworkId || null;
        const dpAnswer = (await txApprovalQueue.add({
          review,
          methods: 'deploy_contract',
          origin: requestOrigin,
          walletAddress: dpSigner.address,
          networkUrl: dpSigner.scope.rpcUrl,
          networkId: dpSigner.scope.networkId,
          extensionNetwork: dpSigner.scope.networkId,
          dappNetwork: dpDappNetwork,
          networkMismatch: !!dpDappNetwork && dpDappNetwork !== dpSigner.scope.networkId,
          params: {
            codeBytes: dpReq.codeBytes,
            contractAddress: dpPreview.contractAddress,
            constructorParams: dpReq.constructorParams,
            ou: dpOu.toString(),
          },
          ...(await tabInfoFor(sender)),
        })) as ApprovalAnswer;

        if (!dpAnswer.approved) {
          sendResponse({
            success: false,
            error: { code: 'USER_REJECTED', message: 'User rejected the deploy.' },
          });
          return;
        }
        // The address shown depends on the deployer: a deploy signs with the wallet it showed.
        if (dpAnswer.selectedAddress && dpAnswer.selectedAddress !== dpSigner.address) {
          sendResponse({
            success: false,
            error: {
              code: 'INVALID_PARAMS',
              message: 'A deploy signs with the wallet its review showed.',
            },
          });
          return;
        }
        const dpSettled = await settleSigner(requestOrigin, dpSigner, undefined);
        if (dpSettled.ok === false) {
          sendResponse({ success: false, error: dpSettled.error });
          return;
        }

        const dpSessionKey = await passwordManager.getSessionKey();
        if (!dpSessionKey) {
          const skipped = await chrome.storage.local
            .get('passwordSkipped')
            .then((r) => r.passwordSkipped);
          if (!skipped) {
            sendResponse({
              success: false,
              error: { code: 'WALLET_LOCKED', message: 'Failed to unlock wallet.' },
            });
            return;
          }
        }

        try {
          const dpWallet = (await walletStorage.loadVault(dpSessionKey)).find(
            (w) => w.address === dpSettled.address
          );
          if (!walletCanSign(dpWallet)) {
            sendResponse({ success: false, error: keyRefusal(dpWallet, GONE_ERROR) });
            return;
          }
          const dpFeeError = await deployFeeError(dpReq.bytecodeB64, dpOu, dpSettled.scope);
          if (dpFeeError) {
            sendResponse({
              success: false,
              error:
                dpFeeError === FEE_UNAVAILABLE_REFUSAL.message
                  ? FEE_UNAVAILABLE_REFUSAL
                  : { code: 'FEE_CHANGED', message: dpFeeError },
            });
            return;
          }
          const dpResult = await submitDeploy({
            scope: dpSettled.scope,
            privateKey: dpWallet.privateKey,
            publicKey: dpWallet.publicKey ?? undefined,
            bytecodeB64: dpReq.bytecodeB64,
            constructorParams: dpReq.constructorParams,
            ou: dpOu,
            reviewed: dpPreview,
          });
          const { outcomeUnknown: dpUnknown, ...dpData } = dpResult;
          sendResponse(
            dpUnknown
              ? unclearSubmitResponse(dpResult.txHash, {
                  contractAddress: dpResult.contractAddress,
                })
              : { success: true, data: { ...dpData, success: true } }
          );
          setTimeout(() => refreshAndBroadcastBalance(dpSettled.address), 2000);
        } catch (err) {
          logger.error('[Background] Deploy failed:', err);
          const code =
            err instanceof TxScopeError
              ? 'NETWORK_CHANGED'
              : err instanceof DeployChangedError
                ? err.code
                : 'DEPLOY_FAILED';
          sendResponse({
            success: false,
            error: { code, message: err instanceof Error ? err.message : 'Deploy failed' },
          });
        }
        return;
      }

      case 'signMessage': {
        const smOrigin = sender.origin || sender.url;
        if (!dappConnections.get(smOrigin)?.connected) {
          sendResponse({
            success: false,
            error: { code: 'NOT_CONNECTED', message: 'Connect before requesting a signature.' },
          });
          return;
        }
        const msgPrep = await prepareSigner(requestOrigin, site);
        if (msgPrep.ok === false) {
          sendResponse({ success: false, error: msgPrep.error });
          return;
        }
        const msgSigner = msgPrep.signer;

        const msgParams = message.params || message.transaction;
        const messageToSign = msgParams.message || msgParams.data;

        if (!messageToSign) {
          sendResponse({ success: false, error: 'Message content is required' });
          return;
        }
        if (typeof messageToSign !== 'string') {
          sendResponse({ success: false, error: 'Message must be text' });
          return;
        }

        let msgTabInfo = {};
        try {
          const tab = await chrome.tabs.get(sender.tab.id);
          msgTabInfo = {
            title: tab.title,
            favicon: tab.favIconUrl,
            url: tab.url,
          };
        } catch (_e) {
          msgTabInfo = {
            title: new URL(sender.origin || sender.url).hostname,
            favicon: `${sender.origin || sender.url}/favicon.ico`,
            url: sender.origin || sender.url,
          };
        }

        const msgApprovalResult = (await msgApprovalQueue.add({
          review,
          origin: sender.origin || sender.url,
          walletAddress: msgSigner.address,
          networkId: msgSigner.scope.networkId,
          message: messageToSign,
          ...msgTabInfo,
        })) as ApprovalAnswer;

        if (!msgApprovalResult.approved) {
          sendResponse({
            success: false,
            error: {
              code: 'USER_REJECTED',
              message: 'User rejected message signing.',
            },
          });
          return;
        }
        // A signature is not tied to a network: only the wallet behind it is re-checked.
        const msgSettled = await settleSigner(
          requestOrigin,
          { ...msgSigner, scope: { ...msgSigner.scope, ...(await resolveNetworkPin()) } },
          msgApprovalResult.selectedAddress
        );
        if (msgSettled.ok === false) {
          sendResponse({ success: false, error: msgSettled.error });
          return;
        }

        const msgSessionKey = await passwordManager.getSessionKey();

        if (!msgSessionKey) {
          const skipped = await chrome.storage.local
            .get('passwordSkipped')
            .then((r) => r.passwordSkipped);
          if (!skipped) {
            sendResponse({
              success: false,
              error: { code: 'WALLET_LOCKED', message: 'Failed to unlock wallet.' },
            });
            return;
          }
        }

        try {
          const allWallets = await walletStorage.loadVault(msgSessionKey);
          const unlockedWallet = allWallets.find((w) => w.address === msgSettled.address);

          if (!walletCanSign(unlockedWallet)) {
            sendResponse({ success: false, error: keyRefusal(unlockedWallet, GONE_ERROR) });
            return;
          }

          // A tx pre-image is JSON starting with '{', so the tag and byte length keep a signed
          // message from ever being a valid tx.
          const msgByteLen = new TextEncoder().encode(messageToSign).length;
          const framedMessage = `Octra Signed Message:\n${msgByteLen}\n${messageToSign}`;
          const signature = await networkService.signMessage(
            framedMessage,
            unlockedWallet.privateKey
          );

          sendResponse({
            success: true,
            data: { signature },
          });
        } catch (err) {
          logger.error('[Background] Message signing failed:', err);
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'getTransactionHistory':
      case 'get_transaction_history': {
        const histOrigin = sender.origin || sender.url;
        const histConn = dappConnections.get(histOrigin);
        const histAddr = histConn?.address;
        const histPage = message.params?.page || 1;
        const histLimit = message.params?.limit || 20;

        if (!histAddr) {
          sendResponse({
            success: true,
            data: { transactions: [], totalCount: 0, page: histPage, hasMore: false },
          });
          break;
        }

        try {
          const histNetUrl = await txQueue.getNetworkUrl();
          const histResp = await rpcFetch(`${histNetUrl}/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'octra_transactionsByAddress',
              params: [histAddr, histLimit, (histPage - 1) * histLimit],
              id: Date.now(),
            }),
            cache: 'no-store',
          });
          const histRpc = await histResp.json();
          const txs = histRpc.result?.transactions || [];
          sendResponse({
            success: true,
            data: {
              transactions: txs,
              totalCount: txs.length,
              page: histPage,
              hasMore: txs.length >= histLimit,
            },
          });
        } catch {
          sendResponse({
            success: true,
            data: { transactions: [], totalCount: 0, page: histPage, hasMore: false },
          });
        }
        break;
      }

      case 'getPublicKey': {
        const pkOrigin = sender.origin || sender.url;
        const pkConn = dappConnections.get(pkOrigin);
        if (!pkConn) {
          sendResponse({ success: false, error: 'Not connected. Call connect() first.' });
          break;
        }
        if (pkConn.publicKey) {
          sendResponse({ success: true, data: { publicKey: pkConn.publicKey } });
          break;
        }
        const pkWallet = (await walletStorage.loadAllWallets()).find(
          (w) => w.address === pkConn.address
        );
        sendResponse({
          success: false,
          error:
            pkWallet && !walletCanSign(pkWallet)
              ? { ...WATCH_ONLY_ERROR }
              : { code: 'NOT_AVAILABLE', message: 'Public key not available' },
        });
        break;
      }

      case 'get_private_balance_info': {
        try {
          const pbiOrigin = sender.origin || sender.url;
          const pbiConn = dappConnections.get(pbiOrigin);
          if (!pbiConn || !pbiConn.address) {
            sendResponse({ success: false, error: 'Not connected' });
            break;
          }
          if (!(await requireUnlocked(sendResponse))) break;
          let privateBalance = 0;
          const pbiNetworkId =
            (await chrome.storage.local.get('0xio_current_network'))['0xio_current_network'] ||
            'mainnet';
          const pbiCached = await readPrivateBalanceCache(pbiNetworkId, pbiConn.address);
          if (pbiCached?.privateBalance != null) {
            privateBalance = parseFloat(pbiCached.privateBalance) || 0;
          } else {
            const pbiWallet = await getActiveWallet();
            privateBalance = pbiWallet?.privateBalance || 0;
          }
          sendResponse({
            success: true,
            data: {
              hasPrivateBalance: privateBalance > 0,
              encryptedAmount: String(privateBalance),
              canDecrypt: privateBalance > 0,
            },
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'get_private_capabilities': {
        const privacy = await activeNetworkHasPrivacy();
        sendResponse({
          success: true,
          data: {
            wallet: 'oxio',
            version: chrome.runtime.getManifest().version,
            supports: {
              accounts: true,
              public_transactions: true,
              contract_calls: true,
              contract_views: true,
              raw_amounts: true,
              private_transfers: privacy,
              private_balance_read: privacy,
              private_claims: privacy,
              encrypt_value: privacy,
              decrypt_value: privacy,
              zero_proofs: privacy,
              range_proofs: privacy,
            },
            methods: [
              'octra_requestAccounts',
              'octra_getPrivateCapabilities',
              'octra_sendTransaction',
              'octra_signTransaction',
              'octra_signMessage',
              'octra_callContractView',
              'octra_sendContractTransaction',
              'octra_sendContractTransactionSequence',
              'octra_sendPrivateTransfer',
              'octra_claimPrivateTransfer',
              'octra_getPrivateBalance',
              'octra_encryptValue',
              'octra_decryptValue',
              'octra_makeZeroProof',
              'octra_makeRangeProof',
              'octra_registerPrivateViewKey',
            ],
            required_permissions: {
              contract_views: ['contract_calls'],
              private_transfers: ['private_transfers'],
              private_balance_read: ['private_balance_read'],
              encrypt_value: ['private_proofs'],
              decrypt_value: ['private_balance_read'],
              zero_proofs: ['private_proofs'],
              range_proofs: ['private_proofs'],
              private_claims: ['private_claims'],
            },
          },
        });
        break;
      }

      case 'encrypt_value': {
        const kr = await resolveDappPvacKey(sender, 'private_proofs');
        if (!kr.ok) {
          sendResponse({ success: false, error: kr.error });
          break;
        }
        try {
          const valueRaw = dappRawInt(message.params);
          await pvacManager.ensureOffscreenReady(kr.privateKey!);
          const { cipherBytes, commitmentBytes } = await pvacManager.encryptRawAsync(valueRaw);
          sendResponse({
            success: true,
            data: {
              cipher: 'hfhe_v1|' + bytesToBase64(cipherBytes),
              commitment: bytesToBase64(commitmentBytes),
              encoding: 'hfhe_v1',
            },
          });
        } catch (err) {
          sendResponse({
            success: false,
            error: { code: 'PRIVATE_PROOF_FAILED', message: err.message },
          });
        }
        break;
      }

      case 'decrypt_value': {
        const kr = await resolveDappPvacKey(sender, 'private_balance_read');
        if (!kr.ok) {
          sendResponse({ success: false, error: kr.error });
          break;
        }
        try {
          const cipher = String(message.params?.cipher || '');
          if (!cipher) throw new Error('Missing cipher');
          await pvacManager.ensureOffscreenReady(kr.privateKey!);
          const value = await pvacManager.decryptAsync(cipher);
          sendResponse({
            success: true,
            data: { value_raw: String(value), display: String(value), decimals: 6 },
          });
        } catch (err) {
          sendResponse({
            success: false,
            error: { code: 'PRIVATE_PROOF_FAILED', message: err.message },
          });
        }
        break;
      }

      case 'make_zero_proof': {
        const kr = await resolveDappPvacKey(sender, 'private_proofs');
        if (!kr.ok) {
          sendResponse({ success: false, error: kr.error });
          break;
        }
        try {
          const cipher = String(message.params?.cipher || '');
          if (!cipher) throw new Error('Missing cipher');
          const valueRaw = dappRawInt(message.params);
          await pvacManager.ensureOffscreenReady(kr.privateKey!);
          // The verifier needs the Pedersen commitment and blinding beside the bound proof.
          const blinding = crypto.getRandomValues(new Uint8Array(32));
          const cipherBytes = pvacManager.getCipherBytes(cipher);
          const commitment = await pvacManager.pedersenCommitAsync(valueRaw, blinding);
          const zpScope = await captureTxScope(kr.wallet!.address);
          const policy = await proofPolicyFor(zpScope.address, zpScope);
          const proof = await pvacManager.makeBoundProof(cipherBytes, valueRaw, blinding, policy);
          sendResponse({
            success: true,
            data: {
              proof,
              commitment,
              blinding: bytesToBase64(blinding),
              encoding: 'zkzp_v2',
            },
          });
        } catch (err) {
          sendResponse({
            success: false,
            error: { code: 'PRIVATE_PROOF_FAILED', message: err.message },
          });
        }
        break;
      }

      case 'make_range_proof': {
        const kr = await resolveDappPvacKey(sender, 'private_proofs');
        if (!kr.ok) {
          sendResponse({ success: false, error: kr.error });
          break;
        }
        try {
          const cipher = String(message.params?.cipher || '');
          if (!cipher) throw new Error('Missing cipher');
          const valueRaw = dappRawInt(message.params);
          await pvacManager.ensureOffscreenReady(kr.privateKey!);
          const cipherBytes = pvacManager.getCipherBytes(cipher);
          const proof = await pvacManager.makeRangeProof(cipherBytes, valueRaw);
          sendResponse({ success: true, data: { proof, encoding: 'rp_v1' } });
        } catch (err) {
          sendResponse({
            success: false,
            error: { code: 'PRIVATE_PROOF_FAILED', message: err.message },
          });
        }
        break;
      }

      case 'get_private_balance': {
        const kr = await resolveDappPvacKey(sender, 'private_balance_read');
        if (!kr.ok) {
          sendResponse({ success: false, error: kr.error });
          break;
        }
        try {
          await pvacManager.ensureOffscreenReady(kr.privateKey!);
          const cipher = await privacyNetworkService.fetchCipherOnly(
            kr.wallet!.address,
            kr.privateKey!,
            ''
          );
          let valueRaw = 0;
          if (cipher) valueRaw = await pvacManager.decryptAsync(cipher);
          sendResponse({
            success: true,
            data: {
              address: kr.wallet!.address,
              private_oct_raw: String(valueRaw),
              private_oct: valueRaw / 1_000_000,
              tokens: [],
            },
          });
        } catch (err) {
          sendResponse({
            success: false,
            error: { code: 'PRIVATE_PROOF_FAILED', message: err.message },
          });
        }
        break;
      }

      case 'register_private_view_key': {
        if (!(await requireConnection(sender, sendResponse))) return;
        const rvWallet = await getActiveWallet();
        if (!rvWallet) {
          sendResponse({
            success: false,
            error: { code: 'WALLET_LOCKED', message: 'No active wallet found.' },
          });
          return;
        }
        const rvOrigin = sender.origin || sender.url;
        const rvTarget = message.params?.address || rvWallet.address;
        if (rvTarget !== rvWallet.address) {
          sendResponse({
            success: false,
            error: {
              code: 'INVALID_PARAMS',
              message: "Can only register the connected wallet's view key.",
            },
          });
          return;
        }
        if (offSiteWallet(rvOrigin, rvWallet.address, sendResponse)) return;
        const rvConn = dappConnections.get(rvOrigin);
        if (!rvConn?.permissions?.includes('private_transfers')) {
          sendResponse({
            success: false,
            error: { code: 'PERMISSION_DENIED', message: 'private_transfers permission required.' },
          });
          return;
        }

        const rvScope = await captureTxScope(rvWallet.address);
        const rvSessionKey = await passwordManager.getSessionKey();
        const rvUnlocked = rvSessionKey
          ? (await walletStorage.loadVault(rvSessionKey)).find(
              (w) => w.address === rvWallet.address || w.id === rvWallet.id
            )
          : null;
        if (!walletCanSign(rvUnlocked)) {
          sendResponse({ success: false, error: keyRefusal(rvUnlocked, NO_KEY_ERROR) });
          return;
        }

        let rvLocalPvac: string;
        let rvRemotePvac: string | null;
        let rvViewPubkey: string | null;
        try {
          await pvacManager.ensureOffscreenReady(rvUnlocked.privateKey);
          rvLocalPvac = await pvacManager.getPublicKeyAsync();
          rvRemotePvac = await privacyNetworkService.getPvacPubkey(rvWallet.address, rvScope);
          rvViewPubkey = await readViewPubkey(rvWallet.address, rvScope);
        } catch (err) {
          sendResponse({
            success: false,
            error: {
              code: 'NETWORK_ERROR',
              message: `Could not read the key status: ${err.message}`,
            },
          });
          return;
        }
        if (rvRemotePvac && rvRemotePvac === rvLocalPvac && rvViewPubkey) {
          sendResponse({
            success: true,
            data: { status: 'registered', view_pubkey: rvViewPubkey, pvac: true },
          });
          return;
        }
        if (rvRemotePvac && rvRemotePvac !== rvLocalPvac) {
          sendResponse({
            success: false,
            error: {
              code: 'PVAC_KEY_MISMATCH',
              message: 'This wallet holds another private key on chain. Update it in 0xio first.',
            },
          });
          return;
        }
        if (await getPendingKeySwitch(rvScope)) {
          sendResponse({
            success: false,
            error: {
              code: 'REGISTRATION_PENDING',
              message: 'A key registration is waiting for confirmation. Try again shortly.',
            },
          });
          return;
        }

        const rvOu = await privacyNetworkService.getKeySwitchFeeQuote('recommended', rvScope);
        if (!rvOu) {
          sendResponse({ success: false, error: FEE_UNAVAILABLE_REFUSAL });
          return;
        }
        const rvBalance = await readBalanceRaw(rvWallet.address, rvScope).catch((): null => null);
        if (rvBalance == null) {
          sendResponse({
            success: false,
            error: { code: 'NETWORK_ERROR', message: 'Could not read the balance.' },
          });
          return;
        }
        if (rvBalance < BigInt(rvOu)) {
          sendResponse({
            success: false,
            error: {
              code: 'INSUFFICIENT_BALANCE',
              message: 'The balance does not cover the key registration fee.',
            },
          });
          return;
        }

        const rvApproval = (await txApprovalQueue.add({
          review,
          methods: 'register_private_view_key',
          origin: rvOrigin,
          walletAddress: rvWallet.address,
          networkUrl: rvScope.rpcUrl,
          networkId: rvScope.networkId,
          params: { address: rvWallet.address, ou: rvOu },
          ...(await tabInfoFor(sender)),
        })) as ApprovalAnswer;
        if (!rvApproval.approved) {
          sendResponse({
            success: false,
            error: { code: 'USER_REJECTED', message: 'User rejected the view key registration.' },
          });
          return;
        }
        if (refusesPick(rvApproval, rvWallet.address, sendResponse)) return;
        if (!(await approvedScopeStillCurrent(rvScope, sendResponse))) return;
        const rvFeeError = reviewedFeeError(
          BigInt(rvOu),
          await networkService.getRecommendedFeeStrict('key_switch', rvScope)
        );
        if (rvFeeError) {
          sendResponse({
            success: false,
            error:
              rvFeeError === FEE_UNAVAILABLE
                ? FEE_UNAVAILABLE_REFUSAL
                : { code: 'FEE_CHANGED', message: rvFeeError },
          });
          return;
        }

        try {
          const signed = await privacyNetworkService.signKeySwitch(
            rvUnlocked.address,
            rvLocalPvac,
            rvUnlocked.privateKey,
            rvUnlocked.publicKey ?? null,
            undefined,
            'recommended',
            rvOu,
            rvScope
          );
          const rvTxId = crypto.randomUUID();
          const { broadcastResult } = await txQueue.add(
            {
              id: rvTxId,
              txId: rvTxId,
              type: 'broadcast_only',
              opType: 'key_switch',
              signedTransaction: signed.signedTx as unknown as Record<string, unknown>,
              from: rvUnlocked.address,
              to: rvUnlocked.address,
              amount: 0,
              scope: signed.scope,
            },
            txSiteOf(sender)
          );
          const sent = await broadcastResult;
          const rvLocalHash = localTxHash(signed.signedTx);
          const rvHash = sent?.success ? sent.txHash : sent?.outcomeUnknown ? rvLocalHash : null;
          if (!rvHash) {
            if (sent?.errorType) {
              networkService.releaseNonce(rvUnlocked.address, signed.nonce, rvScope.networkId);
            }
            sendResponse(
              queueFailureResponse(sent ?? { success: false, error: 'Key registration failed' })
            );
            return;
          }
          await recordPendingKeySwitch(rvScope, rvHash);
          void clearKeySwitchWhenFinal(rvScope, rvHash);
          sendResponse({
            success: true,
            data: {
              status: 'submitted',
              txHash: rvHash,
              hash: rvHash,
              address: rvUnlocked.address,
              ...(sent?.success ? {} : { outcome: 'unknown' }),
            },
          });
        } catch (err) {
          sendResponse({
            success: false,
            error: {
              code: err instanceof TxScopeError ? 'NETWORK_CHANGED' : 'TRANSACTION_FAILED',
              message: err.message,
            },
          });
        }
        break;
      }

      case 'send_contract_transaction_sequence': {
        const seqPrep = await prepareSigner(requestOrigin, site);
        if (seqPrep.ok === false) {
          sendResponse({ success: false, error: seqPrep.error });
          return;
        }
        const seqSigner = seqPrep.signer;
        const seqOrigin = sender.origin || sender.url;
        const seqConn = dappConnections.get(seqOrigin);
        // As with a single contract call, connection plus approval is the gate: no separate
        // contract_calls permission.
        if (!seqConn) {
          sendResponse({
            success: false,
            error: { code: 'NOT_CONNECTED', message: 'Origin is not connected.' },
          });
          return;
        }
        const _rawSeq = (message.params || {}) as Record<string, any>;
        const seqTxns = _rawSeq.transactions;
        if (!Array.isArray(seqTxns) || seqTxns.length === 0) {
          sendResponse({
            success: false,
            error: { code: 'INVALID_PARAMS', message: 'Missing transactions[].' },
          });
          return;
        }
        const seqCalls: SiteTx[] = [];
        for (let i = 0; i < seqTxns.length; i++) {
          const step = normalizeSiteCall(seqTxns[i]);
          if (step.ok === false) {
            sendResponse({
              success: false,
              error: { code: 'INVALID_PARAMS', message: `Step ${i}: ${step.error}` },
            });
            return;
          }
          seqCalls.push(step.tx);
        }

        const seqQuote = await networkService.getRecommendedFeeStrict('call', seqSigner.scope);
        const seqOus = seqTxns.map((t: any) => siteFeeOu(t?.ou, seqQuote));
        if (seqOus.some((ou) => ou == null)) {
          sendResponse({ success: false, error: FEE_UNAVAILABLE_REFUSAL });
          return;
        }
        const seqSteps = seqCalls.map((t, i) => ({ ...t, ou: seqOus[i]!.toString() }));
        const seqNetworkUrl = seqSigner.scope.rpcUrl;
        let seqTabInfo: Record<string, string> = {};
        try {
          const tab = await chrome.tabs.get(sender.tab.id);
          seqTabInfo = { title: tab.title, favicon: tab.favIconUrl, url: tab.url };
        } catch (_e) {
          seqTabInfo = {
            title: new URL(seqOrigin).hostname,
            favicon: `${seqOrigin}/favicon.ico`,
            url: seqOrigin,
          };
        }

        // One approval covers the whole sequence.
        const seqApproval = (await txApprovalQueue.add({
          review,
          methods: 'send_contract_transaction_sequence',
          origin: seqOrigin,
          walletAddress: seqSigner.address,
          networkUrl: seqNetworkUrl,
          networkId: seqSigner.scope.networkId,
          params: { transactions: seqSteps },
          ...seqTabInfo,
        })) as ApprovalAnswer;
        if (!seqApproval.approved) {
          sendResponse({
            success: false,
            error: { code: 'USER_REJECTED', message: 'User rejected the contract sequence.' },
          });
          return;
        }
        const seqSettled = await settleSigner(
          requestOrigin,
          seqSigner,
          seqApproval.selectedAddress
        );
        if (seqSettled.ok === false) {
          sendResponse({ success: false, error: seqSettled.error });
          return;
        }
        const seqScope = seqSettled.scope;

        const seqResults: { index: number; txHash: string; outcome?: 'unknown' }[] = [];
        try {
          const seqSessionKey = await passwordManager.getSessionKey();
          if (!seqSessionKey) {
            sendResponse({
              success: false,
              error: { code: 'WALLET_LOCKED', message: 'Failed to unlock wallet.' },
            });
            return;
          }
          const seqAllWallets = await walletStorage.loadVault(seqSessionKey);
          const seqUnlocked = seqAllWallets.find((w) => w.address === seqSettled.address);
          if (!walletCanSign(seqUnlocked)) {
            sendResponse({ success: false, error: keyRefusal(seqUnlocked, GONE_ERROR) });
            return;
          }

          const seqLowest = seqOus.reduce((a, b) => (b! < a! ? b : a))!;
          const seqFeeRefusal = await reviewedFeeRefusal('call', seqLowest, seqScope);
          if (seqFeeRefusal) {
            sendResponse({ success: false, error: seqFeeRefusal });
            return;
          }
          // Nonces count up locally: earlier steps are not on chain yet, so a per-step
          // getNextNonce would collide.
          const baseNonce = await networkService.getNextNonce(seqUnlocked.address, seqScope);
          let seqStopped: { index: number; reason: string } | null = null;
          for (let i = 0; i < seqCalls.length; i++) {
            const t = seqCalls[i];
            const tOu = seqOus[i]!;
            const signedTx = await networkService.buildContractCallTransaction({
              from: seqUnlocked.address,
              contract: t.to,
              method: t.method!,
              callParams: [],
              rawMessage: t.message!,
              amount: t.amount,
              nonce: baseNonce + i,
              ou: tOu.toString(),
              privateKey: seqUnlocked.privateKey,
              publicKey: seqUnlocked.publicKey,
            });
            const local = localTxHash(signedTx);
            let submitRes: any;
            try {
              // Each step re-checks the scope: a switch mid-sequence stops it, never re-targets it.
              submitRes = await networkService.jsonRpcCall(
                'octra_submit',
                [signedTx],
                undefined,
                seqScope
              );
            } catch (e) {
              if (!isSubmitVerdict(e) && local) {
                seqResults.push({ index: i, txHash: local, outcome: 'unknown' });
                seqStopped = { index: i, reason: 'outcome_unknown' };
                break;
              }
              if (!seqResults.length) throw e;
              seqStopped = { index: i, reason: e.message };
              break;
            }
            const hash = submitRes?.tx_hash || submitRes?.hash;
            if (!hash) {
              const reason = `Step ${i} (${t.method}): ${submitRes?.error?.reason || 'submit rejected'}`;
              if (submitRes?.status !== 'rejected' && local) {
                seqResults.push({ index: i, txHash: local, outcome: 'unknown' });
                seqStopped = { index: i, reason: 'outcome_unknown' };
                break;
              }
              if (!seqResults.length) throw new Error(reason);
              seqStopped = { index: i, reason };
              break;
            }
            seqResults.push({ index: i, txHash: hash });
          }
          sendResponse({
            success: true,
            data: {
              sequence_id: _rawSeq.sequence_id,
              status: 'submitted',
              results: seqResults,
              ...(seqStopped
                ? { stopped: seqStopped, completed: seqResults.length, total: seqCalls.length }
                : {}),
            },
          });
          setTimeout(() => refreshAndBroadcastBalance(seqUnlocked.address), 2000);
        } catch (err) {
          sendResponse({
            success: false,
            error: {
              code: 'CONTRACT_CALL_FAILED',
              message: `${err.message} (completed ${seqResults.length}/${seqTxns.length})`,
            },
          });
        }
        break;
      }

      case 'encrypt_balance':
      case 'decrypt_balance':
        sendResponse({
          success: false,
          error: {
            code: 'NOT_AVAILABLE',
            message: `'${method}' is not yet available via the dApp SDK. Please use the 0xio Wallet extension directly.`,
          },
        });
        break;

      case 'send_private_transfer': {
        const ptWallet = await getActiveWallet();
        if (!ptWallet) {
          sendResponse({
            success: false,
            error: { code: 'WALLET_LOCKED', message: 'No active wallet found.' },
          });
          return;
        }

        const ptOrigin = sender.origin || sender.url;
        if (offSiteWallet(ptOrigin, ptWallet.address, sendResponse)) return;
        const ptConn = dappConnections.get(ptOrigin);
        if (!ptConn?.permissions?.includes('private_transfers')) {
          sendResponse({
            success: false,
            error: { code: 'PERMISSION_DENIED', message: 'private_transfers permission required.' },
          });
          return;
        }

        const ptReq = normalizeSitePrivateTransfer(message.params);
        if (ptReq.ok === false || ptReq.tx.to === ptWallet.address) {
          sendResponse({
            success: false,
            error: {
              code: 'INVALID_PARAMS',
              message: ptReq.ok === false ? ptReq.error : 'Invalid recipient address.',
            },
          });
          return;
        }
        const ptTx = ptReq.tx;
        // The fee the user approves is the fee that gets paid, and it is always read live: no
        // quote, no review and nothing signed.
        const ptScope = await captureTxScope(ptWallet.address);
        const ptFee = await siteFee('stealth', message.params?.ou, ptScope);
        if (ptFee.ok === false) {
          sendResponse({ success: false, error: ptFee.error });
          return;
        }
        const ptOu = ptFee.ou;
        const ptNetworkUrl = ptScope.rpcUrl;
        let ptTabInfo: Record<string, string> = {};
        try {
          const tab = await chrome.tabs.get(sender.tab.id);
          ptTabInfo = { title: tab.title, favicon: tab.favIconUrl, url: tab.url };
        } catch (_e) {
          ptTabInfo = {
            title: new URL(ptOrigin).hostname,
            favicon: `${ptOrigin}/favicon.ico`,
            url: ptOrigin,
          };
        }

        const ptApproval = (await txApprovalQueue.add({
          review,
          methods: 'send_private_transfer',
          origin: ptOrigin,
          walletAddress: ptWallet.address,
          networkUrl: ptNetworkUrl,
          networkId: ptScope.networkId,
          params: { ...ptTx, ou: ptOu.toString() },
          ...ptTabInfo,
        })) as ApprovalAnswer;

        if (!ptApproval.approved) {
          sendResponse({
            success: false,
            error: { code: 'USER_REJECTED', message: 'User rejected the private transfer.' },
          });
          return;
        }
        if (refusesPick(ptApproval, ptWallet.address, sendResponse)) return;
        if (!(await approvedScopeStillCurrent(ptScope, sendResponse))) return;

        try {
          const ptSessionKey = await passwordManager.getSessionKey();
          if (!ptSessionKey) {
            sendResponse({
              success: false,
              error: { code: 'WALLET_LOCKED', message: 'Failed to unlock wallet.' },
            });
            return;
          }

          const ptAllWallets = await walletStorage.loadVault(ptSessionKey);
          const ptUnlocked = ptAllWallets.find(
            (w) => w.address === ptWallet.address || w.id === ptWallet.id
          );
          if (!walletCanSign(ptUnlocked)) {
            sendResponse({ success: false, error: keyRefusal(ptUnlocked, NO_KEY_ERROR) });
            return;
          }

          const { to, asset } = ptTx;
          const amountRaw = Number(ptTx.amount_raw);

          const ptFeeRefusal = await reviewedFeeRefusal('stealth', ptOu, ptScope);
          if (ptFeeRefusal) {
            sendResponse({ success: false, error: ptFeeRefusal });
            return;
          }

          const ptBlocker = await privacyNetworkService.privateSpendBlocker(
            ptUnlocked.address,
            ptUnlocked.privateKey,
            ptScope
          );
          if (ptBlocker) {
            sendResponse({
              success: false,
              error: { code: 'PRIVATE_TRANSFER_FAILED', message: ptBlocker },
            });
            return;
          }

          const result = await privacyNetworkService.createPrivateTransfer(
            ptUnlocked.address,
            to,
            amountRaw,
            ptUnlocked.privateKey,
            ptOu.toString(),
            ptScope
          );

          if (result.success) {
            setTimeout(() => refreshAndBroadcastBalance(ptUnlocked.address), 2000);
            sendResponse({
              success: true,
              data: {
                txHash: result.txHash,
                hash: result.txHash,
                to,
                amount_raw: String(amountRaw),
                asset: asset || 'OCT',
                status: 'submitted',
              },
            });
          } else if ('outcomeUnknown' in result && result.outcomeUnknown && result.txHash) {
            sendResponse(
              unclearSubmitResponse(result.txHash, {
                to,
                amount_raw: String(amountRaw),
                asset: asset || 'OCT',
              })
            );
          } else {
            const msg = result.error || 'Private transfer failed';
            const code = /view ?pubkey|not registered|register first/i.test(msg)
              ? 'RECIPIENT_NOT_REGISTERED'
              : 'PRIVATE_TRANSFER_FAILED';
            sendResponse({ success: false, error: { code, message: msg } });
          }
        } catch (err) {
          sendResponse({
            success: false,
            error: { code: 'PRIVATE_TRANSFER_FAILED', message: err.message },
          });
        }
        break;
      }

      case 'get_pending_private_transfers': {
        // Private data: the connection needs private_balance_read, and the scan needs the key to
        // tell this wallet's outputs from everyone else's.
        const kr = await resolveDappPvacKey(sender, 'private_balance_read');
        if (!kr.ok) {
          sendResponse({ success: false, error: kr.error });
          break;
        }
        try {
          const result = await privacyNetworkService.getPendingPrivateTransfers(
            kr.wallet!.address,
            kr.privateKey!
          );
          if (!result.success) throw new Error(result.error || 'Could not read pending transfers');
          sendResponse({ success: true, data: result.transfers });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case 'claim_private_transfer': {
        const clWallet = await getActiveWallet();
        if (!clWallet) {
          sendResponse({
            success: false,
            error: { code: 'WALLET_LOCKED', message: 'No active wallet found.' },
          });
          return;
        }

        const clOrigin = sender.origin || sender.url;
        if (offSiteWallet(clOrigin, clWallet.address, sendResponse)) return;
        const clConn = dappConnections.get(clOrigin);
        if (
          !clConn?.permissions?.includes('private_claims') &&
          !clConn?.permissions?.includes('private_transfers')
        ) {
          sendResponse({
            success: false,
            error: {
              code: 'PERMISSION_DENIED',
              message: 'private_claims or private_transfers permission required.',
            },
          });
          return;
        }

        const clTransferId = String(message.params?.transferId ?? '');
        if (!clTransferId || clTransferId.length > 256) {
          sendResponse({
            success: false,
            error: { code: 'INVALID_PARAMS', message: 'transferId is required.' },
          });
          return;
        }
        const clScope = await captureTxScope(clWallet.address);
        const clFee = await siteFee('claim', message.params?.ou, clScope);
        if (clFee.ok === false) {
          sendResponse({ success: false, error: clFee.error });
          return;
        }
        const clOu = clFee.ou;

        // The review shows what the claim adds: read before it opens, never after approval.
        const clSession = await passwordManager.getSessionKey();
        const clPreviewWallet = clSession
          ? (await walletStorage.loadVault(clSession)).find(
              (w) => w.address === clWallet.address || w.id === clWallet.id
            )
          : null;
        if (clSession && !walletCanSign(clPreviewWallet)) {
          sendResponse({ success: false, error: keyRefusal(clPreviewWallet, NO_KEY_ERROR) });
          return;
        }
        const clPreviewKey = clPreviewWallet?.privateKey ?? null;
        const clEarlier = await privacyNetworkService.earlierClaim(
          clWallet.address,
          clTransferId,
          clScope
        );
        if (clEarlier) {
          sendResponse(
            'txHash' in clEarlier
              ? {
                  success: true,
                  data: { claimed_count: 1, tx_hashes: [clEarlier.txHash], status: 'submitted' },
                }
              : { success: false, error: { code: clEarlier.code, message: clEarlier.error } }
          );
          return;
        }
        const clAmount = await privacyNetworkService.claimableAmount(
          clWallet.address,
          clPreviewKey,
          clTransferId,
          clScope
        );
        if (clAmount.ok === false) {
          sendResponse({
            success: false,
            error: {
              code: clAmount.locked
                ? 'WALLET_LOCKED'
                : (clAmount.code ?? 'PRIVATE_TRANSFER_FAILED'),
              message: clAmount.error,
            },
          });
          return;
        }

        // A claim is a signed, fee-paying transaction that grows the balance cipher: it gets the
        // same per-request approval as every other write.
        {
          const clNetworkUrl = clScope.rpcUrl;
          let clTabInfo: Record<string, string> = {};
          try {
            const tab = await chrome.tabs.get(sender.tab.id);
            clTabInfo = { title: tab.title, favicon: tab.favIconUrl, url: tab.url };
          } catch (_e) {
            clTabInfo = {
              title: new URL(clOrigin).hostname,
              favicon: `${clOrigin}/favicon.ico`,
              url: clOrigin,
            };
          }
          const clApproval = (await txApprovalQueue.add({
            review,
            methods: 'claim_private_transfer',
            origin: clOrigin,
            walletAddress: clWallet.address,
            networkUrl: clNetworkUrl,
            networkId: clScope.networkId,
            params: {
              ...paramsWithFee(message.params || {}, clOu),
              amount_raw: String(clAmount.amount),
              count: 1,
            },
            ...clTabInfo,
          })) as ApprovalAnswer;
          if (!clApproval.approved) {
            sendResponse({
              success: false,
              error: { code: 'USER_REJECTED', message: 'User rejected the claim.' },
            });
            return;
          }
          if (refusesPick(clApproval, clWallet.address, sendResponse)) return;
        }
        if (!(await approvedScopeStillCurrent(clScope, sendResponse))) return;

        try {
          let clSessionKey = await passwordManager.getSessionKey();
          if (!clSessionKey) {
            sendResponse({
              success: false,
              error: { code: 'WALLET_LOCKED', message: 'Wallet locked.' },
            });
            return;
          }

          const clAllWallets = await walletStorage.loadVault(clSessionKey);
          const clUnlocked = clAllWallets.find(
            (w) => w.address === clWallet.address || w.id === clWallet.id
          );
          if (!walletCanSign(clUnlocked)) {
            sendResponse({ success: false, error: keyRefusal(clUnlocked, NO_KEY_ERROR) });
            return;
          }

          const clFeeRefusal = await reviewedFeeRefusal('claim', clOu, clScope);
          if (clFeeRefusal) {
            sendResponse({ success: false, error: clFeeRefusal });
            return;
          }

          const result = await privacyNetworkService.claimPrivateTransfer(
            clUnlocked.address,
            clUnlocked.privateKey,
            clTransferId,
            clOu.toString(),
            clScope
          );

          if (result.success) {
            setTimeout(() => refreshAndBroadcastBalance(clUnlocked.address), 2000);
            sendResponse({
              success: true,
              data: {
                claimed_count: 1,
                tx_hashes: result.txHash ? [result.txHash] : [],
                status: 'submitted',
              },
            });
          } else if ('outcomeUnknown' in result && result.outcomeUnknown && result.txHash) {
            sendResponse(
              unclearSubmitResponse(result.txHash, {
                claimed_count: 1,
                tx_hashes: [result.txHash],
              })
            );
          } else {
            sendResponse({
              success: false,
              error: {
                code: result.code ?? 'PRIVATE_TRANSFER_FAILED',
                message: result.error || 'Claim failed',
              },
            });
          }
        } catch (err) {
          sendResponse({
            success: false,
            error: { code: 'PRIVATE_TRANSFER_FAILED', message: err.message },
          });
        }
        break;
      }

      case 'sign_transaction':
      case 'signTransaction': {
        if (!(await requireConnection(sender, sendResponse))) return;
        const stPrep = await prepareSigner(requestOrigin, site);
        if (stPrep.ok === false) {
          sendResponse({ success: false, error: stPrep.error });
          return;
        }
        const stSigner = stPrep.signer;
        const networkUrl = stSigner.scope.rpcUrl;
        let stTabInfo: Record<string, string> = {};
        try {
          const tab = await chrome.tabs.get(sender.tab.id);
          stTabInfo = { title: tab.title, favicon: tab.favIconUrl, url: tab.url };
        } catch (_e) {
          const stOriginUrl = sender.origin || sender.url;
          stTabInfo = {
            title: new URL(stOriginUrl).hostname,
            favicon: `${stOriginUrl}/favicon.ico`,
            url: stOriginUrl,
          };
        }
        const stOrigin = sender.origin || sender.url;

        const _rawStParamsEarly = message.params || message.transaction || {};
        const stParamsEarly = Array.isArray(_rawStParamsEarly)
          ? (_rawStParamsEarly[0] ?? {})
          : _rawStParamsEarly;
        const stReq = normalizeSiteTx(stParamsEarly);
        if (stReq.ok === false) {
          sendResponse({ success: false, error: { code: 'INVALID_PARAMS', message: stReq.error } });
          return;
        }
        const stParams = stReq.tx;
        const stFeeOp = stParams.op_type === 'call' ? 'call' : 'transfer';
        const stFee = await siteFee(stFeeOp, stParamsEarly.ou, stSigner.scope);
        if (stFee.ok === false) {
          sendResponse({ success: false, error: stFee.error });
          return;
        }

        const stApproval = (await txApprovalQueue.add({
          review,
          methods: 'sign_transaction',
          origin: stOrigin,
          walletAddress: stSigner.address,
          networkUrl,
          networkId: stSigner.scope.networkId,
          params: { ...stParams, ou: stFee.ou.toString() },
          ...stTabInfo,
        })) as ApprovalAnswer;
        if (!stApproval.approved) {
          sendResponse({
            success: false,
            error: { code: 'USER_REJECTED', message: 'User rejected the request.' },
          });
          return;
        }
        const stSettled = await settleSigner(requestOrigin, stSigner, stApproval.selectedAddress);
        if (stSettled.ok === false) {
          sendResponse({ success: false, error: stSettled.error });
          return;
        }
        const stScope = stSettled.scope;
        const stKey = await passwordManager.getSessionKey();
        if (!stKey) {
          const skipped = await chrome.storage.local
            .get('passwordSkipped')
            .then((r) => r.passwordSkipped);
          if (!skipped) {
            sendResponse({
              success: false,
              error: { code: 'WALLET_LOCKED', message: 'Failed to unlock wallet.' },
            });
            return;
          }
        }
        try {
          const allWallets = await walletStorage.loadVault(stKey);
          const stUnlocked = allWallets.find((w) => w.address === stSettled.address);
          if (!walletCanSign(stUnlocked)) {
            sendResponse({ success: false, error: keyRefusal(stUnlocked, GONE_ERROR) });
            return;
          }
          const stTo = stParams.to;
          const stUnits = BigInt(stParams.amount);
          const stAmtMicro = Number(stUnits);
          const stOu = stFee.ou;
          const stFeeRefusal = await reviewedFeeRefusal(stFeeOp, stOu, stScope);
          if (stFeeRefusal) {
            sendResponse({ success: false, error: stFeeRefusal });
            return;
          }
          const stNonce = await networkService.getNextNonce(stUnlocked.address, stScope);

          let signedTx: any;
          if (stParams.op_type === 'call') {
            signedTx = await networkService.buildContractCallTransaction({
              from: stUnlocked.address,
              contract: stTo,
              method: stParams.method!,
              callParams: [],
              rawMessage: stParams.message!,
              amount: stUnits.toString(),
              nonce: stNonce,
              ou: stOu.toString(),
              privateKey: stUnlocked.privateKey,
              publicKey: stUnlocked.publicKey,
            });
          } else {
            signedTx = await networkService.buildAndSignTransaction({
              from: stUnlocked.address,
              to: stTo,
              amount: stUnits.toString(),
              amountInOCT: stAmtMicro / 1_000_000,
              nonce: stNonce,
              privateKey: stUnlocked.privateKey,
              publicKey: stUnlocked.publicKey,
              message: stParams.memo ?? '',
              ou: stOu.toString(),
            });
          }
          sendResponse({ success: true, data: { signedTx } });
        } catch (err) {
          sendResponse({ success: false, error: { code: 'SIGN_FAILED', message: err.message } });
        }
        return true;
      }

      case 'broadcast_only': {
        const boConn = await requireConnection(sender, sendResponse);
        if (!boConn) return;
        const boSignedTx =
          message.params?.signedTx || message.params?.transaction || message.params;
        if (!boSignedTx || !boSignedTx.signature) {
          sendResponse({
            success: false,
            error: { code: 'INVALID_PARAMS', message: 'signedTx with signature is required' },
          });
          return;
        }
        // The wallet relays and records only its own transactions: a foreign `from` would show
        // up in History as the user's pending send.
        if (boSignedTx.from !== boConn.address) {
          sendResponse({
            success: false,
            error: {
              code: 'INVALID_PARAMS',
              message: 'signedTx.from must be the connected address.',
            },
          });
          return;
        }
        try {
          const txHash = localTxHash(boSignedTx) ?? '';
          const boUuid = crypto.randomUUID();
          const boItem = {
            id: boUuid,
            txId: boUuid,
            type: 'broadcast_only',
            opType: 'transfer' as const,
            signedTransaction: boSignedTx,
            from: boSignedTx.from,
            to: boSignedTx.to_ || boSignedTx.to,
            amount: 0,
            nonce: boSignedTx.nonce,
            message: boSignedTx.message || '',
            timestamp: Date.now(),
            hash: txHash,
            txHash,
          };
          txQueue
            .add(boItem, txSiteOf(sender))
            .then(async (addResult) => {
              const txId = typeof addResult === 'string' ? addResult : addResult?.txId || addResult;
              const outcome = watchQueueFailure(addResult);
              let attempts = 0;
              let finalHash = txHash;
              while (attempts < 60 && !outcome.failed) {
                try {
                  const res = await chrome.storage.local.get(`pending_tx_${txId}`);
                  const td = res[`pending_tx_${txId}`];
                  if (td?.serverHash || (td?.hash && td.hash !== txHash) || td?.confirmed) {
                    finalHash = td.serverHash || td.hash || txHash;
                    break;
                  }
                } catch (_e) {}
                await new Promise((r) => setTimeout(r, 500));
                attempts++;
              }
              if (outcome.failed) {
                sendResponse(queueFailureResponse(outcome.failed, txHash));
                return;
              }
              sendResponse({ success: true, data: { txHash: finalHash } });
            })
            .catch((err) =>
              sendResponse({
                success: false,
                error: { code: 'TRANSACTION_FAILED', message: err.message },
              })
            );
        } catch (err) {
          sendResponse({
            success: false,
            error: { code: 'TRANSACTION_FAILED', message: err.message },
          });
        }
        return true;
      }

      case 'rpc_call': {
        const rpcMethod = message.params?.method;
        const rpcParams = message.params?.params;
        if (!rpcMethod || typeof rpcMethod !== 'string') {
          sendResponse({
            success: false,
            error: { code: 'INVALID_PARAMS', message: 'rpc method is required' },
          });
          return;
        }
        if (!RPC_CALL_ALLOWED_METHODS.has(rpcMethod)) {
          sendResponse({
            success: false,
            error: {
              code: 'METHOD_NOT_ALLOWED',
              message: `rpc_call does not permit '${rpcMethod}'`,
            },
          });
          return;
        }
        try {
          const rpcNetworkUrl = await txQueue.getNetworkUrl();
          const rpcResp = await rpcFetch(`${rpcNetworkUrl}/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: rpcMethod,
              params: rpcParams ?? [],
              id: Date.now(),
            }),
            cache: 'no-store',
          });
          const rpcJson = await rpcResp.json();
          if (rpcJson.error) {
            sendResponse({
              success: false,
              error: {
                code: 'NETWORK_ERROR',
                message: rpcJson.error.message || JSON.stringify(rpcJson.error),
              },
            });
          } else {
            sendResponse({ success: true, data: rpcJson.result });
          }
        } catch (err) {
          sendResponse({ success: false, error: { code: 'NETWORK_ERROR', message: err.message } });
        }
        return;
      }

      default:
        sendResponse({
          success: false,
          error: `Method '${method}' not supported`,
        });
    }
  } catch (error) {
    sendResponse({
      success: false,
      error: error.message,
    });
  }
}
