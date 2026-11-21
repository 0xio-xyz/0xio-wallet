// A site on 0xio Desktop never falls back to signing in this browser.

import { walletStorage } from 'src/services/wallet/WalletStorage';
import type { ConnectAnswer } from '../services/approvals';
import {
  dappConnections,
  getConnection,
  persistDAppConnection,
  sendEventToOrigins,
  showConnectionApproval,
} from '../services/dappConnections';
import { desktopRelay, isRid, type DesktopRelay, type RelayAnswer } from '../services/desktopRelay';
import { canSignAddress } from '../services/signingKey';
import { relayableOrigin, siteOfSender, type SenderSite } from '../services/siteOrigin';
import {
  DESKTOP_NETWORKS,
  currentNetwork,
  setSiteSigner,
  siteSigner,
  siteSigners,
  type SiteSigner,
} from '../services/siteSigner';
import { getActiveWallet } from '../services/wallet';

export const DESKTOP_METHODS = new Set([
  'connect',
  'disconnect',
  'getAddress',
  'getBalance',
  'get_balance',
  'getWalletInfo',
  'getPublicKey',
  'getNetworkInfo',
  'get_network_info',
  'getConnectionStatus',
  'switch_network',
  'send_transaction',
  'sendTransaction',
  'call_contract',
  'callContract',
  'contract_call_view',
  'contractCallView',
  'get_contract_storage',
  'getContractStorage',
  'deploy_contract',
  'deployContract',
  'signMessage',
  'sign_transaction',
  'signTransaction',
  'broadcast_only',
  'send_contract_transaction_sequence',
  'getTransactionHistory',
  'get_transaction_history',
  'rpc_call',
  'get_private_balance_info',
  'get_private_capabilities',
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

export const relayResponse = (answer: RelayAnswer) => ({
  ...('error' in answer
    ? { success: false, error: answer.error }
    : { success: true, data: answer.result }),
  ...(answer.rid ? { rid: answer.rid } : {}),
  ...(answer.status ? { status: answer.status } : {}),
});

const LIFECYCLE_READS = new Set(['request_status', 'cancel_request']);

export const PRE_CONNECT_READS = new Set([
  'getConnectionStatus',
  'getNetworkInfo',
  'get_network_info',
]);

const ANSWERED_HERE = new Set(['ping', 'connect', 'register_dapp']);

const unreachable = (a: RelayAnswer) => 'error' in a && a.error.code === 'NETWORK_ERROR';

export async function desktopNetworkOf(
  origin: string,
  network: string,
  relay: DesktopRelay = desktopRelay
): Promise<string | null> {
  const all = await siteSigners(origin);
  if (all[network] === 'desktop') return network;
  if (all[network] === 'browser') return null;
  const elsewhere = [...DESKTOP_NETWORKS].filter((n) => all[n] === 'desktop');
  if (!elsewhere.length || (await getConnection(origin))) return null;
  const latest = (relay.knownSites ?? [])
    .filter((s) => s.origin === origin && elsewhere.includes(s.network))
    .sort((a, b) => b.connectedAt - a.connectedAt)[0];
  return latest?.network ?? elsewhere[0];
}

export type SiteRoute = 'answered' | 'local' | 'desktop-down';

export async function routeSiteToDesktop(
  message: { method: string; params?: unknown },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
  relay: DesktopRelay = desktopRelay
): Promise<SiteRoute> {
  const { method } = message;
  if (ANSWERED_HERE.has(method)) return 'local';
  const site = siteOfSender(sender);
  if (!site) return 'local';
  const network = await desktopNetworkOf(site.origin, await currentNetwork(), relay);
  if (!network) return 'local';
  if (method === 'wallet_hello' && (await relay.ensure())) {
    const wallet = await relay.wallet();
    if (wallet.protocol >= 2) {
      sendResponse({
        success: true,
        data: { protocol: 2, kind: wallet.kind, capabilities: [...wallet.capabilities] },
      });
      return 'answered';
    }
  }
  if (LIFECYCLE_READS.has(method)) {
    if (!(await relay.ensure()) || (await relay.protocol()) < 2) return 'local';
    const rid = (message.params as { rid?: unknown } | undefined)?.rid;
    if (!isRid(rid)) {
      sendResponse({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'rid must be 32 lowercase hex characters.' },
      });
      return 'answered';
    }
    const answer =
      method === 'request_status' ? await relay.status(site, rid) : await relay.cancel(site, rid);
    if (unreachable(answer)) return 'local';
    sendResponse(relayResponse(answer));
    return 'answered';
  }
  if (!DESKTOP_METHODS.has(method)) {
    sendResponse({
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'This site signs on 0xio Desktop.' },
    });
    return 'answered';
  }
  if (PRE_CONNECT_READS.has(method)) {
    if (!(await relay.ensure())) return 'desktop-down';
    const answer = await relay.request(site, network, message);
    if (unreachable(answer)) return 'desktop-down';
    sendResponse(relayResponse(answer));
    return 'answered';
  }
  sendResponse(relayResponse(await relay.request(site, network, message)));
  return 'answered';
}

