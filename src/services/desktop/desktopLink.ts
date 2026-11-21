// No key material moves to 0xio Desktop before connectAndInit returns `verified`.
import {
  authProof,
  fromHex,
  isHex32,
  isId,
  newKeyPair,
  pairCode,
  pairSecret,
  randomBytes,
  sharedSecret,
  toHex,
  transcript,
  verifyProof,
  type DesktopPairing,
} from 'src/services/desktop/desktopPairing';

export const DESKTOP_URL = 'ws://127.0.0.1:19345';
export const CONNECT_TIMEOUT_MS = 10_000;
export const PAIR_TIMEOUT_MS = 120_000;

export type DesktopStatus =
  | 'unknown'
  | 'absent'
  | 'verified'
  | 'not_paired'
  | 'unverified'
  | 'outdated';

// A plain GET fails quietly; a WebSocket logs a console error when nothing listens.
export async function probeDesktop(): Promise<boolean> {
  const probe = await fetch('http://127.0.0.1:19345/', {
    method: 'GET',
    mode: 'no-cors',
    signal: AbortSignal.timeout(2000),
  }).catch((): null => null);
  return !!probe;
}

export function openDesktopSocket(url: string, timeoutMs: number): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      ws.close();
      resolve(null);
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
  });
}

export interface Link {
  call(method: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  onEvent(cb: (msg: any) => void): () => void;
  notify(msg: Record<string, unknown>): void;
}

interface SocketLike {
  send(data: string): void;
  onmessage: ((ev: MessageEvent) => any) | null;
  onclose: ((ev: CloseEvent) => any) | null;
}

export class SocketLink implements Link {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(msg: any) => void>();

  constructor(private ws: SocketLike) {
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const w = typeof msg?._id === 'number' ? this.waiting.get(msg._id) : undefined;
      if (w) {
        this.waiting.delete(msg._id);
        w.resolve(msg);
      } else if (msg && typeof msg.event === 'string') {
        this.listeners.forEach((cb) => cb(msg));
      }
    };
    ws.onclose = () => this.failAll(new Error('0xio Desktop disconnected'));
  }

  call(method: string, args: Record<string, unknown> = {}, timeoutMs = CONNECT_TIMEOUT_MS) {
    const id = ++this.id;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ _id: id, method, ...args }));
      } catch (e) {
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  onEvent(cb: (msg: any) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  notify(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify(msg));
  }

  failAll(e: Error) {
    const all = [...this.waiting.values()];
    this.waiting.clear();
    all.forEach((w) => w.reject(e));
  }
}

export type AuthStatus = 'verified' | 'not_paired' | 'unverified' | 'outdated';

// A proof reply without `protocol` comes from a protocol 1 desktop.
export interface DesktopWallet {
  protocol: 1 | 2;
  kind: 'desktop';
  capabilities: string[];
}

export function desktopWalletOf(reply: any): DesktopWallet {
  const protocol = typeof reply?.protocol === 'number' && reply.protocol >= 2 ? 2 : 1;
  const listed: unknown[] =
    protocol === 2 && Array.isArray(reply?.capabilities) ? reply.capabilities : [];
  const capabilities = [
    ...new Set(
      listed.filter((c): c is string => typeof c === 'string' && /^[a-z0-9_]{1,32}$/.test(c))
    ),
  ].slice(0, 64);
  return { protocol, kind: 'desktop', capabilities };
}

/** Sends nothing secret: only ids, nonces and HMAC proofs. */
export async function authenticate(
  link: Link,
  clientId: string,
  pairing: DesktopPairing | null,
  timeoutMs = CONNECT_TIMEOUT_MS
): Promise<{ status: AuthStatus; desktopId?: string; wallet?: DesktopWallet }> {
  const nonceE = randomBytes(32);
  const hello = await link.call(
    'auth_hello',
    { v: 1, client_id: clientId, nonce: toHex(nonceE) },
    timeoutMs
  );
  if (hello?.v !== 1 || !isId(hello.desktop_id)) return { status: 'outdated' };
  const desktopId: string = hello.desktop_id;
  if (!hello.paired || !pairing || pairing.desktopId !== desktopId) {
    return { status: 'not_paired', desktopId };
  }
  if (!isHex32(hello.nonce)) return { status: 'unverified', desktopId };
  const secret = fromHex(pairing.secret);
  const nonceD = fromHex(hello.nonce);
  // The desktop proves itself first: a program posing as it gets nothing more.
  if (!verifyProof(secret, 'desktop', clientId, desktopId, nonceE, nonceD, hello.proof)) {
    return { status: 'unverified', desktopId };
  }
  const proof = toHex(authProof(secret, 'extension', clientId, desktopId, nonceE, nonceD));
  const done = await link.call('auth_prove', { v: 1, proof }, timeoutMs);
  if (done?.ok !== true) return { status: 'unverified', desktopId };
  return { status: 'verified', desktopId, wallet: desktopWalletOf(done) };
}

