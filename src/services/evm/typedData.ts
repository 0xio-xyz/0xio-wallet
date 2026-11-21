import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { signDigestHex } from './messages';

export interface TypedField {
  name: string;
  type: string;
}

export interface TypedData {
  types: Record<string, TypedField[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ARRAY = /^(.+)\[(\d*)\]$/;
const UINT = /^u?int(\d*)$/;
const FIXED_BYTES = /^bytes(\d+)$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const MAX_DEPTH = 32;

const DOMAIN_FIELDS: readonly TypedField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
];

const fail = (why: string): never => {
  throw new Error(`Invalid typed data: ${why}`);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const word = (value: bigint): Uint8Array => hexToBytes(value.toString(16).padStart(64, '0'));

const baseType = (type: string): string => {
  let t = type;
  for (let m = ARRAY.exec(t); m; m = ARRAY.exec(t)) t = m[1];
  return t;
};

/**
 * Parses and checks a request's typed data. A domain without an EIP712Domain type gets one made
 * from its own fields, so every domain value the review shows is part of what gets signed.
 */
export function parseTypedData(input: unknown): TypedData {
  let raw = input;
  if (typeof raw === 'string') {
    if (raw.length > 512_000) fail('too large');
    try {
      raw = JSON.parse(raw);
    } catch {
      fail('not JSON');
    }
  }
  if (!isRecord(raw)) fail('expected an object');
  const { types, primaryType, domain, message } = raw as Record<string, unknown>;
  if (!isRecord(types)) fail('missing types');
  if (typeof primaryType !== 'string' || !IDENT.test(primaryType)) fail('missing primaryType');
  if (!isRecord(domain)) fail('missing domain');
  if (!isRecord(message)) fail('missing message');

  const clean: Record<string, TypedField[]> = {};
  for (const [name, fields] of Object.entries(types as Record<string, unknown>)) {
    if (!IDENT.test(name)) fail(`bad type name ${name}`);
    if (!Array.isArray(fields)) fail(`fields of ${name} must be a list`);
    const seen = new Set<string>();
    clean[name] = (fields as unknown[]).map((f) => {
      if (!isRecord(f) || typeof f.name !== 'string' || typeof f.type !== 'string') {
        fail(`bad field in ${name}`);
      }
      const field = f as unknown as TypedField;
      if (!IDENT.test(field.name) || seen.has(field.name)) fail(`bad field name in ${name}`);
      seen.add(field.name);
      return { name: field.name, type: field.type };
    });
  }
  if (!clean.EIP712Domain) {
    clean.EIP712Domain = DOMAIN_FIELDS.filter(
      (f) => (domain as Record<string, unknown>)[f.name] !== undefined
    ).map((f) => ({ ...f }));
  }
  for (const [name, fields] of Object.entries(clean)) {
    for (const f of fields) {
      const base = baseType(f.type);
      if (!clean[base] && !isAtomic(base)) fail(`unknown type ${f.type} in ${name}`);
    }
  }
  if (primaryType !== 'EIP712Domain' && !clean[primaryType as string]) {
    fail(`primaryType ${primaryType} has no type`);
  }
  return {
    types: clean,
    primaryType: primaryType as string,
    domain: domain as Record<string, unknown>,
    message: message as Record<string, unknown>,
  };
}

function isAtomic(type: string): boolean {
  if (type === 'address' || type === 'bool' || type === 'string' || type === 'bytes') return true;
  const u = UINT.exec(type);
  if (u) {
    const bits = u[1] === '' ? 256 : Number(u[1]);
    return bits >= 8 && bits <= 256 && bits % 8 === 0;
  }
  const b = FIXED_BYTES.exec(type);
  return !!b && Number(b[1]) >= 1 && Number(b[1]) <= 32;
}

function dependencies(type: string, types: Record<string, TypedField[]>, found: Set<string>) {
  const base = baseType(type);
  if (found.has(base) || !types[base]) return;
  found.add(base);
  for (const f of types[base]) dependencies(f.type, types, found);
}

/** `Primary(type name,...)` followed by every referenced struct in alphabetical order. */
export function encodeType(primaryType: string, types: Record<string, TypedField[]>): string {
  const found = new Set<string>();
  dependencies(primaryType, types, found);
  found.delete(primaryType);
  return [primaryType, ...[...found].sort()]
    .map((t) => `${t}(${types[t].map((f) => `${f.type} ${f.name}`).join(',')})`)
    .join('');
}

export const typeHash = (primaryType: string, types: Record<string, TypedField[]>): Uint8Array =>
  keccak_256(new TextEncoder().encode(encodeType(primaryType, types)));

function toInteger(value: unknown, type: string): bigint {
  let n: bigint;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail(`${type} is not a safe integer`);
    n = BigInt(value);
  } else if (typeof value === 'string' && /^-?(0x[0-9a-fA-F]+|\d+)$/.test(value.trim())) {
    const s = value.trim();
    n = s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s);
  } else {
    return fail(`${type} value is not a number`);
  }
  const u = UINT.exec(type)!;
  const bits = BigInt(u[1] === '' ? 256 : Number(u[1]));
  if (type.startsWith('u')) {
    if (n < 0n || n >= 1n << bits) fail(`${type} out of range`);
    return n;
  }
  const half = 1n << (bits - 1n);
  if (n < -half || n >= half) fail(`${type} out of range`);
  return n < 0n ? (1n << 256n) + n : n;
}

