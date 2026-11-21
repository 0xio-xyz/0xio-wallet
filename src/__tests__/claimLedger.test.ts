import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookups = vi.hoisted(() => ({
  status: { status: 'unknown', confirmed: false } as Record<string, unknown>,
  outputs: null as unknown[] | null,
  balance: { nonce: 0, pending_nonce: 0 } as Record<string, unknown>,
}));

vi.mock('../services/network/NetworkService', () => ({
  rpcNonce: (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null),
  networkService: {
    getTransactionStatus: vi.fn(async () => lookups.status),
    jsonRpcCall: vi.fn(async () => lookups.balance),
  },
  privacyNetworkService: {
    getStealthOutputsById: vi.fn(async () => lookups.outputs),
  },
}));

import { RpcUnsentError } from '../services/network/rpcExchange';
import { TxSubmitError } from '../services/network/txOutcome';
import {
  CLAIM_STAGING_LIFETIME_MS,
  claimFaultCode,
  claimOutputRefusal,
  claimResend,
  claimResendFor,
  claimSlot,
  claimSlotFor,
  noteClaimOutcome,
  noteClaimSent,
  observeClaim,
  savedClaim,
  type ClaimRow,
} from '../services/privacy/claimLedger';

const A = 'oct' + 'A'.repeat(44);
const MAIN = { networkId: 'mainnet', rpcUrl: 'https://octra.network' } as const;
const DEV = { networkId: 'devnet', rpcUrl: 'https://devnet.octrascan.io' } as const;
const NONE: { confirmed: number | null; pending: number | null } = {
  confirmed: null,
  pending: null,
};

const row = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  outputId: 7,
  hash: 'h'.repeat(64),
  nonce: 5,
  status: 'confirmed',
  at: 0,
  ...over,
});

describe('claim slot', () => {
  it('is fresh with no saved claim', () => {
    expect(claimSlot(null).kind).toBe('fresh');
  });
  it('blocks a confirmed claim in conflict', () => {
    expect(claimSlot(row({ conflictAt: 1 })).kind).toBe('blocked');
  });
  it('returns the earlier claim while it is pending or confirmed', () => {
    expect(claimSlot(row({ status: 'pending' })).kind).toBe('previous');
    expect(claimSlot(row()).kind).toBe('previous');
  });
  it('recovers a released or dropped claim only with its saved bytes', () => {
    const tx = { nonce: 5 } as never;
    expect(claimSlot(row({ status: 'unknown', released: true, tx })).kind).toBe('recovery');
    expect(claimSlot(row({ status: 'dropped', tx })).kind).toBe('recovery');
    expect(claimSlot(row({ status: 'unknown', released: true })).kind).toBe('fresh');
  });
  it('holds an unclear claim until it is released', () => {
    const tx = { nonce: 5 } as never;
    expect(claimSlot(row({ status: 'unknown', tx })).kind).toBe('previous');
    expect(claimSlot(row({ status: 'unknown' })).kind).toBe('previous');
  });
  it('lets a missing or rejected claim be claimed fresh', () => {
    expect(claimSlot(row({ status: 'missing' })).kind).toBe('fresh');
    expect(claimSlot(row({ status: 'rejected' })).kind).toBe('fresh');
  });
});

describe('conflict then missing', () => {
  it('notes the conflict once, then marks it missing after the staging lifetime', () => {
    const first = observeClaim(row(), 'notFound', 'unspent', NONE, 1_000);
    expect(first.conflictAt).toBe(1_000);
    expect(claimSlot(first).kind).toBe('blocked');

    const again = observeClaim(first, 'notFound', 'unspent', NONE, 1_000 + 300_000);
    expect(again).toBe(first);

    const atEdge = observeClaim(first, 'notFound', 'unspent', NONE, 1_000 + 600_000);
    expect(atEdge.status).toBe('confirmed');

    const late = observeClaim(
      first,
      'notFound',
      'unspent',
      NONE,
      1_000 + CLAIM_STAGING_LIFETIME_MS + 1
    );
    expect(late.status).toBe('missing');
    expect(late.conflictAt).toBeUndefined();
    expect(claimSlot(late).kind).toBe('fresh');
  });

  it('settles the claim when the output reads spent', () => {
    const conflicted = row({ conflictAt: 1_000 });
    const settled = observeClaim(conflicted, 'confirmed', 'spent', NONE, 2_000);
    expect(settled.status).toBe('confirmed');
    expect(settled.conflictAt).toBeUndefined();
    expect(claimSlot(settled).kind).toBe('previous');
  });

  it('changes nothing when the output is unknown', () => {
    const r = row();
    expect(observeClaim(r, 'notFound', 'unknown', NONE, 5_000)).toBe(r);
    expect(observeClaim(r, 'error', 'unknown', NONE, 5_000)).toBe(r);
  });

  it('stages a pending claim the node lost, then calls it open once the nonce passed', () => {
    const pending = row({ status: 'pending', stagedAt: undefined });
    const staged = observeClaim(pending, 'notFound', 'unspent', { confirmed: 3, pending: 4 }, 10);
    expect(staged.status).toBe('pending');
    expect(staged.stagedAt).toBe(10);
    const passed = observeClaim(staged, 'notFound', 'unspent', { confirmed: 5, pending: 5 }, 20);
    expect(passed.status).toBe('unknown');
    const expired = observeClaim(
      staged,
      'notFound',
      'unspent',
      { confirmed: 3, pending: 4 },
      10 + CLAIM_STAGING_LIFETIME_MS + 1
    );
    expect(expired.status).toBe('unknown');
  });
});

