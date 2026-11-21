// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { txSigningJson, computeTxHash } from 'src/utils/octra/txHash';

const clock = vi.hoisted(() => ({ now: 0 }));
vi.mock('src/utils/txTimestamp', () => ({ txTimestamp: () => clock.now }));

import { networkService, rpcNonce } from 'src/services/network/NetworkService';

const SEED = new Uint8Array(32).map((_, i) => i + 1);
const PRIVATE_KEY = btoa(String.fromCharCode(...SEED));
const FROM = 'oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB';
const TO = 'oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F';
const PUB = 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=';

// Signed by the webcli 0.06.01 tx_builder (seed 0x01..0x20).
const MEMO_SIGNING =
  `{"from":"${FROM}","to_":"${TO}","amount":"2500","nonce":7,"ou":"10000","timestamp":1762300000.0,` +
  '"op_type":"standard","message":"hi \\"there\\"\\n\\u0001\\u007f end"}';
const MEMO_SIGNATURE =
  'LEvmQfbKjHaFpwEI82uhnmsUq7LQZNLveMRBTg/06u7IQn7y8l5cZULJjKUch4pCYdIdJKnFMXZRYddId8zqCw==';
const MEMO_HASH = 'd639ac7d82d255c6dbce33c349e987232823c70cb7c9efccdcbe7dcffe5573df';
const CALL_SIGNING =
  `{"from":"${FROM}","to_":"${TO}","amount":"0","nonce":9,"ou":"1000","timestamp":1762300123.456,` +
  `"op_type":"call","encrypted_data":"transfer","message":"[\\"${TO}\\",12345678901234567890123]"}`;
const CALL_SIGNATURE =
  'hzhehT3p9IZuYR4tYW5IULKUvTYixE4lT/CPLg1Zth5RPHMamq7Fh7vVZi1ZvDTRVqHhFAWGaz4YaXlk/P9cDQ==';

describe('tx signing text', () => {
  it('writes the reference signing bytes', () => {
    expect(
      txSigningJson({
        from: FROM,
        to_: TO,
        amount: '0002500',
        nonce: 7,
        ou: '010000',
        timestamp: 1762300000,
        op_type: 'standard',
        message: 'hi "there"\n\u0001\u007f end',
      })
    ).toBe(MEMO_SIGNING);
    expect(() =>
      txSigningJson({ from: FROM, to_: TO, amount: '-1', nonce: 1, ou: '1', timestamp: 1 })
    ).toThrow();
  });

  it('signs a send with a DEL memo and padded units exactly like the reference', async () => {
    clock.now = 1762300000;
    const tx = await networkService.buildAndSignTransaction({
      from: FROM,
      to: TO,
      amount: '0002500',
      nonce: 7,
      ou: '010000',
      message: 'hi "there"\n\u0001\u007f end',
      privateKey: PRIVATE_KEY,
      publicKey: PUB,
    } as never);
    expect(tx.amount).toBe('2500');
    expect(tx.ou).toBe('10000');
    expect(tx.signature).toBe(MEMO_SIGNATURE);
    expect(computeTxHash(tx as never)).toBe(MEMO_HASH);
  });

  it('signs a contract call with a big integer argument exactly like the reference', async () => {
    clock.now = 1762300123.456;
    const tx = await networkService.buildContractCallTransaction({
      from: FROM,
      contract: TO,
      method: 'transfer',
      callParams: null,
      rawMessage: `["${TO}",12345678901234567890123]`,
      nonce: 9,
      ou: '1000',
      privateKey: PRIVATE_KEY,
      publicKey: PUB,
    });
    expect(txSigningJson(tx as never)).toBe(CALL_SIGNING);
    expect(tx.signature).toBe(CALL_SIGNATURE);
  });

  it('sends no empty optional field: the node would sign and hash it', async () => {
    clock.now = 1762300000;
    const send = await networkService.buildAndSignTransaction({
      from: FROM,
      to: TO,
      amount: '1000',
      amountInOCT: 0.001,
      nonce: 1,
      privateKey: PRIVATE_KEY,
      publicKey: PUB,
      message: '',
      ou: '1000',
    } as any);
    expect(send).not.toHaveProperty('message');
    const call = await networkService.buildContractCallTransaction({
      from: FROM,
      contract: TO,
      method: 'ping',
      callParams: [],
      rawMessage: '',
      amount: '0',
      nonce: 2,
      ou: '1000',
      privateKey: PRIVATE_KEY,
      publicKey: PUB,
    });
    expect(call).not.toHaveProperty('message');
    expect(call).toMatchObject({ encrypted_data: 'ping', public_key: PUB });
  });

  it('hashes a site record exactly as posted, an empty message included', () => {
    expect(
      computeTxHash({
        from: 'octEwb4krH6vW3Pr23hps9r8pTZ78dKpdpdmiY612FynidH',
        to_: 'octHd7nZVgp1iUy6rDNywdBEK4C8MsoLFFjE5ukrDGuL8Ra',
        amount: '11000000',
        nonce: 36673,
        ou: '1000',
        timestamp: 1793915581.996,
        op_type: 'standard',
        signature: 'c2lnbmF0dXJl',
        message: '',
      })
    ).toBe('e8c57de561589b618874d89a6b495d4275099dae6f066bfa2766c5b892c39568');
  });

  it('refuses a fee that is not plain digits', async () => {
    await expect(
      networkService.buildContractCallTransaction({
        from: FROM,
        contract: TO,
        method: 'transfer',
        callParams: [],
        nonce: 9,
        ou: '1e3',
        privateKey: PRIVATE_KEY,
      })
    ).rejects.toThrow();
  });
});

describe('staged nonce', () => {
  const pin = { networkId: 'devnet' as const, rpcUrl: 'https://dev.example' };

  it('reads the highest own nonce from staging_view the webcli way', async () => {
    const call = vi.spyOn(networkService, 'jsonRpcCall');
    call.mockResolvedValueOnce({
      transactions: [
        { from: FROM, nonce: 4 },
        { from: TO, nonce: 99 },
        { from: FROM, nonce: 6 },
      ],
    });
    expect(await networkService.stagingNonce(FROM, pin)).toBe(6);
    call.mockResolvedValueOnce({ transactions: [] });
    expect(await networkService.stagingNonce(FROM, pin)).toBe(0);
    call.mockResolvedValueOnce({});
    await expect(networkService.stagingNonce(FROM, pin)).rejects.toThrow();
    call.mockResolvedValueOnce({ transactions: [{ from: FROM }] });
    await expect(networkService.stagingNonce(FROM, pin)).rejects.toThrow();
    call.mockRestore();
  });

  it('accepts only whole JSON number nonces', () => {
    expect(rpcNonce(5)).toBe(5);
    expect(rpcNonce('5')).toBeNull();
    expect(rpcNonce(-1)).toBeNull();
    expect(rpcNonce(1.5)).toBeNull();
  });
});
