import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeHealth, LockFee } from 'src/services/bridge/bridge';

const h = vi.hoisted(() => ({
  health: vi.fn(),
  fee: vi.fn(),
  allowance: vi.fn(),
  prepareCall: vi.fn(),
  log: [] as string[],
}));

vi.mock('src/services/bridge/bridge', () => ({
  cachedBridgeHealth: h.health,
  cachedLockFee: h.fee,
  ethereumMainnet: vi.fn(async () => ({ chainId: 1, rpcUrl: 'https://eth' })),
  wOctAllowance: h.allowance,
}));

vi.mock('src/services/evm/signer', () => ({ prepareCall: h.prepareCall }));

import { checkNewTransfer } from 'src/features/bridge/reviewCheck';
import { bridgeErrorText } from 'src/features/bridge/bridgeErrors';
import { BRIDGE } from 'src/services/bridge/constants';
import { RpcHttpError, RpcResponseError } from 'src/services/network/txOutcome';
import { TxScopeError } from 'src/services/network/txScope';

const HEALTHY: BridgeHealth = {
  ethPaused: false,
  octraPaused: null,
  mintCapPerTx: 100_000_000n,
  mintLeftToday: 500_000_000n,
};
const FEE: LockFee = { minimum: 1000n, recommended: 3000n };
const to = '0x4647e1fE715c9e23959022C2416C71867F5a6E80';
const evm = '0x00000000000000000000000000000000000000E0';

const after = <T>(ms: number, label: string, value: T) =>
  new Promise<T>((resolve) =>
    setTimeout(() => {
      h.log.push(label);
      resolve(value);
    }, ms)
  );

const prepared = (to: string) => ({ tx: { to }, totalNative: 1_000n, feeWei: 1_000n });

