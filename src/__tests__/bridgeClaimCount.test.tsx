import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeDirection, BridgeStatus, BridgeTransfer } from 'src/services/bridge/transfers';

const h = vi.hoisted(() => ({
  stored: {} as Record<string, BridgeTransfer[]>,
  networkId: 'mainnet' as string,
  evmAddress: '0xE' as string | null,
  prepareCall: vi.fn(),
  signAndSubmit: vi.fn(),
  advance: vi.fn(async (): Promise<Partial<BridgeTransfer> | null> => null),
  claimCheck: vi.fn(),
  allowance: vi.fn(async () => 0n),
  lockToEth: vi.fn(),
  recoverTransfers: vi.fn(),
  showMessage: vi.fn(),
  estimateFees: vi.fn(async (): Promise<unknown> => {
    throw new Error('offline');
  }),
  reportBridge: vi.fn(),
}));

vi.mock('src/services/evm/send', async (orig) => ({
  ...(await orig<typeof import('src/services/evm/send')>()),
  estimateFees: h.estimateFees,
}));

vi.mock('src/services/bridge/track', () => ({ reportBridge: h.reportBridge }));

vi.mock('src/services/bridge/transfers', () => ({
  ACTIVE: new Set<string>(),
  UNANSWERED: 'unanswered',
  NOT_FOUND: 'not_found',
  CLAIM_DROPPED: 'claim_dropped',
  advance: h.advance,
  toLock: (l: { amountRaw: string }) => ({ ...l, amountRaw: BigInt(l.amountRaw) }),
  claimCheckPatch: (c: { state: string; reason?: string }) =>
    c.state === 'claimed'
      ? { status: 'done' }
      : c.state === 'waiting'
        ? { status: 'waiting' }
        : { status: 'blocked', note: c.reason },
  loadTransfers: vi.fn(async (oct: string) => h.stored[oct] ?? []),
  saveTransfers: vi.fn(async (oct: string, list: BridgeTransfer[]) => {
    h.stored[oct] = list;
  }),
}));

vi.mock('src/services/bridge/recover', () => ({
  recoverTransfers: h.recoverTransfers,
  transferFromHash: vi.fn(),
}));

vi.mock('src/services/bridge/bridge', () => ({
  cachedBridgeHealth: vi.fn(async () => ({
    ethPaused: false,
    octraPaused: false,
    mintCapPerTx: 10n ** 15n,
    mintLeftToday: 10n ** 15n,
  })),
  cachedLockFee: vi.fn(async () => ({ minimum: 1000n, recommended: 3000n })),
  forgetBridgeHealth: vi.fn(),
  LockFeeRaisedError: class LockFeeRaisedError extends Error {
    ouRaw: bigint;
    constructor(ouRaw: bigint) {
      super('Network fee went up');
      this.ouRaw = ouRaw;
    }
  },
  ethereumMainnet: vi.fn(async () => ({ chainId: 1, rpcUrl: 'https://eth' })),
  lockToEth: h.lockToEth,
  claimCheck: h.claimCheck,
  wOctAllowance: h.allowance,
}));

vi.mock('src/services/evm/signer', () => ({
  prepareCall: h.prepareCall,
  signAndSubmit: h.signAndSubmit,
}));

const submitted = (hash: string) => ({ hash, nonce: 7, raw: `${hash}raw`, acknowledged: true });

vi.mock('src/contexts/WalletContext', () => ({
  useWallet: () => ({
    activeWallet: {
      id: 'w1',
      address: 'octA',
      type: 'standard',
      privateKey: 'k',
      metadata: { evm: { index: 0 } },
    },
    wallets: [] as unknown[],
    networkId: h.networkId,
    balance: '10',
    showMessage: h.showMessage,
  }),
}));

vi.mock('src/hooks/wallet/useHomeView', () => ({
  useHomeView: () => ({ evmOn: !!h.evmAddress, evmAddress: h.evmAddress }),
}));

vi.mock('src/hooks/wallet/useEvmBalances', () => ({
  useEvmBalances: () => ({
    rows: [{ chainId: 1, token: { address: null as string | null }, raw: '1000000000000000000' }],
  }),
}));

vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      String(o?.defaultValue ?? key).replace(/{{(\w+)}}/g, (_m, k: string) => String(o?.[k])),
  }),
}));

import {
  bridgeScope,
  burnsWaiting,
  checkEthAddress,
  claimCount,
  defaultClaimTab,
  groupTransfers,
  transferCount,
} from 'src/features/bridge/transfersView';
import { useBridgeFlow } from 'src/features/bridge/useBridgeFlow';

const transfer = (
  id: string,
  status: BridgeStatus,
  octAddress = 'octA',
  extra: Partial<BridgeTransfer> = {}
): BridgeTransfer => ({
  id,
  direction: 'o2e',
  amountRaw: '5000000',
  octAddress,
  evmAddress: '0xE',
  recipient: '0xE',
  createdAt: 1,
  updatedAt: 1,
  status,
  ...extra,
});

const ALL: BridgeStatus[] = [
  'locking',
  'waiting',
  'claimable',
  'claiming',
  'approving',
  'ready_to_burn',
  'burning',
  'swapping',
  'unlocking',
  'blocked',
  'done',
  'failed',
];

const every = (direction: BridgeDirection) =>
  ALL.map((s, i) => transfer(`${direction}${i}`, s, 'octA', { direction }));

describe('bridge claim count', () => {
  it('counts only claimable OCT to wOCT transfers', () => {
    const list = [...every('o2e'), ...every('e2o'), ...every('a2o')];
    expect(claimCount(list, 'octA')).toBe(1);
    expect(transferCount(list, 'octA')).toBe(ALL.length);
  });

  it('counts only the scoped wallet', () => {
    const list = [
      transfer('a', 'claimable', 'octA'),
      transfer('b', 'claimable', 'octB'),
      transfer('c', 'claimable', 'octB'),
    ];
    expect(claimCount(list, 'octA')).toBe(1);
    expect(claimCount(list, 'octB')).toBe(2);
  });

  it('is zero off the bridge network', () => {
    const list = [transfer('a', 'claimable')];
    expect(bridgeScope('devnet', 'octA')).toBeNull();
    expect(bridgeScope('custom_node', 'octA')).toBeNull();
    expect(bridgeScope('mainnet', null)).toBeNull();
    expect(claimCount(list, bridgeScope('devnet', 'octA'))).toBe(0);
    expect(transferCount(list, bridgeScope('devnet', 'octA'))).toBe(0);
    expect(claimCount(list, bridgeScope('mainnet', 'octA'))).toBe(1);
  });

  it('groups OCT to wOCT transfers only', () => {
    const list = [...every('o2e'), ...every('e2o'), ...every('a2o')];
    const g = groupTransfers(list, 'octA');
    expect(g.ready.map((t) => t.status)).toEqual(['claimable']);
    expect(g.done.map((t) => t.status)).toEqual(['done', 'failed']);
    expect([...g.ready, ...g.moving, ...g.done].every((t) => t.direction === 'o2e')).toBe(true);
    expect(g.moving).toHaveLength(ALL.length - 3);
    expect(groupTransfers(list, null)).toEqual({ ready: [], moving: [], done: [] });
  });

  it('counts each claim tab and opens on the first one with something in it', () => {
    const list = [
      transfer('r1', 'claimable'),
      transfer('r2', 'claimable', 'octA', { note: 'claim_failed' }),
      transfer('m1', 'waiting'),
      transfer('d1', 'done'),
      transfer('d2', 'failed'),
      transfer('x1', 'claimable', 'octB'),
      transfer('x2', 'ready_to_burn', 'octA', { direction: 'e2o' }),
    ];
    const g = groupTransfers(list, 'octA');
    expect([g.ready.length, g.moving.length, g.done.length]).toEqual([2, 1, 2]);
    expect(defaultClaimTab(g)).toBe('ready');
    expect(defaultClaimTab({ ...g, ready: [] })).toBe('moving');
    expect(defaultClaimTab({ ...g, ready: [], moving: [] })).toBe('done');
    expect(defaultClaimTab({ ready: [], moving: [], done: [] })).toBe('done');
  });

  it('keeps approved burns for the form', () => {
    const list = [...every('o2e'), ...every('e2o')];
    expect(burnsWaiting(list, 'octA').map((t) => t.id)).toEqual(['e2o5']);
    expect(burnsWaiting(list, null)).toEqual([]);
  });

  it('checks a typed 0x address and its checksum', () => {
    expect(checkEthAddress('0x4647e1fE715c9e23959022C2416C71867F5a6E80')).toBe('ok');
    expect(checkEthAddress('0x4647e1fe715c9e23959022c2416c71867f5a6e80')).toBe('ok');
    expect(checkEthAddress('0x4647e1fE715c9e23959022C2416C71867F5a6e80')).toBe('checksum');
    expect(checkEthAddress('0x4647')).toBe('invalid');
    expect(checkEthAddress('')).toBe('invalid');
  });
});

