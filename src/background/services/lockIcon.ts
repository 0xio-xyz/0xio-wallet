import { logger } from '../../utils/logger';

export type LockIconState = 'locked' | 'unlocked' | 'none';

const SIZES = [16, 32, 48, 128] as const;

const iconSet = (name: (size: number) => string) =>
  Object.fromEntries(SIZES.map((size) => [size, `/${name(size)}`])) as Record<number, string>;

export const NORMAL_ICON = iconSet((size) => `icon${size}.png`);
export const LOCKED_ICON = iconSet((size) => `icon-locked-${size}.png`);

const LOCAL_KEYS = ['vault', 'hashedPassword', 'passwordSkipped'] as const;

export async function readLockIconState(): Promise<LockIconState> {
  const local = await chrome.storage.local.get([...LOCAL_KEYS]);
  if (!local.vault && !local.hashedPassword && !local.passwordSkipped) return 'none';
  if (local.passwordSkipped) return 'unlocked';
  const { wallet_unlocked: unlocked } = await chrome.storage.session.get('wallet_unlocked');
  return unlocked ? 'unlocked' : 'locked';
}

let queue: Promise<void> = Promise.resolve();

export function syncLockIcon(): Promise<void> {
  queue = queue.then(async () => {
    try {
      const state = await readLockIconState();
      await chrome.action.setIcon({ path: state === 'locked' ? LOCKED_ICON : NORMAL_ICON });
    } catch (error) {
      logger.warn('[LockIcon] could not update the toolbar icon', error);
    }
  });
  return queue;
}

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  const relevant =
    area === 'session'
      ? 'wallet_unlocked' in changes
      : area === 'local' && LOCAL_KEYS.some((key) => key in changes);
  if (relevant) void syncLockIcon();
}

export function initLockIcon(): void {
  chrome.storage.onChanged.addListener(onStorageChanged);
  void syncLockIcon();
}
