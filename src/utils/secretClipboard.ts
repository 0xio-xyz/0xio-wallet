import { logger } from 'src/utils/logger';

export const SECRET_CLIPBOARD_MS = 60_000;

interface Pending {
  text: string;
  timer: ReturnType<typeof setTimeout>;
  held: boolean;
  due: boolean;
  stop: () => void;
}

let pending: Pending | null = null;

export const forgetSecretClipboard = (): void => {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.stop();
  pending = null;
};

const canRead = async (): Promise<boolean> => {
  try {
    const status = await navigator.permissions.query({
      name: 'clipboard-read' as PermissionName,
    });
    return status.state === 'granted';
  } catch {
    return false;
  }
};

const settle = async (entry: Pending): Promise<void> => {
  if (pending !== entry) return;
  if (!document.hasFocus()) {
    entry.due = true;
    return;
  }
  const { text, held } = entry;
  forgetSecretClipboard();
  try {
    if (await canRead()) {
      if ((await navigator.clipboard.readText()) !== text) return;
    } else if (!held) return;
    await navigator.clipboard.writeText('');
  } catch {
    logger.warn('Clipboard clear failed');
  }
};

export const writeClipboard = (text: string): Promise<void> => {
  forgetSecretClipboard();
  return navigator.clipboard.writeText(text);
};

export const copySecret = async (text: string): Promise<boolean> => {
  forgetSecretClipboard();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    logger.warn('Copy failed');
    return false;
  }
  const onBlur = () => {
    entry.held = false;
  };
  const onFocus = () => {
    if (entry.due) void settle(entry);
  };
  const onCopy = () => {
    if (pending === entry) forgetSecretClipboard();
  };
  const entry: Pending = {
    text,
    held: document.hasFocus(),
    due: false,
    timer: setTimeout(() => void settle(entry), SECRET_CLIPBOARD_MS),
    stop: () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
    },
  };
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCopy);
  pending = entry;
  return true;
};
