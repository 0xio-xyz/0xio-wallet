// Sites signed on 0xio Desktop over the worker's own proven session (never init). Nothing here
// signs: the menu bar review does.
import {
  CONNECT_TIMEOUT_MS,
  DESKTOP_URL,
  SocketLink,
  authenticate,
  openDesktopSocket,
  probeDesktop,
  type DesktopWallet,
  type Link,
} from 'src/services/desktop/desktopLink';
import {
  getClientId,
  loadPairing,
  randomBytes,
  toHex,
  type DesktopPairing,
} from 'src/services/desktop/desktopPairing';
import { logger } from '../../utils/logger';
import { sendEventToOrigins } from './dappConnections';
import { relayableOrigin, type SenderSite } from './siteOrigin';
import {
  DESKTOP_SITES_KEY,
  routedToDesktopAnywhere,
  setSiteSigner,
  siteSigner,
} from './siteSigner';

export const MAX_IN_FLIGHT = 3;
export const REQUEST_TIMEOUT_MS = 125_000;
// A protocol 2 desktop owns its 5 minute review window: the relay waits past it, never cancels.
export const LIFECYCLE_TIMEOUT_MS = 330_000;
const PROTOCOL_1: DesktopWallet = { protocol: 1, kind: 'desktop', capabilities: [] };
export const PING_EVERY_MS = 60_000;
export const RETRY_AFTER_MS = 5_000;

export interface RelayError {
  code: string;
  message: string;
  details?: { requestId?: string; status?: string };
}
export type RelayAnswer =
  | { ok: true; result: unknown; rid?: string; status?: string }
  | { ok: false; error: RelayError; rid?: string; status?: string };

export interface DesktopSite {
  origin: string;
  network: string;
  address: string;
  wallet: { name: string; seed: string };
  connectedAt: number;
}

export interface RelaySocket {
  link: Link;
  close(): void;
  onClose(cb: () => void): void;
}

export interface RelayDeps {
  open(): Promise<RelaySocket | null>;
  pairing(): Promise<DesktopPairing | null>;
  clientId(): Promise<string>;
  deliver(origin: string, eventData: unknown): Promise<void>;
  deliverFrame(tabId: number, frameId: number, origin: string, eventData: unknown): Promise<void>;
  routed(origin: string): Promise<boolean>;
  signer(origin: string, network: string): Promise<'browser' | 'desktop' | undefined>;
  setSigner(origin: string, network: string, signer: 'browser' | 'desktop'): Promise<void>;
  saveSites(sites: DesktopSite[]): Promise<void>;
  now(): number;
}

const fail = (code: string, message: string): RelayAnswer => ({
  ok: false,
  error: { code, message },
});

export const NOT_REACHABLE = fail('NETWORK_ERROR', '0xio Desktop is not reachable.');
const DROPPED = fail('NETWORK_ERROR', '0xio Desktop disconnected before it answered.');
const CANCELLED = fail('USER_REJECTED', 'The request was cancelled.');
const CLOSED = fail('USER_REJECTED', 'The page closed before 0xio Desktop answered.');
const TIMED_OUT = fail('USER_REJECTED', '0xio Desktop did not answer in time.');
const statusUnknown = (rid: string): RelayAnswer => ({
  ok: false,
  error: {
    code: 'STATUS_UNKNOWN',
    message: '0xio Desktop has not answered yet; the request may still finish.',
    details: { requestId: rid, status: 'unknown' },
  },
  rid,
});

const CODE_MAP: Record<string, string> = {
  RATE_LIMITED: 'RATE_LIMIT_EXCEEDED',
  AUTH_REQUIRED: 'NETWORK_ERROR',
  PAIRING_REQUIRED: 'NETWORK_ERROR',
  AUTH_FAILED: 'NETWORK_ERROR',
};

const codeOf = (c: unknown): string => {
  if (typeof c !== 'string' || !/^[A-Z_]{1,64}$/.test(c)) return 'UNKNOWN_ERROR';
  return CODE_MAP[c] ?? c;
};

const text = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v ? v.slice(0, 500) : fallback;

const RID = /^[0-9a-f]{32}$/;
const STATUS = /^[a-z_]{1,20}$/;
export const isRid = (v: unknown): v is string => typeof v === 'string' && RID.test(v);
const isStatus = (v: unknown): v is string => typeof v === 'string' && STATUS.test(v);