/** A desktop that is not verified never sees the seed. */
export async function connectAndInit(
  link: Link,
  opts: {
    clientId: string;
    pairing: DesktopPairing | null;
    master: () => Promise<Uint8Array>;
    timeoutMs?: number;
  }
): Promise<{ status: AuthStatus; desktopId?: string; init?: any }> {
  const auth = await authenticate(link, opts.clientId, opts.pairing, opts.timeoutMs);
  if (auth.status !== 'verified') return auth;
  const master = await opts.master();
  try {
    const init = await link.call(
      'init',
      { master: Array.from(master) },
      opts.timeoutMs ?? CONNECT_TIMEOUT_MS
    );
    return { ...auth, init };
  } finally {
    master.fill(0);
  }
}

export type PairResult =
  | { status: 'paired'; pairing: DesktopPairing }
  | { status: 'refused' | 'timeout' | 'outdated' | 'failed' | 'cancelled' | 'wrong' };

type PairReply = { kind: 'reply'; reply: any };
type PairPick = { kind: 'pick'; ok: boolean };

/**
 * Nothing is kept until the user's pick was right and the desktop said paired; the desktop saves
 * only after auth_pair_confirm. A wrong pick or a cancel sends auth_pair_cancel.
 */
export async function runPairing(
  link: Link,
  clientId: string,
  opts: {
    onCode: (code: string) => void;
    picked: Promise<boolean>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }
): Promise<PairResult> {
  const timeoutMs = opts.timeoutMs ?? PAIR_TIMEOUT_MS;
  const hello = await link.call('auth_hello', {
    v: 1,
    client_id: clientId,
    nonce: toHex(randomBytes(32)),
  });
  if (hello?.v !== 1 || !isId(hello.desktop_id)) return { status: 'outdated' };
  const desktopId: string = hello.desktop_id;
  const { sk, pk } = newKeyPair();
  let derived: { t: Uint8Array; shared: Uint8Array } | null = null;
  const off = link.onEvent((msg) => {
    if (derived || msg.event !== 'pairing' || msg.v !== 1 || msg.desktop_id !== desktopId) return;
    const shared = sharedSecret(sk, msg.epk);
    if (!shared) return;
    derived = { t: transcript(desktopId, clientId, pk, fromHex(msg.epk)), shared };
    opts.onCode(pairCode(shared, derived.t));
  });
  const tell = (type: 'auth_pair_confirm' | 'auth_pair_cancel') => {
    try {
      link.notify({ type, v: 1, client_id: clientId });
    } catch {}
  };
  const cancelled = new Promise<'cancelled'>((resolve) => {
    if (opts.signal?.aborted) resolve('cancelled');
    opts.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true });
  });
  const replyP: Promise<PairReply> = link
    .call('auth_pair', { v: 1, client_id: clientId, epk: toHex(pk) }, timeoutMs + 5_000)
    .then(
      (reply) => ({ kind: 'reply' as const, reply }),
      (e: Error) => ({
        kind: 'reply' as const,
        reply: /timed out/.test(e?.message ?? '') ? { code: 'PAIRING_TIMEOUT' } : null,
      })
    );
  const pickP: Promise<PairPick> = opts.picked.then((ok) => ({ kind: 'pick' as const, ok }));
  const verdict = (reply: any): PairResult => {
    const got = derived as { t: Uint8Array; shared: Uint8Array } | null;
    if (reply?.paired === true && got) {
      const secret = pairSecret(got.shared, got.t);
      const pairing: DesktopPairing = {
        v: 1,
        clientId,
        desktopId,
        secret: toHex(secret),
        pairedAt: Date.now(),
      };
      secret.fill(0);
      return { status: 'paired', pairing };
    }
    if (reply?.code === 'PAIRING_REFUSED') return { status: 'refused' };
    if (reply?.code === 'PAIRING_TIMEOUT') return { status: 'timeout' };
    return { status: 'failed' };
  };
  try {
    const first = await Promise.race([replyP, pickP, cancelled]);
    if (first === 'cancelled') {
      tell('auth_pair_cancel');
      return { status: 'cancelled' };
    }
    if (first.kind === 'reply') {
      if (first.reply?.paired !== true || !derived) return verdict(first.reply);
      const pick = await Promise.race([pickP, cancelled]);
      if (pick === 'cancelled' || !pick.ok) {
        tell('auth_pair_cancel');
        return { status: pick === 'cancelled' ? 'cancelled' : 'wrong' };
      }
      tell('auth_pair_confirm');
      return verdict(first.reply);
    }
    if (!first.ok || !derived) {
      tell('auth_pair_cancel');
      return { status: 'wrong' };
    }
    tell('auth_pair_confirm');
    const reply = await Promise.race([replyP, cancelled]);
    if (reply === 'cancelled') {
      tell('auth_pair_cancel');
      return { status: 'cancelled' };
    }
    return verdict(reply.reply);
  } finally {
    off();
    sk.fill(0);
  }
}
