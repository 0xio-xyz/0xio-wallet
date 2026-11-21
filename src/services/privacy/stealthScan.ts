import { logger } from 'src/utils/logger';

export interface StealthOutput {
  id: number;
  eph_pub: string;
  stealth_tag: string;
  enc_amount: string;
  claimed: number;
  epoch_id?: number;
  tx_hash?: string;
  amount_hash?: string;
  amount_commitment?: string;
}

export interface MatchedStealthOutput {
  id: number;
  amount: number;
  tag: string;
  epoch: number;
  claimSecret: string;
  blinding: Uint8Array;
  amountHash?: string;
  amountCommitment?: string;
}

export const scopeKey = (networkId: string, address: string) => `${networkId}:${address}`;

const memStore = new Map<string, string>();
const hasChromeStorage = () => typeof chrome !== 'undefined' && !!chrome.storage?.local;
const storage = {
  async get(key: string): Promise<string | null> {
    if (!hasChromeStorage()) return memStore.get(key) ?? null;
    const got = await chrome.storage.local.get(key);
    return typeof got[key] === 'string' ? (got[key] as string) : null;
  },
  async set(key: string, value: string): Promise<void> {
    if (!hasChromeStorage()) {
      memStore.set(key, value);
      return;
    }
    await chrome.storage.local.set({ [key]: value });
  },
};

export interface WaitingRef {
  id: number;
  epoch: number;
}

export interface StealthScanState {
  outputs: MatchedStealthOutput[];
  maxEpoch: number;
  processedIds: Set<number>;
  restore: WaitingRef[];
  lastScanAt: number;
  waitingCheckedAt: number;
}

export interface ScanFindings {
  claimable: MatchedStealthOutput[];
  unchecked: number[];
}

const emptyState = (): StealthScanState => ({
  outputs: [],
  maxEpoch: 0,
  processedIds: new Set(),
  restore: [],
  lastScanAt: 0,
  waitingCheckedAt: 0,
});

/**
 * Only a complete scan with
 * every match checked moves the cursor: after a failed page the older outputs were never fetched,
 * and moving past them hid them.
 */
export function foldStealthScan(
  prev: StealthScanState,
  scan: { outputs: StealthOutput[]; complete: boolean },
  found: ScanFindings,
  claimedHere: ReadonlySet<number>,
  headEpoch: number | null = null
): StealthScanState {
  const claimedNow = new Set(scan.outputs.filter((o) => o.claimed !== 0).map((o) => o.id));
  const outputs = prev.outputs.filter((o) => !claimedNow.has(o.id) && !claimedHere.has(o.id));
  const have = new Set(outputs.map((o) => o.id));
  for (const m of found.claimable) {
    if (have.has(m.id) || claimedHere.has(m.id) || claimedNow.has(m.id)) continue;
    have.add(m.id);
    outputs.push(m);
  }
  const restore = prev.restore.filter((r) => !have.has(r.id) && !claimedNow.has(r.id));

  if (!scan.complete) return { ...prev, outputs, restore };

  const unchecked = new Set(found.unchecked);
  let maxEpoch = prev.maxEpoch;
  if (unchecked.size === 0) {
    for (const o of scan.outputs) maxEpoch = Math.max(maxEpoch, o.epoch_id ?? 0);
    if (headEpoch != null) maxEpoch = Math.max(maxEpoch, headEpoch);
  }
  const processedIds = new Set<number>();
  for (const o of scan.outputs) {
    if (unchecked.has(o.id)) continue;
    if ((o.epoch_id ?? 0) >= maxEpoch - 1) processedIds.add(o.id);
  }
  return { ...prev, outputs, restore, maxEpoch, processedIds };
}

export function newestFirst<T extends { id: number; timestamp?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.timestamp != null && b.timestamp != null && a.timestamp !== b.timestamp
      ? b.timestamp - a.timestamp
      : b.id - a.id
  );
}

// Per scope (network and address): its own outputs, cursor and processed ids. The cursor and the
// waiting ids are stored, so a restart resumes where the last scan stopped; the opened outputs
// (claim secret, blinding) stay in memory only and are opened again from the node after a restart.
const scopes = new Map<string, StealthScanState>();
const loading = new Map<string, Promise<StealthScanState | undefined>>();
const running = new Map<string, Promise<MatchedStealthOutput[] | null>>();

const STORE_PREFIX = 'stealth_scan_v1:';

interface Stored {
  maxEpoch: number;
  processed: number[];
  waiting: WaitingRef[];
  lastScanAt: number;
}

