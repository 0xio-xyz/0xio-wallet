// Wallet traffic rides a private MessageChannel handed to the MAIN world before page scripts run,
// so a page can neither read nor forge it. Needs Chrome 111+ (world: "MAIN").

import {
  OCTRA_PER_SECOND,
  RATE_LIMITED_RESPONSE,
  dappRequestMessage,
  rateWindow,
} from './pageRelay';

// Lets the SDK reject forged answers on the window.postMessage path.
const SESSION_NONCE = crypto.randomUUID();

// Internal message types a page must never reach; the worker's own switch is the real boundary.
const BLOCKED_METHODS = new Set([
  'QUEUE_TRANSACTION',
  'QUEUE_BULK_TRANSACTIONS',
  'GET_QUEUE_STATUS',
  'CLEAR_QUEUE_HISTORY',
  'CANCEL_QUEUED',
  'ENSURE_PVAC_OFFSCREEN',
  'CLOSE_PVAC_OFFSCREEN',
  'GET_APPROVAL_DATA',
  'GET_ALL_WALLETS',
  'BROADCAST_WALLET_LOCKED',
  'BROADCAST_WALLET_UNLOCKED',
  'DAPP_APPROVAL_RESPONSE',
  'TRANSACTION_APPROVAL_RESPONSE',
  'MESSAGE_APPROVAL_RESPONSE',
  'NETWORK_REQUEST',
  'EVM_APPROVAL_DATA',
  'EVM_APPROVAL_RESPONSE',
  'EVM_SITE_DISCONNECT',
  'DAPP_APPROVAL_DESKTOP',
  'DESKTOP_SITE_DISCONNECT',
  'DESKTOP_SITE_MOVE',
  'SITE_PAGE_GONE',
]);

const EVM_PREFIXES = ['eth_', 'net_', 'wallet_', 'personal_', 'web3_'];
const isEvmMethod = (method: unknown) =>
  typeof method === 'string' &&
  method !== 'wallet_hello' &&
  EVM_PREFIXES.some((p) => method.startsWith(p));
const evmRate = rateWindow(200);
const octraRate = rateWindow(OCTRA_PER_SECOND);

const pendingRequests = new Map<string, number>();
let octraTalked = false;

const { port1, port2 } = new MessageChannel();
port1.start();

window.postMessage({ source: '0xio-port-init', nonce: SESSION_NONCE }, window.location.origin, [
  port2,
]);

port1.onmessage = async (event) => {
  const { requestId, method } = event.data;

  if (!requestId) return;
  if (pendingRequests.has(requestId)) return;

  const now = Date.now();
  if (isEvmMethod(method)) {
    if (!evmRate.take(now)) {
      port1.postMessage({
        requestId,
        response: {
          success: false,
          error: { code: -32005, message: 'Too many requests from this page. Retry shortly.' },
        },
      });
      return;
    }
  } else if (!octraRate.take(now)) {
    port1.postMessage({ requestId, response: RATE_LIMITED_RESPONSE });
    return;
  }

  if (!method || BLOCKED_METHODS.has(method)) return;

  pendingRequests.set(requestId, now);
  if (!isEvmMethod(method)) octraTalked = true;

  for (const [id, timestamp] of pendingRequests.entries()) {
    if (now - timestamp > 30000) {
      pendingRequests.delete(id);
    }
  }

  try {
    const response = await chrome.runtime.sendMessage(dappRequestMessage(event.data));

    port1.postMessage({ requestId, response });
  } catch (error) {
    const msg = (error as Error).message || 'Request failed';
    const isInvalidated =
      msg.includes('Extension context invalidated') ||
      msg.includes('Could not establish connection');
    port1.postMessage({
      requestId,
      response: {
        success: false,
        error: isInvalidated
          ? {
              code: 'EXTENSION_NOT_FOUND',
              message: 'Extension was reloaded. Please refresh the page to reconnect.',
            }
          : msg,
      },
    });
  } finally {
    pendingRequests.delete(requestId);
  }
};

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'WALLET_EVENT' && message.origin === window.location.origin) {
    port1.postMessage({
      type: 'event',
      eventData: message.eventData,
    });
  } else if (message.type === 'EVM_EVENT' && message.data?.origin === window.location.origin) {
    port1.postMessage({ type: 'evm_event', evmData: message.data });
  }
});

window.addEventListener('pagehide', (event) => {
  if (!event.isTrusted || !octraTalked) return;
  try {
    chrome.runtime.sendMessage({ type: 'SITE_PAGE_GONE' }).catch(() => {});
  } catch {}
});
