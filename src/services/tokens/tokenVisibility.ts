import { OCT_ADDRESS_RE } from 'src/utils/octra/address';
import { registerSessionCache } from 'src/utils/sessionCaches';

export type VisMap = Readonly<Record<string, boolean>>;

export const VIS_PREFIX = '0xio_token_vis_';
const MAX_ENTRIES = 1000;
const EVM_CONTRACT = /^0x[0-9a-f]{40}$/;

export const evmVisKey = (chainId: number, address: string) =>
  `${VIS_PREFIX}evm_${chainId}_${address.toLowerCase()}`;

export const octraVisKey = (networkId: string, address: string) =>
  `${VIS_PREFIX}oct_${networkId}_${address}`;

const isEvmKey = (key: string) => key.startsWith(`${VIS_PREFIX}evm_`);

export const visContract = (key: string, contract: string) =>
  isEvmKey(key) ? contract.toLowerCase() : contract;

export function cleanVisMap(key: string, raw: unknown): VisMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const valid = isEvmKey(key) ? EVM_CONTRACT : OCT_ADDRESS_RE;
  const out: Record<string, boolean> = {};
  let n = 0;
  for (const [contract, shown] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_ENTRIES) break;
    if (typeof shown !== 'boolean' || !valid.test(contract)) continue;
    out[contract] = shown;
    n++;
  }
  return out;
}

const mem = new Map<string, VisMap>();
registerSessionCache(() => mem.clear());

export const peekVisibility = (key: string): VisMap | undefined => mem.get(key);

export async function readVisibility(keys: readonly string[]): Promise<Record<string, VisMap>> {
  const out: Record<string, VisMap> = {};
  const missing = keys.filter((k) => !mem.has(k));
  if (missing.length) {
    try {
      const stored = await chrome.storage.local.get(missing);
      for (const k of missing) if (!mem.has(k)) mem.set(k, cleanVisMap(k, stored?.[k]));
    } catch {}
  }
  for (const k of keys) out[k] = mem.get(k) ?? {};
  return out;
}

const pending = new Map<string, number>();

export function primeVisibility(key: string, raw: unknown): void {
  if (pending.get(key)) return;
  mem.set(key, cleanVisMap(key, raw));
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch((): undefined => undefined);
  return next;
}

export function setTokenShown(key: string, contract: string, shown: boolean): Promise<VisMap> {
  const c = visContract(key, contract);
  const prior = (mem.get(key) ?? {})[c];
  mem.set(key, { ...(mem.get(key) ?? {}), [c]: shown });
  pending.set(key, (pending.get(key) ?? 0) + 1);
  return serial(async () => {
    try {
      const stored = await chrome.storage.local.get([key]);
      const next = { ...cleanVisMap(key, stored?.[key]), [c]: shown };
      await chrome.storage.local.set({ [key]: next });
      if (pending.get(key) === 1) mem.set(key, next);
      return next;
    } catch (e) {
      const rest = Object.fromEntries(Object.entries(mem.get(key) ?? {}).filter(([k]) => k !== c));
      mem.set(key, prior === undefined ? rest : { ...rest, [c]: prior });
      throw e;
    } finally {
      const left = (pending.get(key) ?? 1) - 1;
      if (left > 0) pending.set(key, left);
      else pending.delete(key);
    }
  });
}