function lifecycleOf(reply: any): { rid?: string; status?: string } {
  return {
    ...(isRid(reply?.rid) ? { rid: reply.rid } : {}),
    ...(isStatus(reply?.status) ? { status: reply.status } : {}),
  };
}

export function readReply(reply: any): RelayAnswer {
  const life = lifecycleOf(reply);
  if (reply && typeof reply === 'object' && 'result' in reply) {
    return { ok: true, result: reply.result, ...life };
  }
  const e = reply?.error;
  if (e && typeof e === 'object') {
    const d = e.details;
    const details =
      d && typeof d === 'object'
        ? {
            ...(isRid(d.requestId) ? { requestId: d.requestId } : {}),
            ...(isStatus(d.status) ? { status: d.status } : {}),
          }
        : null;
    return {
      ok: false,
      error: {
        code: codeOf(e.code),
        message: text(e.message, 'Request failed on 0xio Desktop.'),
        ...(details && Object.keys(details).length ? { details } : {}),
      },
      ...life,
    };
  }
  if (typeof e === 'string') return fail(codeOf(reply.code), text(e, 'Request failed.'));
  return fail('UNKNOWN_ERROR', 'No answer from 0xio Desktop.');
}

export function pageEvent(kind: unknown, data: any): { type: string; data: unknown } | null {
  switch (kind) {
    case 'accountsChanged': {
      const accounts = Array.isArray(data?.accounts)
        ? data.accounts.filter((a: unknown) => typeof a === 'string')
        : [];
      if (!accounts.length) return { type: 'disconnect', data: {} };
      return {
        type: 'accountChanged',
        data: {
          address: accounts[0],
          ...(typeof data?.publicKey === 'string' ? { publicKey: data.publicKey } : {}),
          ...(typeof data?.canSign === 'boolean' ? { canSign: data.canSign } : {}),
        },
      };
    }
    case 'networkChanged':
      return { type: 'networkChanged', data: data ?? {} };
    case 'tx':
      return { type: 'transactionConfirmed', data: data ?? {} };
    case 'lock':
      return { type: 'extensionLocked', data: {} };
    case 'request':
      return data && typeof data === 'object' && isRid(data.requestId) && isStatus(data.status)
        ? { type: 'requestUpdate', data }
        : null;
    default:
      return null;
  }
}

function readSites(raw: unknown, clientId: string): DesktopSite[] {
  if (!Array.isArray(raw)) return [];
  const out: DesktopSite[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object' || s.relayed_by !== clientId) continue;
    const origin = relayableOrigin(s.origin, true);
    if (!origin || typeof s.network !== 'string' || typeof s.address !== 'string') continue;
    out.push({
      origin,
      network: s.network,
      address: s.address,
      wallet: {
        name: text(s.wallet?.name, ''),
        seed: text(s.wallet?.seed, s.address),
      },
      connectedAt: Number(s.connected_at) || 0,
    });
  }
  return out;
}

interface Waiting {
  ref: string;
  settle: (a: RelayAnswer) => void;
}

interface Session {
  socket: RelaySocket;
  clientId: string;
  ping: ReturnType<typeof setInterval>;
  wallet: DesktopWallet;
}

interface FrameRef {
  tabId: number;
  frameId: number;
  origin: string;
}

export class DesktopRelay {
  private session: Session | null = null;
  private opening: Promise<Session | null> | null = null;
  private failedAt = 0;
  private inFlight = new Map<string, number>();
  private refs = new Map<string, string>();
  private frames = new Map<string, FrameRef>();
  private waiting = new Map<string, Waiting>();
  private sites: DesktopSite[] = [];

  constructor(private deps: RelayDeps) {}

  get live(): boolean {
    return !!this.session;
  }

  get knownSites(): DesktopSite[] {
    return this.sites;
  }

  async ensure(force = false): Promise<boolean> {
    if (this.session) return true;
    if (!force && this.deps.now() - this.failedAt < RETRY_AFTER_MS) return false;
    if (!this.opening) {
      this.opening = this.open().finally(() => {
        this.opening = null;
      });
    }
    const s = await this.opening;
    if (!s) this.failedAt = this.deps.now();
    return !!s;
  }