describe('useBridgeFlow', () => {
  beforeEach(() => {
    h.stored = {};
    h.networkId = 'mainnet';
    h.evmAddress = '0xE';
    h.prepareCall.mockReset();
    h.signAndSubmit.mockReset();
    h.advance.mockReset();
    h.advance.mockResolvedValue(null);
    h.claimCheck.mockReset();
    h.allowance.mockReset();
    h.allowance.mockResolvedValue(0n);
    h.lockToEth.mockReset();
    h.recoverTransfers.mockReset();
    h.recoverTransfers.mockResolvedValue([]);
    h.showMessage.mockReset();
  });

  it('exposes claim and burn behind the review and the count for the scope', async () => {
    h.stored.octA = [
      transfer('c1', 'claimable', 'octA', { claimData: '0xclaim' }),
      transfer('b1', 'ready_to_burn', 'octA', { direction: 'e2o' }),
      transfer('w1', 'waiting'),
    ];
    const prepared = { tx: { to: '0xB' }, totalNative: 1n, feeWei: 1n };
    h.prepareCall.mockResolvedValue(prepared);
    h.signAndSubmit.mockResolvedValue(submitted('0xhash'));

    const { result } = renderHook(() => useBridgeFlow());
    expect(typeof result.current.openClaim).toBe('function');
    expect(typeof result.current.openBurn).toBe('function');
    expect(typeof result.current.confirm).toBe('function');
    await waitFor(() => expect(result.current.readyCount).toBe(1));
    expect(result.current.burnsWaiting.map((t) => t.id)).toEqual(['b1']);

    await act(async () => {
      await result.current.openClaim(result.current.groups.ready[0]);
    });
    expect(h.signAndSubmit).not.toHaveBeenCalled();
    expect(result.current.pending).toMatchObject({ action: 'claim', transferId: 'c1' });

    await act(async () => {
      await result.current.confirm();
    });
    expect(h.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull();
    expect(result.current.transfers.find((t) => t.id === 'c1')).toMatchObject({
      status: 'claiming',
      claimHash: '0xhash',
      claimNonce: 7,
      claimRaw: '0xhashraw',
      claimSentAt: expect.any(Number),
    });
    expect(result.current.readyCount).toBe(0);

    await act(async () => {
      await result.current.openBurn(result.current.burnsWaiting[0]);
    });
    expect(result.current.pending).toMatchObject({ action: 'burn', transferId: 'b1' });
    act(() => result.current.cancel());
    expect(result.current.pending).toBeNull();
    expect(h.signAndSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows a status with no time estimate while the proof is on its way', async () => {
    const hour = 3_600_000;
    const now = 2_000_000_000_000;
    h.stored.octA = [
      transfer('w1', 'waiting', 'octA', { createdAt: now - 27 * hour }),
      transfer('w3', 'waiting', 'octA', { createdAt: now - 40 * hour }),
      transfer('l1', 'locking', 'octA', { createdAt: now - hour }),
    ];
    const { result } = renderHook(() => useBridgeFlow());
    await waitFor(() => expect(result.current.groups.moving).toHaveLength(3));
    const text = (id: string) =>
      result.current.statusText(result.current.transfers.find((t) => t.id === id)!);
    expect(text('w1')).toBe("Waiting for Octra's proof on Ethereum");
    expect(text('w3')).toBe("Waiting for Octra's proof on Ethereum");
    expect(text('l1')).toBe('Confirming on Octra');
  });

  it('counts nothing off mainnet', async () => {
    h.networkId = 'devnet';
    h.stored.octA = [transfer('c1', 'claimable')];
    const { result } = renderHook(() => useBridgeFlow());
    await act(async () => {});
    expect(result.current.ready).toBe(false);
    expect(result.current.readyCount).toBe(0);
  });

  it('locks to a typed 0x address from a wallet without a 0x key, after the review', async () => {
    h.evmAddress = null;
    h.lockToEth.mockResolvedValue('lockhash');
    const to = '0x4647e1fE715c9e23959022C2416C71867F5a6E80';
    const { result } = renderHook(() => useBridgeFlow());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.ready).toBe(true);
    expect(result.current.keyless).toBe(true);
    expect(h.recoverTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ octAddress: 'octA', evmAddress: null })
    );

    await act(async () => {
      await result.current.openNew('o2e', 2_000_000n, to);
    });
    expect(h.lockToEth).not.toHaveBeenCalled();
    expect(result.current.pending).toMatchObject({ action: 'lock', recipient: to });

    await act(async () => {
      await result.current.confirm();
    });
    expect(h.lockToEth).toHaveBeenCalledWith(
      expect.objectContaining({ ethRecipient: to, ouRaw: 3000n })
    );
    expect(result.current.transfers[0]).toMatchObject({
      direction: 'o2e',
      status: 'locking',
      recipient: to,
      evmAddress: to,
    });
    expect(result.current.transferCount).toBe(1);

    await act(async () => {
      await result.current.openNew('e2o', 1n, 'octA');
    });
    expect(result.current.pending).toBeNull();
    expect(h.prepareCall).not.toHaveBeenCalled();
  });
});

