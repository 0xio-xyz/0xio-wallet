import { describe, expect, it } from 'vitest';
import { NonceManager } from '../services/network/NonceManager';
import type { TxScope } from '../services/network/txScope';

const SCOPE: TxScope = { networkId: 'mainnet', rpcUrl: 'https://main.example', address: 'oct1me' };
const DEV: TxScope = { networkId: 'devnet', rpcUrl: 'https://dev.example', address: 'oct1me' };

const stubNetwork = (confirmed: Record<string, number>): any => ({
  resolveNetwork: async () => SCOPE,
  getBalance: async (_a: string, _f: boolean, at: { rpcUrl: string }) => ({
    success: true,
    balance: 1,
    nonce: confirmed[at.rpcUrl],
  }),
  getCachedNonce: (): number | null => null,
  probeNonce: async (): Promise<number | null> => null,
  stagingNonce: async (): Promise<number> => 0,
});

describe('NonceManager.reserveRange', () => {
  it('a send during a pending batch takes the nonce after the whole range', async () => {
    const nm = new NonceManager(stubNetwork({ [SCOPE.rpcUrl]: 9 }));
    expect(await nm.reserveRange(SCOPE, 4)).toBe(10);
    expect(await nm.getNextNonce(SCOPE.address, SCOPE)).toBe(14);
  });

  it('is keyed by network and address', async () => {
    const nm = new NonceManager(stubNetwork({ [SCOPE.rpcUrl]: 9, [DEV.rpcUrl]: 2 }));
    await nm.reserveRange(SCOPE, 5);
    expect(await nm.getNextNonce(DEV.address, DEV)).toBe(3);
    expect(await nm.getNextNonce('oct1other', SCOPE)).toBe(10);
  });

  it('releasing a failed batch frees the whole range', async () => {
    const nm = new NonceManager(stubNetwork({ [SCOPE.rpcUrl]: 9 }));
    const first = await nm.reserveRange(SCOPE, 3);
    nm.releaseRange(SCOPE.address, first, 3, SCOPE.networkId);
    expect(await nm.getNextNonce(SCOPE.address, SCOPE)).toBe(first);
  });

  it('releasing the unused tail keeps the accepted head', async () => {
    const nm = new NonceManager(stubNetwork({ [SCOPE.rpcUrl]: 9 }));
    const first = await nm.reserveRange(SCOPE, 4);
    nm.releaseRange(SCOPE.address, first + 2, 2, SCOPE.networkId);
    expect(await nm.getNextNonce(SCOPE.address, SCOPE)).toBe(first + 2);
  });

  it('leaves a range alone once a later send reserved past it', async () => {
    const nm = new NonceManager(stubNetwork({ [SCOPE.rpcUrl]: 9 }));
    const first = await nm.reserveRange(SCOPE, 2);
    const after = await nm.getNextNonce(SCOPE.address, SCOPE);
    nm.releaseRange(SCOPE.address, first, 2, SCOPE.networkId);
    expect(await nm.getNextNonce(SCOPE.address, SCOPE)).toBe(after + 1);
  });

  it('refuses an empty range', async () => {
    const nm = new NonceManager(stubNetwork({ [SCOPE.rpcUrl]: 9 }));
    await expect(nm.reserveRange(SCOPE, 0)).rejects.toThrow();
  });
});
