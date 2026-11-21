/**
 * Decoding follows ethers v6 (non-loose), which the 0xio bridge app checks quotes with: reads past the end or an
 * array longer than the data throw at once, while a value that cannot be read (an address with high bits set, a
 * length past 2^53) only throws when that item is read, so junk in a field the check ignores is ignored as well.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';

export type AbiType =
  | { kind: 'address' | 'bool' | 'bytes' | 'string' }
  | { kind: 'uint'; bits: number }
  | { kind: 'fixed'; size: number }
  | { kind: 'array'; item: AbiType }
  | { kind: 'tuple'; items: AbiParam[] };

export interface AbiParam {
  type: AbiType;
  name: string;
}

export interface AbiFunction {
  name: string;
  selector: string;
  inputs: AbiParam[];
}

export interface AbiResult extends Array<any> {
  [name: string]: any;
}

const WORD = 32;
const MAX_INFLATION = 1024;

class Overrun extends Error {}

export function hexBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) {
    throw new Error('invalid hex data');
  }
  return hexToBytes(value.slice(2));
}

export const toHex = (bytes: Uint8Array) => '0x' + bytesToHex(bytes);

/** UTF-8 the way ethers encodes it: a lone high surrogate throws, a lone low one is written as is. */
export function utf8(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if ((c & 0xfc00) === 0xd800) {
      const low = str.charCodeAt(++i);
      if (i >= str.length || (low & 0xfc00) !== 0xdc00) throw new Error('invalid surrogate pair');
      c = 0x10000 + ((c & 0x3ff) << 10) + (low & 0x3ff);
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      );
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && value !== '') {
    return value[0] === '-' && value[1] !== '-' ? -BigInt(value.slice(1)) : BigInt(value);
  }
  throw new Error('invalid number');
}

export function checkAddress(value: unknown): string {
  if (typeof value !== 'string' || !/^(0x)?[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error('invalid address');
  }
  const hex = value.slice(value.length - 40);
  const lower = hex.toLowerCase();
  if (/[a-f]/.test(hex) && /[A-F]/.test(hex)) {
    const hash = bytesToHex(keccak_256(utf8(lower)));
    const sum = [...lower].map((ch, i) => (parseInt(hash[i], 16) >= 8 ? ch.toUpperCase() : ch));
    if (sum.join('') !== hex) throw new Error('bad address checksum');
  }
  return '0x' + lower;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function parseParams(list: string): AbiParam[] {
  return splitTopLevel(list).map((part) => {
    const named = /^(.*\S)\s+([A-Za-z_$][\w$]*)$/.exec(part);
    return named && !/[)\]]$/.test(part)
      ? { type: parseType(named[1]), name: named[2] }
      : { type: parseType(part), name: '' };
  });
}

export function parseType(raw: string): AbiType {
  const type = raw.trim();
  if (type.endsWith('[]')) return { kind: 'array', item: parseType(type.slice(0, -2)) };
  const tuple = /^(?:tuple)?\((.*)\)$/.exec(type);
  if (tuple) return { kind: 'tuple', items: parseParams(tuple[1]) };
  if (type === 'address' || type === 'bool' || type === 'bytes' || type === 'string') {
    return { kind: type };
  }
  const uint = /^uint(\d*)$/.exec(type);
  if (uint) {
    const bits = uint[1] ? Number(uint[1]) : 256;
    if (bits % 8 === 0 && bits >= 8 && bits <= 256) return { kind: 'uint', bits };
  }
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed && Number(fixed[1]) >= 1 && Number(fixed[1]) <= 32) {
    return { kind: 'fixed', size: Number(fixed[1]) };
  }
  throw new Error(`unsupported ABI type ${type}`);
}

function canonical(type: AbiType): string {
  switch (type.kind) {
    case 'uint':
      return `uint${type.bits}`;
    case 'fixed':
      return `bytes${type.size}`;
    case 'array':
      return `${canonical(type.item)}[]`;
    case 'tuple':
      return `(${type.items.map((p) => canonical(p.type)).join(',')})`;
    default:
      return type.kind;
  }
}

export function abiFunction(signature: string): AbiFunction {
  const match = /^(?:function\s+)?([A-Za-z_$][\w$]*)\((.*)\)$/.exec(signature.trim());
  if (!match) throw new Error(`bad signature ${signature}`);
  const inputs = parseParams(match[2]);
  const key = `${match[1]}(${inputs.map((p) => canonical(p.type)).join(',')})`;
  return { name: match[1], selector: toHex(keccak_256(utf8(key)).slice(0, 4)), inputs };
}

const isDynamic = (type: AbiType): boolean =>
  type.kind === 'bytes' ||
  type.kind === 'string' ||
  type.kind === 'array' ||
  (type.kind === 'tuple' && type.items.some((p) => isDynamic(p.type)));

class Reader {
  constructor(
    private readonly ctx: { data: Uint8Array; read: number },
    private pos: number
  ) {}

  sub(offset: number) {
    return new Reader(this.ctx, this.pos + offset);
  }

  get length() {
    return Math.max(0, this.ctx.data.length - this.pos);
  }