describe('bridge confirm feedback', () => {
  const to = '0x4647e1fE715c9e23959022C2416C71867F5a6E80';

  beforeEach(() => {
    h.stored = {};
    h.networkId = 'mainnet';
    h.evmAddress = '0xE';
    h.prepareCall.mockReset();
    h.signAndSubmit.mockReset();
    h.advance.mockReset();
    h.advance.mockResolvedValue(null);
    h.claimCheck.mockReset();
    h.allowance.mockReset();
    h.allowance.mockResolvedValue(0n);
    h.lockToEth.mockReset();
    h.recoverTransfers.mockReset();
    h.recoverTransfers.mockResolvedValue([]);
    h.showMessage.mockReset();
  });

  const reviewLock = async () => {
    const view = renderHook(() => useBridgeFlow());
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    await act(async () => {
      await view.result.current.openNew('o2e', 2_000_000n, to);
    });
    expect(view.result.current.pending).toMatchObject({ action: 'lock', ouRaw: 3000n });
    return view;
  };

  const toasts = () => h.showMessage.mock.calls.map(([text, type]) => `${type}: ${text}`);

  it('stays open and busy while sending, then closes with a status and the transfer in progress', async () => {
    let finish: (hash: string) => void = () => {};
    h.lockToEth.mockReturnValue(new Promise<string>((r) => (finish = r)));
    const { result } = await reviewLock();
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.confirm();
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.pending).not.toBeNull();
    await act(async () => {
      finish('lockhash');
      await done;
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.pending).toBeNull();
    expect(toasts()).toEqual(['info: Bridging to Ethereum']);
    expect(result.current.active.o2e).toMatchObject({ status: 'locking', lockHash: 'lockhash' });
    expect(result.current.groups.moving).toHaveLength(1);
  });

  it('shows why a send failed in the toast, not in the form', async () => {
    const { RpcHttpError } = await import('src/services/network/txOutcome');
    h.lockToEth.mockRejectedValue(new RpcHttpError('Too Many Requests', 429));
    const { result } = await reviewLock();
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.problem).toBeNull();
    expect(toasts()).toEqual(['error: Octra network is busy. Try again in a moment.']);
    expect(result.current.transfers).toHaveLength(0);
  });

  it('never says not sent when the lock may have gone through, and follows it', async () => {
    const { TxOutcomeUnknownError } = await import('src/services/network/txOutcome');
    h.lockToEth.mockRejectedValue(new TxOutcomeUnknownError('no answer'));
    const { result } = await reviewLock();
    await act(async () => {
      await result.current.confirm();
    });
    expect(toasts()).toEqual([
      'warning: It may have gone through. Check Claim before you try again.',
    ]);
    expect(toasts().join(' ')).not.toMatch(/not sent/i);
    expect(result.current.transfers[0]).toMatchObject({
      status: 'locking',
      note: 'unanswered',
      amountRaw: '2000000',
    });
    expect(result.current.statusText(result.current.transfers[0])).toBe(
      'Checking Octra for this transfer'
    );
  });

  it('keeps the review open with the new fee when the minimum went up', async () => {
    const { LockFeeRaisedError } = await import('src/services/bridge/bridge');
    h.lockToEth.mockRejectedValue(new LockFeeRaisedError(6000n));
    const { result } = await reviewLock();
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.pending).toMatchObject({ action: 'lock', ouRaw: 6000n, feeRaised: true });
    expect(toasts()).toEqual([]);
    expect(result.current.transfers).toHaveLength(0);
  });

  it('a claim and a burn get the same feedback, and prepare errors go to the toast', async () => {
    h.stored.octA = [
      transfer('c1', 'claimable', 'octA', { claimData: '0xclaim' }),
      transfer('b1', 'ready_to_burn', 'octA', { direction: 'e2o' }),
    ];
    h.prepareCall.mockRejectedValueOnce(new Error('RPC HTTP 429'));
    const { result } = renderHook(() => useBridgeFlow());
    await waitFor(() => expect(result.current.readyCount).toBe(1));
    await act(async () => {
      await result.current.openClaim(result.current.groups.ready[0]);
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.problem).toBeNull();
    expect(toasts()).toEqual(['error: Ethereum network is busy. Try again in a moment.']);

    h.prepareCall.mockResolvedValue({ tx: { to: '0xB' }, totalNative: 1n, feeWei: 1n });
    h.signAndSubmit.mockResolvedValue(submitted('0xhash'));
    await act(async () => {
      await result.current.openClaim(result.current.groups.ready[0]);
    });
    await act(async () => {
      await result.current.confirm();
    });
    await act(async () => {
      await result.current.openBurn(result.current.burnsWaiting[0]);
    });
    await act(async () => {
      await result.current.confirm();
    });
    expect(toasts().slice(1)).toEqual(['info: Claiming on Ethereum', 'info: Bridging to Octra']);
    expect(result.current.active.e2o).toMatchObject({ id: 'b1', status: 'burning' });
  });

  it('a claim without ETH for the gas shows a toast and opens no review', async () => {
    h.stored.octA = [transfer('c1', 'claimable', 'octA', { claimData: '0xclaim' })];
    h.prepareCall.mockResolvedValue({
      tx: { to: '0xB' },
      totalNative: 2_000_000_000_000_000_000n,
      feeWei: 1n,
    });
    const { result } = renderHook(() => useBridgeFlow());
    await waitFor(() => expect(result.current.readyCount).toBe(1));
    await act(async () => {
      await result.current.openClaim(result.current.groups.ready[0]);
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.problem).toBeNull();
    expect(toasts()).toEqual(['error: Insufficient ETH on Ethereum for network fee']);
  });
});

