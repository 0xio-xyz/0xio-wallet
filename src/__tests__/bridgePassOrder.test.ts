import { describe, expect, it } from 'vitest';
import { passOrder, runCapped } from 'src/hooks/wallet/useBridgeTransfers';
import type { BridgeStatus, BridgeTransfer } from 'src/services/bridge/transfers';

const tr = (id: string, status: BridgeStatus): BridgeTransfer => ({
  id,
  direction: 'o2e',
  amountRaw: '1',
  octAddress: 'octA',
  evmAddress: '0xE',
  recipient: '0xE',
  createdAt: 1,
  updatedAt: 1,
  status,
});

describe('bridge tracker pass', () => {
  it('checks claims and allowances before slow scans, and skips finished transfers', () => {
    const list = [
      tr('u', 'unlocking'),
      tr('d', 'done'),
      tr('w', 'waiting'),
      tr('c', 'claiming'),
      tr('a', 'approving'),
    ];
    expect(passOrder(list).map((t) => t.id)).toEqual(['c', 'a', 'u', 'w']);
  });

  it('runs at most the cap at once, so one slow row never holds the rest', async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    await runCapped([30, 1, 1, 1, 1], 3, async (ms) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      done.push(ms);
    });
    expect(most).toBe(3);
    expect(done).toEqual([1, 1, 1, 1, 30]);
  });
});