const isRef = (r: unknown): r is WaitingRef =>
  !!r && Number.isInteger((r as WaitingRef).id) && Number.isFinite((r as WaitingRef).epoch);

export async function loadScope(scope: string): Promise<StealthScanState | undefined> {
  const mem = scopes.get(scope);
  if (mem) return mem;
  let pending = loading.get(scope);
  if (!pending) {
    pending = (async () => {
      try {
        const raw = await storage.get(STORE_PREFIX + scope);
        if (!raw) return undefined;
        const s = JSON.parse(raw) as Partial<Stored>;
        if (typeof s.maxEpoch !== 'number' || !Number.isFinite(s.maxEpoch)) return undefined;
        return {
          ...emptyState(),
          maxEpoch: s.maxEpoch,
          processedIds: new Set((s.processed ?? []).filter(Number.isInteger)),
          restore: (s.waiting ?? []).filter(isRef),
          lastScanAt: typeof s.lastScanAt === 'number' ? s.lastScanAt : 0,
        };
      } catch (e) {
        logger.warn('[ClaimScan] stored cursor unreadable, starting over:', e);
        return undefined;
      }
    })();
    loading.set(scope, pending);
  }
  const read = await pending;
  loading.delete(scope);
  // A scan or a claim may have written the scope meanwhile; that state is newer.
  const now = scopes.get(scope);
  if (now) return now;
  if (read) scopes.set(scope, read);
  return read;
}

function persist(scope: string): void {
  const s = scopes.get(scope);
  if (!s) return;
  const gone = claimedInScope(scope);
  const waiting: WaitingRef[] = [
    ...s.outputs.map((o) => ({ id: o.id, epoch: o.epoch })),
    ...s.restore,
  ].filter((r) => !gone.has(r.id));
  const stored: Stored = {
    maxEpoch: s.maxEpoch,
    processed: [...s.processedIds],
    waiting,
    lastScanAt: s.lastScanAt,
  };
  storage
    .set(STORE_PREFIX + scope, JSON.stringify(stored))
    .catch((e) => logger.warn('[ClaimScan] could not store the cursor:', e));
}

// Claimed on this device lately, per scope. Until the chain executes a claim, a scan still lists
// it as waiting, and showing it again would invite a second claim of the same transfer.
const CLAIMED_TTL_MS = 10 * 60_000;
const claimedHere = new Map<string, Map<number, number>>();

export function scanState(scope: string): StealthScanState | undefined {
  return scopes.get(scope);
}

export function claimedInScope(scope: string, now: number = Date.now()): Set<number> {
  const at = claimedHere.get(scope);
  if (!at) return new Set();
  for (const [id, t] of at) if (now - t > CLAIMED_TTL_MS) at.delete(id);
  return new Set(at.keys());
}

export function dropFromScope(scope: string, ids: number[], now: number = Date.now()): void {
  const at = claimedHere.get(scope) ?? new Map<number, number>();
  for (const id of ids) at.set(id, now);
  claimedHere.set(scope, at);
  const s = scopes.get(scope);
  if (s) {
    const gone = new Set(ids);
    scopes.set(scope, {
      ...s,
      outputs: s.outputs.filter((o) => !gone.has(o.id)),
      restore: s.restore.filter((r) => !gone.has(r.id)),
    });
    persist(scope);
  }
}

export function forgetClaimed(scope: string, ids: number[]): void {
  const at = claimedHere.get(scope);
  for (const id of ids) at?.delete(id);
}

export function restoreToScope(scope: string, outputs: MatchedStealthOutput[]): void {
  forgetClaimed(
    scope,
    outputs.map((o) => o.id)
  );
  const s = scopes.get(scope);
  if (!s) return;
  const have = new Set(s.outputs.map((o) => o.id));
  scopes.set(scope, { ...s, outputs: [...s.outputs, ...outputs.filter((o) => !have.has(o.id))] });
  persist(scope);
}

export interface ScanDeps {
  head: () => Promise<number | null>;
  fetch: (
    fromEpoch: number,
    headEpoch: number | null
  ) => Promise<{ outputs: StealthOutput[]; complete: boolean }>;
  byId: (ids: number[], minEpoch: number) => Promise<StealthOutput[] | null>;
  match: (outputs: StealthOutput[]) => Promise<MatchedStealthOutput[]>;
  check: (matched: MatchedStealthOutput[]) => Promise<ScanFindings>;
  stillHere: () => Promise<boolean>;
  idle?: () => Promise<void>;
  now?: () => number;
}

export const WAITING_RECHECK_MS = 5 * 60_000;
const RESET_SLACK = 1000;
const MATCH_CHUNK = 50;

