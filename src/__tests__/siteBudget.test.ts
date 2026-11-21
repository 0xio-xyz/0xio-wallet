import { describe, expect, it } from 'vitest';
import { takeSiteBudget } from '../background/services/siteBudget';

describe('site request budget', () => {
  it('allows a page-load burst, then its refill rate', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) expect(takeSiteBudget('https://busy.app', t0)).toBe(true);
    expect(takeSiteBudget('https://busy.app', t0)).toBe(false);

    let allowed = 0;
    for (let i = 0; i < 20; i++) if (takeSiteBudget('https://busy.app', t0 + 1000)) allowed++;
    expect(allowed).toBe(8);
  });

  it('keeps each site on its own budget', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 30; i++) takeSiteBudget('https://one.app', t0);
    expect(takeSiteBudget('https://one.app', t0)).toBe(false);
    expect(takeSiteBudget('https://two.app', t0)).toBe(true);
  });
});