export interface DesktopOffer {
  site: SenderSite;
  network: string;
  pick: SiteSigner | undefined;
  available: boolean;
}

export async function desktopConnectOffer(
  sender: chrome.runtime.MessageSender,
  relay: DesktopRelay = desktopRelay
): Promise<DesktopOffer | null> {
  const site = siteOfSender(sender);
  if (!site) return null;
  const current = await currentNetwork();
  const routed = await desktopNetworkOf(site.origin, current, relay);
  const network = routed ?? current;
  if (!DESKTOP_NETWORKS.has(network)) return null;
  const pick = routed ? 'desktop' : await siteSigner(site.origin, network);
  const available = pick === 'desktop' ? await relay.ensure(true) : false;
  return { site, network, pick, available };
}

export async function offerAvailable(
  offer: DesktopOffer | null,
  relay: DesktopRelay = desktopRelay
): Promise<boolean> {
  if (!offer) return false;
  if (!offer.available && offer.pick !== 'desktop') offer.available = await relay.ensure();
  return offer.available || offer.pick === 'desktop';
}

const hostOf = (origin: string) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
};

export async function moveSiteToBrowser(
  origin: string,
  network: string,
  relay: DesktopRelay = desktopRelay
): Promise<boolean> {
  const site = relayableOrigin(origin);
  if (!site) return false;
  await setSiteSigner(site, network, 'browser');
  await relay.disconnectSite(site, network);
  const wallet = await getActiveWallet();
  const answer = wallet
    ? ((await showConnectionApproval({
        origin: site,
        walletAddress: wallet.address,
        extensionNetwork: network,
        dappNetwork: null,
        networkMismatch: false,
        permissions: [],
        title: hostOf(site),
        favicon: `${site}/favicon.ico`,
        url: site,
      })) as ConnectAnswer)
    : false;
  if (!wallet || !answer || !answer.approved) {
    await sendEventToOrigins([site], { type: 'disconnect', data: { origin: site } });
    return true;
  }
  const all = await walletStorage.loadAllWallets();
  const picked =
    all.find((w) => w.address === (answer.selectedAddress || wallet.address)) ?? wallet;
  const connection = {
    address: picked.address,
    publicKey: picked.publicKey,
    connectedAt: Date.now(),
    connected: true,
    origin: site,
    appName: hostOf(site),
    favicon: `${site}/favicon.ico`,
    dappNetworkId: null as string | null,
    permissions: [] as string[],
  };
  dappConnections.set(site, connection);
  await persistDAppConnection(site, connection);
  await sendEventToOrigins([site], {
    type: 'accountChanged',
    data: {
      address: picked.address,
      publicKey: picked.publicKey,
      canSign: await canSignAddress(picked.address, picked.publicKey),
    },
  });
  return true;
}
