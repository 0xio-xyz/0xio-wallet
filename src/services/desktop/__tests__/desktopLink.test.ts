import { describe, expect, it, vi } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  SocketLink,
  authenticate,
  connectAndInit,
  runPairing,
  type Link,
} from 'src/services/desktop/desktopLink';
import {
  authProof,
  fromHex,
  pairCode,
  pairSecret,
  sharedSecret,
  toHex,
  transcript,
  verifyProof,
  type DesktopPairing,
} from 'src/services/desktop/desktopPairing';

const DESKTOP_ID = '0123456789abcdef0123456789abcdef';
const CLIENT_ID = 'fedcba9876543210fedcba9876543210';
const SECRET = toHex(new Uint8Array(32).fill(5));
const PAIRING: DesktopPairing = {
  v: 1,
  clientId: CLIENT_ID,
  desktopId: DESKTOP_ID,
  secret: SECRET,
  pairedAt: 1,
};

function fakeDesktop(opts: {
  secret?: string | null;
  old?: boolean;
  impostor?: boolean;
  pairAnswer?: 'approve' | 'refuse' | 'hang' | 'afterConfirm';
}) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const notes: Record<string, unknown>[] = [];
  let confirmed: () => void = () => {};
  const confirm = new Promise<void>((r) => (confirmed = r));
  const listeners = new Set<(m: any) => void>();
  let challenge: { ne: Uint8Array; nd: Uint8Array } | null = null;
  const state = { code: '', secret: '' };
  const link: Link = {
    notify: (msg) => {
      notes.push(msg);
      if (msg.type === 'auth_pair_confirm') confirmed();
    },
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async call(method, args = {}) {
      calls.push({ method, args });
      if (opts.old) return { error: `unknown method: ${method}` };
      const secret = opts.secret === undefined ? SECRET : opts.secret;
      if (method === 'auth_hello') {
        if (!secret) return { v: 1, desktop_id: DESKTOP_ID, paired: false };
        const ne = fromHex(args.nonce as string);
        const nd = new Uint8Array(32).fill(9);
        challenge = { ne, nd };
        const proof = opts.impostor
          ? toHex(new Uint8Array(32).fill(1))
          : toHex(authProof(fromHex(secret), 'desktop', CLIENT_ID, DESKTOP_ID, ne, nd));
        return { v: 1, desktop_id: DESKTOP_ID, paired: true, nonce: toHex(nd), proof };
      }
      if (method === 'auth_prove') {
        const ok =
          !!secret &&
          !!challenge &&
          verifyProof(
            fromHex(secret),
            'extension',
            CLIENT_ID,
            DESKTOP_ID,
            challenge.ne,
            challenge.nd,
            args.proof
          );
        return ok
          ? { v: 1, ok: true }
          : { v: 1, error: 'proof does not match', code: 'AUTH_FAILED' };
      }
      if (method === 'auth_pair') {
        const sk = x25519.utils.randomSecretKey();
        const epkD = x25519.getPublicKey(sk);
        const shared = sharedSecret(sk, args.epk as string)!;
        const t = transcript(DESKTOP_ID, CLIENT_ID, fromHex(args.epk as string), epkD);
        state.code = pairCode(shared, t);
        state.secret = toHex(pairSecret(shared, t));
        listeners.forEach((cb) =>
          cb({ event: 'pairing', v: 1, desktop_id: DESKTOP_ID, epk: toHex(epkD) })
        );
        if (opts.pairAnswer === 'hang') return new Promise(() => {});
        if (opts.pairAnswer === 'afterConfirm') {
          await confirm;
          return { v: 1, paired: true, desktop_id: DESKTOP_ID };
        }
        if (opts.pairAnswer === 'refuse')
          return { v: 1, error: 'refused', code: 'PAIRING_REFUSED' };
        return { v: 1, paired: true, desktop_id: DESKTOP_ID };
      }
      if (method === 'init') return { ready: true, pubkey_fp: 'ab', ctx: 'c' };
      return { error: 'unexpected' };
    },
  };
  return { link, calls, notes, state };
}

