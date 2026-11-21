import type { Wallet } from 'src/types/wallet';
import { canUseEvm, isEvmOn } from '../evm/walletEvm';

export const WHATS_NEW_VERSION = '3.0.0';
export const WHATS_NEW_PENDING_KEY = 'whats_new_pending';
export const WHATS_NEW_SEEN_KEY = 'whats_new_seen';

export const compareVersions = (a: string, b: string): number => {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
};

export async function noteWhatsNewOnInstalled(details: {
  reason: string;
  previousVersion?: string;
}): Promise<boolean> {
  if (details.reason !== 'update' || !details.previousVersion) return false;
  if (compareVersions(details.previousVersion, WHATS_NEW_VERSION) >= 0) return false;
  await chrome.storage.local.set({ [WHATS_NEW_PENDING_KEY]: WHATS_NEW_VERSION });
  return true;
}

export const isWhatsNewDue = (pending: unknown, seen: unknown): boolean =>
  pending === WHATS_NEW_VERSION && seen !== WHATS_NEW_VERSION;

export async function readWhatsNewDue(): Promise<boolean> {
  const s = await chrome.storage.local.get([WHATS_NEW_PENDING_KEY, WHATS_NEW_SEEN_KEY]);
  return isWhatsNewDue(s[WHATS_NEW_PENDING_KEY], s[WHATS_NEW_SEEN_KEY]);
}

export async function markWhatsNewSeen(): Promise<void> {
  await chrome.storage.local.set({ [WHATS_NEW_SEEN_KEY]: WHATS_NEW_VERSION });
  await chrome.storage.local.remove(WHATS_NEW_PENDING_KEY);
}

export const evmCandidates = <W extends Wallet>(wallets: W[]): W[] =>
  wallets.filter((w) => canUseEvm(w, wallets) && !isEvmOn(w, wallets));

export async function turnOnEvmForAll(
  wallets: Wallet[],
  enable: (walletId: string) => Promise<unknown>
): Promise<{ enabled: string[]; failed: string[] }> {
  const enabled: string[] = [];
  const failed: string[] = [];
  for (const w of evmCandidates(wallets)) {
    try {
      await enable(w.id);
      enabled.push(w.id);
    } catch {
      failed.push(w.id);
    }
  }
  return { enabled, failed };
}
