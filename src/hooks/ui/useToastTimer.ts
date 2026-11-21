import { useCallback, useRef, useState } from 'react';
import useMountEffect from './useMountEffect';

export const TOAST_EXIT_MS = 200;
export const TOAST_SHORT_MS = 4000;
export const TOAST_LONG_MS = 6000;

export const toastDuration = (type: string): number =>
  type === 'info' || type === 'success' ? TOAST_SHORT_MS : TOAST_LONG_MS;

export function useToastTimer<T extends HTMLElement = HTMLDivElement>(
  duration: number,
  onClose: () => void
) {
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remaining = useRef(duration);
  const startedAt = useRef(0);
  const held = useRef(false);

  const dismiss = useCallback(() => {
    if (exitTimer.current) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setLeaving(true);
    exitTimer.current = setTimeout(() => onCloseRef.current(), TOAST_EXIT_MS);
  }, []);

  const run = useCallback(() => {
    if (exitTimer.current || hideTimer.current) return;
    startedAt.current = Date.now();
    hideTimer.current = setTimeout(dismiss, remaining.current);
  }, [dismiss]);

  const pause = useCallback(() => {
    held.current = true;
    if (!hideTimer.current) return;
    clearTimeout(hideTimer.current);
    hideTimer.current = null;
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
  }, []);

  const resume = useCallback(() => {
    held.current = false;
    run();
  }, [run]);

  useMountEffect(() => {
    run();
    const onMove = (e: Event) => {
      if (!held.current) return;
      const el = ref.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      resume();
    };
    const root = document.documentElement;
    window.addEventListener('blur', resume);
    document.addEventListener('visibilitychange', resume);
    root.addEventListener('mouseleave', resume);
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('blur', resume);
      document.removeEventListener('visibilitychange', resume);
      root.removeEventListener('mouseleave', resume);
      window.removeEventListener('pointermove', onMove);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (exitTimer.current) clearTimeout(exitTimer.current);
      hideTimer.current = null;
      exitTimer.current = null;
    };
  });

  return { ref, leaving, dismiss, pause, resume };
}

export default useToastTimer;
