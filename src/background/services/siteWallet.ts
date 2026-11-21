// A connected site stays on its own wallet; switching the open wallet never moves it. It moves
// only when the user picks another wallet for it on a request.

import { walletStorage } from 'src/services/wallet/WalletStorage';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import {
  captureSiteTxScope,
  captureTxScope,
  txScopeMismatch,
  type TxScope,
} from 'src/services/network/txScope';
import { connectionKey, getConnection, moveConnections } from './dappConnections';
import { getActiveWallet } from './wallet';
import { msgApprovalQueue, type ReviewHooks } from './approvals';
import { isOctAddress } from '../../utils/octra/address';
import { WATCH_ONLY_ERROR, walletCanSign } from './signingKey';

export interface SiteWallet {
  id: string;
  address: string;
  publicKey: string | null;
  name: string;
  balance: string;
  privateBalance: number;
}

export type SiteWalletResult =
  | { status: 'ok'; wallet: SiteWallet; bound: boolean; activeAddress: string }
  | { status: 'locked' }
  | { status: 'gone' };

export interface DappError {
  code: string;
  message: string;
}

export type Settled<T> = ({ ok: true } & T) | { ok: false; error: DappError };

export interface Signer {
  address: string;
  bound: boolean;
  scope: TxScope;
}

export const GONE_ERROR: DappError = {
  code: 'NOT_CONNECTED',
  message: 'The wallet this site was connected to is no longer in 0xio. Connect again.',
};

const LOCKED_ERROR: DappError = {
  code: 'WALLET_LOCKED',
  message: 'No active wallet found. Please unlock your wallet.',
};

export async function walletForOrigin(origin: string): Promise<SiteWalletResult> {
  const active = await getActiveWallet();
  if (!active) return { status: 'locked' };
  const activeSite: SiteWallet = {
    id: active.id,
    address: active.address,
    publicKey: active.publicKey ?? null,
    name: active.name || 'Wallet',
    balance: typeof active.balance === 'string' ? active.balance : '0.00',
    privateBalance: Number((active as { privateBalance?: number }).privateBalance) || 0,
  };
  const conn = await getConnection(origin);
  if (!conn?.address) {
    return { status: 'ok', wallet: activeSite, bound: false, activeAddress: active.address };
  }
  if (conn.address === active.address) {
    return { status: 'ok', wallet: activeSite, bound: true, activeAddress: active.address };
  }
  const own = (await walletStorage.loadAllWallets()).find((w) => w.address === conn.address);
  if (!own) return { status: 'gone' };
  return {
    status: 'ok',
    wallet: {
      id: own.id,
      address: own.address,
      publicKey: own.publicKey ?? null,
      name: own.name || 'Wallet',
      balance: '0.00',
      privateBalance: 0,
    },
    bound: true,
    activeAddress: active.address,
  };
}

/** PVAC exists only for the open wallet: a site on another one gets a choice, never a silent switch. */
export function privateRequestRoute(site: SiteWalletResult): 'run' | 'choose' {
  return site.status === 'ok' && site.bound && site.wallet.address !== site.activeAddress
    ? 'choose'
    : 'run';
}

export async function prepareSigner(
  origin: string,
  site: SiteWalletResult | null
): Promise<Settled<{ signer: Signer }>> {
  if (!site || site.status === 'locked') return { ok: false, error: LOCKED_ERROR };
  if (site.status === 'gone') return { ok: false, error: GONE_ERROR };
  const address = site.wallet.address;
  const scope = site.bound
    ? await captureSiteTxScope(address, connectionKey(origin))
    : await captureTxScope(address);
  return { ok: true, signer: { address, bound: site.bound, scope } };
}

