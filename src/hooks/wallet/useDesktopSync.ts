import { useState, useEffect, useCallback } from 'react';
import { pvacManager } from 'src/services/pvac/PvacManager';
import type { DesktopStatus } from 'src/services/desktop/desktopLink';

export function useDesktopSync() {
  const [connected, setConnected] = useState(pvacManager.hasDesktopApp);
  const [keygenMismatch, setKeygenMismatch] = useState(pvacManager.desktopKeygenMismatch);
  const [status, setStatus] = useState<DesktopStatus>(pvacManager.desktopStatus);
  const [pairSheet, setPairSheet] = useState(pvacManager.desktopPairSheet);
  const [pairing, setPairing] = useState(pvacManager.desktopPairingActive);
  const [reconnecting, setReconnecting] = useState(false);

  // effect:audited - subscribes to the desktop link held by the PVAC manager (an external system)
  useEffect(() => {
    const read = () => {
      setConnected(pvacManager.hasDesktopApp);
      setKeygenMismatch(pvacManager.desktopKeygenMismatch);
      setStatus(pvacManager.desktopStatus);
      setPairSheet(pvacManager.desktopPairSheet);
      setPairing(pvacManager.desktopPairingActive);
    };
    read();
    const off = pvacManager.onDesktopChange(read);
    const id = setInterval(read, 2000);
    return () => {
      off();
      clearInterval(id);
    };
  }, []);

  const reconnect = useCallback(
    async (privateKeyB64?: string): Promise<boolean> => {
      if (pvacManager.hasDesktopApp) return true;
      if (reconnecting) return false;
      setReconnecting(true);
      try {
        const ok = await pvacManager.reconnectDesktop(privateKeyB64);
        const connectedNow = ok || pvacManager.hasDesktopApp;
        setConnected(connectedNow);
        return connectedNow;
      } finally {
        setReconnecting(false);
      }
    },
    [reconnecting]
  );

  return {
    connected,
    keygenMismatch,
    status,
    pairSheet,
    pairing,
    reconnect,
    reconnecting,
    pair: () => pvacManager.pairDesktop(),
    cancelPair: () => pvacManager.closeDesktopPairSheet(),
    pickPairCode: (index: number) => pvacManager.pickDesktopPairCode(index),
    submitPairPick: () => pvacManager.submitDesktopPairPick(),
    unpair: () => pvacManager.unpairDesktop(),
    outdated: () => pvacManager.desktopOutdated,
  };
}
