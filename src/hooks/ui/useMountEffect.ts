import { useEffect } from 'react';

const useMountEffect = (fn: () => (() => void) | void | Promise<void>): void =>
  useEffect(() => {
    const teardown = fn();
    return typeof teardown === 'function' ? teardown : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // effect:audited - intentional mount-only sync

export default useMountEffect;
