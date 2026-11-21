import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REVIEW_WINDOW_MS,
  approvalQueue,
  msgApprovalQueue,
  txApprovalQueue,
  type ReviewHooks,
} from '../background/services/approvals';

let nextWindow = 100;
const created: number[] = [];
const removed: number[] = [];
const messageListeners = new Set<(...a: any[]) => unknown>();

beforeEach(() => {
  vi.useFakeTimers();
  created.length = 0;
  removed.length = 0;
  messageListeners.clear();
  (chrome as any).windows = {
    getAll: vi.fn(async () => []),
    create: vi.fn((_opts: unknown, cb: (w: any) => void) => {
      const id = nextWindow++;
      created.push(id);
      cb({ id, tabs: [{ id: id * 10 }] });
    }),
    remove: vi.fn(async (id: number) => {
      removed.push(id);
    }),
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  (chrome as any).tabs.onUpdated = { addListener: vi.fn(), removeListener: vi.fn() };
  (chrome.runtime.onMessage.addListener as any).mockImplementation((l: any) =>
    messageListeners.add(l)
  );
  (chrome.runtime.onMessage.removeListener as any).mockImplementation((l: any) =>
    messageListeners.delete(l)
  );
});

afterEach(() => {
  vi.useRealTimers();
});

function hooks() {
  const log: string[] = [];
  let close: (() => void) | null = null;
  const review: ReviewHooks & { gone: boolean; log: string[]; leave: () => void } = {
    log,
    gone: false,
    shown: async () => {
      log.push('shown');
    },
    answered: async (approved) => {
      log.push(`answered:${approved}`);
    },
    expire: () => {
      log.push('expire');
    },
    onPageGone: (fn) => {
      close = fn;
      return () => {
        close = null;
      };
    },
    leave: () => {
      review.gone = true;
      close?.();
    },
  };
  return review;
}

describe('review windows', () => {
  it('stay open for five minutes, then report expired', async () => {
    expect(REVIEW_WINDOW_MS).toBe(300_000);
    const review = hooks();
    const result = txApprovalQueue.add({ origin: 'https://a.app', review });
    await vi.advanceTimersByTimeAsync(0);
    expect(review.log).toEqual(['shown']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(removed).toEqual([]);
    await vi.advanceTimersByTimeAsync(REVIEW_WINDOW_MS - 120_000);
    expect(await result).toMatchObject({ approved: false });
    expect(review.log).toEqual(['shown', 'expire', 'answered:false']);
    expect(removed).toEqual([created[0]]);
  });

  it('keep the hooks out of the stored review', async () => {
    const review = hooks();
    void msgApprovalQueue.add({ origin: 'https://a.app', review, message: 'hi' });
    await vi.advanceTimersByTimeAsync(0);
    const stored = (chrome.storage.local.set as any).mock.calls.at(-1)[0];
    const record = Object.values(stored)[0] as Record<string, unknown>;
    expect(record).not.toHaveProperty('review');
    expect(record).not.toHaveProperty('resolve');
    expect(record).toMatchObject({ origin: 'https://a.app', message: 'hi' });
    review.leave();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('close with the requesting page while unanswered', async () => {
    for (const queue of [txApprovalQueue, msgApprovalQueue]) {
      created.length = 0;
      removed.length = 0;
      const review = hooks();
      const result = queue.add({ origin: 'https://a.app', review });
      await vi.advanceTimersByTimeAsync(0);
      review.leave();
      expect(await result).toMatchObject({ approved: false });
      expect(removed).toEqual(created);
      expect(review.log).toEqual(['shown', 'answered:false']);
    }
  });

  it('a connect review closes with its page too', async () => {
    const review = hooks();
    const result = approvalQueue.add({ origin: 'https://a.app', review });
    await vi.advanceTimersByTimeAsync(0);
    review.leave();
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(false);
    expect(removed).toEqual(created);
  });

  it('never open for a page that already left', async () => {
    const review = hooks();
    review.gone = true;
    const result = await txApprovalQueue.add({ origin: 'https://a.app', review });
    expect(result).toMatchObject({ approved: false });
    expect(created).toEqual([]);
    expect(review.log).toEqual(['answered:false']);
  });

  it('leave other messages to their own handler: no listener answers them with a promise', async () => {
    for (const queue of [txApprovalQueue, msgApprovalQueue]) {
      const review = hooks();
      void queue.add({ origin: 'https://a.app', review });
      await vi.advanceTimersByTimeAsync(0);
      for (const l of [...messageListeners]) {
        const out = l(
          { type: 'DAPP_REQUEST', method: 'request_status' },
          { tab: { id: 7 } },
          () => {}
        );
        expect(out).toBeUndefined();
      }
      review.leave();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('store the approval before the handler signs', async () => {
    const order: string[] = [];
    const review = hooks();
    review.answered = async (approved) => {
      await Promise.resolve();
      order.push(`stored:${approved}`);
    };
    const result = txApprovalQueue.add({ origin: 'https://a.app', review }).then((r: any) => {
      order.push('handler');
      return r;
    });
    await vi.advanceTimersByTimeAsync(0);
    const approvalId = (
      Object.values((chrome.storage.local.set as any).mock.calls.at(-1)[0])[0] as any
    ).approvalId;
    for (const l of [...messageListeners]) {
      l(
        { type: 'TRANSACTION_APPROVAL_RESPONSE', approvalId, approved: true },
        { url: 'chrome-extension://mock-id/index.html' },
        () => {}
      );
    }
    expect(await result).toMatchObject({ approved: true });
    expect(order).toEqual(['stored:true', 'handler']);
  });
});
