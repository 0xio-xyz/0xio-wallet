import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransactionStatusResult } from 'src/types/network';
import { syncCustomNetworks } from 'src/utils/config';
import {
  bulkStage,
  isResultStage,
  octraTxUrl,
  pollTxOutcome,
  stageAfterError,
  stageFromStatus,
  trimAmount,
  type SendStage,
} from 'src/features/transactions/sendStage';

const STAGES: SendStage[] = ['form', 'review', 'sending', 'pending', 'done', 'failed'];

const status = (over: Partial<TransactionStatusResult>): TransactionStatusResult => ({
  status: 'pending',
  confirmed: false,
  ...over,
});

const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

describe('stageFromStatus', () => {
  it('reads Sent only once the node confirms', () => {
    expect(stageFromStatus(status({ status: 'pending' }))).toBe('pending');
    expect(stageFromStatus(status({ status: 'unknown' }))).toBe('pending');
    expect(stageFromStatus(status({ status: 'confirmed', confirmed: true }))).toBe('done');
    expect(stageFromStatus(status({ finality: 'confirmed' }))).toBe('done');
  });

  it('maps a rejection to failed', () => {
    expect(stageFromStatus(status({ status: 'rejected' }))).toBe('failed');
    expect(stageFromStatus(status({ finality: 'rejected' }))).toBe('failed');
  });

  it('maps a dropped or expired tx to failed, and a failed lookup to still pending', () => {
    expect(stageFromStatus(status({ status: 'dropped' }))).toBe('failed');
    expect(stageFromStatus(status({ status: 'expired' }))).toBe('failed');
    expect(stageFromStatus(status({ status: 'error' }))).toBe('pending');
  });
});

describe('stageAfterError', () => {
  it('returns to the form while nothing was broadcast', () => {
    for (const s of STAGES) expect(stageAfterError(false, s)).toBe('form');
  });

  it('never returns to the form once broadcast', () => {
    for (const s of STAGES) {
      const next = stageAfterError(true, s);
      expect(next).not.toBe('form');
      expect(isResultStage(next)).toBe(true);
    }
    expect(stageAfterError(true, 'done')).toBe('done');
    expect(stageAfterError(true, 'failed')).toBe('failed');
    expect(stageAfterError(true, 'sending')).toBe('pending');
  });
});

describe('bulkStage', () => {
  it('is Sent only when every transfer was accepted', () => {
    expect(bulkStage(3, 3)).toBe('done');
    expect(bulkStage(2, 3)).toBe('failed');
  });

  it('broadcast nothing when none was accepted', () => {
    expect(bulkStage(0, 3)).toBeNull();
  });
});

describe('pollTxOutcome', () => {
  it('stays pending until the node confirms', async () => {
    const c = clock();
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(status({ status: 'pending' }))
      .mockResolvedValueOnce(status({ status: 'pending' }))
      .mockResolvedValueOnce(status({ status: 'confirmed', confirmed: true }));
    const res = await pollTxOutcome('h', getStatus, { cancelled: () => false, ...c });
    expect(res).toEqual({ outcome: 'done', reason: undefined, timedOut: false });
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(c.now()).toBe(9000);
  });

  it('carries the node reason on a rejection', async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValue(status({ status: 'rejected', errorReason: 'fhe_epoch_cap' }));
    const res = await pollTxOutcome('h', getStatus, { cancelled: () => false, ...clock() });
    expect(res).toEqual({ outcome: 'failed', reason: 'fhe_epoch_cap', timedOut: false });
  });

  it('keeps pending after the timeout', async () => {
    const getStatus = vi.fn().mockResolvedValue(status({ status: 'pending' }));
    const res = await pollTxOutcome('h', getStatus, {
      cancelled: () => false,
      timeoutMs: 15_000,
      ...clock(),
    });
    expect(res).toEqual({ outcome: 'pending', timedOut: true });
    expect(getStatus).toHaveBeenCalledTimes(5);
  });

  it('treats a failed status read as still pending', async () => {
    const getStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(status({ status: 'confirmed', confirmed: true }));
    const res = await pollTxOutcome('h', getStatus, { cancelled: () => false, ...clock() });
    expect(res.outcome).toBe('done');
  });

  it('stops when the screen goes away', async () => {
    let gone = false;
    const getStatus = vi.fn().mockImplementation(async () => {
      gone = true;
      return status({ status: 'pending' });
    });
    const res = await pollTxOutcome('h', getStatus, { cancelled: () => gone, ...clock() });
    expect(res).toEqual({ outcome: 'pending', timedOut: false });
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});

describe('octraTxUrl', () => {
  afterEach(() => syncCustomNetworks([]));

  it('links the explorer History opens', () => {
    expect(octraTxUrl('mainnet', 'abc')).toBe('https://octrascan.io/tx.html?hash=abc');
    expect(octraTxUrl('devnet', 'abc')).toBe('https://devnet.octrascan.io/tx.html?hash=abc');
  });

  it('gives a custom node its own explorer, or no link', () => {
    const node = {
      id: 'custom_1',
      name: 'My Node',
      rpc_url: 'http://10.0.0.5:8080',
      explorer_url: '',
      explorer_address_url: '',
      indexer_url: '',
      supports_privacy: false,
      color: '#9b8cff',
    };
    syncCustomNetworks([node]);
    expect(octraTxUrl('custom_1', 'abc')).toBeNull();
    syncCustomNetworks([{ ...node, explorer_url: 'https://scan.example.com/tx.html?hash=' }]);
    expect(octraTxUrl('custom_1', 'abc')).toBe('https://scan.example.com/tx.html?hash=abc');
    expect(octraTxUrl('mainnet', '')).toBeNull();
  });
});

describe('trimAmount', () => {
  it('drops trailing zeros without float rounding', () => {
    expect(trimAmount('1.500')).toBe('1.5');
    expect(trimAmount('2.0')).toBe('2');
    expect(trimAmount('0.000000000000000001')).toBe('0.000000000000000001');
    expect(trimAmount('12')).toBe('12');
    expect(trimAmount('')).toBe('0');
  });
});
