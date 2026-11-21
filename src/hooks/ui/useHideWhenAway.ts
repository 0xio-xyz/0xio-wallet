import { useRef } from 'react';
import useMountEffect from './useMountEffect';

const useHideWhenAway = (hide: () => void): void => {
  const latest = useRef(hide);
  latest.current = hide;

  useMountEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') latest.current();
    };
    const onPageHide = () => latest.current();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  });
};

export default useHideWhenAway;
