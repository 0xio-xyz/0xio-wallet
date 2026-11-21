import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvmApprovalData } from 'src/services/evm/dappTypes';

const win = vi.hoisted(() => ({ urls: [] as string[] }));

vi.stubGlobal('chrome', {
  runtime: {
    id: 'mock-extension-id',
    getURL: (p: string) => `chrome-extension://mock-extension-id/${p}`,
  },
  windows: {
    create: vi.fn(async (opts: { url: string }) => {
      win.urls.push(opts.url);
      return { id: win.urls.length };
    }),
    remove: vi.fn(async () => {}),
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  },
});

const { handleEvmApprovalMessage, requestEvmApproval } =
  await import('src/background/services/evmApprovals');

const own = {
  id: 'mock-extension-id',
  url: 'chrome-extension://mock-extension-id/index.html',
} as chrome.runtime.MessageSender;

const sendTx = { kind: 'sendTx', origin: 'https://app.example' } as unknown as EvmApprovalData;
const connect = {
  kind: 'connect',
  origin: 'https://c.example',
} as unknown as EvmApprovalData;
const personal = {
  kind: 'personalSign',
  origin: 'https://b.example',
} as unknown as EvmApprovalData;

async function answerWith(data: EvmApprovalData, message: Record<string, unknown>) {
  const pending = requestEvmApproval(data);
  await vi.waitFor(() => expect(win.urls.length).toBeGreaterThan(0));
  const approvalId = win.urls[win.urls.length - 1].split('/').pop();
  handleEvmApprovalMessage(
    { type: 'EVM_APPROVAL_RESPONSE', approvalId, ...message },
    own,
    () => {}
  );
  return pending;
}

beforeEach(() => {
  win.urls = [];
});

describe('the review answer', () => {
  it('carries the approve amount the user chose', async () => {
    expect(
      await answerWith(sendTx, { approved: true, edit: { unlimited: false, amount: '25' } })
    ).toEqual({ approved: true, edit: { unlimited: false, amount: '25' }, walletId: null });
    expect(await answerWith(sendTx, { approved: true, edit: { unlimited: true } })).toEqual({
      approved: true,
      edit: { unlimited: true },
      walletId: null,
    });
    expect(await answerWith(sendTx, { approved: true })).toEqual({
      approved: true,
      edit: null,
      walletId: null,
    });
  });

  it('rejects a malformed edit, or one on anything but a transaction', async () => {
    expect(
      await answerWith(sendTx, { approved: true, edit: { unlimited: false, amount: '-1' } })
    ).toEqual({ approved: false, edit: null, walletId: null });
    expect(await answerWith(personal, { approved: true, edit: { unlimited: true } })).toEqual({
      approved: false,
      edit: null,
      walletId: null,
    });
    expect(
      await answerWith(sendTx, { approved: false, edit: { unlimited: false, amount: '5' } })
    ).toEqual({ approved: false, edit: null, walletId: null });
  });

  it('carries the picked wallet only on a connect review', async () => {
    expect(await answerWith(connect, { approved: true, walletId: 'w2' })).toEqual({
      approved: true,
      edit: null,
      walletId: 'w2',
    });
    expect(await answerWith(sendTx, { approved: true, walletId: 'w2' })).toEqual({
      approved: true,
      edit: null,
      walletId: null,
    });
  });

  it('keeps only a connect review open longer while a wallet is added', async () => {
    const answers: unknown[] = [];
    const pending = requestEvmApproval(connect);
    await vi.waitFor(() => expect(win.urls.length).toBeGreaterThan(0));
    const approvalId = win.urls[win.urls.length - 1].split('/').pop();
    handleEvmApprovalMessage({ type: 'EVM_APPROVAL_EXTEND', approvalId }, own, (r) =>
      answers.push(r)
    );
    expect(answers).toEqual([{ success: true }]);
    handleEvmApprovalMessage({ type: 'EVM_APPROVAL_RESPONSE', approvalId }, own, () => {});
    expect(await pending).toEqual({ approved: false, edit: null, walletId: null });

    const tx = requestEvmApproval(sendTx);
    await vi.waitFor(() => expect(win.urls.length).toBeGreaterThan(1));
    const txId = win.urls[win.urls.length - 1].split('/').pop();
    handleEvmApprovalMessage({ type: 'EVM_APPROVAL_EXTEND', approvalId: txId }, own, (r) =>
      answers.push(r)
    );
    expect(answers[1]).toEqual({ success: false });
    handleEvmApprovalMessage({ type: 'EVM_APPROVAL_RESPONSE', approvalId: txId }, own, () => {});
    await tx;
  });
});
