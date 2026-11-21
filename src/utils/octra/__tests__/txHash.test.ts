// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computeTxHash, formatTxTimestamp, trackedTxHash, txHashJson } from '../txHash';

const FROM = 'oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB';
const TO = 'oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F';
const PUB = 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=';

// Signed and hashed by the webcli 0.06.01 tx_builder (seed 0x01..0x20).
const VECTORS = [
  {
    name: 'standard',
    tx: {
      from: FROM,
      to_: TO,
      amount: '1000000',
      nonce: 7,
      ou: '1000',
      timestamp: 1762300000.123,
      op_type: 'standard',
      public_key: PUB,
      signature:
        'VBORX2a2r6uAlv2W0EPFqTp4sNf2+QL0CzPyAaqTrjYbe8qczkMrpqXMqMLFmEA02yiUIe26DqdmWcs2LQNCCw==',
    },
    hash: 'f802c9eed1384aa62879c871ab3ccba84f536866dfa5373dd09f549a77aed8d9',
  },
  {
    name: 'memo with control characters at a whole second',
    tx: {
      from: FROM,
      to_: TO,
      amount: '0002500',
      nonce: 7,
      ou: '010000',
      timestamp: 1762300000,
      op_type: 'standard',
      public_key: PUB,
      message: 'hi "there"\n\u0001\u007f end',
      signature:
        'LEvmQfbKjHaFpwEI82uhnmsUq7LQZNLveMRBTg/06u7IQn7y8l5cZULJjKUch4pCYdIdJKnFMXZRYddId8zqCw==',
    },
    json:
      `{"from":"${FROM}","to_":"${TO}","amount":"2500","nonce":7,"ou":"10000","timestamp":1762300000.0,` +
      '"signature":"LEvmQfbKjHaFpwEI82uhnmsUq7LQZNLveMRBTg/06u7IQn7y8l5cZULJjKUch4pCYdIdJKnFMXZRYddId8zqCw==",' +
      `"op_type":"standard","public_key":"${PUB}","message":"hi \\"there\\"\\n\\u0001\\u007f end","encrypted_data":null}`,
    hash: 'd639ac7d82d255c6dbce33c349e987232823c70cb7c9efccdcbe7dcffe5573df',
  },
  {
    name: 'contract call without a public key',
    tx: {
      from: FROM,
      to_: TO,
      amount: '0',
      nonce: 9,
      ou: '1000',
      timestamp: 1762300123.456,
      op_type: 'call',
      encrypted_data: 'transfer',
      message: `["${TO}",12345678901234567890123]`,
      signature:
        'hzhehT3p9IZuYR4tYW5IULKUvTYixE4lT/CPLg1Zth5RPHMamq7Fh7vVZi1ZvDTRVqHhFAWGaz4YaXlk/P9cDQ==',
    },
    hash: 'd22ed2337af82b12784fd85300ee3964552b54ff10643c7ec3480112f1d3480a',
  },
  {
    name: 'decrypt with encrypted data',
    tx: {
      from: FROM,
      to_: FROM,
      amount: '0',
      nonce: 10,
      ou: '5000',
      timestamp: 1762300200.5,
      op_type: 'decrypt',
      public_key: PUB,
      encrypted_data: '{"cipher":"hfhe_v1|AAAA","amount":"100"}',
      signature:
        'SDZQ9wRd5nAEk4JpHpPK5sJO1KaA015wl3YbULyHkehvxbV2jqNCVq4p+F8kJyIEK30C0fnRkDb0UdgUd1itBg==',
    },
    hash: '8936223d550f640bfd099b3dbff97e0bd721ab4f400238e62b4002ff03b2ee38',
  },
];

describe('tx hash', () => {
  for (const v of VECTORS) {
    it(`matches the reference: ${v.name}`, () => {
      if ('json' in v) expect(txHashJson(v.tx)).toBe(v.json);
      expect(computeTxHash(v.tx)).toBe(v.hash);
    });
  }

  describe('an optional field sent as a string, even empty, is hashed as that string', () => {
    const base = {
      from: 'octEwb4krH6vW3Pr23hps9r8pTZ78dKpdpdmiY612FynidH',
      to_: 'octHd7nZVgp1iUy6rDNywdBEK4C8MsoLFFjE5ukrDGuL8Ra',
      amount: '11000000',
      nonce: 36673,
      ou: '1000',
      timestamp: 1793915581.996,
      op_type: 'standard',
      signature: 'c2lnbmF0dXJl',
    };
    it.each([
      [
        'empty',
        { message: '' },
        'e8c57de561589b618874d89a6b495d4275099dae6f066bfa2766c5b892c39568',
      ],
      ['absent', {}, 'cb59fd73fa7eb81315a87756b147f347ea5939ff9a22dc7c298cf4ddcb3668f3'],
      [
        'with control characters',
        { message: 'a\x7f\x01"\n' },
        '79aba7afaed1942c20a3ebc4c0271fb7f76e02b25c0a6c670aac7f72f1e31bac',
      ],
    ])('message %s', (_name, extra, hash) => {
      expect(computeTxHash({ ...base, ...extra })).toBe(hash);
    });
  });

  it('writes the timestamp the way the node does', () => {
    expect(formatTxTimestamp(1762300000)).toBe('1762300000.0');
    expect(formatTxTimestamp(1762300000.001)).toBe('1762300000.001');
    expect(formatTxTimestamp(0.1)).toBe('0.1');
    expect(() => formatTxTimestamp(NaN)).toThrow();
  });

  it('refuses amounts that are not whole digits', () => {
    expect(() => computeTxHash({ ...VECTORS[0].tx, amount: '1.5' })).toThrow();
  });

  it("tracks the local exact hash over the node's and falls back to the node's", () => {
    expect(trackedTxHash('aa', 'bb')).toBe('bb');
    expect(trackedTxHash(undefined, 'bb')).toBe('bb');
    expect(trackedTxHash('aa', null)).toBe('aa');
    expect(trackedTxHash('', null)).toBeNull();
  });
});
