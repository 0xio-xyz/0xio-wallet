import { walletStorage } from 'src/services/wallet/WalletStorage';

export const WATCH_ONLY_ERROR = Object.freeze({
  code: 'WATCH_ONLY',
  message: 'This wallet is watch-only and cannot sign.',
});

interface KeyHolder {
  type?: string;
  privateKey?: string | null;
}

export function walletCanSign<T extends KeyHolder>(
  wallet: T | null | undefined
): wallet is T & { privateKey: string } {
  return !!wallet && wallet.type !== 'watch' && !!wallet.privateKey;
}

export function keyRefusal(
  wallet: KeyHolder | null | undefined,
  missing: { code: string; message: string }
): { code: string; message: string } {
  return wallet ? { ...WATCH_ONLY_ERROR } : missing;
}

export async function canSignAddress(address: string, publicKey?: string | null): Promise<boolean> {
  try {
    const wallet = (await walletStorage.loadAllWallets()).find((w) => w.address === address);
    if (wallet) return walletCanSign(wallet);
  } catch {}
  return !!publicKey;
}
