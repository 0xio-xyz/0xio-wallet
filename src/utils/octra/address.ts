export const OCT_ADDRESS_LENGTH = 47;
export const OCT_ADDRESS_RE = /^oct[1-9A-HJ-NP-Za-km-z]{44}$/;

export function normalizeAddress(input: string): string {
  return (input ?? '').replace(/\s+/g, '');
}

export function isOctAddress(input: string): boolean {
  return typeof input === 'string' && OCT_ADDRESS_RE.test(input);
}
