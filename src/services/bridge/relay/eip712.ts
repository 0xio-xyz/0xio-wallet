import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { checkAddress, hexBytes, toBigInt, toHex, utf8 } from './abiDecode';

export type TypedFields = Record<string, Array<{ name: string; type: string }>>;

const ARRAY = /^(.*)\[\]$/;
const baseType = (type: string) => type.replace(/(\[\])+$/, '');

function encodeType(primary: string, types: TypedFields): string {
  const found = new Set<string>();
  const visit = (name: string) => {
    if (found.has(name) || !types[name]) return;
    found.add(name);
    types[name].forEach((f) => visit(baseType(f.type)));
  };
  visit(primary);
  found.delete(primary);
  return [primary, ...[...found].sort()]
    .map((name) => `${name}(${types[name].map((f) => `${f.type} ${f.name}`).join(',')})`)
    .join('');
}

const word = (value: bigint) => hexToBytes(value.toString(16).padStart(64, '0'));

function encodeField(type: string, value: unknown, types: TypedFields): Uint8Array {
  const array = ARRAY.exec(type);
  if (array) {
    const items = (value as unknown[]).map((v) => encodeField(array[1], v, types));
    return keccak_256(concatBytes(...items));
  }
  if (types[type]) return keccak_256(encodeData(type, value as Record<string, unknown>, types));
  if (type === 'string') {
    if (typeof value !== 'string') throw new Error('expected a string');
    return keccak_256(utf8(value));
  }
  if (type === 'bytes') return keccak_256(hexBytes(value));
  if (type === 'address') return word(BigInt(checkAddress(value)));
  const uint = /^uint(\d+)$/.exec(type);
  if (uint) {
    const n = toBigInt(value);
    if (n < 0n || n >> BigInt(uint[1])) throw new Error(`value out of range for ${type}`);
    return word(n);
  }
  throw new Error(`unsupported EIP-712 type ${type}`);
}

function encodeData(name: string, value: Record<string, unknown>, types: TypedFields): Uint8Array {
  return concatBytes(
    keccak_256(utf8(encodeType(name, types))),
    ...types[name].map((f) => encodeField(f.type, value[f.name], types))
  );
}

export function hashStruct(
  name: string,
  types: TypedFields,
  value: Record<string, unknown>
): string {
  return toHex(keccak_256(encodeData(name, value, types)));
}
