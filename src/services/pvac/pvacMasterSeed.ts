const LABEL = new TextEncoder().encode('OCTRA_PVAC_MASTER_V1');

/**
 * sha256("OCTRA_PVAC_MASTER_V1" || walletSeed): the only step of pvac-rs keygen_from_seed that
 * reads the wallet key. 0xio Desktop derives identical PVAC keys from it, and never sees the
 * signing key.
 */
export async function pvacMasterSeed(walletSeed: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(LABEL.length + walletSeed.length);
  buf.set(LABEL);
  buf.set(walletSeed, LABEL.length);
  try {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  } finally {
    buf.fill(0);
  }
}
