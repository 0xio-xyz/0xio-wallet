import { EXT_BASE_URL } from '../constants';
import { logger } from '../../utils/logger';
import type { RelayAnswer } from './desktopRelay';

export type DesktopRoute = (signal: AbortSignal) => Promise<RelayAnswer>;

export type ConnectAnswer =
  | { approved: boolean; selectedAddress?: string; desktop?: RelayAnswer }
  | false;

export const REVIEW_WINDOW_MS = 300_000;

/** `answered` is stored before the approval resolves, so nothing signs ahead of the record. */
export interface ReviewHooks {
  readonly gone: boolean;
  shown(): Promise<void>;
  answered(approved: boolean): Promise<void>;
  expire(): void;
  onPageGone(close: () => void): () => void;
}

interface ApprovalRequest extends Record<string, unknown> {
  origin?: string;
  addedAt: number;
  resolve: (result: any) => void;
  routeDesktop?: DesktopRoute;
  review?: ReviewHooks;
}

const approvedOf = (answer: unknown) =>
  !!answer && typeof answer === 'object' && (answer as { approved?: unknown }).approved === true;

const PAGE_GONE = { approved: false, error: 'The page closed before the review.' };

class ApprovalQueue {
  queue: ApprovalRequest[];
  processing: boolean;
  currentApproval: ApprovalRequest | null;

  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentApproval = null;
  }

  async add(approvalRequest: Omit<ApprovalRequest, 'addedAt' | 'resolve'>) {
    return new Promise((resolve) => {
      this.queue.push({
        ...approvalRequest,
        resolve,
        addedAt: Date.now(),
      });

      if (!this.processing) {
        this.process();
      }
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const approval = this.queue[0];
      this.currentApproval = approval;

      try {
        const approved = approval.review?.gone ? false : await this.showApprovalPopup(approval);
        await approval.review?.answered(approvedOf(approved)).catch(() => {});
        this.queue.shift();
        approval.resolve(approved);
      } catch (error) {
        logger.error('[Approval Queue] Error processing approval:', error);
        this.queue.shift();
        approval.resolve(false);
      }

      this.currentApproval = null;
    }

    this.processing = false;
  }

  async showApprovalPopup(dappInfo: ApprovalRequest): Promise<ConnectAnswer> {
    return new Promise((resolve) => {
      (async () => {
        const approvalId = crypto.randomUUID();
        const { routeDesktop, resolve: _resolve, review, ...shown } = dappInfo;

        await chrome.storage.local.set({
          [`approval_${approvalId}`]: {
            ...shown,
            approvalId,
            timestamp: Date.now(),
          },
        });
        logger.debug(`[Approval] storage written: approval_${approvalId}`);

        const width = 400;
        const height = 600;

        const existingWindows = await chrome.windows.getAll({
          populate: true,
          windowTypes: ['popup'],
        });
        for (const win of existingWindows) {
          const isExtensionWindow = win.tabs?.some(
            (tab) => tab.url?.startsWith(EXT_BASE_URL) && tab.url?.includes('index.html')
          );
          logger.debug(
            `[Approval] existing popup winId=${win.id} isExtension=${isExtensionWindow} tabs=${win.tabs?.map((t) => t.url?.split('#')[0]).join(',')}`
          );
          if (isExtensionWindow) {
            logger.debug(`[Approval] removing existing extension popup winId=${win.id}`);
            await chrome.windows.remove(win.id).catch(() => {});
          }
        }

        chrome.windows.create(
          {
            url: `index.html#/dapp-approval/${approvalId}`,
            type: 'popup',
            width,
            height,
            focused: true,
          },
          (window) => {
            if (chrome.runtime.lastError) {
              logger.error('[Approval Queue] Error creating window:', chrome.runtime.lastError);
              resolve(false);
              return;
            }

            if (!window) {
              logger.error('[Approval Queue] Window creation returned null');
              resolve(false);
              return;
            }

            logger.debug(
              `[Approval] approval window created winId=${window.id} approvalId=${approvalId}`
            );

            const tabId = window.tabs?.[0]?.id;
            logger.debug(`[Approval] tab id=${tabId}`);
            if (tabId) {
              const tabLoadListener = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
                if (updatedId === tabId) {
                  logger.debug(
                    `[Approval] tab ${tabId} update: status=${info.status} url=${info.url ?? ''}`
                  );
                  if (info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(tabLoadListener);
                  }
                }
              };
              chrome.tabs.onUpdated.addListener(tabLoadListener);
            }

            let settled = false;
            let desktopAbort: AbortController | null = null;
            const cleanup = () => {
              settled = true;
              clearTimeout(timeoutId);
              desktopAbort?.abort();
              leavePage();
              chrome.runtime.onMessage.removeListener(approvalListener);
              chrome.windows.onRemoved.removeListener(windowCloseListener);
              chrome.storage.local.remove(`approval_${approvalId}`);
            };
            const finish = (answer: ConnectAnswer) => {
              if (settled) return;
              cleanup();
              if (window && window.id) chrome.windows.remove(window.id).catch(() => {});
              resolve(answer);
            };

            const approvalListener = (
              message: any,
              sender: chrome.runtime.MessageSender,
              sendResponse: (response?: any) => void
            ) => {
              // Popup pages carry sender.tab like content scripts; only our own URL may answer.
              if (sender.tab && !sender.url?.startsWith(EXT_BASE_URL)) return;
              if (message.type === 'DAPP_APPROVAL_RESPONSE' && message.approvalId === approvalId) {
                finish({ approved: message.approved, selectedAddress: message.selectedAddress });
                sendResponse({ success: true });
                return true;
              }
              if (
                message.type === 'DAPP_APPROVAL_DESKTOP' &&
                message.approvalId === approvalId &&
                routeDesktop &&
                !desktopAbort
              ) {
                clearTimeout(timeoutId);
                const abort = new AbortController();
                desktopAbort = abort;
                routeDesktop(abort.signal).then((answer) => {
                  if (desktopAbort === abort) desktopAbort = null;
                  if (settled) return;
                  if ('error' in answer && answer.error.code === 'NETWORK_ERROR') {
                    arm();
                    sendResponse({ status: 'unreachable' });
                    return;
                  }
                  sendResponse({ status: 'done' });
                  finish({ approved: answer.ok, desktop: answer });
                });
                return true;
              }
            };

            const windowCloseListener = (removedWindowId: number) => {
              logger.debug(
                `[Approval] windows.onRemoved winId=${removedWindowId} approvalWinId=${window?.id} match=${removedWindowId === window?.id}`
              );
              if (removedWindowId === window?.id) finish(false);
            };

            chrome.runtime.onMessage.addListener(approvalListener);
            chrome.windows.onRemoved.addListener(windowCloseListener);

            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const arm = () => {
              clearTimeout(timeoutId);
              timeoutId = setTimeout(() => {
                review?.expire();
                finish(false);
              }, REVIEW_WINDOW_MS);
            };
            arm();
            const leavePage = review?.onPageGone(() => finish(false)) ?? (() => {});
            void review?.shown().catch(() => {});
          }
        );
      })().catch(() => resolve(false));
    });
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentApproval: this.currentApproval
        ? {
            origin: this.currentApproval.origin,
            addedAt: this.currentApproval.addedAt,
          }
        : null,
    };
  }
}

