import { BRIDGE_MSG, SELECTOR } from './constants';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

const word = (n: bigint): string => {
  if (n < 0n || n >= 1n << 256n) throw new Error('Value out of range');
  return n.toString(16).padStart(64, '0');
};

const addressWord = (a: string): string => {
  if (!ADDRESS.test(a)) throw new Error('Invalid address');
  return a.slice(2).toLowerCase().padStart(64, '0');
};

const bytes32Word = (h: string): string => {
  if (!BYTES32.test(h)) throw new Error('Invalid bytes32');
  return h.slice(2).toLowerCase();
};

/**
 * verifyAndMint(uint64 epoch, (uint8,uint8,uint64,uint64,bytes32,bytes32,bytes32,address,uint128,uint64) m,
 * bytes32[] siblings, uint32 leafIndex) with no siblings and leaf 0, as the bridge app sends it.
 */
export function verifyAndMintData(args: {
  epoch: number | bigint;
  recipient: string;
  amountRaw: bigint;
  srcNonce: number | bigint;
}): string {
  const head = [
    word(BigInt(args.epoch)),
    word(BigInt(BRIDGE_MSG.version)),
    word(BigInt(BRIDGE_MSG.direction)),
    word(BRIDGE_MSG.srcChainId),
    word(BRIDGE_MSG.dstChainId),
    bytes32Word(BRIDGE_MSG.srcBridgeId),
    bytes32Word(BRIDGE_MSG.dstBridgeId),
    bytes32Word(BRIDGE_MSG.tokenId),
    addressWord(args.recipient),
    word(args.amountRaw),
    word(BigInt(args.srcNonce)),
  ];
  const siblingsOffset = word(BigInt((head.length + 2) * 32));
  const leafIndex = word(0n);
  const siblings = word(0n);
  return SELECTOR.verifyAndMint + head.join('') + siblingsOffset + leafIndex + siblings;
}

export function burnToOctraData(octraRecipient: string, amountRaw: bigint): string {
  const bytes = new TextEncoder().encode(octraRecipient);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return SELECTOR.burnToOctra + word(64n) + word(amountRaw) + word(BigInt(bytes.length)) + padded;
}

export function addressCall(selector: string, ...addresses: string[]): string {
  return selector + addresses.map(addressWord).join('');
}

export function readUint(result: unknown): bigint {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) {
    throw new Error('Bad call result');
  }
  return result === '0x' ? 0n : BigInt(result.slice(0, 66));
}
