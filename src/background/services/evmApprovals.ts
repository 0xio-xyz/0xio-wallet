// Review windows for EVM site requests. One window at a time; the request data stays in the
// worker's memory (never storage) and the window asks for it by id. Closing the window, or no
// answer within the time limit, is a rejection.

import { EXT_BASE_URL } from '../constants';
import { logger } from '../../utils/logger';
import { readApproveEdit, type ApproveEdit } from '../../services/evm/approveEdit';
import type { EvmApprovalData } from '../../services/evm/dappTypes';

const TIMEOUT_MS = 180_000;
const ADD_WALLET_MS = 900_000;

export interface EvmApprovalAnswer {
  approved: boolean;
  edit: ApproveEdit | null;
  walletId: string | null;
}

interface Pending {
  data: EvmApprovalData & { approvalId: string };
  answer: (answer: EvmApprovalAnswer) => void;
  extend: (ms: number) => void;
}

const NO: EvmApprovalAnswer = { approved: false, edit: null, walletId: null };

const pending = new Map<string, Pending>();
const waiting: string[] = [];
let queue: Promise<unknown> = Promise.resolve();

export function hasPendingEvmApproval(origin: string): boolean {
  for (const p of pending.values()) if (p.data.origin === origin) return true;
  return waiting.includes(origin);
}

function openWindow(approvalId: string, data: EvmApprovalData): Promise<EvmApprovalAnswer> {
  return new Promise((resolve) => {
    let windowId: number | undefined;
    let done = false;
    const finish = (answer: EvmApprovalAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.windows.onRemoved.removeListener(onRemoved);
      pending.delete(approvalId);
      if (windowId !== undefined) chrome.windows.remove(windowId).catch(() => {});
      resolve(answer);
    };
    const onRemoved = (id: number) => {
      if (id !== windowId) return;
      windowId = undefined;
      finish(NO);
    };
    let timer = setTimeout(() => finish(NO), TIMEOUT_MS);
    const extend = (ms: number) => {
      if (done) return;
      clearTimeout(timer);
      timer = setTimeout(() => finish(NO), ms);
    };
    pending.set(approvalId, { data: { ...data, approvalId }, answer: finish, extend });
    chrome.windows.onRemoved.addListener(onRemoved);
    chrome.windows
      .create({
        url: `index.html#/evm-approval/${approvalId}`,
        type: 'popup',
        width: 400,
        height: 620,
        focused: true,
      })
      .then((win) => {
        if (!win?.id) return finish(NO);
        if (done) {
          chrome.windows.remove(win.id).catch(() => {});
          return;
        }
        windowId = win.id;
      })
      .catch((e) => {
        logger.error('[EVM approval] could not open the window', e);
        finish(NO);
      });
  });
}

export function requestEvmApproval(data: EvmApprovalData): Promise<EvmApprovalAnswer> {
  const approvalId = crypto.randomUUID();
  waiting.push(data.origin);
  const run = queue.then(() => {
    waiting.splice(waiting.indexOf(data.origin), 1);
    return openWindow(approvalId, data);
  });
  queue = run.catch(() => NO);
  return run.catch(() => NO);
}

const fromOwnPage = (sender: chrome.runtime.MessageSender): boolean =>
  sender.id === chrome.runtime.id && !!sender.url?.startsWith(EXT_BASE_URL);

export function handleEvmApprovalMessage(
  message: {
    type: string;
    approvalId?: unknown;
    approved?: unknown;
    edit?: unknown;
    walletId?: unknown;
  },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): void {
  if (!fromOwnPage(sender) || typeof message.approvalId !== 'string') {
    sendResponse({ success: false });
    return;
  }
  const entry = pending.get(message.approvalId);
  if (message.type === 'EVM_APPROVAL_DATA') {
    sendResponse({ success: !!entry, data: entry?.data ?? null });
    return;
  }
  if (message.type === 'EVM_APPROVAL_EXTEND') {
    if (entry?.data.kind === 'connect') entry.extend(ADD_WALLET_MS);
    sendResponse({ success: entry?.data.kind === 'connect' });
    return;
  }
  const edit = message.edit === undefined ? null : readApproveEdit(message.edit);
  const editOk = message.edit === undefined || edit !== null;
  const walletId =
    entry?.data.kind === 'connect' && typeof message.walletId === 'string'
      ? message.walletId
      : null;
  entry?.answer(
    message.approved === true && editOk && (edit === null || entry.data.kind === 'sendTx')
      ? { approved: true, edit, walletId }
      : NO
  );
  sendResponse({ success: !!entry });
}
