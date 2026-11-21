// PVAC layer policy - webcli-verified math.
// Every balance-mutating op (encrypt, claim tx, stealth send, decrypt) adds exactly TWO base
// layers; a fresh/compacted cipher has two; counts are always even and only a compact
// (same-key key_switch) resets them. Proof limits (MimcX5V7): spends/decrypt prove over B+2
// with a 5-layer cap (so B must be 2), the key-switch proof proves over B with a 6-layer cap.
// Ladder: 2 healthy -> 4 spends unprovable (compact still fine) -> 6 last compactable -> 8
// unrecoverable. Claims are the one op the node does not layer-gate, so batch claims are how
// balances jump past 6 and brick - the cap below is the preventer.

/** Base layers at/above which private spends and decrypt cannot be proven (compact required). */
export const REQUIRED_COMPACT_LAYERS = 4;

/** Base layers of the LAST compactable state - the key-switch proof cap. One more op bricks. */
export const KEY_SWITCH_MAX_LAYERS = 6;

/** How many claims may be safely made in one batch at the given base-layer count.
 *  Each claim tx adds two layers; the balance must stay compactable (<= 6). */
export function claimCap(baseLayers: number): number {
  return Math.max(0, Math.floor((KEY_SWITCH_MAX_LAYERS - baseLayers) / 2));
}

export type CompactTier = 'none' | 'compact' | 'critical';

export function compactTier(baseLayers: number): CompactTier {
  if (baseLayers >= KEY_SWITCH_MAX_LAYERS) return 'critical';
  if (baseLayers >= REQUIRED_COMPACT_LAYERS) return 'compact';
  return 'none';
}
