import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

vi.mock('../services/network/NetworkService', () => ({
  networkService: {},
  privacyNetworkService: {},
}));

import {
  FINAL_STATES,
  LIFECYCLE_LIMITS,
  REVIEW_METHODS,
  RID_PATTERN,
  STATE_MOVES,
  WALLET_CAPABILITIES,
  canonicalJson,
  requestDigest,
} from '../background/services/requestLifecycle';
import { REVIEW_WINDOW_MS } from '../background/services/approvals';
import { OCTRA_PER_SECOND } from '../content/pageRelay';

const file = resolve(__dirname, '../../../0xio-sdk/conformance/vectors.json');
const vectors = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;

describe.skipIf(!vectors)('wallet protocol 2 shared vectors', () => {
  it('digests each request byte for byte', () => {
    for (const v of vectors.digest) {
      const input = { method: v.method, network: v.network, params: v.params };
      expect(canonicalJson(input), v.name).toBe(v.canonical);
      expect(requestDigest(v.method, v.params, v.network), v.name).toBe(v.sha256);
    }
  });

  it('allows exactly the shared moves', () => {
    const { unknown, ...stored } = vectors.transitions;
    expect(unknown).toEqual([]);
    expect(STATE_MOVES).toEqual(stored);
    expect([...FINAL_STATES].sort()).toEqual([...vectors.finalStatuses].sort());
  });

  it('accepts and refuses the same request ids', () => {
    for (const id of vectors.requestId.valid) expect(RID_PATTERN.test(id)).toBe(true);
    for (const id of vectors.requestId.invalid) expect(RID_PATTERN.test(id)).toBe(false);
  });

  it('names the same capabilities and review methods', () => {
    expect([...WALLET_CAPABILITIES]).toEqual(vectors.capabilities);
    for (const m of vectors.lifecycleMethods) expect(REVIEW_METHODS.has(m)).toBe(true);
  });

  it('keeps the same limits', () => {
    const l = vectors.limits;
    expect(LIFECYCLE_LIMITS).toMatchObject({
      perOrigin: l.recordsPerOrigin,
      openPerOrigin: l.openPerOrigin,
      total: l.recordsGlobal,
      lifeMs: l.recordTtlMs,
      replyBytes: l.resultMaxBytes,
      fastIntervalMs: l.watchFastEveryMs,
      fastWatchMs: l.watchFastForMs,
      slowIntervalMs: l.watchSlowEveryMs,
      watchMs: l.watchForMs,
      watchTotal: l.watchedPerWallet,
      watchPerOrigin: l.watchedPerOrigin,
      checkCacheMs: l.chainCheckCacheMs,
      statusPerSecond: l.statusQueriesPerSecond,
    });
    expect(REVIEW_WINDOW_MS).toBe(l.reviewWindowMs);
    expect(OCTRA_PER_SECOND).toBe(l.requestsPerSecond);
  });
});