  private async open(): Promise<Session | null> {
    const pairing = await this.deps.pairing();
    if (!pairing) return null;
    const socket = await this.deps.open();
    if (!socket) return null;
    let session: Session | null = null;
    socket.onClose(() => {
      if (session) this.dropped(session);
    });
    try {
      const clientId = await this.deps.clientId();
      const auth = await authenticate(socket.link, clientId, pairing);
      if (auth.status !== 'verified') {
        socket.close();
        return null;
      }
      socket.link.onEvent((msg) => void this.onEvent(msg, clientId));
      const sub = await socket.link.call('sites_subscribe', { v: 1 });
      if (sub?.ok !== true) {
        socket.close();
        return null;
      }
      const ping = setInterval(() => {
        socket.link.call('ping', {}, CONNECT_TIMEOUT_MS).catch(() => socket.close());
      }, PING_EVERY_MS);
      session = { socket, clientId, ping, wallet: auth.wallet ?? PROTOCOL_1 };
      this.session = session;
      return session;
    } catch (e) {
      logger.debug(`[DesktopRelay] session not opened: ${(e as Error).message}`);
      socket.close();
      return null;
    }
  }

  private dropped(session: Session): void {
    clearInterval(session.ping);
    if (this.session === session) this.session = null;
    this.refs.clear();
    this.frames.clear();
    const all = [...this.waiting.values()];
    this.waiting.clear();
    all.forEach((w) => w.settle(DROPPED));
  }

  private refFor(tabId: number, frameId: number, origin: string): string {
    const key = `${tabId}:${frameId}`;
    let ref = this.refs.get(key);
    if (!ref) {
      ref = toHex(randomBytes(16));
      this.refs.set(key, ref);
    }
    this.frames.set(ref, { tabId, frameId, origin });
    return ref;
  }

  async wallet(): Promise<DesktopWallet> {
    if (!(await this.ensure(true)) || !this.session) return PROTOCOL_1;
    return this.session.wallet;
  }

  async protocol(): Promise<1 | 2> {
    return (await this.wallet()).protocol;
  }

  async status(site: { origin: string }, rid: string): Promise<RelayAnswer> {
    if (!(await this.ensure(true)) || !this.session) return NOT_REACHABLE;
    try {
      return readReply(
        await this.session.socket.link.call('site_status', { v: 1, rid, origin: site.origin })
      );
    } catch {
      return DROPPED;
    }
  }

  /** An approved request keeps running; the answer is its status after the attempt. */
  async cancel(site: { origin: string }, rid: string): Promise<RelayAnswer> {
    if (!(await this.ensure(true)) || !this.session) return NOT_REACHABLE;
    try {
      const r: any = await this.session.socket.link.call('site_cancel', {
        v: 1,
        rid,
        origin: site.origin,
      });
      if (r && typeof r === 'object' && r.result && typeof r.result === 'object') {
        return { ok: true, result: r.result };
      }
    } catch {
      return DROPPED;
    }
    return this.status(site, rid);
  }

