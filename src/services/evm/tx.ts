import { HARDENED_OFFSET, HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cryptoManager } from '../crypto/CryptoManager';
import { evmPath, toChecksumAddress } from './accounts';
import { rlpEncode, type RlpInput } from './rlp';

export interface Eip1559Tx {
  chainId: number;
  nonce: number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string | null;
  value: bigint;
  data: string;
  legacy?: true;
}

export interface LegacyTx {
  chainId: number;
  nonce: number;
  gasPrice: bigint;
  gasLimit: bigint;
  to: string | null;
  value: bigint;
  data: string;
}

export interface SignedTx {
  raw: string;
  hash: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DATA = /^0x([0-9a-fA-F]{2})*$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const TRANSFER_SELECTOR = 'a9059cbb';
const APPROVE_SELECTOR = '095ea7b3';
const ERC721_SAFE_TRANSFER = '42842e0e';
const ERC1155_SAFE_TRANSFER = 'f242432a';

export function isEvmAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS.test(value);
}

function assertAddress(value: unknown, label: string): asserts value is string {
  if (!isEvmAddress(value)) throw new Error(`Invalid ${label} address`);
}

function assertUint(value: unknown, label: string, max = MAX_UINT256): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > max) throw new Error(`Invalid ${label}`);
}

function assertChainId(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('Invalid chain id');
}

function assertNonce(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid nonce');
}

function dataBytes(data: string): Uint8Array {
  if (typeof data !== 'string' || !DATA.test(data)) throw new Error('Invalid transaction data');
  return hexToBytes(data.slice(2));
}

function assertPrivateKey(key: Uint8Array) {
  if (!(key instanceof Uint8Array) || !secp256k1.utils.isValidSecretKey(key)) {
    throw new Error('Invalid private key');
  }
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

/** Same path as deriveEvmAddress. The caller owns the returned key and should zero it after use. */
export async function deriveEvmPrivateKey(
  mnemonic: string[] | string,
  index = 0
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error('Invalid account number');
  }
  const steps = evmPath(index)
    .split('/')
    .slice(1)
    .map((s) => (s.endsWith("'") ? Number(s.slice(0, -1)) + HARDENED_OFFSET : Number(s)));
  const phrase = Array.isArray(mnemonic) ? mnemonic.join(' ') : mnemonic.trim();
  const seed = await cryptoManager.mnemonicToSeed(phrase);
  const nodes: HDKey[] = [];
  try {
    let node = HDKey.fromMasterSeed(seed);
    nodes.push(node);
    for (const step of steps) {
      node = node.deriveChild(step);
      nodes.push(node);
    }
    const out = node.privateKey;
    if (!out) throw new Error('Could not derive the EVM key');
    return out;
  } finally {
    seed.fill(0);
    for (const n of nodes) n.wipePrivateData();
  }
}

export function erc20TransferData(to: string, amount: bigint): string {
  assertAddress(to, 'recipient');
  assertUint(amount, 'amount');
  return '0x' + TRANSFER_SELECTOR + word(BigInt(to)) + word(amount);
}

export function erc20ApproveData(spender: string, amount: bigint): string {
  assertAddress(spender, 'spender');
  assertUint(amount, 'amount');
  return '0x' + APPROVE_SELECTOR + word(BigInt(spender)) + word(amount);
}

export function erc721SafeTransferData(from: string, to: string, tokenId: bigint): string {
  assertAddress(from, 'sender');
  assertAddress(to, 'recipient');
  assertUint(tokenId, 'token id');
  return '0x' + ERC721_SAFE_TRANSFER + word(BigInt(from)) + word(BigInt(to)) + word(tokenId);
}

export function erc1155SafeTransferData(
  from: string,
  to: string,
  tokenId: bigint,
  amount: bigint
): string {
  assertAddress(from, 'sender');
  assertAddress(to, 'recipient');
  assertUint(tokenId, 'token id');
  assertUint(amount, 'amount');
  if (amount === 0n) throw new Error('Invalid amount');
  return (
    '0x' +
    ERC1155_SAFE_TRANSFER +
    word(BigInt(from)) +
    word(BigInt(to)) +
    word(tokenId) +
    word(amount) +
    word(160n) +
    word(0n)
  );
}