const sentAnything = (calls: { method: string; args: Record<string, unknown> }[]) =>
  JSON.stringify(calls);

describe('connecting to 0xio Desktop', () => {
  it('sends the master seed only after both sides proved the pairing', async () => {
    const d = fakeDesktop({});
    const master = vi.fn(async () => new Uint8Array(32).fill(4));
    const r = await connectAndInit(d.link, { clientId: CLIENT_ID, pairing: PAIRING, master });
    expect(r.status).toBe('verified');
    expect(d.calls.map((c) => c.method)).toEqual(['auth_hello', 'auth_prove', 'init']);
    expect(master).toHaveBeenCalledTimes(1);
  });

  it('sends no key material to a desktop that cannot prove the secret', async () => {
    for (const d of [
      fakeDesktop({ impostor: true }),
      fakeDesktop({ secret: toHex(new Uint8Array(32).fill(6)) }),
    ]) {
      const master = vi.fn(async () => new Uint8Array(32).fill(4));
      const r = await connectAndInit(d.link, { clientId: CLIENT_ID, pairing: PAIRING, master });
      expect(r.status).toBe('unverified');
      expect(master).not.toHaveBeenCalled();
      expect(d.calls.map((c) => c.method)).toEqual(['auth_hello']);
      expect(sentAnything(d.calls)).not.toMatch(/master|seed|init/);
    }
  });

  it('treats a desktop without pairing, or an old one, as not usable and sends nothing', async () => {
    const master = vi.fn(async () => new Uint8Array(32));
    const fresh = fakeDesktop({ secret: null });
    expect(
      (await connectAndInit(fresh.link, { clientId: CLIENT_ID, pairing: PAIRING, master })).status
    ).toBe('not_paired');
    const old = fakeDesktop({ old: true });
    expect(
      (await connectAndInit(old.link, { clientId: CLIENT_ID, pairing: PAIRING, master })).status
    ).toBe('outdated');
    const unpairedHere = fakeDesktop({});
    expect(
      (await connectAndInit(unpairedHere.link, { clientId: CLIENT_ID, pairing: null, master }))
        .status
    ).toBe('not_paired');
    expect(master).not.toHaveBeenCalled();
    for (const d of [fresh, old, unpairedHere])
      expect(d.calls.map((c) => c.method)).toEqual(['auth_hello']);
  });

  it('does not use a pairing made with another desktop', async () => {
    const d = fakeDesktop({});
    const other = { ...PAIRING, desktopId: 'ffffffffffffffffffffffffffffffff' };
    expect((await authenticate(d.link, CLIENT_ID, other)).status).toBe('not_paired');
  });
});

const CONFIRM = { type: 'auth_pair_confirm', v: 1, client_id: CLIENT_ID };
const CANCEL = { type: 'auth_pair_cancel', v: 1, client_id: CLIENT_ID };
const tick = () => new Promise((r) => setTimeout(r, 10));

function pickLater() {
  let make: (ok: boolean) => void = () => {};
  const picked = new Promise<boolean>((r) => (make = r));
  return { picked, make };
}

