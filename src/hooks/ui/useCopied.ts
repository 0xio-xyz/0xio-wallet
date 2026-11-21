import { useCallback, useRef, useState } from 'react';
import useMountEffect from './useMountEffect';
import { logger } from 'src/utils/logger';
import { writeClipboard } from 'src/utils/secretClipboard';

export const COPIED_MS = 1500;

export function useCopied(ms = COPIED_MS) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useMountEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  });

  const flash = useCallback(
    (id = 'default') => {
      if (timer.current) clearTimeout(timer.current);
      setCopied(id);
      timer.current = setTimeout(() => setCopied(null), ms);
    },
    [ms]
  );

  const copy = useCallback(
    async (text: string, id = 'default') => {
      try {
        await writeClipboard(text);
      } catch (err) {
        logger.warn('Copy failed:', err);
        return false;
      }
      flash(id);
      return true;
    },
    [flash]
  );

  return { copied, copy, flash, isCopied: (id = 'default') => copied === id };
}

export default useCopied;
