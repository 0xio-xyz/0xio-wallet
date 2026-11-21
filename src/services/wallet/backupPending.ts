export const BACKUP_PENDING_KEY = 'backupPending';

const pendingList = async (): Promise<string[]> => {
  const stored = await chrome.storage.local.get(BACKUP_PENDING_KEY);
  const list = stored[BACKUP_PENDING_KEY];
  return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : [];
};

export const isBackupPending = async (address: string): Promise<boolean> =>
  (await pendingList()).includes(address);

export const markBackupPending = async (address: string): Promise<void> => {
  const list = await pendingList();
  if (!list.includes(address))
    await chrome.storage.local.set({ [BACKUP_PENDING_KEY]: [...list, address] });
};

export const clearBackupPending = async (address: string): Promise<void> => {
  const list = await pendingList();
  if (list.includes(address))
    await chrome.storage.local.set({ [BACKUP_PENDING_KEY]: list.filter((a) => a !== address) });
};

export const readPendingFromChange = (value: unknown, address: string): boolean =>
  Array.isArray(value) && value.includes(address);
