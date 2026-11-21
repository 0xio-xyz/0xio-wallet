import { useEffect, useRef } from 'react';

const stack: symbol[] = [];

export function useSheetEscape(open: boolean, close: (() => void) | undefined) {
  const closeRef = useRef(close);
  closeRef.current = close;
  // effect:audited - a document key listener while the sheet is open (external system: the DOM)
  useEffect(() => {
    if (!open) return;
    const id = Symbol('sheet');
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || stack[stack.length - 1] !== id) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && focused !== document.documentElement) return;
      closeRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
    };
  }, [open]);
}