async function openInChunks(
  outputs: StealthOutput[],
  d: ScanDeps
): Promise<MatchedStealthOutput[] | null> {
  const mine: MatchedStealthOutput[] = [];
  for (let i = 0; i < outputs.length; i += MATCH_CHUNK) {
    await d.idle?.();
    if (!(await d.stillHere())) return null;
    mine.push(...(await d.match(outputs.slice(i, i + MATCH_CHUNK))));
  }
  return mine;
}

export function scanScope(scope: string, d: ScanDeps): Promise<MatchedStealthOutput[] | null> {
  const inFlight = running.get(scope);
  if (inFlight) return inFlight;
  const run = runScan(scope, d).finally(() => running.delete(scope));
  running.set(scope, run);
  return run;
}

async function runScan(scope: string, d: ScanDeps): Promise<MatchedStealthOutput[] | null> {
  const now = d.now ?? Date.now;
  await d.idle?.();
  let start = (await loadScope(scope)) ?? emptyState();
  const head = await d.head();
  if (!(await d.stillHere())) return null;
  if (head != null && start.maxEpoch > head + RESET_SLACK) {
    logger.warn(
      `[ClaimScan] node epoch ${head} is under the cursor ${start.maxEpoch}: chain reset`
    );
    start = emptyState();
    scopes.set(scope, start);
  }

  const fromEpoch = start.maxEpoch > 0 ? start.maxEpoch - 1 : 0;
  await d.idle?.();
  const scan = await d.fetch(fromEpoch, head);
  if (!(await d.stillHere())) return null;

  const unclaimed = scan.outputs.filter((o) => o.claimed === 0 && !start.processedIds.has(o.id));
  let found: ScanFindings = { claimable: [], unchecked: [] };
  if (unclaimed.length > 0) {
    const matched = await openInChunks(unclaimed, d);
    if (!matched) return null;
    await d.idle?.();
    if (!(await d.stillHere())) return null;
    found = await d.check(matched);
    if (!(await d.stillHere())) return null;
  }

  // A claim may have dropped an output while this ran: fold into the scope as it is now.
  let next = foldStealthScan(scopes.get(scope) ?? start, scan, found, claimedInScope(scope), head);

  // Waiting outputs under the range just read: their claimed flag and their secrets come from the
  // node by id (webcli reads by id before a claim). After a restart that is the only way to open
  // them again; otherwise every few minutes, so one claimed elsewhere leaves the list.
  const t = now();
  const stale = t - next.waitingCheckedAt > WAITING_RECHECK_MS;
  const refs: WaitingRef[] = [
    ...next.restore,
    ...(stale
      ? next.outputs
          .filter((o) => o.epoch < fromEpoch || !scan.complete)
          .map((o) => ({ id: o.id, epoch: o.epoch }))
      : []),
  ];
  if (refs.length === 0 && stale) next = { ...next, waitingCheckedAt: t };
  if (refs.length > 0) {
    await d.idle?.();
    const raw = await d.byId(
      refs.map((r) => r.id),
      Math.min(...refs.map((r) => r.epoch))
    );
    if (!(await d.stillHere())) return null;
    if (raw) {
      const claimedNow = new Set(raw.filter((o) => o.claimed !== 0).map((o) => o.id));
      const open = raw.filter((o) => o.claimed === 0);
      let reopened: ScanFindings = { claimable: [], unchecked: [] };
      if (open.length > 0) {
        const matched = await openInChunks(open, d);
        if (!matched) return null;
        reopened = await d.check(matched);
        if (!(await d.stillHere())) return null;
      }
      const answered = new Set(raw.map((o) => o.id));
      const keep = new Set(reopened.unchecked);
      const gone = claimedInScope(scope);
      const fresh = reopened.claimable.filter((m) => !gone.has(m.id));
      const freshIds = new Set(fresh.map((m) => m.id));
      next = {
        ...next,
        outputs: [
          ...next.outputs.filter(
            (o) =>
              !claimedNow.has(o.id) &&
              !freshIds.has(o.id) &&
              (!answered.has(o.id) || keep.has(o.id))
          ),
          ...fresh,
        ],
        restore: next.restore.filter((r) => !answered.has(r.id) || keep.has(r.id)),
        waitingCheckedAt: stale ? t : next.waitingCheckedAt,
      };
    }
  }

  next = { ...next, lastScanAt: t };
  scopes.set(scope, next);
  persist(scope);
  return next.outputs;
}

export function resetStealthScopesForTests(storageToo = false): void {
  if (storageToo) memStore.clear();
  scopes.clear();
  loading.clear();
  running.clear();
  claimedHere.clear();
}
