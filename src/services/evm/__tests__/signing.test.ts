// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveEvmPrivateKey } from '../tx';
import {
  personalMessageBytes,
  personalMessageHash,
  readableMessage,
  signPersonalMessage,
} from '../messages';
import {
  encodeType,
  parseTypedData,
  signTypedData,
  typedDataChainId,
  typedDataHashHex,
} from '../typedData';

// Expected values come from viem 2.57 (mnemonicToAccount, signMessage, signTypedData,
// hashTypedData) with the same phrase and inputs.
const ABANDON = [...Array(11).fill('abandon'), 'about'];
const key = () => deriveEvmPrivateKey(ABANDON, 0);

const MAIL = {
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  types: {
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallets', type: 'address[]' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person[]' },
      { name: 'contents', type: 'string' },
    ],
    Group: [
      { name: 'name', type: 'string' },
      { name: 'members', type: 'Person[]' },
    ],
  },
  primaryType: 'Mail',
  message: {
    from: {
      name: 'Cow',
      wallets: [
        '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826',
        '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF',
      ],
    },
    to: [
      {
        name: 'Bob',
        wallets: [
          '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
          '0xB0BdaBea57B0BDABeA57b0bdABEA57b0BDabEa57',
          '0xB0B0b0b0b0b0B000000000000000000000000000',
        ],
      },
    ],
    contents: 'Hello, Bob!',
  },
};

