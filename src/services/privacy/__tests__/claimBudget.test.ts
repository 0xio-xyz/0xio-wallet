import { describe, it, expect, beforeEach } from 'vitest';
import {
  markSingleWriterContext,
  _setForceMemStoreForTests,
  seedClaimBudget,
  seedClaimBudgetEmpty,
  remainingClaims,
  consumeClaimSlot,
  refundClaimSlot,
  resetClaimBudget,
  plausibleLayers,
  _clearMemStoreForTests,
} from '../claimBudget';

const ADDR = 'oct_test_addr';
const CIPHER_A = 'hfhe_v1|' + 'a'.repeat(100);
const CIPHER_B = 'hfhe_v1|' + 'b'.repeat(100);

beforeEach(async () => {
  _clearMemStoreForTests();
  await resetClaimBudget(ADDR);
});

describe('plausibleLayers - fail-closed gate', () => {
  it('accepts real even counts >= 2', () => {
    expect(plausibleLayers(2)).toBe(true);
    expect(plausibleLayers(6)).toBe(true);
  });
  it('rejects the impossible and the unreadable', () => {
    expect(plausibleLayers(0)).toBe(false);
    expect(plausibleLayers(3)).toBe(false);
    expect(plausibleLayers(NaN)).toBe(false);
    expect(plausibleLayers(undefined)).toBe(false);
  });
});

describe('in-flight counter - the stale-read defeat', () => {
  it('a burst of claims shares one budget despite stale re-reads', async () => {
    await seedClaimBudget(ADDR, CIPHER_A, 2);
    expect(await consumeClaimSlot(ADDR)).toBe(true);
    await seedClaimBudget(ADDR, CIPHER_A, 2);
    expect(await remainingClaims(ADDR)).toBe(1);
    expect(await consumeClaimSlot(ADDR)).toBe(true);
    expect(await consumeClaimSlot(ADDR)).toBe(false);
  });
  it('re-seeds only when the cipher actually changed (execution observed)', async () => {
    await seedClaimBudget(ADDR, CIPHER_A, 2);
    await consumeClaimSlot(ADDR);
    await consumeClaimSlot(ADDR);
    await seedClaimBudget(ADDR, CIPHER_B, 4);
    expect(await remainingClaims(ADDR)).toBe(1);
  });
  it('implausible seed pins the budget to zero (fail closed, no unseeded allowance)', async () => {
    await seedClaimBudget(ADDR, CIPHER_A, 0);
    expect(await remainingClaims(ADDR)).toBe(0);
    expect(await consumeClaimSlot(ADDR)).toBe(false);
    await seedClaimBudget(ADDR, CIPHER_A, 4);
    expect(await remainingClaims(ADDR)).toBe(1);
  });
  it('empty-seed never lifts a real budget, only the transport pin', async () => {
    await seedClaimBudget(ADDR, CIPHER_A, 6);
    await seedClaimBudgetEmpty(ADDR);
    expect(await remainingClaims(ADDR)).toBe(0);
    await resetClaimBudget(ADDR);
    await consumeClaimSlot(ADDR);
    await seedClaimBudgetEmpty(ADDR);
    expect(await remainingClaims(ADDR)).toBe(3);
  });
  it('at six layers the budget is zero - claiming blocked outright', async () => {
    await seedClaimBudget(ADDR, CIPHER_A, 6);
    expect(await consumeClaimSlot(ADDR)).toBe(false);
  });
});

describe('audit holes closed in v3', () => {
  it('unseeded consume allows exactly ONE claim, never unlimited', async () => {
    expect(await consumeClaimSlot(ADDR)).toBe(true);
    expect(await consumeClaimSlot(ADDR)).toBe(false);
    expect(await consumeClaimSlot(ADDR)).toBe(false);
  });
  it('first-time claimer (no cipher yet) gets the true B=0 cap of three', async () => {
    await seedClaimBudgetEmpty(ADDR);
    expect(await consumeClaimSlot(ADDR)).toBe(true);
    expect(await consumeClaimSlot(ADDR)).toBe(true);
    expect(await consumeClaimSlot(ADDR)).toBe(true);
    expect(await consumeClaimSlot(ADDR)).toBe(false);
  });
  it('empty-seed keeps in-flight decrements across stale re-seeds', async () => {
    await seedClaimBudgetEmpty(ADDR);
    await consumeClaimSlot(ADDR);
    await seedClaimBudgetEmpty(ADDR);
    expect(await remainingClaims(ADDR)).toBe(2);
  });
  it('refunds are clamped to the seeded cap', async () => {
    await seedClaimBudget(ADDR, CIPHER_A, 4);
    await refundClaimSlot(ADDR);
    expect(await remainingClaims(ADDR)).toBe(1);
    await consumeClaimSlot(ADDR);
    await refundClaimSlot(ADDR);
    await refundClaimSlot(ADDR);
    expect(await remainingClaims(ADDR)).toBe(1);
  });
  it('unseeded pin does not survive a successful re-seed', async () => {
    await consumeClaimSlot(ADDR);
    await seedClaimBudget(ADDR, CIPHER_A, 2);
    expect(await remainingClaims(ADDR)).toBe(2);
  });
});

describe('concurrency', () => {
  it('parallel consumes never exceed the budget (RMW chain serializes)', async () => {
    await seedClaimBudget(ADDR, CIPHER_A, 2);
    const results = await Promise.all([
      consumeClaimSlot(ADDR),
      consumeClaimSlot(ADDR),
      consumeClaimSlot(ADDR),
      consumeClaimSlot(ADDR),
    ]);
    expect(results.filter(Boolean).length).toBe(2);
    expect(await remainingClaims(ADDR)).toBe(0);
  });
});

describe('round-4 regressions', () => {
  it('empty-seed never lifts the IMPLAUSIBLE pin (only a plausible read may)', async () => {
    await seedClaimBudget(ADDR, CIPHER_A, 0);
    await seedClaimBudgetEmpty(ADDR);
    expect(await remainingClaims(ADDR)).toBe(0);
    expect(await consumeClaimSlot(ADDR)).toBe(false);
  });
  it('the single-writer context never re-delegates (polyfilled window regression)', async () => {
    markSingleWriterContext();
    const prevChrome = (globalThis as { chrome?: unknown }).chrome;
    let delegated = false;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: () => {
          delegated = true;
          return Promise.resolve(undefined);
        },
      },
    };
    _setForceMemStoreForTests(false);
    try {
      await seedClaimBudget(ADDR, CIPHER_A, 2);
      expect(await consumeClaimSlot(ADDR)).toBe(true);
      expect(delegated).toBe(false);
    } finally {
      _setForceMemStoreForTests(true);
      (globalThis as { chrome?: unknown }).chrome = prevChrome;
    }
  });
});