beforeEach(() => {
  vi.useFakeTimers();
  h.log = [];
  h.health.mockReset();
  h.fee.mockReset();
  h.allowance.mockReset();
  h.prepareCall.mockReset();
  h.allowance.mockImplementation(() => after(100, 'allowance', 5_000_000n));
  h.health.mockImplementation(() => after(100, 'health', HEALTHY));
  h.fee.mockImplementation(() => after(50, 'fee', FEE));
  h.prepareCall.mockImplementation((_n: unknown, call: { to: string }) =>
    after(100, `prepare ${call.to === BRIDGE.wOCT ? 'approve' : 'burn'}`, prepared(call.to))
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const o2e = (amountRaw: bigint, octRaw = 10_000_000_000n) =>
  checkNewTransfer({ direction: 'o2e', amountRaw, recipient: to, ethRaw: 0n, octRaw });
const e2o = (amountRaw: bigint, ethRaw = 10n ** 18n) =>
  checkNewTransfer({
    direction: 'e2o',
    amountRaw,
    recipient: 'octA',
    evmAddress: evm,
    ethRaw,
    octRaw: 0n,
  });

const settle = async <T>(p: Promise<T>) => {
  let out: T | undefined;
  let done = false;
  void p.then((v) => {
    out = v;
    done = true;
  });
  let waited = 0;
  while (!done && waited < 5_000) {
    await vi.advanceTimersByTimeAsync(10);
    waited += 10;
  }
  return { value: out as T, ms: waited };
};

describe('checks before the bridge review', () => {
  it('opens a lock with the live fee while the Octra pause is unknown', async () => {
    const { value } = await settle(o2e(2_000_000n));
    expect(value).toEqual({
      pending: { action: 'lock', amountRaw: 2_000_000n, recipient: to, ouRaw: 3000n },
    });
  });

  it('blocks when Ethereum is paused', async () => {
    h.health.mockResolvedValue({ ...HEALTHY, ethPaused: true });
    expect((await settle(o2e(2_000_000n))).value).toEqual({ problem: 'paused' });
    expect((await settle(e2o(2_000_000n))).value).toEqual({ problem: 'paused' });
    expect(h.prepareCall).toHaveBeenCalledTimes(1);
  });

  it('blocks when the Octra vault is known to be paused', async () => {
    h.health.mockResolvedValue({ ...HEALTHY, octraPaused: true });
    expect((await settle(o2e(2_000_000n))).value).toEqual({ problem: 'paused' });
  });

  it('blocks above the mint caps', async () => {
    expect((await settle(o2e(100_000_001n))).value).toEqual({
      problem: 'cap',
      maxRaw: 100_000_000n,
    });
    h.health.mockResolvedValue({ ...HEALTHY, mintLeftToday: 5_000_000n });
    expect((await settle(o2e(6_000_000n))).value).toEqual({ problem: 'cap', maxRaw: 5_000_000n });
  });

  it('blocks a lock when the fee cannot be read or is not covered', async () => {
    h.fee.mockResolvedValue(null);
    expect((await settle(o2e(2_000_000n))).value).toEqual({ problem: 'feeUnavailable' });
    h.fee.mockResolvedValue(FEE);
    expect((await settle(o2e(2_000_000n, 2_002_999n))).value).toEqual({ problem: 'noOct' });
  });

  it('reads the allowance and prepares the burn alongside the health check', async () => {
    h.allowance.mockImplementation(() => after(100, 'allowance', 5_000_000n));
    const { value, ms } = await settle(e2o(2_000_000n));
    expect(value).toMatchObject({ pending: { action: 'burn', amountRaw: 2_000_000n } });
    expect(ms).toBeLessThanOrEqual(120);
    expect(h.prepareCall).toHaveBeenCalledTimes(1);
  });

  it('prepares the allowance instead when it is short', async () => {
    h.allowance.mockImplementation(() => after(100, 'allowance', 1_000_000n));
    const { value, ms } = await settle(e2o(2_000_000n));
    expect(value).toMatchObject({ pending: { action: 'approve' } });
    expect(
      (value as { pending: { prepared: { tx: { to: string } } } }).pending.prepared.tx.to
    ).toBe(BRIDGE.wOCT);
    expect(ms).toBeLessThanOrEqual(220);
    expect(h.log.indexOf('prepare approve')).toBeGreaterThan(h.log.indexOf('allowance'));
  });

  it('a failed speculative burn does not matter when the allowance is short', async () => {
    h.allowance.mockResolvedValue(0n);
    h.prepareCall.mockImplementation(async (_n: unknown, call: { to: string }) => {
      if (call.to === BRIDGE.ethBridge) throw new Error('execution reverted: allowance');
      return prepared(call.to);
    });
    expect((await settle(e2o(2_000_000n))).value).toMatchObject({
      pending: { action: 'approve' },
    });
  });

  it('blocks without ETH for the fee', async () => {
    h.allowance.mockResolvedValue(5_000_000n);
    expect((await settle(e2o(2_000_000n, 999n))).value).toEqual({ problem: 'noEth' });
  });
});

describe('bridge error copy', () => {
  const t = ((key: string, o?: Record<string, unknown>) =>
    String(o?.defaultValue ?? key).replace(/{{(\w+)}}/g, (_m, k: string) =>
      String(o?.[k])
    )) as never;
  const text = (e: unknown, network = 'Octra') => bridgeErrorText(e, t, network, 'Fallback.');

  it('names each failure', () => {
    expect(text(new RpcHttpError('Too Many Requests', 429))).toBe(
      'Octra network is busy. Try again in a moment.'
    );
    expect(text(new Error('Unable to determine nonce: Network unreachable.'))).toBe(
      'Octra network is busy. Try again in a moment.'
    );
    expect(text(new Error('RPC HTTP 429'), 'Ethereum')).toBe(
      'Ethereum network is busy. Try again in a moment.'
    );
    expect(text(new RpcResponseError('insufficient balance', {}))).toBe(
      'Insufficient OCT for the amount and fee.'
    );
    expect(
      text(new Error('RPC eth_sendRawTransaction: insufficient funds (-32000)'), 'Ethereum')
    ).toBe('Insufficient ETH on Ethereum for network fee');
    expect(text(new RpcResponseError('ou below minimum', {}))).toBe(
      'Network fee too low. Review again.'
    );
    expect(text(new RpcResponseError('nonce too low', {}))).toBe(
      'Another transaction is still pending. Try again in a moment.'
    );
    expect(text(new RpcResponseError('invalid_signature', {}))).toBe(
      'Octra refused the transaction. Invalid signature.'
    );
    expect(text(new RpcResponseError('bridge paused', {}))).toBe('Bridge paused. Try again later.');
    expect(text(new Error('Wallet locked'))).toBe('Unlock 0xio and try again.');
    expect(text(new TxScopeError('network changed'))).toBe(
      'Wallet or network changed. Review again.'
    );
    expect(text(new Error('something odd'))).toBe('Fallback.');
  });
});