const PERMIT2 = {
  domain: {
    name: 'Permit2',
    chainId: 1,
    verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  },
  types: {
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
    PermitBatch: [
      { name: 'details', type: 'PermitDetails[]' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
  },
  primaryType: 'PermitBatch',
  message: {
    details: [
      {
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        amount: '1461501637330902918203684832716283019655932542975',
        expiration: 1735689600,
        nonce: 0,
      },
      {
        token: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        amount: '0x17d7840',
        expiration: '1735689600',
        nonce: 3,
      },
    ],
    spender: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
    sigDeadline: '1735693200',
  },
};

const EIP2612 = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
  domain: {
    name: 'USD Coin',
    version: '2',
    chainId: '0xaa36a7',
    verifyingContract: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  primaryType: 'Permit',
  message: {
    owner: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
    spender: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
    value: '1000000',
    nonce: 0,
    deadline: 1893456000,
  },
};

const MISC = {
  domain: { name: 'Misc', version: '1', chainId: 4663, salt: '0x' + '11'.repeat(32) },
  types: {
    Inner: [
      { name: 'flag', type: 'bool' },
      { name: 'tag', type: 'bytes4' },
      { name: 'blob', type: 'bytes' },
    ],
    Outer: [
      { name: 'delta', type: 'int256' },
      { name: 'small', type: 'int8' },
      { name: 'inners', type: 'Inner[2]' },
      { name: 'grid', type: 'uint8[][]' },
      { name: 'id', type: 'bytes32' },
    ],
  },
  primaryType: 'Outer',
  message: {
    delta: '-123456789',
    small: -128,
    inners: [
      { flag: true, tag: '0x12345678', blob: '0x' },
      { flag: false, tag: '0xa9059cbb', blob: '0x0102030405' },
    ],
    grid: [[1, 2], [], [255]],
    id: '0x' + 'ab'.repeat(32),
  },
};

describe('personal_sign', () => {
  it('hashes like EIP-191', () => {
    expect('0x' + bytesToHex(personalMessageHash(personalMessageBytes('Hello from 0xio')))).toBe(
      '0xfd832cc0cb0ccf381e14dbc014d3b7026ff7a7a0efbfa44599743c93391a4934'
    );
  });

  it('signs text, unicode, raw hex and empty messages like viem', async () => {
    const k = await key();
    expect(signPersonalMessage('Hello from 0xio', k)).toBe(
      '0x5d9321c9afa33ec788c2399d945a14983b096af4f3d08d4dff4f638df24c6ec65e819e9f55bc05683c6b1742735c9ed0bf79290209824ae1279d54b0145caf2b1c'
    );
    expect(signPersonalMessage('Sign in to example.com\nNonce: 42 ✓ ünïcode', k)).toBe(
      '0x999cdfb93b63129776368e71952b5909b6980ca1031af396b4b565edcb9aca7d5f5653308e991c76aaac0a0dd7f767a39d3abf0f9a94b521c213974c76ced9371b'
    );
    expect(signPersonalMessage('0xdeadbeef00ff', k)).toBe(
      '0x094adf892e9cd618f97288276ae300f2cc0db8ed9fdb45dc1393eb3efde23e3b7da889b1aa4b96c45ddfa8c9150bb15e9d293de06a179a2fa7168a8d83d9c8811b'
    );
    expect(signPersonalMessage('', k)).toBe(
      '0x195c2781d9d0611afba721326ff367703626865825ef108cc19da092d14d48bb15ffba03245302210654019fd45cf1378e15474689c2d2aee77ae080266044101b'
    );
  });

  it('shows hex text as text and binary as hex', () => {
    const hello = '0x' + bytesToHex(new TextEncoder().encode('hello\nworld'));
    expect(readableMessage(hello)).toEqual({ text: 'hello\nworld', hex: hello });
    expect(readableMessage('0xdeadbeef00ff').text).toBeNull();
    expect(readableMessage('plain words').text).toBe('plain words');
  });
});

describe('eth_signTypedData_v4', () => {
  it('encodes types with sorted dependencies', () => {
    const typed = parseTypedData(MAIL);
    expect(encodeType('Mail', typed.types)).toBe(
      'Mail(Person from,Person[] to,string contents)Person(string name,address[] wallets)'
    );
  });

  it('matches viem for nested structs and arrays', async () => {
    const k = await key();
    const mail = parseTypedData(JSON.stringify(MAIL));
    expect(typedDataHashHex(mail)).toBe(
      '0xa85c2e2b118698e88db68a8105b794a8cc7cec074e89ef991cb4f5f533819cc2'
    );
    expect(signTypedData(mail, k)).toBe(
      '0xa611ea8753a78f7390e5be0b1def230d1f9cb93f9a97b146f97e78df7ac44a4d14598c5b4e45bae6d9d4dc28ced3a4c0e7c8567e64714d49bfd0492329181ae61b'
    );
  });

  it('matches viem for a Permit2 batch with uint160 and uint48', async () => {
    const k = await key();
    const typed = parseTypedData(PERMIT2);
    expect(typedDataHashHex(typed)).toBe(
      '0xba0b17c7048f8d3f851c3b53994aa0f4720b90c60fe51d204261beb14bc5a6a7'
    );
    expect(signTypedData(typed, k)).toBe(
      '0x19a2344430e14b6a93c82cb173563aa6175e783a6dc09ba810e87e7e257da1560f967a0b0109010a4f488c8c48648338b0465db140de83bed54fec5e9bb926531c'
    );
  });

  it('matches viem for an EIP-2612 permit with an explicit domain type', async () => {
    const k = await key();
    const typed = parseTypedData(JSON.stringify(EIP2612));
    expect(typedDataChainId(typed)).toBe(11155111);
    expect(signTypedData(typed, k)).toBe(
      '0x2d6829984a372b9673e388d1c0af5892306f5052f2f41d4bd38dd439776c5d2c690fea2a133a15c9a761366851a9ce70d3587308016284809c95b976b7d47d101c'
    );
  });

  it('matches viem for signed ints, fixed arrays, bytesN, bytes and salt', async () => {
    const k = await key();
    const typed = parseTypedData(MISC);
    expect(typedDataHashHex(typed)).toBe(
      '0xcd8582c998443a4360607a6902e304bc1a73aa231de21aa537985677b874c759'
    );
    expect(signTypedData(typed, k)).toBe(
      '0x96711c622ff8c6eb9d5a122c1b53acda10234d56080bba81b09a70a71ffce373089c9a9ef1c0649f4dc4d4c5837c870144a3217015edc92f4663507227826c701b'
    );
  });

  it('refuses malformed data', () => {
    expect(() => parseTypedData('{')).toThrow();
    expect(() => parseTypedData({ ...MAIL, primaryType: 'Nope' })).toThrow();
    expect(() =>
      parseTypedData({ ...MAIL, types: { ...MAIL.types, Mail: [{ name: 'x', type: 'Missing' }] } })
    ).toThrow();
    const short = parseTypedData({ ...MISC, message: { ...MISC.message, inners: [] } });
    expect(() => typedDataHashHex(short)).toThrow(/wrong length/);
    const big = parseTypedData({ ...MISC, message: { ...MISC.message, small: 128 } });
    expect(() => typedDataHashHex(big)).toThrow(/out of range/);
    const missing = parseTypedData({ ...MAIL, message: { ...MAIL.message, contents: undefined } });
    expect(() => typedDataHashHex(missing)).toThrow(/missing/);
  });
});
