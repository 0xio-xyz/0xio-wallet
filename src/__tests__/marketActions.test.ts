import { describe, expect, it } from 'vitest';
import { marketActionsOn } from 'src/features/wallet/nft/nftData';

const base = {
  market: true,
  verdictIn: true,
  listable: 'ready' as const,
  listed: false,
  listingUnknown: false,
};

describe('market actions on a piece page', () => {
  it('waits for the collection verdict before offering List', () => {
    expect(marketActionsOn({ ...base, verdictIn: false, listable: 'unknown' })).toBe(false);
    expect(marketActionsOn(base)).toBe(true);
  });

  it('never offers List on an incompatible collection', () => {
    expect(marketActionsOn({ ...base, listable: 'incompatible' })).toBe(false);
  });

  it('keeps List when the node never answered', () => {
    expect(marketActionsOn({ ...base, listable: 'unknown' })).toBe(true);
  });

  it('always offers the listing actions on a listed piece', () => {
    expect(
      marketActionsOn({ ...base, verdictIn: false, listable: 'incompatible', listed: true })
    ).toBe(true);
  });

  it('offers nothing when the listing read failed or there is no market', () => {
    expect(marketActionsOn({ ...base, listingUnknown: true })).toBe(false);
    expect(marketActionsOn({ ...base, market: false })).toBe(false);
  });
});
