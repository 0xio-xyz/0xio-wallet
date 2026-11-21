import { bytesToHex } from '@noble/hashes/utils.js';
import { passwordManager, WrongPasswordError } from './PasswordManager';
import { walletStorage } from '../wallet/WalletStorage';
import { withEvmKey } from '../evm/signer';
import type { Wallet } from 'src/types/wallet';

export class PasswordRequiredError extends Error {
  constructor() {
    super('Set a password first');
    this.name = 'PasswordRequiredError';
  }
}

export type RevealGrant = Readonly<{ reveal: true }>;

const grants = new WeakSet<RevealGrant>();

export async function grantReveal(password: string): Promise<RevealGrant> {
  if (await passwordManager.isPasswordSkipped()) throw new PasswordRequiredError();
  const s = await chrome.storage.local.get(['hashedPassword', 'salt']);
  if (!(await passwordManager.verifyPassword(password, s.hashedPassword, s.salt))) {
    throw new WrongPasswordError();
  }
  const grant: RevealGrant = Object.freeze({ reveal: true });
  grants.add(grant);
  return grant;
}

async function assertGrant(grant: RevealGrant | null | undefined): Promise<void> {
  if (!grant || !grants.has(grant)) throw new PasswordRequiredError();
  if (await passwordManager.isPasswordSkipped()) throw new PasswordRequiredError();
}

export async function revealWallet(
  walletId: string,
  grant: RevealGrant | null | undefined
): Promise<Wallet | null> {
  await assertGrant(grant);
  const sessionKey = await passwordManager.getSessionKey();
  if (!sessionKey) return null;
  return walletStorage.loadWallet(walletId, sessionKey);
}

export async function revealEvmKey(
  walletId: string,
  index: number,
  address: string,
  grant: RevealGrant | null | undefined
): Promise<string> {
  await assertGrant(grant);
  return withEvmKey(walletId, index, address, (key) => `0x${bytesToHex(key)}`);
}
