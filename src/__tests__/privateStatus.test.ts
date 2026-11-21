import { describe, expect, it } from 'vitest';
import { privateStatusOf } from 'src/services/privacy/privateStatus';
import { homeTagOrder } from 'src/features/wallet/home/homeTags';
import { octraNative } from 'src/features/wallet/home/pricedHoldings';

const fresh = {
  cipher_class: 'empty',
  key_class: 'missing',
  migration_route: 'direct_key_switch',
  can_key_switch: true,
  can_v3_migrate: false,
  can_owner_proof_migrate: false,
  can_cipher_proof_migrate: false,
  needs_legacy_public_replay: false,
  reason: 'encrypted balance is empty',
};

const legacyHeld = {
  cipher_class: 'legacy_hfhe',
  key_class: 'missing',
  migration_route: 'history_migration',
  can_key_switch: false,
  can_v3_migrate: false,
  can_owner_proof_migrate: false,
  can_cipher_proof_migrate: false,
  needs_legacy_public_replay: true,
  reason: 'legacy hfhe balance needs public-history replay or ciphertext migration proof',
  legacy_public_replay: {
    audit_class: 'poisoned',
    can_public_migrate: false,
    reason: 'legacy public replay history index is incomplete',
  },
};

describe('private status', () => {
  it('reads a wallet with nothing encrypted as empty', () => {
    expect(privateStatusOf(fresh)).toEqual({ kind: 'empty', reason: null });
  });

  it('reads a legacy balance with no route open as held, with the node reason', () => {
    expect(privateStatusOf(legacyHeld)).toEqual({
      kind: 'held',
      reason: 'legacy public replay history index is incomplete',
    });
  });

  it('is open as soon as a route this wallet can run opens', () => {
    for (const open of [
      { can_v3_migrate: true },
      { legacy_public_replay: { can_public_migrate: true } },
      { can_key_switch: true },
    ]) {
      expect(privateStatusOf({ ...legacyHeld, ...open })?.kind).toBe('open');
    }
  });

  it('stays held on routes without client support, so Home agrees with Privacy', () => {
    for (const unsupported of [
      { can_owner_proof_migrate: true },
      { can_cipher_proof_migrate: true },
      { can_owner_proof_migrate: true, can_cipher_proof_migrate: true },
    ]) {
      expect(privateStatusOf({ ...legacyHeld, ...unsupported })).toEqual({
        kind: 'held',
        reason: 'legacy public replay history index is incomplete',
      });
    }
  });

  it('knows nothing from a failed or odd read', () => {
    expect(privateStatusOf(null)).toBeNull();
    expect(privateStatusOf({} as never)).toBeNull();
  });

  it('shows one private tag at most, held before set up', () => {
    const base = { padded: false, backup: false, keyBlocked: false, setupPrivate: true };
    expect(homeTagOrder({ ...base, privateHold: true })).toEqual(['privateHold']);
    expect(homeTagOrder({ ...base, keyBlocked: true, privateHold: true })).toEqual(['keyBlocked']);
    expect(homeTagOrder(base)).toEqual(['setupPrivate']);
  });

  it('does not wait on a private half that is empty or held', () => {
    expect(octraNative('19004.29', null, true, true)).toEqual({ value: 19004.29, missing: null });
  });
});
