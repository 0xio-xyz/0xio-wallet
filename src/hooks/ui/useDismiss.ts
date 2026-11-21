import { useEffect, useRef } from 'react';

export const useDismiss = <T extends HTMLElement>(open: boolean, close: () => void) => {
  const ref = useRef<T>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  // effect:audited - listens to document presses and keys only while the menu is open
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return ref;
};