  bytes(length: number): Uint8Array {
    const aligned = Math.ceil(length / WORD) * WORD;
    if (aligned > this.length) throw new Overrun('data out of bounds');
    this.ctx.read += length;
    // Offsets may point at the same data again and again; ethers caps the work the same way.
    if (this.ctx.read > MAX_INFLATION * this.ctx.data.length) throw new Overrun('data inflation');
    const out = this.ctx.data.slice(this.pos, this.pos + length);
    this.pos += aligned;
    return out;
  }

  word(): bigint {
    return BigInt(toHex(this.bytes(WORD)));
  }

  index(): number {
    const value = this.word();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('index overflow');
    return Number(value);
  }
}

function decodeOne(type: AbiType, reader: Reader): unknown {
  switch (type.kind) {
    case 'address': {
      const value = reader.word();
      if (value >> 160n) throw new Error('address exceeds 20 bytes');
      return '0x' + value.toString(16).padStart(40, '0');
    }
    case 'bool':
      return reader.word() !== 0n;
    case 'uint':
      return reader.word() & ((1n << BigInt(type.bits)) - 1n);
    case 'fixed':
      return toHex(reader.bytes(type.size));
    case 'bytes':
      return toHex(reader.bytes(reader.index()));
    case 'string':
      return new TextDecoder('utf-8', { fatal: true }).decode(reader.bytes(reader.index()));
    case 'array': {
      const count = reader.index();
      if (count * WORD > reader.length) throw new Overrun('array longer than the data');
      return unpack(Array(count).fill({ type: type.item, name: '' }), reader);
    }
    case 'tuple':
      return unpack(type.items, reader);
  }
}

class Fault {
  constructor(readonly error: unknown) {}
}

function attempt(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Overrun) throw error;
    return new Fault(error);
  }
}

const read = (item: unknown) => {
  if (item instanceof Fault) throw item.error;
  return item;
};

function result(items: unknown[], names: string[]): AbiResult {
  return new Proxy(items, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        if (Number(prop) >= target.length) throw new RangeError('out of result range');
        return read(target[Number(prop)]);
      }
      if (typeof prop === 'string' && !(prop in target)) {
        const i = names.indexOf(prop);
        return i < 0 ? undefined : read(target[i]);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as AbiResult;
}

function unpack(params: AbiParam[], reader: Reader): AbiResult {
  const base = reader.sub(0);
  const items = params.map((param) => {
    if (!isDynamic(param.type)) return attempt(() => decodeOne(param.type, reader));
    const at = base.sub(reader.index());
    return attempt(() => decodeOne(param.type, at));
  });
  return result(
    items,
    params.map((p) => p.name)
  );
}

export function decodeAbi(params: AbiParam[], data: Uint8Array): AbiResult {
  return unpack(params, new Reader({ data, read: 0 }, 0));
}

export function parseCall(
  fns: AbiFunction[],
  data: unknown
): { name: string; args: AbiResult } | null {
  const bytes = hexBytes(data);
  const selector = toHex(bytes.slice(0, 4));
  const fn = fns.find((f) => f.selector === selector);
  return fn ? { name: fn.name, args: decodeAbi(fn.inputs, bytes.slice(4)) } : null;
}

const word = (value: bigint) => hexToBytes(value.toString(16).padStart(64, '0'));

function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / WORD) * WORD);
  out.set(bytes);
  return out;
}

function encodeOne(type: AbiType, value: unknown): Uint8Array {
  switch (type.kind) {
    case 'address':
      return word(BigInt(checkAddress(value)));
    case 'bool':
      return word(value ? 1n : 0n);
    case 'uint': {
      const n = toBigInt(value);
      if (n < 0n || n >> BigInt(type.bits))
        throw new Error(`value out of range for uint${type.bits}`);
      return word(n);
    }
    case 'fixed': {
      const bytes = hexBytes(value);
      if (bytes.length !== type.size) throw new Error(`expected ${type.size} bytes`);
      return padded(bytes);
    }
    case 'bytes':
    case 'string': {
      if (type.kind === 'string' && typeof value !== 'string') throw new Error('expected a string');
      const bytes = type.kind === 'string' ? utf8(value as string) : hexBytes(value);
      return concatBytes(word(BigInt(bytes.length)), padded(bytes));
    }
    case 'array': {
      const items = value as unknown[];
      const params = items.map(() => ({ type: type.item, name: '' }));
      return concatBytes(word(BigInt(items.length)), encodeTuple(params, items));
    }
    case 'tuple':
      return encodeTuple(type.items, value as unknown[]);
  }
}

function encodeTuple(params: AbiParam[], values: unknown[]): Uint8Array {
  if (values.length !== params.length) throw new Error('wrong number of values');
  const parts = params.map((p, i) => ({
    dynamic: isDynamic(p.type),
    data: encodeOne(p.type, values[i]),
  }));
  let tail = parts.reduce((size, p) => size + (p.dynamic ? WORD : p.data.length), 0);
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  for (const p of parts) {
    if (!p.dynamic) heads.push(p.data);
    else {
      heads.push(word(BigInt(tail)));
      tails.push(p.data);
      tail += p.data.length;
    }
  }
  return concatBytes(...heads, ...tails);
}

export const encodeAbi = (params: AbiParam[], values: unknown[]): Uint8Array =>
  encodeTuple(params, values);

export const encodeCall = (fn: AbiFunction, values: unknown[]): string =>
  fn.selector + bytesToHex(encodeTuple(fn.inputs, values));
