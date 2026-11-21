export const PHRASE_LENGTHS = [12, 24];

/** A private key is the base64 of a 32-byte seed: 43 characters and one padding sign. */
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=?$/;
const EVM_KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface SecretChecks {
  isWord: (word: string) => boolean;
  isAddress: (text: string) => boolean;
  wordlist: readonly string[];
}

export type Detection =
  | { kind: 'empty' }
  | { kind: 'partial' }
  | { kind: 'typing'; count: number; target: number }
  | { kind: 'tooMany'; count: number }
  | { kind: 'badWord'; word: string; index: number; suggestion: string | null }
  | { kind: 'phrase'; words: string[] }
  | { kind: 'key'; key: string }
  | { kind: 'address'; address: string }
  | { kind: 'evmKey' }
  | { kind: 'evmAddress' };

const withinOneEdit = (a: string, b: string): boolean => {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};

export function closeMatch(word: string, wordlist: readonly string[]): string | null {
  let found: string | null = null;
  for (const candidate of wordlist) {
    if (!withinOneEdit(word, candidate)) continue;
    if (found) return null;
    found = candidate;
  }
  return found;
}

export function detectSecret(input: string, checks: SecretChecks): Detection {
  const text = input.trim();
  if (!text) return { kind: 'empty' };
  const parts = text.split(/\s+/);

  if (parts.length === 1) {
    if (checks.isAddress(text)) return { kind: 'address', address: text };
    if (EVM_KEY_PATTERN.test(text)) return { kind: 'evmKey' };
    if (EVM_ADDRESS_PATTERN.test(text)) return { kind: 'evmAddress' };
    if (!checks.isWord(text.toLowerCase())) {
      if (KEY_PATTERN.test(text)) return { kind: 'key', key: text };
      const lower = text.toLowerCase();
      if (!/^[a-z]+$/.test(lower) || !checks.wordlist.some((w) => w.startsWith(lower)))
        return { kind: 'partial' };
    }
  }

  const words = parts.map((w) => w.toLowerCase());
  if (words.length > 24) return { kind: 'tooMany', count: words.length };
  const target = words.length > 12 ? 24 : 12;
  const bad = words.findIndex((w) => !checks.isWord(w));
  if (bad !== -1) {
    const word = words[bad];
    const stillTyping =
      bad === words.length - 1 &&
      !/\s$/.test(input) &&
      checks.wordlist.some((w) => w.startsWith(word));
    if (stillTyping) return { kind: 'typing', count: words.length, target };
    return { kind: 'badWord', word, index: bad, suggestion: closeMatch(word, checks.wordlist) };
  }
  if (PHRASE_LENGTHS.includes(words.length)) return { kind: 'phrase', words };
  return { kind: 'typing', count: words.length, target };
}

export function replaceWord(input: string, index: number, replacement: string): string {
  let at = -1;
  return input.replace(/\S+/g, (w) => (++at === index ? replacement : w));
}