describe('pairing with 0xio Desktop', () => {
  it('keeps the desktop secret once the user picked its code, and confirms it', async () => {
    const d = fakeDesktop({ secret: null, pairAnswer: 'afterConfirm' });
    const onCode = vi.fn();
    const r = await runPairing(d.link, CLIENT_ID, { onCode, picked: Promise.resolve(true) });
    expect(onCode).toHaveBeenCalledWith(d.state.code);
    expect(r.status).toBe('paired');
    if (r.status === 'paired') {
      expect(r.pairing.secret).toBe(d.state.secret);
      expect(r.pairing.desktopId).toBe(DESKTOP_ID);
    }
    expect(d.notes).toEqual([CONFIRM]);
    expect(sentAnything(d.calls)).not.toMatch(/master|seed/);
  });

  it('holds an early paired:true silently until the pick', async () => {
    const d = fakeDesktop({ secret: null, pairAnswer: 'approve' });
    const pick = pickLater();
    let done = false;
    const pending = runPairing(d.link, CLIENT_ID, { onCode: () => {}, picked: pick.picked }).then(
      (r) => {
        done = true;
        return r;
      }
    );
    await tick();
    expect(done).toBe(false);
    expect(d.notes).toEqual([]);
    pick.make(true);
    expect((await pending).status).toBe('paired');
    expect(d.notes).toEqual([CONFIRM]);
  });

  it('stops on a wrong pick, keeps nothing and tells the desktop to drop its review', async () => {
    for (const answer of ['approve', 'hang'] as const) {
      const d = fakeDesktop({ secret: null, pairAnswer: answer });
      const r = await runPairing(d.link, CLIENT_ID, {
        onCode: () => {},
        picked: tick().then(() => false),
      });
      expect(r).toEqual({ status: 'wrong' });
      expect(d.notes).toEqual([CANCEL]);
    }
  });

  it('reports a refusal and keeps nothing', async () => {
    const d = fakeDesktop({ secret: null, pairAnswer: 'refuse' });
    const r = await runPairing(d.link, CLIENT_ID, {
      onCode: () => {},
      picked: new Promise(() => {}),
    });
    expect(r.status).toBe('refused');
    expect(d.notes).toEqual([]);
  });

  it('waits for the user until cancelled, then dismisses the desktop review', async () => {
    const d = fakeDesktop({ secret: null, pairAnswer: 'hang' });
    const abort = new AbortController();
    const onCode = vi.fn();
    const pending = runPairing(d.link, CLIENT_ID, {
      onCode,
      picked: new Promise(() => {}),
      signal: abort.signal,
    });
    await tick();
    expect(onCode).toHaveBeenCalledTimes(1);
    abort.abort();
    expect((await pending).status).toBe('cancelled');
    expect(d.notes).toEqual([CANCEL]);
  });

  it('asks an old desktop to update instead of pairing', async () => {
    const d = fakeDesktop({ old: true });
    expect(
      (await runPairing(d.link, CLIENT_ID, { onCode: () => {}, picked: Promise.resolve(true) }))
        .status
    ).toBe('outdated');
    expect(d.calls.map((c) => c.method)).toEqual(['auth_hello']);
  });
});

describe('socket link', () => {
  it('matches replies by id and passes events on', async () => {
    const sent: string[] = [];
    const ws = { send: (s: string) => sent.push(s), onmessage: null, onclose: null } as any;
    const link = new SocketLink(ws);
    const events: any[] = [];
    link.onEvent((m) => events.push(m));
    const reply = link.call('ping');
    const { _id } = JSON.parse(sent[0]);
    ws.onmessage({ data: JSON.stringify({ event: 'pairing', v: 1 }) });
    ws.onmessage({ data: JSON.stringify({ _id, pong: true }) });
    expect(await reply).toMatchObject({ pong: true });
    expect(events).toEqual([{ event: 'pairing', v: 1 }]);
    const lost = link.call('ping');
    ws.onclose();
    await expect(lost).rejects.toThrow(/disconnected/);
  });
});

describe('the protocol a proven desktop names', () => {
  it('is 2 with its checked capabilities, and 1 with none when the field is missing', async () => {
    const { desktopWalletOf } = await import('../desktopLink');
    expect(
      desktopWalletOf({
        v: 1,
        ok: true,
        protocol: 2,
        kind: 'desktop',
        capabilities: ['request_id', 'request_id', 'Bad Cap', 7, 'receipt'],
      })
    ).toEqual({ protocol: 2, kind: 'desktop', capabilities: ['request_id', 'receipt'] });
    expect(desktopWalletOf({ v: 1, ok: true })).toEqual({
      protocol: 1,
      kind: 'desktop',
      capabilities: [],
    });
    expect(desktopWalletOf({ v: 1, ok: true, protocol: '2', capabilities: ['kind'] })).toEqual({
      protocol: 1,
      kind: 'desktop',
      capabilities: [],
    });
  });
});
