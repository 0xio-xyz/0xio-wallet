// Binds the offscreen PVAC workers to one wallet seed. The offscreen document outlives popups and
// wallet switches, so every request carries a fingerprint of the seed it expects and is refused
// unless the workers were built from that same seed.

const FP_DOMAIN = new TextEncoder().encode('0xio.pvac.offscreen.v1');

/** Hex SHA-256 over a domain tag and the seed bytes: identifies a seed without revealing it. */
export async function seedFingerprint(seed) {
  const bytes = seed instanceof Uint8Array ? seed : new Uint8Array(seed);
  const buf = new Uint8Array(FP_DOMAIN.length + bytes.length);
  buf.set(FP_DOMAIN, 0);
  buf.set(bytes, FP_DOMAIN.length);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  buf.fill(0);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const WRONG_SEED_ERROR = 'PVAC offscreen holds a different wallet key';

export function createSeedGuard() {
  let current = null;
  let queue = Promise.resolve();

  return {
    get fingerprint() {
      return current;
    },

    init(seed, expectedFp, build, teardown, isLive) {
      const run = queue.then(async () => {
        const fp = await seedFingerprint(seed);
        if (expectedFp && expectedFp !== fp) throw new Error('PVAC seed fingerprint mismatch');
        if (current === fp && isLive()) return { fp, rebuilt: false, result: null };
        current = null;
        teardown();
        const result = await build();
        current = fp;
        return { fp, rebuilt: true, result };
      });
      queue = run.catch(() => {});
      return run;
    },

    check(fp) {
      if (current === null || fp !== current) throw new Error(WRONG_SEED_ERROR);
    },

    reset() {
      current = null;
    },
  };
}