export const approvalQueue = new ApprovalQueue();

export interface ApprovalAnswer {
  approved: boolean;
  error?: string;
  selectedAddress?: string;
  choice?: string;
}

interface TransactionApprovalRequest extends Record<string, unknown> {
  addedAt: number;
  resolve: (result: ApprovalAnswer) => void;
}

class TransactionApprovalQueue {
  queue: TransactionApprovalRequest[];
  processing: boolean;
  currentApproval: TransactionApprovalRequest | null;

  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentApproval = null;
  }

  async add(txInfo: Omit<TransactionApprovalRequest, 'addedAt' | 'resolve'>) {
    return new Promise((resolve) => {
      this.queue.push({
        ...txInfo,
        resolve,
        addedAt: Date.now(),
      });
      if (!this.processing) this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const approval = this.queue[0];
      this.currentApproval = approval;

      try {
        const review = approval.review as ReviewHooks | undefined;
        const result = review?.gone ? PAGE_GONE : await this.showTransactionPopup(approval);
        await review?.answered(result.approved === true).catch(() => {});
        this.queue.shift();
        approval.resolve(result);
      } catch (error) {
        logger.error('[Tx Approval] Error:', error);
        this.queue.shift();
        approval.resolve({ approved: false, error: error.message });
      }
      this.currentApproval = null;
    }
    this.processing = false;
  }

  async showTransactionPopup(txInfo: TransactionApprovalRequest): Promise<ApprovalAnswer> {
    return new Promise((resolve) => {
      (async () => {
        const approvalId = crypto.randomUUID();
        const { review: rawReview, resolve: _resolve, ...shown } = txInfo;
        const review = rawReview as ReviewHooks | undefined;
        await chrome.storage.local.set({
          [`tx_approval_${approvalId}`]: {
            ...shown,
            approvalId,
            timestamp: Date.now(),
          },
        });

        const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
        for (const win of windows) {
          if (win.tabs?.some((t) => t.url?.includes('approve-transaction'))) {
            await chrome.windows.remove(win.id).catch(() => {});
          }
        }

        const width = 400;
        const height = 600;

        chrome.windows.create(
          {
            url: `index.html#/approve-transaction/${approvalId}`,
            type: 'popup',
            width,
            height,
            focused: true,
          },
          (window) => {
            if (!window) {
              resolve({ approved: false, error: 'Failed to create window' });
              return;
            }

            const popupWindowId = window.id;

            const cleanup = () => {
              clearTimeout(timeoutId);
              leavePage();
              chrome.runtime.onMessage.removeListener(listener);
              chrome.windows.onRemoved.removeListener(windowCloseListener);
              chrome.storage.local.remove(`tx_approval_${approvalId}`);
            };

            const listener = (message: any, sender: chrome.runtime.MessageSender) => {
              // Popup pages carry sender.tab like content scripts; only our own URL may answer.
              if (sender.tab && !sender.url?.startsWith(EXT_BASE_URL)) return;
              if (
                message.type === 'TRANSACTION_APPROVAL_RESPONSE' &&
                message.approvalId === approvalId
              ) {
                cleanup();
                resolve({
                  approved: message.approved,
                  selectedAddress:
                    typeof message.selectedAddress === 'string'
                      ? message.selectedAddress
                      : undefined,
                });
              }
            };
            chrome.runtime.onMessage.addListener(listener);

            const windowCloseListener = (closedWindowId: number) => {
              if (closedWindowId === popupWindowId) {
                cleanup();
                resolve({ approved: false, error: 'User closed approval window' });
              }
            };
            chrome.windows.onRemoved.addListener(windowCloseListener);

            const timeoutId = setTimeout(() => {
              review?.expire();
              cleanup();
              chrome.windows.remove(popupWindowId).catch(() => {});
              resolve({ approved: false, error: 'Transaction approval timed out' });
            }, REVIEW_WINDOW_MS);
            const leavePage =
              review?.onPageGone(() => {
                cleanup();
                chrome.windows.remove(popupWindowId).catch(() => {});
                resolve(PAGE_GONE);
              }) ?? (() => {});
            void review?.shown().catch(() => {});
          }
        );
      })().catch(() => resolve({ approved: false, error: 'Internal error' }));
    });
  }
}
export const txApprovalQueue = new TransactionApprovalQueue();

