import { useRef, useState } from 'react';

export function useTwoStepConfirm(timeoutMs = 4000) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setArmed(false);
  };

  const trigger = (onConfirm: () => void) => {
    if (!armed) {
      setArmed(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setArmed(false);
      }, timeoutMs);
      return;
    }
    disarm();
    onConfirm();
  };

  return { armed, trigger, disarm };
}
