import { holdsPhrase, isDerivedAccount } from 'src/services/evm/walletEvm';
import type { Wallet } from 'src/types/wallet';

export type WalletKind = 'phrase' | 'key' | 'watch';

export function walletKind(
  w: Pick<Wallet, 'type' | 'mnemonic' | 'privateKey' | 'metadata'>
): WalletKind {
  if (w.type === 'watch') return 'watch';
  if (holdsPhrase(w as never) || isDerivedAccount(w as never)) return 'phrase';
  return 'key';
}
