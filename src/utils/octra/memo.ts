export const MEMO_MAX_BYTES = 1024;
export const MEMO_INPUT_MAX_BYTES = 200;

const encoder = new TextEncoder();

export function memoBytes(text: string): number {
  return encoder.encode(text ?? '').length;
}

/** Cuts on a character boundary, never inside an emoji or other multi-unit character. */
export function clampMemo(text: string, maxBytes: number = MEMO_INPUT_MAX_BYTES): string {
  let out = '';
  let used = 0;
  for (const ch of text ?? '') {
    const n = encoder.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}