function hexBytes(value: unknown, type: string): Uint8Array {
  if (typeof value !== 'string' || !HEX.test(value) || value.length % 2) {
    return fail(`${type} value is not hex`);
  }
  return hexToBytes(value.slice(2));
}

function encodeValue(
  type: string,
  value: unknown,
  types: Record<string, TypedField[]>,
  depth: number
): Uint8Array {
  if (depth > MAX_DEPTH) fail('nested too deeply');
  if (value === undefined || value === null) fail(`missing value for ${type}`);
  if (types[type]) {
    if (!isRecord(value)) fail(`${type} value is not an object`);
    return hashStructAt(type, value as Record<string, unknown>, types, depth + 1);
  }
  const arr = ARRAY.exec(type);
  if (arr) {
    if (!Array.isArray(value)) fail(`${type} value is not a list`);
    const items = value as unknown[];
    if (arr[2] !== '' && items.length !== Number(arr[2])) fail(`${type} has the wrong length`);
    return keccak_256(concat(items.map((v) => encodeValue(arr[1], v, types, depth + 1))));
  }
  if (type === 'string') {
    if (typeof value !== 'string') fail('string value is not text');
    return keccak_256(new TextEncoder().encode(value as string));
  }
  if (type === 'bytes') return keccak_256(hexBytes(value, type));
  if (type === 'bool') {
    if (typeof value !== 'boolean') fail('bool value is not true or false');
    return word(value ? 1n : 0n);
  }
  if (type === 'address') {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail('bad address');
    return word(BigInt(value as string));
  }
  const fixed = FIXED_BYTES.exec(type);
  if (fixed) {
    const bytes = hexBytes(value, type);
    if (bytes.length > Number(fixed[1])) fail(`${type} value is too long`);
    const out = new Uint8Array(32);
    out.set(bytes);
    return out;
  }
  if (UINT.test(type)) return word(toInteger(value, type));
  return fail(`unknown type ${type}`);
}

function hashStructAt(
  type: string,
  data: Record<string, unknown>,
  types: Record<string, TypedField[]>,
  depth: number
): Uint8Array {
  const parts = [typeHash(type, types)];
  for (const f of types[type]) parts.push(encodeValue(f.type, data[f.name], types, depth));
  return keccak_256(concat(parts));
}

export const hashStruct = (
  type: string,
  data: Record<string, unknown>,
  types: Record<string, TypedField[]>
): Uint8Array => hashStructAt(type, data, types, 0);

export const domainSeparator = (typed: TypedData): Uint8Array =>
  hashStruct('EIP712Domain', typed.domain, typed.types);

/** keccak256(0x1901 || domainSeparator || hashStruct(message)). */
export function typedDataHash(typed: TypedData): Uint8Array {
  const parts = [new Uint8Array([0x19, 0x01]), domainSeparator(typed)];
  if (typed.primaryType !== 'EIP712Domain') {
    parts.push(hashStruct(typed.primaryType, typed.message, typed.types));
  }
  return keccak_256(concat(parts));
}

export const typedDataHashHex = (typed: TypedData): string =>
  '0x' + bytesToHex(typedDataHash(typed));

export function signTypedData(typed: TypedData, privateKey: Uint8Array): string {
  return signDigestHex(typedDataHash(typed), privateKey);
}

export function typedDataChainId(typed: TypedData): number | null {
  const v = typed.domain.chainId;
  if (v === undefined || v === null) return null;
  const n = Number(toInteger(v, 'uint256'));
  return Number.isSafeInteger(n) ? n : fail('chainId out of range');
}