  async request(
    site: SenderSite,
    network: string,
    request: { method: string; params?: unknown; rid?: unknown },
    signal?: AbortSignal
  ): Promise<RelayAnswer> {
    const count = this.inFlight.get(site.origin) ?? 0;
    if (count >= MAX_IN_FLIGHT) {
      return fail(
        'RATE_LIMIT_EXCEEDED',
        `${MAX_IN_FLIGHT} requests from this site are already waiting for 0xio Desktop.`
      );
    }
    this.inFlight.set(site.origin, count + 1);
    try {
      if (signal?.aborted) return CANCELLED;
      if (!(await this.ensure(true)) || !this.session) return NOT_REACHABLE;
      const session = this.session;
      const lifecycle = isRid(request.rid) && session.wallet.protocol >= 2;
      const rid = lifecycle ? (request.rid as string) : null;
      const id = toHex(randomBytes(16));
      const ref = this.refFor(site.tabId, site.frameId, site.origin);
      let settle: (a: RelayAnswer) => void = () => {};
      const local = new Promise<RelayAnswer>((resolve) => {
        settle = resolve;
      });
      this.waiting.set(id, { ref, settle });
      const onAbort = () => {
        settle(CANCELLED);
        session.socket.link.call('site_cancel', { v: 1, id }).catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const asked = session.socket.link
        .call(
          'site_request',
          {
            v: 1,
            id,
            site: {
              origin: site.origin,
              ...(site.topOrigin ? { top_origin: site.topOrigin } : {}),
              framed: site.framed,
              tab_ref: ref,
              browser: site.browser,
            },
            network,
            ...(rid ? { rid } : {}),
            request: { method: request.method, params: request.params ?? {} },
          },
          lifecycle ? LIFECYCLE_TIMEOUT_MS : REQUEST_TIMEOUT_MS
        )
        .then(readReply, (e: Error) => {
          if (this.session === session && /timed out$/.test(e.message)) {
            if (lifecycle) return statusUnknown(rid!);
            session.socket.link.call('site_cancel', { v: 1, id }).catch(() => {});
            return TIMED_OUT;
          }
          return DROPPED;
        });
      try {
        return await Promise.race([asked, local]);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        this.waiting.delete(id);
      }
    } finally {
      const left = (this.inFlight.get(site.origin) ?? 1) - 1;
      if (left > 0) this.inFlight.set(site.origin, left);
      else this.inFlight.delete(site.origin);
    }
  }

  closeFrame(tabId: number, frameId: number): void {
    const key = `${tabId}:${frameId}`;
    const ref = this.refs.get(key);
    if (!ref) return;
    this.refs.delete(key);
    this.frames.delete(ref);
    for (const w of this.waiting.values()) if (w.ref === ref) w.settle(CLOSED);
    this.session?.socket.link.call('site_closed', { v: 1, tab_ref: ref }).catch(() => {});
  }

  closeTab(tabId: number): void {
    for (const key of [...this.refs.keys()]) {
      const [t, f] = key.split(':').map(Number);
      if (t === tabId) this.closeFrame(t, f);
    }
  }

  async disconnectSite(origin: string, network: string): Promise<boolean> {
    if (!(await this.ensure(true)) || !this.session) return false;
    try {
      const r = await this.session.socket.link.call('site_disconnect', { v: 1, origin, network });
      return r?.ok === true;
    } catch {
      return false;
    }
  }

  private async onEvent(msg: any, clientId: string): Promise<void> {
    if (msg?.v !== 1) return;
    if (msg.event === 'sites_snapshot') {
      const sites = readSites(msg.sites, clientId);
      this.sites = sites;
      await this.deps.saveSites(sites).catch(() => {});
      for (const s of sites) {
        const pick = await this.deps.signer(s.origin, s.network);
        if (pick === 'browser') {
          this.session?.socket.link
            .call('site_disconnect', { v: 1, origin: s.origin, network: s.network })
            .catch(() => {});
        } else if (pick === undefined) {
          await this.deps.setSigner(s.origin, s.network, 'desktop').catch(() => {});
        }
      }
      return;
    }
    if (msg.event === 'site_event') {
      const origin = relayableOrigin(msg.origin, true);
      const ev = pageEvent(msg.kind, msg.data);
      if (!origin || !ev) return;
      if (ev.type === 'requestUpdate') {
        if ((this.session?.wallet.protocol ?? 1) < 2) return;
        // Only the frame that sent the request, and only while it still shows that site.
        const frame = typeof msg.tab_ref === 'string' ? this.frames.get(msg.tab_ref) : undefined;
        if (!frame || frame.origin !== origin) return;
        await this.deps.deliverFrame(frame.tabId, frame.frameId, origin, ev).catch(() => {});
        return;
      }
      const ours = this.sites.some((s) => s.origin === origin) || (await this.deps.routed(origin));
      if (!ours) return;
      await this.deps.deliver(origin, ev).catch(() => {});
    }
  }
}

async function openSocket(): Promise<RelaySocket | null> {
  if (!(await probeDesktop())) return null;
  const ws = await openDesktopSocket(DESKTOP_URL, CONNECT_TIMEOUT_MS);
  if (!ws) return null;
  const link = new SocketLink(ws);
  const closers: (() => void)[] = [];
  const linkClose = ws.onclose;
  ws.onclose = (ev) => {
    linkClose?.call(ws, ev);
    closers.forEach((cb) => cb());
  };
  return {
    link,
    close: () => ws.close(),
    onClose: (cb) => closers.push(cb),
  };
}

export function relayDeps(over: Partial<RelayDeps> = {}): RelayDeps {
  return {
    open: openSocket,
    pairing: loadPairing,
    clientId: getClientId,
    deliver: (origin, eventData) => sendEventToOrigins([origin], eventData),
    deliverFrame: async (tabId, frameId, origin, eventData) => {
      await chrome.tabs.sendMessage(
        tabId,
        { type: 'WALLET_EVENT', origin, eventData },
        { frameId }
      );
    },
    routed: routedToDesktopAnywhere,
    signer: siteSigner,
    setSigner: setSiteSigner,
    saveSites: async (sites) => {
      await chrome.storage.session.set({ [DESKTOP_SITES_KEY]: sites });
    },
    now: () => Date.now(),
    ...over,
  };
}

export const desktopRelay = new DesktopRelay(relayDeps());
