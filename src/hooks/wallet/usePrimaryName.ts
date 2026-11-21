import { useCallback, useEffect, useRef, useState } from 'react';
import { ONS_PRIMARY_TTL_MS, primaryName } from 'src/services/names/ons';
import { resolveNetworkPin } from 'src/services/network/txScope';
import type { NetworkId } from 'src/utils/config';
import { isOctAddress } from 'src/utils/octra/address';
import { useOnsContract } from 'src/hooks/wallet/useOnsContract';
import { registerSessionCache } from 'src/utils/sessionCaches';

export const PRIMARY_RETRY_MS = 60_000;
export const PRIMARY_CONCURRENCY = 2;

interface Known {
  at: number;
  ttlMs: number;
  name: string | null;
}

const known = new Map<string, Known>();
const inFlight = new Map<string, Promise<string | null>>();
const waiting: Array<() => void> = [];
let running = 0;

export function clearPrimaryNames(): void {
  known.clear();
}
registerSessionCache(clearPrimaryNames);

const keyOf = (networkId: string, address: string) => `${networkId}|${address}`;

function peek(key: string): { name: string | null; fresh: boolean } | null {
  const hit = known.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  return { name: hit.name, fresh: age >= 0 && age < hit.ttlMs };
}

function slot(): Promise<void> {
  if (running < PRIMARY_CONCURRENCY) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

function lookup(networkId: string, address: string): Promise<string | null> {
  const key = keyOf(networkId, address);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const job = (async () => {
    await slot();
    try {
      const read = await primaryName(address, {
        at: await resolveNetworkPin(networkId as NetworkId),
      });
      const name = read.ok === true ? read.name : (known.get(key)?.name ?? null);
      known.set(key, {
        at: Date.now(),
        ttlMs: read.ok === true ? ONS_PRIMARY_TTL_MS : PRIMARY_RETRY_MS,
        name,
      });
      return name;
    } catch {
      known.set(key, { at: Date.now(), ttlMs: PRIMARY_RETRY_MS, name: null });
      return null;
    } finally {
      release();
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

export function usePrimaryName(
  address: string | null | undefined,
  networkId: string | null | undefined
): { ref: (el: Element | null) => void; name: string | null } {
  const contract = useOnsContract(networkId);
  const key =
    address && networkId && contract && isOctAddress(address) ? keyOf(networkId, address) : '';
  const [seen, setSeen] = useState(false);
  const [got, setGot] = useState<{ key: string; name: string | null } | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);

  const ref = useCallback((el: Element | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      setSeen(true);
      io.disconnect();
    });
    io.observe(el);
    observer.current = io;
  }, []);

  // effect:audited - one read per network and address once the row has been on screen.
  useEffect(() => {
    if (!key || !seen || !address || !networkId || peek(key)?.fresh) return;
    let alive = true;
    void lookup(networkId, address).then((name) => {
      if (alive) setGot({ key, name });
    });
    return () => {
      alive = false;
    };
  }, [key, seen, address, networkId]);

  const name = !key ? null : got?.key === key ? got.name : (peek(key)?.name ?? null);
  return { ref, name };
}