/** Anything that moved the site or the network while the approval was open fails the request. */
export async function settleSigner(
  origin: string,
  signer: Signer,
  selectedAddress?: unknown
): Promise<Settled<{ address: string; scope: TxScope }>> {
  const moved = await txScopeMismatch(signer.scope);
  if (moved) return { ok: false, error: { code: 'NETWORK_CHANGED', message: moved } };

  if (selectedAddress == null || selectedAddress === '' || selectedAddress === signer.address) {
    return { ok: true, address: signer.address, scope: signer.scope };
  }
  if (typeof selectedAddress !== 'string' || !isOctAddress(selectedAddress)) {
    return { ok: false, error: { code: 'INVALID_PARAMS', message: 'Unknown wallet picked.' } };
  }

  let picked:
    | { address: string; publicKey: string | null; privateKey: string | null; type?: string }
    | undefined;
  try {
    const sessionKey = await passwordManager.getSessionKey();
    if (!sessionKey) return { ok: false, error: LOCKED_ERROR };
    picked = (await walletStorage.loadVault(sessionKey)).find((w) => w.address === selectedAddress);
  } catch {
    return { ok: false, error: LOCKED_ERROR };
  }
  if (!picked) {
    return { ok: false, error: { code: 'INVALID_PARAMS', message: 'Unknown wallet picked.' } };
  }
  if (!walletCanSign(picked)) return { ok: false, error: { ...WATCH_ONLY_ERROR } };
  if (!(await getConnection(origin))) {
    return { ok: false, error: { code: 'NOT_CONNECTED', message: 'Connect before this request.' } };
  }

  await moveConnections([origin], { address: picked.address, publicKey: picked.publicKey });
  const scope: TxScope = {
    ...signer.scope,
    address: picked.address,
    siteKey: connectionKey(origin),
  };
  const after = await txScopeMismatch(scope);
  if (after) return { ok: false, error: { code: 'NETWORK_CHANGED', message: after } };
  return { ok: true, address: picked.address, scope };
}

const choosing = new Set<string>();

export async function choosePrivateWallet(
  origin: string,
  method: string,
  site: Extract<SiteWalletResult, { status: 'ok' }>,
  tabInfo: Record<string, unknown> = {},
  review?: ReviewHooks
): Promise<Settled<object>> {
  if (choosing.has(origin)) {
    return {
      ok: false,
      error: { code: 'REQUEST_PENDING', message: 'Finish or reject the open request first.' },
    };
  }
  choosing.add(origin);
  try {
    const active = await getActiveWallet();
    if (!active) return { ok: false, error: LOCKED_ERROR };
    const answer = (await msgApprovalQueue.add({
      review,
      kind: 'site_wallet_choice',
      origin,
      method,
      siteAddress: site.wallet.address,
      siteName: site.wallet.name,
      activeAddress: active.address,
      activeName: active.name || 'Wallet',
      ...tabInfo,
    })) as { approved?: boolean; choice?: unknown } | false;
    if (!answer || !answer.approved || (answer.choice !== 'switch' && answer.choice !== 'move')) {
      return { ok: false, error: { code: 'USER_REJECTED', message: 'User rejected the request.' } };
    }

    const now = await walletForOrigin(origin);
    if (
      now.status !== 'ok' ||
      now.wallet.address !== site.wallet.address ||
      now.activeAddress !== active.address
    ) {
      return {
        ok: false,
        error: {
          code: 'NETWORK_CHANGED',
          message: 'The wallet changed while the choice was open. Nothing was sent. Try again.',
        },
      };
    }

    if (answer.choice === 'switch') {
      await walletStorage.setActiveWallet(site.wallet.id);
    } else {
      await moveConnections([origin], { address: active.address, publicKey: active.publicKey });
    }

    const settled = await walletForOrigin(origin);
    if (settled.status !== 'ok' || privateRequestRoute(settled) !== 'run') {
      return {
        ok: false,
        error: { code: 'NETWORK_CHANGED', message: 'Could not settle the wallet. Try again.' },
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: { code: 'WALLET_LOCKED', message: (e as Error)?.message || 'Wallet locked.' },
    };
  } finally {
    choosing.delete(origin);
  }
}
