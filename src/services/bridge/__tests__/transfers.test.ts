import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  lockProgress: vi.fn(),
  claimCheck: vi.fn(),
  burnMessageId: vi.fn(),
  findUnlock: vi.fn(),
  wOctAllowance: vi.fn(),
  ethereumMainnet: () => ({ rpcUrl: 'https://eth.example' }),
}));
const rpc = vi.hoisted(() => ({ rpcCall: vi.fn() }));
const send = vi.hoisted(() => ({ broadcast: vi.fn() }));

vi.mock('../bridge', () => bridge);
vi.mock('../../evm/rpc', () => rpc);
vi.mock('../../evm/send', () => send);

import { CLAIM_DROPPED, SENT_GIVE_UP_MS, advance, type BridgeTransfer } from '../transfers';

const chain = (state: { receipt?: unknown; tx?: unknown; nonce?: number }) =>
  rpc.rpcCall.mockImplementation(async (_url: string, method: string) => {
    if (method === 'eth_getTransactionReceipt') return state.receipt ?? null;
    if (method === 'eth_getTransactionByHash') return state.tx ?? null;
    if (method === 'eth_getTransactionCount') return `0x${(state.nonce ?? 0).toString(16)}`;
    throw new Error(`unexpected ${method}`);
  });

const base: BridgeTransfer = {
  id: 'x',
  direction: 'o2e',
  amountRaw: '2000000',
  octAddress: 'oct1',
  evmAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  recipient: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  createdAt: 1,
  updatedAt: 1,
  status: 'locking',
  lockHash: 'h1',
};
const lock = {
  hash: 'h2',
  epoch: 9,
  amountRaw: '2000000',
  ethAddress: base.recipient,
  srcNonce: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  send.broadcast.mockResolvedValue('0xc');
});

