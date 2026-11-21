import { describe, it, expect } from 'vitest';
import { needsRebackup } from 'src/services/wallet/rebackup';

const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

describe('wallets to back up again', () => {
  it('asks only for first-run Create wallets made since the 18 May rework', () => {
    expect(
      needsRebackup({
        type: 'standard',
        metadata: { source: 'generate', createdAt: at(2026, 6, 1) },
      })
    ).toBe(true);
    expect(
      needsRebackup({
        type: 'standard',
        metadata: { source: 'generate', createdAt: at(2026, 5, 18) },
      })
    ).toBe(true);
  });

  it('leaves older wallets, other sources and watch-only wallets alone', () => {
    expect(
      needsRebackup({
        type: 'standard',
        metadata: { source: 'generate', createdAt: at(2026, 5, 17) },
      })
    ).toBe(false);
    expect(
      needsRebackup({
        type: 'standard',
        metadata: { source: 'generated', createdAt: at(2026, 7, 1) },
      })
    ).toBe(false);
    expect(
      needsRebackup({
        type: 'standard',
        metadata: { source: 'imported_phrase', createdAt: at(2026, 7, 1) },
      })
    ).toBe(false);
    expect(
      needsRebackup({ type: 'watch', metadata: { source: 'generate', createdAt: at(2026, 7, 1) } })
    ).toBe(false);
    expect(needsRebackup(null)).toBe(false);
  });
});
