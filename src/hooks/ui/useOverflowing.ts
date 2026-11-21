import { useLayoutEffect, useState } from 'react';

export function useOverflowing<T extends HTMLElement>(): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [over, setOver] = useState(false);

  // effect:audited - measures layout (external system: the DOM) and follows size changes
  useLayoutEffect(() => {
    if (!el) return;
    const check = () => setOver(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return [setEl, over];
}

export default useOverflowing;