function validateCommon(tx: Eip1559Tx | LegacyTx) {
  assertChainId(tx.chainId);
  assertNonce(tx.nonce);
  assertUint(tx.gasLimit, 'gas limit');
  if (tx.gasLimit === 0n) throw new Error('Invalid gas limit');
  if (tx.to === null) {
    if (!tx.data || tx.data === '0x') throw new Error('A contract creation needs code');
  } else {
    assertAddress(tx.to, 'recipient');
  }
  assertUint(tx.value, 'value');
}

function eip1559Fields(tx: Eip1559Tx): RlpInput[] {
  validateCommon(tx);
  assertUint(tx.maxPriorityFeePerGas, 'priority fee');
  assertUint(tx.maxFeePerGas, 'max fee');
  if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) {
    throw new Error('Priority fee is above the max fee');
  }
  return [
    tx.chainId,
    tx.nonce,
    tx.maxPriorityFeePerGas,
    tx.maxFeePerGas,
    tx.gasLimit,
    tx.to === null ? new Uint8Array(0) : hexToBytes(tx.to.slice(2)),
    tx.value,
    dataBytes(tx.data),
    [],
  ];
}

function withType(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = type;
  out.set(body, 1);
  return out;
}

function signDigest(digest: Uint8Array, privateKey: Uint8Array) {
  assertPrivateKey(privateKey);
  const sig = secp256k1.sign(digest, privateKey, {
    prehash: false,
    lowS: true,
    format: 'recovered',
  });
  return {
    recovery: sig[0],
    r: BigInt('0x' + bytesToHex(sig.subarray(1, 33))),
    s: BigInt('0x' + bytesToHex(sig.subarray(33, 65))),
  };
}

function finish(bytes: Uint8Array): SignedTx {
  return { raw: '0x' + bytesToHex(bytes), hash: '0x' + bytesToHex(keccak_256(bytes)) };
}

export function contractAddressFor(sender: string, nonce: number): string {
  assertAddress(sender, 'sender');
  assertNonce(nonce);
  const hash = keccak_256(rlpEncode([hexToBytes(sender.slice(2)), nonce]));
  return toChecksumAddress('0x' + bytesToHex(hash.slice(-20)));
}

export function buildEip1559(tx: Eip1559Tx): Uint8Array {
  return withType(2, rlpEncode(eip1559Fields(tx)));
}

export function signEip1559(tx: Eip1559Tx, privateKey: Uint8Array): SignedTx {
  const fields = eip1559Fields(tx);
  const { recovery, r, s } = signDigest(keccak_256(withType(2, rlpEncode(fields))), privateKey);
  return finish(withType(2, rlpEncode([...fields, recovery, r, s])));
}

export function signLegacyEip155(tx: LegacyTx, privateKey: Uint8Array): SignedTx {
  validateCommon(tx);
  assertUint(tx.gasPrice, 'gas price');
  const fields: RlpInput[] = [
    tx.nonce,
    tx.gasPrice,
    tx.gasLimit,
    tx.to === null ? new Uint8Array(0) : hexToBytes(tx.to.slice(2)),
    tx.value,
    dataBytes(tx.data),
  ];
  const chainId = BigInt(tx.chainId);
  const { recovery, r, s } = signDigest(
    keccak_256(rlpEncode([...fields, chainId, 0, 0])),
    privateKey
  );
  return finish(rlpEncode([...fields, chainId * 2n + 35n + BigInt(recovery), r, s]));
}

/** Type 2, or legacy EIP-155 at gas price = maxFeePerGas when the tx is marked legacy. */
export function signEvmTx(tx: Eip1559Tx, privateKey: Uint8Array): SignedTx {
  if (!tx.legacy) return signEip1559(tx, privateKey);
  if (tx.maxPriorityFeePerGas !== tx.maxFeePerGas) {
    throw new Error('A legacy transaction has one gas price');
  }
  return signLegacyEip155(
    {
      chainId: tx.chainId,
      nonce: tx.nonce,
      gasPrice: tx.maxFeePerGas,
      gasLimit: tx.gasLimit,
      to: tx.to,
      value: tx.value,
      data: tx.data,
    },
    privateKey
  );
}
