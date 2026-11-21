import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimedInScope,
  dropFromScope,
  foldStealthScan,
  newestFirst,
  resetStealthScopesForTests,
  restoreToScope,
  scanScope,
  scanState,
  scopeKey,
  WAITING_RECHECK_MS,
  type MatchedStealthOutput,
  type ScanDeps,
  type StealthOutput,
  type StealthScanState,
} from 'src/services/privacy/stealthScan';

vi.mock('src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const stored = new Map<string, unknown>();
const local = chrome.storage.local as unknown as Record<string, ReturnType<typeof vi.fn>>;

const raw = (id: number, epoch: number, claimed = 0): StealthOutput => ({
  id,
  eph_pub: `e${id}`,
  stealth_tag: `t${id}`,
  enc_amount: `a${id}`,
  claimed,
  epoch_id: epoch,
});
const match = (id: number, epoch = 0): MatchedStealthOutput => ({
  id,
  amount: id * 1000,
  tag: `t${id}`,
  epoch,
  claimSecret: `s${id}`,
  blinding: new Uint8Array(32),
});
const state = (over: Partial<StealthScanState> = {}): StealthScanState => ({
  outputs: [],
  maxEpoch: 0,
  processedIds: new Set(),
  restore: [],
  lastScanAt: 0,
  waitingCheckedAt: 0,
  ...over,
});
const none = new Set<number>();
const flush = () => new Promise((r) => setImmediate(r));

describe('foldStealthScan', () => {
  it('a complete scan adds what is ours and moves the cursor; only its edge stays processed', () => {
    const next = foldStealthScan(
      state(),
      { outputs: [raw(1, 100), raw(2, 105)], complete: true },
      { claimable: [match(2, 105)], unchecked: [] },
      none
    );
    expect(next.outputs.map((o) => o.id)).toEqual([2]);
    expect(next.maxEpoch).toBe(105);
    expect([...next.processedIds]).toEqual([2]);
  });

  it('a complete scan moves the cursor to the node epoch it began at', () => {
    const next = foldStealthScan(
      state({ maxEpoch: 90 }),
      { outputs: [raw(1, 100)], complete: true },
      { claimable: [], unchecked: [] },
      none,
      400
    );
    expect(next.maxEpoch).toBe(400);
    expect(next.processedIds.size).toBe(0);
  });

  it('after a failed page keeps what it found but neither moves the cursor nor marks anything', () => {
    const prev = state({ maxEpoch: 90, processedIds: new Set([7]) });
    const next = foldStealthScan(
      prev,
      { outputs: [raw(1, 100), raw(2, 105)], complete: false },
      { claimable: [match(2, 105)], unchecked: [] },
      none,
      400
    );
    expect(next.outputs.map((o) => o.id)).toEqual([2]);
    expect(next.maxEpoch).toBe(90);
    expect([...next.processedIds]).toEqual([7]);
  });

  it('finds a match only once when the same range is read again', () => {
    const once = foldStealthScan(
      state(),
      { outputs: [raw(2, 105)], complete: false },
      { claimable: [match(2, 105)], unchecked: [] },
      none
    );
    const twice = foldStealthScan(
      once,
      { outputs: [raw(2, 105)], complete: true },
      { claimable: [match(2, 105)], unchecked: [] },
      none
    );
    expect(twice.outputs.map((o) => o.id)).toEqual([2]);
  });

  it('leaves unchecked outputs unprocessed and the cursor where it was', () => {
    const next = foldStealthScan(
      state({ maxEpoch: 50 }),
      { outputs: [raw(1, 100), raw(2, 105)], complete: true },
      { claimable: [], unchecked: [2] },
      none,
      400
    );
    expect(next.processedIds.has(1)).toBe(true);
    expect(next.processedIds.has(2)).toBe(false);
    expect(next.maxEpoch).toBe(50);
  });

  it('drops outputs the node now reports claimed and never brings back ones claimed here', () => {
    const next = foldStealthScan(
      state({ outputs: [match(1), match(2)], maxEpoch: 10, processedIds: new Set([1, 2]) }),
      { outputs: [raw(1, 10, 1), raw(3, 11)], complete: true },
      { claimable: [match(3)], unchecked: [] },
      new Set([2, 3])
    );
    expect(next.outputs).toEqual([]);
  });

  it('sorts newest first', () => {
    expect(newestFirst([{ id: 1 }, { id: 3 }, { id: 2 }]).map((i) => i.id)).toEqual([3, 2, 1]);
    expect(
      newestFirst([
        { id: 1, timestamp: 50 },
        { id: 2, timestamp: 40 },
      ]).map((i) => i.id)
    ).toEqual([1, 2]);
  });
});

describe('scanScope', () => {
  beforeEach(() => {
    resetStealthScopesForTests(true);
    stored.clear();
    local.get.mockImplementation(async (k: string) =>
      stored.has(k) ? { [k]: stored.get(k) } : {}
    );
    local.set.mockImplementation(async (o: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(o)) stored.set(k, v);
    });
  });

  const deps = (
    over: Partial<ScanDeps> & {
      pages?: Record<number, StealthOutput[]>;
      node?: StealthOutput[];
      headEpoch?: number | null;
    } = {}
  ): ScanDeps => ({
    head: vi.fn(async () => (over.headEpoch === undefined ? null : over.headEpoch)),
    fetch: vi.fn(async (fromEpoch: number) => ({
      outputs: over.pages?.[fromEpoch] ?? [],
      complete: true,
    })),
    byId: vi.fn(async (ids: number[]) => (over.node ?? []).filter((o) => ids.includes(o.id))),
    match: vi.fn(async (outputs: StealthOutput[]) =>
      outputs.filter((o) => o.id % 2 === 0).map((o) => match(o.id, o.epoch_id))
    ),
    check: vi.fn(async (matched: MatchedStealthOutput[]) => ({
      claimable: matched,
      unchecked: [],
    })),
    stillHere: vi.fn(async () => true),
    ...over,
  });

  it('keeps a separate cache and cursor per wallet and network', async () => {
    const devA = scopeKey('devnet', 'octA');
    const mainA = scopeKey('mainnet', 'octA');
    const devB = scopeKey('devnet', 'octB');

    await scanScope(devA, deps({ pages: { 0: [raw(2, 100), raw(3, 101)] } }));
    expect(scanState(devA)?.outputs.map((o) => o.id)).toEqual([2]);
    expect(scanState(devA)?.maxEpoch).toBe(101);
    expect(scanState(mainA)).toBeUndefined();
    expect(scanState(devB)).toBeUndefined();

    const forB = deps({ pages: { 0: [raw(4, 7)] } });
    await scanScope(devB, forB);
    expect(forB.fetch).toHaveBeenCalledWith(0, null);
    expect(scanState(devB)?.outputs.map((o) => o.id)).toEqual([4]);
    expect(scanState(devA)?.outputs.map((o) => o.id)).toEqual([2]);

    const again = deps({ pages: { 100: [raw(6, 102)] } });
    await scanScope(devA, again);
    expect(again.fetch).toHaveBeenCalledWith(100, null);
    expect(scanState(devA)?.outputs.map((o) => o.id)).toEqual([2, 6]);
  });

  it('keeps the cursor across a restart and opens the waiting outputs again by id', async () => {
    const devA = scopeKey('devnet', 'octA');
    await scanScope(devA, deps({ pages: { 0: [raw(2, 100), raw(3, 101)] }, headEpoch: 1618222 }));
    expect(scanState(devA)?.maxEpoch).toBe(1618222);

    resetStealthScopesForTests();
    const after = deps({ node: [raw(2, 100)], headEpoch: 1618300 });
    const outputs = await scanScope(devA, after);
    expect(after.fetch).toHaveBeenCalledWith(1618221, 1618300);
    expect(after.byId).toHaveBeenCalledWith([2], 100);
    expect(outputs?.map((o) => o.id)).toEqual([2]);
    expect(outputs?.[0].claimSecret).toBe('s2');
  });

  it('never stores the opened secrets', async () => {
    const devA = scopeKey('devnet', 'octA');
    await scanScope(devA, deps({ pages: { 0: [raw(2, 100)] } }));
    await flush();
    const saved = String(stored.get(`stealth_scan_v1:${devA}`));
    expect(saved).toContain('"waiting":[{"id":2,"epoch":100}]');
    expect(saved).not.toContain('s2');
    expect(saved).not.toContain('blinding');
  });

  it('drops a restored output the node now reports claimed', async () => {
    const devA = scopeKey('devnet', 'octA');
    await scanScope(devA, deps({ pages: { 0: [raw(2, 100)] }, headEpoch: 500 }));
    resetStealthScopesForTests();
    const after = deps({ node: [raw(2, 100, 1)], headEpoch: 510 });
    await expect(scanScope(devA, after)).resolves.toEqual([]);
    expect(after.match).not.toHaveBeenCalled();
  });

  it('a partial scan keeps the stored cursor', async () => {
    const devA = scopeKey('devnet', 'octA');
    await scanScope(devA, deps({ pages: { 0: [raw(3, 100)] }, headEpoch: 500 }));
    const partial = deps({
      headEpoch: 900,
      fetch: vi.fn(async () => ({ outputs: [raw(5, 700)], complete: false })),
    });
    await scanScope(devA, partial);
    resetStealthScopesForTests();
    const next = deps({ headEpoch: 900 });
    await scanScope(devA, next);
    expect(next.fetch).toHaveBeenCalledWith(499, 900);
  });

  it('starts over after a chain reset', async () => {
    const devA = scopeKey('devnet', 'octA');
    await scanScope(devA, deps({ pages: { 0: [raw(2, 100)] }, headEpoch: 50_000 }));
    resetStealthScopesForTests();
    const reset = deps({ headEpoch: 120 });
    await scanScope(devA, reset);
    expect(reset.fetch).toHaveBeenCalledWith(0, 120);
    expect(reset.byId).not.toHaveBeenCalled();
  });

  it('joins a scan already running for the scope', async () => {
    const devA = scopeKey('devnet', 'octA');
    const d = deps({ pages: { 0: [raw(2, 100)] } });
    const [a, b] = await Promise.all([scanScope(devA, d), scanScope(devA, d)]);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('reads waiting outputs under the cursor again every few minutes', async () => {
    const devA = scopeKey('devnet', 'octA');
    let t = 1_000_000;
    const now = () => t;
    await scanScope(devA, deps({ pages: { 0: [raw(2, 100)] }, headEpoch: 500, now }));
    const later = deps({ headEpoch: 510, now, node: [raw(2, 100, 1)] });
    t += 60_000;
    await scanScope(devA, later);
    expect(later.byId).not.toHaveBeenCalled();
    expect(scanState(devA)?.outputs.map((o) => o.id)).toEqual([2]);
    t += WAITING_RECHECK_MS;
    await scanScope(devA, later);
    expect(later.byId).toHaveBeenCalledWith([2], 100);
    expect(scanState(devA)?.outputs).toEqual([]);
  });

  it('drops a scan that lands after a switch: no scope takes its result', async () => {
    const devA = scopeKey('devnet', 'octA');
    await scanScope(devA, deps({ pages: { 0: [raw(2, 100)] } }));
    const before = scanState(devA);

    let here = true;
    const late = deps({
      fetch: vi.fn(async () => {
        here = false;
        return { outputs: [raw(8, 120)], complete: true };
      }),
      stillHere: vi.fn(async () => here),
    });
    await expect(scanScope(devA, late)).resolves.toBeNull();
    expect(late.match).not.toHaveBeenCalled();
    expect(scanState(devA)).toBe(before);
    expect(scanState(scopeKey('devnet', 'octB'))).toBeUndefined();
  });

  it('drops a scan whose wallet changed while outputs were being opened', async () => {
    const devA = scopeKey('devnet', 'octA');
    const answers = [true, true, false];
    const late = deps({
      pages: { 0: [raw(2, 100)] },
      stillHere: vi.fn(async () => answers.shift() ?? false),
    });
    await expect(scanScope(devA, late)).resolves.toBeNull();
    expect(late.check).not.toHaveBeenCalled();
    expect(scanState(devA)).toBeUndefined();
  });

  it('keeps claimed-here ids per scope, and a rejected claim waits again', async () => {
    const devA = scopeKey('devnet', 'octA');
    const devB = scopeKey('devnet', 'octB');
    await scanScope(devA, deps({ pages: { 0: [raw(2, 100), raw(4, 100)] } }));
    dropFromScope(devA, [2]);
    expect(scanState(devA)?.outputs.map((o) => o.id)).toEqual([4]);
    expect(claimedInScope(devA).has(2)).toBe(true);
    expect(claimedInScope(devB).has(2)).toBe(false);
    restoreToScope(devA, [match(2, 100)]);
    expect(claimedInScope(devA).has(2)).toBe(false);
    expect(
      scanState(devA)
        ?.outputs.map((o) => o.id)
        .sort()
    ).toEqual([2, 4]);
  });

  it('forgets a claimed-here id after ten minutes', () => {
    const devA = scopeKey('devnet', 'octA');
    dropFromScope(devA, [5], 1_000);
    expect(claimedInScope(devA, 1_000 + 9 * 60_000).has(5)).toBe(true);
    expect(claimedInScope(devA, 1_000 + 11 * 60_000).has(5)).toBe(false);
  });
});
