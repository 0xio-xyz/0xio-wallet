const DONE_KEY = 'rebackupDone';

/**
 * From the 18 May 2026 onboarding rework until its fix, first-run Create showed one recovery
 * phrase and saved a different wallet. Those wallets carry the source 'generate' (every other
 * path records 'generated' or an import); the vault holds their real phrase.
 */
const AFFECTED_FROM = Date.UTC(2026, 4, 18);

interface WalletLike {
  type?: string;
  metadata?: { source?: string; createdAt?: number };
}

export const needsRebackup = (wallet?: WalletLike | null): boolean =>
  !!wallet &&
  wallet.type !== 'watch' &&
  wallet.metadata?.source === 'generate' &&
  (wallet.metadata?.createdAt ?? 0) >= AFFECTED_FROM;

const doneList = async (): Promise<string[]> => {
  const stored = await chrome.storage.local.get(DONE_KEY);
  const list = stored[DONE_KEY];
  return Array.isArray(list) ? list : [];
};

const known = new Map<string, boolean>();

export const knownRebackupDone = (address: string): boolean | undefined => known.get(address);

export const isRebackupDone = async (address: string): Promise<boolean> => {
  const done = (await doneList()).includes(address);
  known.set(address, done);
  return done;
};

export const markRebackupDone = async (address: string): Promise<void> => {
  const list = await doneList();
  if (!list.includes(address)) await chrome.storage.local.set({ [DONE_KEY]: [...list, address] });
  known.set(address, true);
};