describe('wOCT to OCT in two steps', () => {
  const OCT = 'octA';
  const prepared = { tx: { to: '0xB' }, totalNative: 1n, feeWei: 1n };
  const toasts = () => h.showMessage.mock.calls.map(([text, type]) => `${type}: ${text}`);

  beforeEach(() => {
    h.stored = {};
    h.networkId = 'mainnet';
    h.evmAddress = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
    h.prepareCall.mockReset();
    h.prepareCall.mockResolvedValue(prepared);
    h.signAndSubmit.mockReset();
    h.advance.mockReset();
    h.advance.mockResolvedValue(null);
    h.allowance.mockReset();
    h.allowance.mockResolvedValue(0n);
    h.claimCheck.mockReset();
    h.recoverTransfers.mockReset();
    h.recoverTransfers.mockResolvedValue([]);
    h.showMessage.mockReset();
  });

  const loaded = async () => {
    const view = renderHook(() => useBridgeFlow());
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    return view;
  };

  it('allows exactly the amount as step 1, then waits for it before step 2 can sign', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.signAndSubmit.mockResolvedValue(submitted('0xa11'));
      const { result } = await loaded();
      await act(async () => {
        await result.current.openNew('e2o', 2_500_000n, OCT);
      });
      expect(result.current.pending).toMatchObject({ action: 'approve', step: 1 });
      const { BRIDGE } = await import('src/services/bridge/constants');
      const { erc20ApproveData } = await import('src/services/evm/tx');
      expect(h.prepareCall).toHaveBeenCalledWith(expect.anything(), {
        from: h.evmAddress,
        to: BRIDGE.wOCT,
        data: erc20ApproveData(BRIDGE.ethBridge, 2_500_000n),
      });

      await act(async () => {
        await result.current.confirm();
      });
      const allowing = result.current.transfers[0];
      expect(allowing).toMatchObject({
        direction: 'e2o',
        status: 'approving',
        approveHash: '0xa11',
        approveNonce: 7,
        approveRaw: '0xa11raw',
        amountRaw: '2500000',
      });
      expect(result.current.pending).toMatchObject({
        action: 'burn',
        step: 2,
        transferId: allowing.id,
      });
      expect(result.current.pending?.prepared).toBeUndefined();
      expect(result.current.waiting).toBe(true);
      expect(h.stored[OCT][0]).toMatchObject({ status: 'approving', approveHash: '0xa11' });

      h.advance.mockResolvedValue({ status: 'ready_to_burn' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100);
      });
      await waitFor(() => expect(result.current.pending?.prepared).toBe(prepared));
      expect(result.current.pending).toMatchObject({ action: 'burn', step: 2 });
      expect(result.current.waiting).toBe(false);
      expect(h.signAndSubmit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips step 1 when the allowance already covers the amount', async () => {
    h.allowance.mockResolvedValue(10_000_000n);
    const { result } = await loaded();
    await act(async () => {
      await result.current.openNew('e2o', 2_500_000n, OCT);
    });
    expect(result.current.pending).toMatchObject({ action: 'burn', prepared });
    expect(result.current.pending?.step).toBeUndefined();
  });

  it('never signs a second allowance while one is on its way, after the popup closed', async () => {
    h.stored[OCT] = [
      transfer('a1', 'approving', OCT, {
        direction: 'e2o',
        recipient: OCT,
        evmAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
        approveHash: '0xa1',
      }),
    ];
    const { result } = await loaded();
    await act(async () => {
      await result.current.openNew('e2o', 9_000_000n, OCT);
    });
    expect(result.current.pending).toMatchObject({ action: 'burn', step: 2, transferId: 'a1' });
    expect(result.current.pending?.prepared).toBeUndefined();
    expect(h.prepareCall).not.toHaveBeenCalled();
    expect(h.allowance).not.toHaveBeenCalled();
  });

  it('continues an allowed transfer as step 2 of 2', async () => {
    h.stored[OCT] = [
      transfer('r1', 'ready_to_burn', OCT, {
        direction: 'e2o',
        recipient: OCT,
        evmAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
        approveHash: '0xa1',
      }),
    ];
    const { result } = await loaded();
    await act(async () => {
      await result.current.openNew('e2o', 5_000_000n, OCT);
    });
    expect(result.current.pending).toMatchObject({
      action: 'burn',
      step: 2,
      transferId: 'r1',
      prepared,
    });
    expect(h.allowance).not.toHaveBeenCalled();
  });

  it('ends step 2 with an error when the allowance failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.stored[OCT] = [
        transfer('a1', 'approving', OCT, {
          direction: 'e2o',
          recipient: OCT,
          evmAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
          approveHash: '0xa1',
        }),
      ];
      const { result } = await loaded();
      await act(async () => {
        await result.current.openBurn(result.current.transfers[0]);
      });
      expect(result.current.pending).toMatchObject({ step: 2, transferId: 'a1' });
      h.advance.mockResolvedValue({ status: 'failed', note: 'approve_failed' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100);
      });
      await waitFor(() => expect(result.current.pending).toBeNull());
      expect(toasts()).toEqual([
        'error: Allowance did not go through. Your wOCT stayed in your wallet.',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('claim simulated before its review', () => {
  const lock = { hash: 'h', epoch: 9, amountRaw: '5000000', ethAddress: '0xE', srcNonce: 1 };
  const toasts = () => h.showMessage.mock.calls.map(([text, type]) => `${type}: ${text}`);

  beforeEach(() => {
    h.stored = {
      octA: [transfer('c1', 'claimable', 'octA', { claimData: '0xold', locked: lock })],
    };
    h.networkId = 'mainnet';
    h.evmAddress = '0xE';
    h.prepareCall.mockReset();
    h.prepareCall.mockResolvedValue({ tx: { to: '0xB' }, totalNative: 1n, feeWei: 1n });
    h.claimCheck.mockReset();
    h.recoverTransfers.mockReset();
    h.recoverTransfers.mockResolvedValue([]);
    h.showMessage.mockReset();
  });

  const openClaim = async () => {
    const view = renderHook(() => useBridgeFlow());
    await waitFor(() => expect(view.result.current.readyCount).toBe(1));
    await act(async () => {
      await view.result.current.openClaim(view.result.current.groups.ready[0]);
    });
    return view;
  };

  it('claims with the calldata the simulation passed', async () => {
    h.claimCheck.mockResolvedValue({ state: 'claimable', data: '0xfresh' });
    const { result } = await openClaim();
    expect(h.claimCheck).toHaveBeenCalledWith(expect.objectContaining({ epoch: 9 }), '0xE');
    expect(h.prepareCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ data: '0xfresh' })
    );
    expect(result.current.pending).toMatchObject({ action: 'claim', transferId: 'c1' });
  });

  it('a claim made elsewhere is done, with no review and no gas', async () => {
    h.claimCheck.mockResolvedValue({ state: 'claimed' });
    const { result } = await openClaim();
    expect(result.current.pending).toBeNull();
    expect(h.prepareCall).not.toHaveBeenCalled();
    expect(result.current.transfers[0].status).toBe('done');
    expect(toasts()).toEqual(['info: Already claimed. The wOCT is at the receiving address.']);
  });

  it('an epoch Ethereum has not reached waits for Octra', async () => {
    h.claimCheck.mockResolvedValue({ state: 'waiting' });
    const { result } = await openClaim();
    expect(result.current.pending).toBeNull();
    expect(result.current.transfers[0].status).toBe('waiting');
    expect(toasts()).toEqual(["info: Waiting for Octra's proof on Ethereum"]);
  });

  it('the daily mint limit says so before any gas', async () => {
    h.claimCheck.mockResolvedValue({ state: 'blocked', reason: 'cap' });
    const { result } = await openClaim();
    expect(result.current.pending).toBeNull();
    expect(h.prepareCall).not.toHaveBeenCalled();
    expect(result.current.transfers[0]).toMatchObject({ status: 'blocked', note: 'cap' });
    expect(toasts()).toEqual(['error: Daily bridge limit reached. Claimable tomorrow.']);
  });
});