interface MessageApprovalRequest extends Record<string, unknown> {
  addedAt: number;
  resolve: (result: ApprovalAnswer) => void;
}

class MessageApprovalQueue {
  queue: MessageApprovalRequest[];
  processing: boolean;
  currentApproval: MessageApprovalRequest | null;

  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentApproval = null;
  }

  async add(msgInfo: Omit<MessageApprovalRequest, 'addedAt' | 'resolve'>) {
    return new Promise((resolve) => {
      this.queue.push({
        ...msgInfo,
        resolve,
        addedAt: Date.now(),
      });
      if (!this.processing) this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const approval = this.queue[0];
      this.currentApproval = approval;

      try {
        const review = approval.review as ReviewHooks | undefined;
        const result = review?.gone ? PAGE_GONE : await this.showMessagePopup(approval);
        await review?.answered(result.approved === true).catch(() => {});
        this.queue.shift();
        approval.resolve(result);
      } catch (error) {
        logger.error('[Msg Approval] Error:', error);
        this.queue.shift();
        approval.resolve({ approved: false, error: error.message });
      }
      this.currentApproval = null;
    }
    this.processing = false;
  }

  async showMessagePopup(msgInfo: MessageApprovalRequest): Promise<ApprovalAnswer> {
    return new Promise((resolve) => {
      (async () => {
        const approvalId = crypto.randomUUID();
        const { review: rawReview, resolve: _resolve, ...shown } = msgInfo;
        const review = rawReview as ReviewHooks | undefined;
        await chrome.storage.local.set({
          [`msg_approval_${approvalId}`]: {
            ...shown,
            approvalId,
            timestamp: Date.now(),
          },
        });

        const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
        for (const win of windows) {
          if (win.tabs?.some((t) => t.url?.includes('approve-message'))) {
            await chrome.windows.remove(win.id).catch(() => {});
          }
        }

        const width = 400;
        const height = 600;

        chrome.windows.create(
          {
            url: `index.html#/approve-message/${approvalId}`,
            type: 'popup',
            width,
            height,
            focused: true,
          },
          (window) => {
            if (!window) {
              resolve({ approved: false, error: 'Failed to create window' });
              return;
            }

            const popupWindowId = window.id;

            const cleanup = () => {
              clearTimeout(timeoutId);
              leavePage();
              chrome.runtime.onMessage.removeListener(listener);
              chrome.windows.onRemoved.removeListener(windowCloseListener);
              chrome.storage.local.remove(`msg_approval_${approvalId}`);
            };

            const listener = (message: any, sender: chrome.runtime.MessageSender) => {
              // Popup pages carry sender.tab like content scripts; only our own URL may answer.
              if (sender.tab && !sender.url?.startsWith(EXT_BASE_URL)) return;
              if (
                message.type === 'MESSAGE_APPROVAL_RESPONSE' &&
                message.approvalId === approvalId
              ) {
                cleanup();
                resolve({
                  approved: message.approved,
                  selectedAddress:
                    typeof message.selectedAddress === 'string'
                      ? message.selectedAddress
                      : undefined,
                  choice: typeof message.choice === 'string' ? message.choice : undefined,
                });
              }
            };
            chrome.runtime.onMessage.addListener(listener);

            const windowCloseListener = (closedWindowId: number) => {
              if (closedWindowId === popupWindowId) {
                cleanup();
                resolve({ approved: false, error: 'User closed approval window' });
              }
            };
            chrome.windows.onRemoved.addListener(windowCloseListener);

            const timeoutId = setTimeout(() => {
              review?.expire();
              cleanup();
              chrome.windows.remove(popupWindowId).catch(() => {});
              resolve({ approved: false, error: 'Message approval timed out' });
            }, REVIEW_WINDOW_MS);
            const leavePage =
              review?.onPageGone(() => {
                cleanup();
                chrome.windows.remove(popupWindowId).catch(() => {});
                resolve(PAGE_GONE);
              }) ?? (() => {});
            void review?.shown().catch(() => {});
          }
        );
      })().catch(() => resolve({ approved: false, error: 'Internal error' }));
    });
  }
}
export const msgApprovalQueue = new MessageApprovalQueue();

export function hasPendingApproval(origin: string): boolean {
  return [approvalQueue, txApprovalQueue, msgApprovalQueue].some((q) =>
    q.queue.some((r) => r.origin === origin)
  );
}
