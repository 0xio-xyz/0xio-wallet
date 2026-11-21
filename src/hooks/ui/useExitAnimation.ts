import { useCallback, useRef, useState } from 'react';

const EXIT_MS = 200;

export function useExitAnimation(onClose: () => void) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestClose = useCallback(() => {
    if (timer.current) return;
    setClosing(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setClosing(false);
      onClose();
    }, EXIT_MS);
  }, [onClose]);

  return { closing, requestClose };
}

export default useExitAnimation;