describe('editable Ethereum fee in the bridge review', () => {
  const GWEI = 1_000_000_000n;
  const fees = { baseFeePerGas: 10n * GWEI, maxPriorityFeePerGas: GWEI, maxFeePerGas: 21n * GWEI };
  const prepared = {
    tx: {
      chainId: 1,
      nonce: 3,
      maxPriorityFeePerGas: GWEI,
      maxFeePerGas: 21n * GWEI,
      gasLimit: 100_000n,
      to: '0xB',
      value: 0n,
      data: '0xclaim',
    },
    feeWei: 2_100_000n * GWEI,
    totalNative: 2_100_000n * GWEI,
    fees,
  };

  beforeEach(() => {
    h.stored = { octA: [transfer('c1', 'claimable', 'octA', { claimData: '0xclaim' })] };
    h.networkId = 'mainnet';
    h.evmAddress = '0xE';
    h.prepareCall.mockReset();
    h.prepareCall.mockResolvedValue(prepared);
    h.signAndSubmit.mockReset();
    h.signAndSubmit.mockResolvedValue(submitted('0xhash'));
    h.claimCheck.mockReset();
    h.estimateFees.mockReset();
    h.reportBridge.mockReset();
    h.showMessage.mockReset();
  });

  const openReview = async () => {
    const view = renderHook(() => useBridgeFlow());
    await waitFor(() => expect(view.result.current.readyCount).toBe(1));
    await act(async () => {
      await view.result.current.openClaim(view.result.current.groups.ready[0]);
    });
    expect(view.result.current.pending).toMatchObject({ action: 'claim' });
    return view;
  };

  it('signs the live estimate when nothing was changed', async () => {
    h.estimateFees.mockResolvedValue({ ...fees, baseFeePerGas: 11n * GWEI });
    const { result } = await openReview();
    await act(async () => {
      await result.current.confirm();
    });
    expect(h.signAndSubmit.mock.calls[0][1]).toMatchObject({
      nonce: 3,
      gasLimit: 100_000n,
      maxFeePerGas: 21n * GWEI,
      maxPriorityFeePerGas: GWEI,
    });
  });

  it('signs the chosen preset or custom fee', async () => {
    h.estimateFees.mockResolvedValue(fees);
    const { result } = await openReview();
    act(() => result.current.setFee({ speed: 'fast' }));
    expect(result.current.pending?.fee).toEqual({ speed: 'fast' });
    act(() =>
      result.current.setFee({
        custom: { maxFeePerGas: 15n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
      })
    );
    await act(async () => {
      await result.current.confirm();
    });
    expect(h.signAndSubmit.mock.calls[0][1]).toMatchObject({
      maxFeePerGas: 15n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    });
  });

  it('asks again when the network minimum moved above the chosen max fee', async () => {
    const fresh = { ...fees, baseFeePerGas: 20n * GWEI, maxFeePerGas: 41n * GWEI };
    h.estimateFees.mockResolvedValue(fresh);
    const { result } = await openReview();
    act(() => result.current.setFee({ speed: 'slow' }));
    await act(async () => {
      await result.current.confirm();
    });
    expect(h.signAndSubmit).not.toHaveBeenCalled();
    expect(result.current.pending).toMatchObject({
      action: 'claim',
      fee: { speed: 'slow' },
      prepared: { fees: fresh },
    });
    expect(result.current.pending?.feeRaised).toBe(true);
    expect(h.showMessage).not.toHaveBeenCalledWith(
      'Network fee went up. Review the new fee.',
      'info'
    );
  });

  it('drops a custom fee the network left behind, so the review shows the new estimate', async () => {
    h.estimateFees.mockResolvedValue({ ...fees, baseFeePerGas: 20n * GWEI });
    const { result } = await openReview();
    act(() =>
      result.current.setFee({ custom: { maxFeePerGas: 12n * GWEI, maxPriorityFeePerGas: GWEI } })
    );
    await act(async () => {
      await result.current.confirm();
    });
    expect(h.signAndSubmit).not.toHaveBeenCalled();
    expect(result.current.pending?.fee).toBeUndefined();
  });

  it('refuses a chosen fee the ETH balance cannot cover, without signing', async () => {
    h.estimateFees.mockResolvedValue(fees);
    const { result } = await openReview();
    act(() =>
      result.current.setFee({
        custom: { maxFeePerGas: 20_000_000n * GWEI, maxPriorityFeePerGas: GWEI },
      })
    );
    await act(async () => {
      await result.current.confirm();
    });
    expect(h.signAndSubmit).not.toHaveBeenCalled();
    expect(h.showMessage).toHaveBeenCalledWith(
      'Insufficient ETH on Ethereum for network fee',
      'error'
    );
  });

  it('reports the sent claim for the bridge stats with the network', async () => {
    h.estimateFees.mockResolvedValue(fees);
    const { result } = await openReview();
    await act(async () => {
      await result.current.confirm();
    });
    expect(h.reportBridge).toHaveBeenCalledWith(
      { kind: 'claim', txHash: '0xhash', amountRaw: 5_000_000n, ethAddr: '0xE' },
      'mainnet'
    );
  });
});
