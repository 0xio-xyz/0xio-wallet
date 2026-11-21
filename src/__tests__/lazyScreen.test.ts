import { beforeEach, describe, expect, it } from 'vitest';
import { claimReload, isStaleChunkError } from 'src/utils/lazyScreen';

beforeEach(() => sessionStorage.clear());

describe('stale screen files', () => {
  it('recognises a missing code file after a rebuild', () => {
    expect(
      isStaleChunkError(
        new TypeError(
          'Failed to fetch dynamically imported module: chrome-extension://x/assets/ConnectionsScreen-ChSRY99E.js'
        )
      )
    ).toBe(true);
    expect(isStaleChunkError(new Error('Wallet locked'))).toBe(false);
  });

  it('reloads once, then not again within the window', () => {
    expect(claimReload(1_000_000)).toBe(true);
    expect(claimReload(1_005_000)).toBe(false);
    expect(claimReload(1_020_000)).toBe(true);
  });
});
