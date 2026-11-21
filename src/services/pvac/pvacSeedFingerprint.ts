// Same derivation as public/pvac-offscreen-guard.js: the offscreen workers accept a request only
// when its fingerprint names the seed they were built from.
const FP_DOMAIN = new TextEncoder().encode('0xio.pvac.offscreen.v1');

export async function pvacSeedFingerprint(seed: Uint8Array): Promise<string> {
  const buf = new Uint8Array(FP_DOMAIN.length + seed.length);
  buf.set(FP_DOMAIN, 0);
  buf.set(seed, FP_DOMAIN.length);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  buf.fill(0);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
