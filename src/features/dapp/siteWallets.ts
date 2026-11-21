import type { TFunction } from 'src/i18n/core';
import { evmMetaOf, isEvmOn } from 'src/services/evm/walletEvm';
import type { Wallet } from 'src/types/wallet';
import { siteWalletIds, type EvmSite, type UsableWallet } from 'src/services/evm/siteModel';
import type { OctraSite } from 'src/hooks/dapp/useSiteConnections';
import type { DesktopSite } from 'src/background/services/desktopRelay';

export const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: '12px' };

export const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export interface EvmChoice {
  wallet: Wallet;
  address: string;
}

export const evmChoices = (wallets: Wallet[]): EvmChoice[] =>
  wallets
    .filter((w) => w.type !== 'watch' && isEvmOn(w, wallets) && !!evmMetaOf(w)?.address)
    .map((w) => ({ wallet: w, address: evmMetaOf(w)!.address }));

export type ConnectMode =
  | { kind: 'fixed'; choice: EvmChoice }
  | { kind: 'pick' }
  | { kind: 'empty' };

export const connectHeading = (mode: ConnectMode, t: TFunction) =>
  mode.kind === 'fixed'
    ? t('evmDapp.connectTitle', { defaultValue: 'Connect to this site' })
    : mode.kind === 'pick'
      ? t('evmDapp.pickTitle', { defaultValue: 'Choose a wallet for this site' })
      : t('evmDapp.emptyTitle', { defaultValue: 'No wallet here has an EVM address' });

export const usableFrom =
  (wallets: Wallet[]): UsableWallet =>
  (walletId, address) => {
    const w = wallets.find((x) => x.id === walletId);
    const meta = w && w.type !== 'watch' && isEvmOn(w, wallets) ? evmMetaOf(w) : null;
    return !!meta && meta.address.toLowerCase() === address.toLowerCase();
  };

export const siteChoices = (
  site: EvmSite | undefined,
  openId: string | null,
  wallets: Wallet[]
): EvmChoice[] =>
  siteWalletIds(site, openId, usableFrom(wallets)).map((id) => ({
    wallet: wallets.find((w) => w.id === id)!,
    address: site!.accounts[id].address,
  }));

export const siteDisplayWallets = (
  site: EvmSite,
  openId: string | null,
  wallets: Wallet[]
): Wallet[] => {
  const known = (id: string) => wallets.some((w) => w.id === id);
  return siteWalletIds(site, openId, (id) => known(id)).map(
    (id) => wallets.find((w) => w.id === id)!
  );
};

const DEFAULT_CHAIN = { mainnet: 1, testnet: 11155111 } as const;

export const siteChainFor = (site: EvmSite | undefined, side: 'mainnet' | 'testnet'): number =>
  site?.chains[side] ?? DEFAULT_CHAIN[side];

export type ChipState =
  | { kind: 'none' }
  | { kind: 'join'; origin: string }
  | { kind: 'evm'; origin: string; host: string; wallets: EvmChoice[]; others: EvmChoice[] }
  | { kind: 'octra'; origin: string; host: string; site: OctraSite; wallet: Wallet | null }
  | { kind: 'desktop'; origin: string; host: string; site: DesktopSite };

export const desktopNetworkLabel = (network: string) =>
  network === 'devnet' ? 'Devnet' : 'Mainnet';

const hostname = (origin: string) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
};

export function siteChipState(
  origin: string | null,
  sites: { evm: Record<string, EvmSite>; octra: OctraSite[]; desktop?: DesktopSite[] },
  openId: string,
  wallets: Wallet[],
  network?: string
): ChipState {
  if (!origin) return { kind: 'none' };
  const onDesktop = (sites.desktop ?? []).filter((s) => s.origin === origin);
  const desk = onDesktop.find((s) => s.network === network) ?? onDesktop[0];
  if (desk) return { kind: 'desktop', origin, host: hostname(origin), site: desk };
  const octra = sites.octra.find((s) => s.origin === origin);
  if (octra) {
    return {
      kind: 'octra',
      origin,
      host: hostname(origin),
      site: octra,
      wallet: octra.address ? (wallets.find((w) => w.address === octra.address) ?? null) : null,
    };
  }
  const evm = sites.evm[origin];
  if (!evm) return { kind: 'none' };
  const list = siteChoices(evm, openId, wallets);
  const openAccount = evm.accounts[openId];
  const openHere =
    !!openAccount && usableFrom(wallets)(openId, openAccount.address) && list.length > 0;
  return openHere
    ? {
        kind: 'evm',
        origin,
        host: hostname(origin),
        wallets: list,
        others: evmChoices(wallets).filter((c) => !evm.accounts[c.wallet.id]),
      }
    : { kind: 'join', origin };
}
