import { useEffect, useMemo, useRef } from 'react';

const SETTLE_MS = 400;

const CROSSFADE = 'animate-in! fade-in! duration-200!';

const useRouteTransition = (pathname: string): string => {
  const previous = useRef<string | null>(null);
  const openedAt = useRef(performance.now());

  const enter = useMemo(() => {
    const from = previous.current;
    if (from === null || from === pathname) return '';
    if (from === '/lock' || pathname === '/lock') return '';
    if (performance.now() - openedAt.current < SETTLE_MS) return '';
    return CROSSFADE;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // effect:audited - remembers the page that just painted, so the next change knows where it came from
  useEffect(() => {
    previous.current = pathname;
  }, [pathname]);

  return enter;
};

export default useRouteTransition;
