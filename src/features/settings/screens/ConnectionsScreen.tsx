import { useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { addressBookService } from 'src/services/wallet/AddressBookService';
import Header from 'src/shared/ui/Header';
import { RuledList, ListRow, TextButton } from 'src/shared/ui/primitives';
import { loadPairing } from 'src/services/desktop/desktopPairing';
import { useDesktopSync } from 'src/hooks/wallet/useDesktopSync';
import { useStartDesktopPairing } from 'src/hooks/wallet/useStartDesktopPairing';

const ConnectionsScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sites, setSites] = useState<number | null>(null);
  const [contacts, setContacts] = useState<number | null>(null);
  const [paired, setPaired] = useState<boolean | null>(null);
  const { unpair, pairing, pairSheet, status } = useDesktopSync();
  const busy = pairing || !!pairSheet;
  const startPairing = useStartDesktopPairing();
  const isPaired = !!paired && status !== 'not_paired';
  const readPaired = (): void => {
    void loadPairing()
      .then((p) => setPaired(!!p))
      .catch(() => setPaired(false));
  };

  useMountEffect(() => {
    void (async () => {
      try {
        const stored = (await chrome.storage.local.get(null)) as unknown as Record<string, any>;
        setSites(
          Object.entries(stored).filter(
            ([key, value]) => key.startsWith('dapp_connection_') && value?.connected
          ).length
        );
      } catch {
        setSites(0);
      }
    })();
    readPaired();
    void addressBookService
      .getAllContacts()
      .then((list) => setContacts(list.length))
      .catch(() => setContacts(0));
  });

  return (
    <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
      <Header
        title={t('settings.connections', { defaultValue: 'Connections' })}
        showBack
        showSettings={false}
      />
      <div
        className="flex-1! overflow-y-auto! scrollbar-hide!"
        style={{ padding: '14px var(--gutter) 24px' }}
      >
        <RuledList>
          <ListRow
            label={t('settings.connectedSites', { defaultValue: 'Connected sites' })}
            hint={sites === null ? undefined : String(sites)}
            onClick={() => navigate('/settings/connected-dapps')}
          />
          <ListRow
            label={t('settings.addressBookRow', { defaultValue: 'Address book' })}
            hint={contacts === null ? undefined : String(contacts)}
            onClick={() => navigate('/settings/addressbook')}
          />
          <ListRow
            label={t('settings.desktopRow', { defaultValue: '0xio Desktop' })}
            right={
              paired === null ? undefined : isPaired ? (
                <TextButton muted onClick={() => void unpair().then(readPaired)} disabled={busy}>
                  {t('settings.desktopUnpair', { defaultValue: 'Unpair' })}
                </TextButton>
              ) : (
                <TextButton onClick={() => void startPairing().then(readPaired)} disabled={busy}>
                  {t('settings.desktopPair', { defaultValue: 'Pair' })}
                </TextButton>
              )
            }
          />
        </RuledList>
      </div>
    </div>
  );
};

export default ConnectionsScreen;
