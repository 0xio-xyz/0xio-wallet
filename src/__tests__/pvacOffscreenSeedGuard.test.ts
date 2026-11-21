import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shipped as-is from public/
import * as guardModule from '../../public/pvac-offscreen-guard.js';
import { pvacSeedFingerprint } from '../services/pvac/pvacSeedFingerprint';

const { createSeedGuard, seedFingerprint, WRONG_SEED_ERROR } = guardModule as {
  createSeedGuard: () => any;
  seedFingerprint: (seed: number[]) => Promise<string>;
  WRONG_SEED_ERROR: string;
};

const SEED_A = new Uint8Array(32).fill(1);
const SEED_B = new Uint8Array(32).fill(2);

function harness() {
  const guard = createSeedGuard();
  let live: string | null = null;
  const events: string[] = [];
  const init = (seed: Uint8Array, fp?: string) =>
    guard.init(
      Array.from(seed),
      fp,
      async () => {
        live = `workers-${seed[0]}`;
        events.push(`build ${seed[0]}`);
        return { ready: true };
      },
      () => {
        if (live) events.push(`teardown ${live}`);
        live = null;
      },
      () => live !== null
    );
  return { guard, init, events, live: () => live };
}

describe('offscreen seed guard', () => {
  it('derives the same fingerprint as PvacManager', async () => {
    expect(await seedFingerprint(Array.from(SEED_A))).toBe(await pvacSeedFingerprint(SEED_A));
    expect(await pvacSeedFingerprint(SEED_A)).not.toBe(await pvacSeedFingerprint(SEED_B));
  });

  it('reuses workers for the same seed and rebuilds them for another', async () => {
    const h = harness();
    expect((await h.init(SEED_A)).rebuilt).toBe(true);
    expect((await h.init(SEED_A)).rebuilt).toBe(false);
    expect((await h.init(SEED_B)).rebuilt).toBe(true);
    expect(h.events).toEqual(['build 1', 'teardown workers-1', 'build 2']);
    expect(h.live()).toBe('workers-2');
  });

  it('refuses requests fingerprinted for any seed but the live one', async () => {
    const h = harness();
    const fpA = await pvacSeedFingerprint(SEED_A);
    const fpB = await pvacSeedFingerprint(SEED_B);
    expect(() => h.guard.check(fpA)).toThrow(WRONG_SEED_ERROR);
    await h.init(SEED_A);
    expect(() => h.guard.check(fpA)).not.toThrow();
    expect(() => h.guard.check(undefined)).toThrow(WRONG_SEED_ERROR);
    await h.init(SEED_B);
    expect(() => h.guard.check(fpA)).toThrow(WRONG_SEED_ERROR);
    expect(() => h.guard.check(fpB)).not.toThrow();
    h.guard.reset();
    expect(() => h.guard.check(fpB)).toThrow(WRONG_SEED_ERROR);
  });

  it('serializes overlapping inits so the last seed wins', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.init(SEED_A), h.init(SEED_B)]);
    expect(a.rebuilt && b.rebuilt).toBe(true);
    expect(h.guard.fingerprint).toBe(await pvacSeedFingerprint(SEED_B));
    expect(h.live()).toBe('workers-2');
  });

  it('rejects an init whose fingerprint does not match its seed', async () => {
    const h = harness();
    await expect(h.init(SEED_A, await pvacSeedFingerprint(SEED_B))).rejects.toThrow(
      'fingerprint mismatch'
    );
    expect(h.live()).toBeNull();
  });
});
