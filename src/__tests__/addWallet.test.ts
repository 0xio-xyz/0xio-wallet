import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectSecret,
  closeMatch,
  replaceWord,
  type SecretChecks,
} from 'src/features/wallet/add/readSecret';
import {
  isBackupPending,
  markBackupPending,
  clearBackupPending,
  readPendingFromChange,
  BACKUP_PENDING_KEY,
} from 'src/services/wallet/backupPending';
import { strengthBars } from 'src/features/wallet/add/strength';

const WORDS = [
  'orbit',
  'velvet',
  'canyon',
  'ribbon',
  'maple',
  'silent',
  'ember',
  'hollow',
  'quartz',
  'tunnel',
  'meadow',
  'signal',
];
const LIST = [...WORDS, 'orbital', 'october', 'cable', 'table'];
const ADDRESS = 'octHaoq3Kc9Vt2mXyE5pR8wLzN4bUjF6sTgD1hA7kQedHtg';
const checks: SecretChecks = {
  isWord: (w) => LIST.includes(w),
  isAddress: (s) => /^oct[A-Za-z0-9]{44}$/.test(s),
  wordlist: LIST,
};

describe('reading the import field', () => {
  it('is empty until something is typed', () => {
    expect(detectSecret('   ', checks)).toEqual({ kind: 'empty' });
  });

  it('reads a full phrase, whatever the spacing and case', () => {
    expect(detectSecret(`  ${WORDS.join('   ').toUpperCase()}\n`, checks)).toEqual({
      kind: 'phrase',
      words: WORDS,
    });
    const long = [...WORDS, ...WORDS].join(' ');
    expect(detectSecret(long, checks)).toMatchObject({ kind: 'phrase' });
  });

  it('counts a partial phrase toward 12, then toward 24', () => {
    expect(detectSecret('orbit velvet ', checks)).toEqual({ kind: 'typing', count: 2, target: 12 });
    expect(detectSecret([...WORDS, 'orbit'].join(' '), checks)).toEqual({
      kind: 'typing',
      count: 13,
      target: 24,
    });
  });

  it('does not call a last word wrong while it is still being typed', () => {
    expect(detectSecret('orbit velv', checks)).toEqual({ kind: 'typing', count: 2, target: 12 });
    expect(detectSecret('orbit velv ', checks)).toMatchObject({ kind: 'badWord', word: 'velv' });
  });

  it('names a word off the list and offers its one close match', () => {
    const typo = ['orbit', 'velvt', ...WORDS.slice(2)].join(' ');
    expect(detectSecret(typo, checks)).toEqual({
      kind: 'badWord',
      word: 'velvt',
      index: 1,
      suggestion: 'velvet',
    });
  });

  it('offers no fix when no word or more than one word is a single edit away', () => {
    expect(closeMatch('zzzzz', LIST)).toBeNull();
    expect(closeMatch('xable', LIST)).toBeNull();
    expect(closeMatch('orbt', LIST)).toBe('orbit');
    expect(closeMatch('ribbbon', LIST)).toBe('ribbon');
    expect(closeMatch('maplo', LIST)).toBe('maple');
  });

  it('swaps one word in place and keeps the rest of the text', () => {
    expect(replaceWord('orbit  velvt\ncanyon', 1, 'velvet')).toBe('orbit  velvet\ncanyon');
  });

  it('reads one base64 token of 44 characters as a private key', () => {
    const key = 'kQ3vT8nR2yW5pL9xH4mC7bJ1dF6gS0aZ3eU8iO2qN5r=';
    expect(detectSecret(key, checks)).toEqual({ kind: 'key', key });
    expect(detectSecret('kQ3vT8nR2y', checks)).toEqual({ kind: 'partial' });
  });

  it('reads an Octra address as a wallet to watch', () => {
    expect(detectSecret(` ${ADDRESS} `, checks)).toEqual({ kind: 'address', address: ADDRESS });
    expect(detectSecret(ADDRESS.slice(0, 20), checks)).toEqual({ kind: 'partial' });
  });

  it('recognises an EVM private key and a 0x address without importing them', () => {
    const hex = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
    expect(detectSecret(hex, checks)).toEqual({ kind: 'evmKey' });
    expect(detectSecret(`0x${hex.toUpperCase()}`, checks)).toEqual({ kind: 'evmKey' });
    expect(detectSecret('0x9858EfFD232B4033E47d90003D41EC34EcaEda94', checks)).toEqual({
      kind: 'evmAddress',
    });
    expect(detectSecret(`0x${hex.slice(0, 40)}`, checks)).toEqual({ kind: 'evmAddress' });
    expect(detectSecret(hex.slice(0, 50), checks)).toEqual({ kind: 'partial' });
  });

  it('treats one recovery word as the start of a phrase', () => {
    expect(detectSecret('orbit', checks)).toEqual({ kind: 'typing', count: 1, target: 12 });
  });
});

describe('password strength', () => {
  it('shows no bars below 8 characters, then one to four', () => {
    expect(strengthBars('Aa1!')).toBe(0);
    expect(strengthBars('abcdefgh')).toBe(1);
    expect(strengthBars('MyP@ssw0rd!Long123')).toBe(4);
  });
});

describe('the backup flag', () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    chrome.storage.local.get = (async (key: string) => ({ [key]: store[key] })) as any;
    chrome.storage.local.set = (async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }) as any;
  });

  it('is off for a wallet nobody marked', async () => {
    expect(await isBackupPending(ADDRESS)).toBe(false);
  });

  it('is kept per address and cleared once backed up', async () => {
    const other = `${ADDRESS.slice(0, -1)}x`;
    await markBackupPending(ADDRESS);
    await markBackupPending(ADDRESS);
    await markBackupPending(other);
    expect(store[BACKUP_PENDING_KEY]).toEqual([ADDRESS, other]);
    expect(await isBackupPending(ADDRESS)).toBe(true);

    await clearBackupPending(ADDRESS);
    expect(await isBackupPending(ADDRESS)).toBe(false);
    expect(await isBackupPending(other)).toBe(true);
  });

  it('reads a storage change for one address only', () => {
    expect(readPendingFromChange([ADDRESS], ADDRESS)).toBe(true);
    expect(readPendingFromChange(['octOther'], ADDRESS)).toBe(false);
    expect(readPendingFromChange(undefined, ADDRESS)).toBe(false);
  });
});