describe('advance', () => {
  it('moves a confirmed lock to waiting and keeps the real hash', async () => {
    bridge.lockProgress.mockResolvedValue({
      state: 'confirmed',
      locked: { ...lock, amountRaw: 2_000_000n },
    });
    expect(await advance(base)).toEqual({ status: 'waiting', lockHash: 'h2', locked: lock });
  });

  it('marks a rejected lock as failed', async () => {
    bridge.lockProgress.mockResolvedValue({ state: 'failed', hash: 'h1', reason: 'rejected' });
    expect(await advance(base)).toMatchObject({ status: 'failed', note: 'rejected' });
  });

  it('turns a waiting lock claimable, or done when already claimed', async () => {
    const waiting = { ...base, status: 'waiting' as const, locked: lock };
    bridge.claimCheck.mockResolvedValueOnce({ state: 'claimable', data: '0xabc' });
    expect(await advance(waiting)).toMatchObject({ status: 'claimable', claimData: '0xabc' });
    bridge.claimCheck.mockResolvedValueOnce({ state: 'claimed' });
    expect(await advance(waiting)).toEqual({ status: 'done' });
    bridge.claimCheck.mockResolvedValueOnce({ state: 'waiting' });
    expect(await advance(waiting)).toBeNull();
  });

  it('finishes a claim only on a successful receipt', async () => {
    const claiming = {
      ...base,
      status: 'claiming' as const,
      claimHash: '0xc',
      claimNonce: 4,
      claimSentAt: Date.now(),
      locked: lock,
    };
    chain({ tx: { hash: '0xc' }, nonce: 4 });
    expect(await advance(claiming)).toBeNull();
    chain({ receipt: { status: '0x0' } });
    expect(await advance(claiming)).toMatchObject({ status: 'claimable', note: 'claim_failed' });
    chain({ receipt: { status: '0x1' } });
    expect(await advance(claiming)).toMatchObject({ status: 'done' });
    expect(bridge.claimCheck).not.toHaveBeenCalled();
  });

  it('sends a claim the node does not know again, with the same signed bytes', async () => {
    const claiming = {
      ...base,
      status: 'claiming' as const,
      claimHash: '0xc',
      claimNonce: 4,
      claimRaw: '0x02f8',
      claimSentAt: Date.now(),
      locked: lock,
    };
    chain({ tx: null, nonce: 4 });
    expect(await advance(claiming)).toBeNull();
    expect(send.broadcast).toHaveBeenCalledWith({ rpcUrl: 'https://eth.example' }, '0x02f8');
    chain({ tx: { hash: '0xc' }, nonce: 4 });
    send.broadcast.mockClear();
    expect(await advance(claiming)).toBeNull();
    expect(send.broadcast).not.toHaveBeenCalled();
  });

  it('leaves Claiming once the claim nonce was used without its receipt', async () => {
    const claiming = {
      ...base,
      status: 'claiming' as const,
      claimHash: '0xc',
      claimNonce: 4,
      claimSentAt: Date.now(),
      locked: lock,
    };
    chain({ tx: null, nonce: 5 });
    bridge.claimCheck.mockResolvedValueOnce({ state: 'claimed' });
    expect(await advance(claiming)).toMatchObject({ status: 'done', claimHash: undefined });
    bridge.claimCheck.mockResolvedValueOnce({ state: 'claimable', data: '0xnew' });
    expect(await advance(claiming)).toMatchObject({
      status: 'claimable',
      claimData: '0xnew',
      note: CLAIM_DROPPED,
      claimHash: undefined,
    });
    bridge.claimCheck.mockResolvedValueOnce({ state: 'waiting' });
    expect(await advance(claiming)).toMatchObject({ status: 'waiting' });
    expect(bridge.claimCheck).toHaveBeenCalledWith(
      expect.objectContaining({ epoch: 9, amountRaw: 2_000_000n }),
      base.evmAddress
    );
  });

  it('gives up on a claim no node has known for 10 minutes', async () => {
    const claiming = {
      ...base,
      status: 'claiming' as const,
      claimHash: '0xc',
      claimNonce: 4,
      claimSentAt: Date.now() - SENT_GIVE_UP_MS - 1,
      locked: lock,
    };
    chain({ tx: null, nonce: 4 });
    bridge.claimCheck.mockResolvedValueOnce({ state: 'claimable', data: '0xnew' });
    expect(await advance(claiming)).toMatchObject({ status: 'claimable', note: CLAIM_DROPPED });
    chain({ tx: { hash: '0xc' }, nonce: 4 });
    expect(await advance(claiming)).toBeNull();
  });

  it('checks a claiming transfer without a hash on Ethereum', async () => {
    const claiming = { ...base, status: 'claiming' as const, locked: lock };
    bridge.claimCheck.mockResolvedValueOnce({ state: 'blocked', reason: 'cap' });
    expect(await advance(claiming)).toMatchObject({ status: 'blocked', note: 'cap' });
    expect(rpc.rpcCall).not.toHaveBeenCalled();
  });

  it('settles a dropped allowance by what the bridge may spend', async () => {
    const approving = {
      ...base,
      direction: 'e2o' as const,
      recipient: 'oct1',
      status: 'approving' as const,
      approveHash: '0xa',
      approveNonce: 2,
      approveSentAt: Date.now(),
    };
    chain({ tx: null, nonce: 3 });
    bridge.wOctAllowance.mockResolvedValueOnce(2_000_000n);
    expect(await advance(approving)).toMatchObject({ status: 'ready_to_burn' });
    bridge.wOctAllowance.mockResolvedValueOnce(0n);
    expect(await advance(approving)).toMatchObject({ status: 'failed', note: 'approve_dropped' });
    chain({ tx: { hash: '0xa' }, nonce: 2 });
    expect(await advance(approving)).toBeNull();
  });

  it('walks a burn through to the unlock on Octra', async () => {
    const e2o = { ...base, direction: 'e2o' as const, recipient: 'oct1' };
    chain({ receipt: { status: '0x1' } });
    expect(await advance({ ...e2o, status: 'approving', approveHash: '0xa' })).toMatchObject({
      status: 'ready_to_burn',
    });
    bridge.burnMessageId.mockResolvedValueOnce('0xmsg');
    expect(await advance({ ...e2o, status: 'burning', burnHash: '0xb' })).toMatchObject({
      status: 'unlocking',
      messageId: '0xmsg',
    });
    bridge.findUnlock.mockResolvedValueOnce(null);
    expect(await advance({ ...e2o, status: 'unlocking', messageId: '0xmsg' })).toBeNull();
    bridge.findUnlock.mockResolvedValueOnce('octUnlockHash');
    expect(await advance({ ...e2o, status: 'unlocking', messageId: '0xmsg' })).toEqual({
      status: 'done',
      unlockHash: 'octUnlockHash',
    });
  });
});
