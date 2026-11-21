/**
 * Balance snapshots for the portfolio chart. The public half goes to local storage. The private
 * half goes to session storage only, under the balance cache prefix, so a lock or a browser
 * restart drops it and nothing on disk tells the private amount.
 */
import { privateHistoryKey } from './balanceCache';

export const BAL_HIST_PREFIX = '0xio_bal_hist_';
const MAX_POINTS = 2880;
const MIN_INTERVAL_S = 25;

export interface BalanceSnapshot {
  time: number;
  bal: number;
}

interface PublicPoint {
  time: number;
  pub: number;
}

interface PrivatePoint {
  time: number;
  priv: number;
}

function storageKey(address: string, network: string): string {
  return `${BAL_HIST_PREFIX}${network}_${address}`;
}

function legacyKey(address: string, network: string): string {
  return `${BAL_HIST_PREFIX}${network}_${address.slice(0, 12)}`;
}

const isPublicPoint = (p: unknown): p is PublicPoint =>
  !!p &&
  typeof p === 'object' &&
  Number.isFinite((p as PublicPoint).time) &&
  Number.isFinite((p as PublicPoint).pub);

const isPrivatePoint = (p: unknown): p is PrivatePoint =>
  !!p &&
  typeof p === 'object' &&
  Number.isFinite((p as PrivatePoint).time) &&
  Number.isFinite((p as PrivatePoint).priv);

async function readPublic(address: string, network: string): Promise<PublicPoint[]> {
  const key = storageKey(address, network);
  const old = legacyKey(address, network);
  const result = await chrome.storage.local.get([key, old]);
  if (Array.isArray(result[key])) return result[key].filter(isPublicPoint);
  if (result[old] !== undefined) await chrome.storage.local.remove(old);
  return [];
}

async function readPrivate(address: string, network: string): Promise<PrivatePoint[]> {
  try {
    const key = privateHistoryKey(network, address);
    const stored = (await chrome.storage.session.get(key))?.[key];
    return Array.isArray(stored) ? stored.filter(isPrivatePoint) : [];
  } catch {
    return [];
  }
}

async function sessionUnlocked(): Promise<boolean> {
  try {
    return !!(await chrome.storage.session.get('wallet_unlocked'))?.wallet_unlocked;
  } catch {
    return false;
  }
}

function pushPoint<T extends { time: number }>(points: T[], point: T): T[] | null {
  if (points.length > 0 && point.time - points[points.length - 1].time < MIN_INTERVAL_S) {
    return null;
  }
  points.push(point);
  if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
  return points;
}

export async function appendSnapshot(
  address: string,
  network: string,
  publicBalance: number,
  privateBalance: number | null
): Promise<void> {
  const time = Math.floor(Date.now() / 1000);
  try {
    const pub = pushPoint(await readPublic(address, network), { time, pub: publicBalance });
    if (pub) await chrome.storage.local.set({ [storageKey(address, network)]: pub });
  } catch {}
  if (privateBalance === null || !(await sessionUnlocked())) return;
  try {
    const priv = pushPoint(await readPrivate(address, network), { time, priv: privateBalance });
    if (priv) await chrome.storage.session.set({ [privateHistoryKey(network, address)]: priv });
  } catch {}
}

export function combineSnapshots(
  pub: PublicPoint[],
  priv: PrivatePoint[],
  fallbackPrivate = 0
): BalanceSnapshot[] {
  const sorted = [...priv].sort((a, b) => a.time - b.time);
  const base = sorted[0]?.priv ?? fallbackPrivate;
  let i = 0;
  let current = base;
  return [...pub]
    .sort((a, b) => a.time - b.time)
    .map((p) => {
      while (i < sorted.length && sorted[i].time <= p.time) current = sorted[i++].priv;
      return { time: p.time, bal: p.pub + current };
    });
}

export async function getSnapshots(
  address: string,
  network: string,
  hoursBack = 24,
  fallbackPrivate = 0
): Promise<BalanceSnapshot[]> {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - hoursBack * 3600;
    const [pub, priv] = await Promise.all([
      readPublic(address, network),
      readPrivate(address, network),
    ]);
    return combineSnapshots(
      pub.filter((p) => p.time >= cutoff),
      priv,
      fallbackPrivate
    );
  } catch {
    return [];
  }
}

export async function clearSnapshots(address: string, network: string): Promise<void> {
  try {
    await chrome.storage.local.remove([storageKey(address, network), legacyKey(address, network)]);
  } catch {}
  try {
    await chrome.storage.session.remove(privateHistoryKey(network, address));
  } catch {}
}

export async function stripPrivateFromSnapshots(): Promise<void> {
  try {
    const all =
      ((await chrome.storage.local.get(null)) as unknown as Record<string, unknown>) ?? {};
    const rewrite: Record<string, PublicPoint[]> = {};
    const drop: string[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(BAL_HIST_PREFIX)) continue;
      if (!Array.isArray(value)) {
        drop.push(key);
        continue;
      }
      if (value.every(isPublicPoint) && value.every((p) => !('bal' in p))) continue;
      const kept = value.filter(isPublicPoint).map((p) => ({ time: p.time, pub: p.pub }));
      if (kept.length) rewrite[key] = kept;
      else drop.push(key);
    }
    if (Object.keys(rewrite).length) await chrome.storage.local.set(rewrite);
    if (drop.length) await chrome.storage.local.remove(drop);
  } catch {}
}