describe('unclear claim release', () => {
  const unclear = row({ status: 'unknown', at: 1_000, tx: { nonce: 5, ou: '1000' } as never });

  it('stays held inside the staging lifetime while its nonce is open', () => {
    const r = observeClaim(unclear, 'notFound', 'unspent', { confirmed: 3, pending: 4 }, 600_000);
    expect(r.released).toBeUndefined();
    expect(claimSlot(r).kind).toBe('previous');
  });

  it('is released 600 s after it was sent', () => {
    const r = observeClaim(
      unclear,
      'notFound',
      'unspent',
      { confirmed: 3, pending: 4 },
      1_000 + CLAIM_STAGING_LIFETIME_MS + 1
    );
    expect(r.released).toBe(true);
    expect(claimSlot(r).kind).toBe('recovery');
  });

  it('is released at once when its nonce is spent', () => {
    const r = observeClaim(unclear, 'notFound', 'unspent', { confirmed: 5, pending: 5 }, 2_000);
    expect(r.released).toBe(true);
  });

  it('is not released while the node stages its nonce or the output is not unspent', () => {
    const late = 1_000 + CLAIM_STAGING_LIFETIME_MS + 1;
    const staged = observeClaim(unclear, 'notFound', 'unspent', { confirmed: 3, pending: 5 }, late);
    expect(staged.released).toBeUndefined();
    expect(observeClaim(unclear, 'notFound', 'unknown', NONE, late)).toBe(unclear);
    expect(observeClaim(unclear, 'error', 'unspent', NONE, late).released).toBeUndefined();
  });
});

describe('resend guard', () => {
  const saved = row({ status: 'dropped', nonce: 5, tx: { nonce: 5, ou: '1000' } as never });

  it('resends only when the output is unspent, the nonce is next and the fee is the reviewed one', () => {
    expect(claimResend(saved, 'unspent', 5, '1000')).toBe('resend');
  });
  it('builds fresh when the nonce moved or the fee changed', () => {
    expect(claimResend(saved, 'unspent', 6, '1000')).toBe('fresh');
    expect(claimResend(saved, 'unspent', 4, '1000')).toBe('fresh');
    expect(claimResend(saved, 'unspent', null, '1000')).toBe('fresh');
    expect(claimResend(saved, 'unspent', 5, '2000')).toBe('fresh');
    expect(claimResend(row({ status: 'dropped', nonce: 5 }), 'unspent', 5, '1000')).toBe('fresh');
  });
  it('sends nothing when the output is spent or unreadable', () => {
    expect(claimResend(saved, 'spent', 5, '1000')).toBe('spent');
    expect(claimResend(saved, 'unknown', 5, '1000')).toBe('unreadable');
  });
});

describe('dApp claim codes', () => {
  it('splits spent from unreadable', () => {
    expect(claimOutputRefusal('spent').code).toBe('CLAIM_OUTPUT_SPENT');
    expect(claimOutputRefusal('unknown').code).toBe('CLAIM_OUTPUT_UNREADABLE');
  });
  it('maps faults after the retry window', () => {
    expect(claimFaultCode(new RpcUnsentError('capacity'))).toBe('RATE_LIMIT_EXCEEDED');
    expect(claimFaultCode(new RpcUnsentError('busy'))).toBe('RATE_LIMIT_EXCEEDED');
    expect(claimFaultCode(new RpcUnsentError('network'))).toBe('NETWORK_ERROR');
    const unsent = new TxSubmitError('not_accepted', 'x', null, 'capacity');
    expect(claimFaultCode(unsent)).toBe('RATE_LIMIT_EXCEEDED');
    expect(claimFaultCode(new Error('rpc capacity reached'))).toBe('RATE_LIMIT_EXCEEDED');
    expect(claimFaultCode(new Error('network unreachable: reset'))).toBe('NETWORK_ERROR');
    expect(claimFaultCode(new TxSubmitError('rejected', 'bad proof'))).toBeNull();
    expect(claimFaultCode(new Error('proof failed'))).toBeNull();
  });
});

