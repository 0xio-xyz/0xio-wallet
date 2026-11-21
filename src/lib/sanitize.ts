const CODE = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TAG = /<\/?[a-zA-Z!?][^>]*>?/g;
const hidden = (c: number) =>
  (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) ||
  c === 0x7f ||
  (c >= 0x200b && c <= 0x200f) ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069) ||
  c === 0xfeff;

export function sanitizeText(input: string | undefined | null): string {
  if (!input) return '';
  let text = '';
  for (const ch of input) if (!hidden(ch.codePointAt(0)!)) text += ch;
  let prev;
  do {
    prev = text;
    text = text.replace(CODE, '').replace(TAG, '');
  } while (text !== prev);
  return text;
}

export function sanitizeUrl(input: string | undefined | null): string {
  if (!input) return '';
  try {
    const url = new URL(input);
    if (['https:', 'http:', 'data:'].includes(url.protocol)) {
      return input;
    }
  } catch {}
  return '';
}

export type PasswordStrength = 'weak' | 'fair' | 'good' | 'strong';

export function getPasswordStrength(password: string): {
  level: PasswordStrength;
  score: number;
} {
  if (!password) return { level: 'weak', score: 0 };

  let score = 0;

  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;

  if (/[a-z]/.test(password)) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;

  let level: PasswordStrength;
  if (score <= 2) level = 'weak';
  else if (score <= 4) level = 'fair';
  else if (score <= 5) level = 'good';
  else level = 'strong';

  return { level, score };
}
