// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { walletStorage } from '../services/wallet/WalletStorage';
import { passwordManager, WrongPasswordError } from '../services/crypto/PasswordManager';
import { cryptoManager } from '../services/crypto/CryptoManager';
import { withEvmKey } from '../services/evm/signer';
import { deriveEvmAddress } from '../services/evm/accounts';
import {
  grantReveal,
  PasswordRequiredError,
  revealEvmKey,
  revealWallet,
  type RevealGrant,
} from '../services/crypto/secretReveal';

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();

const area = (m: Map<string, unknown>) => ({
  get: async (keys?: string | string[] | null) => {
    if (keys == null) return Object.fromEntries(m);
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => m.has(k)).map((k) => [k, m.get(k)]));
  },
  set: async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) m.set(k, structuredClone(v));
  },
  remove: async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k);
  },
});

const SEED = new Uint8Array(32).map((_, i) => i + 1);
const PRIVATE_KEY = btoa(String.fromCharCode(...SEED));
const FROM = 'oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB';
const TO = 'oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F';
const SIGNING =
  `{"from":"${FROM}","to_":"${TO}","amount":"2500","nonce":7,"ou":"10000","timestamp":1762300000.0,` +
  '"op_type":"standard","message":"hi \\"there\\"\\n\\u0001\\u007f end"}';
const SIGNATURE =
  'LEvmQfbKjHaFpwEI82uhnmsUq7LQZNLveMRBTg/06u7IQn7y8l5cZULJjKUch4pCYdIdJKnFMXZRYddId8zqCw==';
const WORDS = 'test test test test test test test test test test test junk'.split(' ');

const setUp = async (password: string) => {
  const evmAddress = await deriveEvmAddress(WORDS, 0);
  const wallet = await passwordManager.initializeVault(password, {
    name: 'Main',
    address: FROM,
    privateKey: PRIVATE_KEY,
    mnemonic: WORDS,
    evm: { enabled: true, address: evmAddress, index: 0 },
  });
  return { wallet, evmAddress };
};

beforeEach(async () => {
  local.clear();
  session.clear();
  (chrome.storage as any).local = area(local);
  (chrome.storage as any).session = area(session);
  await passwordManager.lockWallet();
  passwordManager.stopAutoLockTimer();
});

describe('reading a secret for display', () => {
  it('reads nothing in no-password mode and asks for a password', async () => {
    const { wallet, evmAddress } = await setUp('');
    const loadWallet = vi.spyOn(walletStorage, 'loadWallet');
    const loadVault = vi.spyOn(walletStorage, 'loadVault');

    await expect(grantReveal('')).rejects.toBeInstanceOf(PasswordRequiredError);
    await expect(grantReveal('anything')).rejects.toBeInstanceOf(PasswordRequiredError);
    await expect(revealWallet(wallet.id, null)).rejects.toBeInstanceOf(PasswordRequiredError);
    await expect(revealWallet(wallet.id, { reveal: true } as RevealGrant)).rejects.toBeInstanceOf(
      PasswordRequiredError
    );
    await expect(revealEvmKey(wallet.id, 0, evmAddress, null)).rejects.toBeInstanceOf(
      PasswordRequiredError
    );

    expect(loadWallet).not.toHaveBeenCalled();
    expect(loadVault).not.toHaveBeenCalled();
    loadWallet.mockRestore();
    loadVault.mockRestore();
  });

  it('still signs in no-password mode', async () => {
    const { wallet, evmAddress } = await setUp('');
    const [stored] = await walletStorage.loadAllWallets();
    expect(cryptoManager.signTransaction(SIGNING, stored.privateKey!)).toBe(SIGNATURE);
    expect(await withEvmKey(wallet.id, 0, evmAddress, (key) => key.length)).toBe(32);
  });

  it('reveals once a password is set, to that password only', async () => {
    const { wallet, evmAddress } = await setUp('');
    await passwordManager.changePassword('', 'correct horse');

    await expect(grantReveal('wrong horse')).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(revealWallet(wallet.id, { reveal: true } as RevealGrant)).rejects.toBeInstanceOf(
      PasswordRequiredError
    );

    const grant = await grantReveal('correct horse');
    const shown = await revealWallet(wallet.id, grant);
    expect(shown?.mnemonic).toEqual(WORDS);
    expect(shown?.privateKey).toBe(PRIVATE_KEY);
    expect(await revealEvmKey(wallet.id, 0, evmAddress, grant)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('stops revealing when the password is removed again', async () => {
    const { wallet } = await setUp('correct horse');
    const grant = await grantReveal('correct horse');
    expect((await revealWallet(wallet.id, grant))?.privateKey).toBe(PRIVATE_KEY);

    await passwordManager.changePassword('correct horse', '');
    await expect(revealWallet(wallet.id, grant)).rejects.toBeInstanceOf(PasswordRequiredError);
  });
});

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

describe('who reads one wallet out of the vault', () => {
  it('is the reveal gate and the add-account step only', () => {
    const root = join(process.cwd(), 'src');
    const callers = sources(root)
      .filter((file) => /\.loadWallet\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file))
      .sort();
    expect(callers).toEqual([
      'features/wallet/screens/WalletListScreen.tsx',
      'services/crypto/secretReveal.ts',
    ]);
  });
});
