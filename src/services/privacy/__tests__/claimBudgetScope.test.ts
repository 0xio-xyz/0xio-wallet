import { describe, expect, it, vi } from 'vitest';
import {
  _clearMemStoreForTests,
  _setForceMemStoreForTests,
  consumeClaimSlot,
  markSingleWriterContext,
  remainingClaims,
  seedClaimBudget,
} from '../claimBudget';

const ADDR = 'oct_scope_addr';
const CIPHER = 'hfhe_v1|' + 'c'.repeat(100);

describe('claim budget network scope', () => {
  it('a delegated op carries the network resolved at the call, not at the background', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const prevChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: vi.fn(async (m: Record<string, unknown>) => {
          sent.push(m);
          return true;
        }),
      },
      storage: { local: { get: async () => ({ '0xio_current_network': 'mainnet' }) } },
    };
    _setForceMemStoreForTests(false);
    try {
      await consumeClaimSlot(ADDR);
      await consumeClaimSlot(ADDR, 'devnet');
      expect(sent.map((m) => [m.op, m.networkId])).toEqual([
        ['consume', 'mainnet'],
        ['consume', 'devnet'],
      ]);
    } finally {
      _setForceMemStoreForTests(true);
      (globalThis as { chrome?: unknown }).chrome = prevChrome;
    }
  });

  it('the single writer keys every op by the network it was given', async () => {
    markSingleWriterContext();
    _clearMemStoreForTests();
    await seedClaimBudget(ADDR, CIPHER, 2, 'devnet');
    expect(await remainingClaims(ADDR, 'devnet')).toBe(2);
    expect(await remainingClaims(ADDR)).toBeNull();
    expect(await consumeClaimSlot(ADDR, 'devnet')).toBe(true);
    expect(await remainingClaims(ADDR, 'devnet')).toBe(1);
  });
});