describe('claim ledger storage', () => {
  const store = new Map<string, unknown>();
  beforeEach(() => {
    store.clear();
    (chrome.storage as any).local = {
      get: async (k: string) => (store.has(k) ? { [k]: structuredClone(store.get(k)) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [k, val] of Object.entries(items)) store.set(k, structuredClone(val));
      },
    };
    lookups.status = { status: 'unknown', confirmed: false };
    lookups.outputs = null;
    lookups.balance = { nonce: 0, pending_nonce: 0 };
    vi.useRealTimers();
  });

  const signed = {
    from: A,
    to_: A,
    amount: '0',
    nonce: 9,
    ou: '1000',
    timestamp: 1_700_000_000,
    op_type: 'claim',
    encrypted_data: '{}',
    signature: 'c2ln',
    public_key: 'cHVi',
  };

  it('keeps rows per network and address', async () => {
    const hash = await noteClaimSent(MAIN, A, 7, signed as never);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await savedClaim(MAIN, A, 7))?.status).toBe('unknown');
    expect(await savedClaim(DEV, A, 7)).toBeNull();
    expect(await savedClaim(MAIN, 'oct' + 'B'.repeat(44), 7)).toBeNull();
  });

  it('holds an unclear claim, releases it after 600 s, then stands on it once the node has it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const hash = (await noteClaimSent(MAIN, A, 7, signed as never))!;
    lookups.outputs = [{ id: 7, claimed: 0 }];
    lookups.balance = { nonce: 8, pending_nonce: 8 };
    expect((await claimSlotFor(MAIN, A, 7)).kind).toBe('previous');

    vi.setSystemTime(1_000_000 + CLAIM_STAGING_LIFETIME_MS + 1);
    const slot = await claimSlotFor(MAIN, A, 7);
    expect(slot.kind).toBe('recovery');
    expect(slot.kind !== 'fresh' && slot.row.tx).toBeTruthy();
    vi.useRealTimers();

    await noteClaimOutcome(MAIN, A, 7, hash, 'pending');
    lookups.status = { status: 'pending', confirmed: false };
    const after = await claimSlotFor(MAIN, A, 7);
    expect(after.kind).toBe('previous');
    expect(after.kind !== 'fresh' && after.row.tx).toBeUndefined();
  });

  it('blocks a confirmed claim the node lost while the output is unspent', async () => {
    const hash = (await noteClaimSent(MAIN, A, 7, signed as never))!;
    await noteClaimOutcome(MAIN, A, 7, hash, 'pending');
    lookups.status = { status: 'confirmed', confirmed: true, finality: 'confirmed' };
    expect((await claimSlotFor(MAIN, A, 7)).kind).toBe('previous');

    lookups.status = { status: 'unknown', confirmed: false };
    lookups.outputs = [{ id: 7, claimed: 0 }];
    expect((await claimSlotFor(MAIN, A, 7)).kind).toBe('blocked');
    expect((await savedClaim(MAIN, A, 7))?.conflictAt).toBeTypeOf('number');
  });

  it('reads the output and the node nonce before a resend', async () => {
    await noteClaimSent(MAIN, A, 7, signed as never);
    const saved = (await savedClaim(MAIN, A, 7))!;
    lookups.outputs = [{ id: 7, claimed: 0 }];
    lookups.balance = { nonce: 8, pending_nonce: 8 };
    expect(await claimResendFor(MAIN, A, saved, '1000')).toBe('resend');
    expect(await claimResendFor(MAIN, A, saved, '1001')).toBe('fresh');
    lookups.balance = { nonce: 9, pending_nonce: 9 };
    expect(await claimResendFor(MAIN, A, saved, '1000')).toBe('fresh');
    lookups.outputs = [{ id: 7, claimed: 12 }];
    expect(await claimResendFor(MAIN, A, saved, '1000')).toBe('spent');
    lookups.outputs = null;
    expect(await claimResendFor(MAIN, A, saved, '1000')).toBe('unreadable');
  });

  it('frees the slot after a refusal', async () => {
    const hash = (await noteClaimSent(MAIN, A, 7, signed as never))!;
    await noteClaimOutcome(MAIN, A, 7, hash, 'rejected');
    expect((await claimSlotFor(MAIN, A, 7)).kind).toBe('fresh');
  });
});
