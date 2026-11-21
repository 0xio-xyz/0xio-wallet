import { describe, it, expect, vi } from 'vitest';
import { MAX_PENDING_GAP, NonceManager, noteNonceUsed } from '../services/network/NonceManager';
import type { NetworkPin } from '../services/network/txScope';

const MAINNET: NetworkPin = { networkId: 'mainnet', rpcUrl: 'https://main.example' };
const DEVNET: NetworkPin = { networkId: 'devnet', rpcUrl: 'https://dev.example' };

const stubNetwork = (confirmed: Record<string, number>, active: NetworkPin = MAINNET): any => ({
  resolveNetwork: async () => active,
  getBalance: async (_a: string, _f: boolean, at: NetworkPin) => ({
    success: true,
    balance: 1,
    nonce: confirmed[at.rpcUrl],
  }),
  getCachedNonce: (): number | null => null,
  probeNonce: async (): Promise<number | null> => null,
  stagingNonce: async (): Promise<number> => 0,
});

const pendingNetwork = (balance: Record<string, unknown>, staged = 0): any => ({
  resolveNetwork: async () => MAINNET,
  getBalance: async () => ({ success: true, balance: 1, ...balance }),
  getCachedNonce: (): number | null => null,
  probeNonce: async (): Promise<number | null> => null,
  stagingNonce: vi.fn(async (): Promise<number> => staged),
});

describe('NonceManager', () => {
  const addr = 'oct1test';

  it('reserves consecutive nonces ahead of the confirmed one', async () => {
    const nm = new NonceManager(stubNetwork({ [MAINNET.rpcUrl]: 5 }));
    expect(await nm.getNextNonce(addr)).toBe(6);
    expect(await nm.getNextNonce(addr)).toBe(7);
  });

  it('release frees a rejected nonce so the next send reuses it', async () => {
    const nm = new NonceManager(stubNetwork({ [MAINNET.rpcUrl]: 5 }));
    const n = await nm.getNextNonce(addr);
    nm.release(addr, n, 'mainnet');
    expect(await nm.getNextNonce(addr)).toBe(n);
  });

  it('release ignores a nonce that is not the latest reservation', async () => {
    const nm = new NonceManager(stubNetwork({ [MAINNET.rpcUrl]: 5 }));
    const first = await nm.getNextNonce(addr);
    const second = await nm.getNextNonce(addr);
    nm.release(addr, first, 'mainnet');
    expect(await nm.getNextNonce(addr)).toBe(second + 1);
  });
});

describe('NonceManager pending nonce', () => {
  const addr = 'oct1test';

  it('builds on pending_nonce when the node gives it', async () => {
    const ns = pendingNetwork({ nonce: 5, pendingNonce: 8 }, 20);
    expect(await new NonceManager(ns).getNextNonce(addr)).toBe(9);
    expect(ns.stagingNonce).not.toHaveBeenCalled();
  });

  it('refuses a pending_nonce below the confirmed one or a malformed one', async () => {
    await expect(
      new NonceManager(pendingNetwork({ nonce: 5, pendingNonce: 4 })).getNextNonce(addr)
    ).rejects.toThrow(/precedes/);
    await expect(
      new NonceManager(pendingNetwork({ nonce: 5, pendingNonce: null })).getNextNonce(addr)
    ).rejects.toThrow(/pending nonce/i);
  });

  it('falls back to the highest staged nonce without pending_nonce', async () => {
    expect(await new NonceManager(pendingNetwork({ nonce: 5 }, 7)).getNextNonce(addr)).toBe(8);
    expect(await new NonceManager(pendingNetwork({ nonce: 5 }, 2)).getNextNonce(addr)).toBe(6);
  });

  it('refuses to sign when the node reports more than 32 nonces pending', async () => {
    const at = (balance: Record<string, unknown>, staged = 0) =>
      new NonceManager(pendingNetwork(balance, staged)).getNextNonce(addr);
    expect(await at({ nonce: 5, pendingNonce: 5 + MAX_PENDING_GAP })).toBe(6 + MAX_PENDING_GAP);
    await expect(at({ nonce: 5, pendingNonce: 6 + MAX_PENDING_GAP })).rejects.toThrow(/pending/);
    await expect(at({ nonce: 5, pendingNonce: 2147483000 })).rejects.toThrow(/pending/);
    expect(await at({ nonce: 5 }, 5 + MAX_PENDING_GAP)).toBe(6 + MAX_PENDING_GAP);
    await expect(at({ nonce: 5 }, 6 + MAX_PENDING_GAP)).rejects.toThrow(/pending/);
  });
});

describe('NonceManager network isolation', () => {
  const addr = 'oct1test';

  it('a mainnet reservation never raises the devnet nonce', async () => {
    const nm = new NonceManager(stubNetwork({ [MAINNET.rpcUrl]: 40, [DEVNET.rpcUrl]: 2 }));
    expect(await nm.getNextNonce(addr, MAINNET)).toBe(41);
    expect(await nm.getNextNonce(addr, MAINNET)).toBe(42);
    expect(await nm.getNextNonce(addr, DEVNET)).toBe(3);
    expect(await nm.getNextNonce(addr, MAINNET)).toBe(43);
  });

  it('an unpinned call reserves on the network active at the call', async () => {
    const nm = new NonceManager(stubNetwork({ [MAINNET.rpcUrl]: 40, [DEVNET.rpcUrl]: 2 }, DEVNET));
    expect(await nm.getNextNonce(addr)).toBe(3);
    expect(await nm.getNextNonce(addr, MAINNET)).toBe(41);
  });

  it('releasing on one network leaves the other untouched', async () => {
    const nm = new NonceManager(stubNetwork({ [MAINNET.rpcUrl]: 9, [DEVNET.rpcUrl]: 9 }));
    expect(await nm.getNextNonce(addr, MAINNET)).toBe(10);
    expect(await nm.getNextNonce(addr, DEVNET)).toBe(10);
    nm.release(addr, 10, 'devnet');
    expect(await nm.getNextNonce(addr, DEVNET)).toBe(10);
    expect(await nm.getNextNonce(addr, MAINNET)).toBe(11);
  });
});

describe('NonceManager used nonce', () => {
  it('reserves above a nonce the node called used, on that network only', async () => {
    const saved = new Map<string, unknown>();
    const get = vi
      .spyOn(chrome.storage.session, 'get')
      .mockImplementation((async (k: string) =>
        saved.has(k) ? { [k]: saved.get(k) } : {}) as any);
    const set = vi.spyOn(chrome.storage.session, 'set').mockImplementation((async (
      items: Record<string, unknown>
    ) => {
      for (const [k, v] of Object.entries(items)) saved.set(k, v);
    }) as any);
    const nm = new NonceManager(stubNetwork({ [MAINNET.rpcUrl]: 5, [DEVNET.rpcUrl]: 5 }));
    const n = await nm.getNextNonce('oct1used', MAINNET);
    await noteNonceUsed('mainnet', 'oct1used', n + 2);
    nm.release('oct1used', n, 'mainnet');
    expect(await nm.getNextNonce('oct1used', MAINNET)).toBe(n + 3);
    expect(await nm.getNextNonce('oct1used', DEVNET)).toBe(6);
    get.mockRestore();
    set.mockRestore();
  });
});
