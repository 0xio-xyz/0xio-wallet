export type RlpInput = Uint8Array | bigint | number | RlpInput[];

function bigintBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('RLP cannot encode negative numbers');
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function header(length: number, short: number): Uint8Array {
  if (length < 56) return Uint8Array.of(short + length);
  const len = bigintBytes(BigInt(length));
  return concat([Uint8Array.of(short + 55 + len.length), len]);
}

/** Numbers encode as minimal big-endian bytes, so 0 is the empty string (0x80). */
export function rlpEncode(input: RlpInput): Uint8Array {
  if (Array.isArray(input)) {
    const body = concat(input.map(rlpEncode));
    return concat([header(body.length, 0xc0), body]);
  }
  let bytes: Uint8Array;
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) throw new Error('RLP numbers must be safe integers');
    bytes = bigintBytes(BigInt(input));
  } else if (typeof input === 'bigint') {
    bytes = bigintBytes(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    throw new Error('Unsupported RLP input');
  }
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return concat([header(bytes.length, 0x80), bytes]);
}
