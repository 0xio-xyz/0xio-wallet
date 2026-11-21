import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { KeyRound, Plus } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import AddWalletFlow, { type WalletDraft } from 'src/features/wallet/add/AddWalletFlow';
import { ListRow, RuledList, Sheet } from 'src/shared/ui/primitives';
import { plainError } from 'src/utils/plainError';
import { logger } from 'src/utils/logger';

const AddWalletForSite = ({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (walletId: string) => void;
}) => {
  const { t } = useTranslation();
  const { wallets, walletStorage, passwordManager, refreshWallets, showMessage } = useWallet();
  const [flow, setFlow] = useState<'import' | 'generate' | null>(null);

  const save = async (draft: WalletDraft): Promise<boolean> => {
    if (wallets.some((w) => w.address === draft.address)) {
      showMessage(t('wallet.addressAlreadyExists'), 'error');
      return false;
    }
    if (draft.isPadded) {
      showMessage(
        t('evmDapp.addPadded', {
          defaultValue: 'Import this key from the wallet list.',
        }),
        'error'
      );
      return false;
    }
    try {
      const sessionKey = await passwordManager.getSessionKey();
      if (!sessionKey) throw new Error(t('wallet.sessionExpired'));
      const saved = await walletStorage.saveWallet(
        {
          name: draft.name,
          address: draft.address,
          type: draft.type,
          privateKey: draft.privateKey,
          publicKey: draft.publicKey,
          mnemonic: draft.mnemonic,
          source: draft.source,
          isActive: false,
          isPadded: false,
          needsBackup: draft.needsBackup,
          evm: draft.evm,
        },
        sessionKey
      );
      await refreshWallets();
      setFlow(null);
      onAdded(saved.id);
      return false;
    } catch (e) {
      logger.error('[EVM connect] adding a wallet failed', e);
      showMessage(plainError(e, t('toast.walletSaveFailed')), 'error');
      return false;
    }
  };

  if (flow) {
    return (
      <div className="absolute! inset-0! z-modal! flex! flex-col! bg-(--bg)! animate-in! fade-in! duration-200!">
        <AddWalletFlow
          key={flow}
          mode={flow}
          firstRun={false}
          wallets={wallets}
          exitIcon="back"
          onExit={() => setFlow(null)}
          onDone={save}
        />
      </div>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('evmDapp.addTitle', { defaultValue: 'Add a wallet' })}
    >
      <RuledList>
        <ListRow
          leading={<KeyRound size={16} style={{ color: 'var(--fg-2)' }} />}
          label={t('evmDapp.addImport', { defaultValue: 'Import a recovery phrase' })}
          onClick={() => {
            onClose();
            setFlow('import');
          }}
        />
        <ListRow
          leading={<Plus size={16} style={{ color: 'var(--fg-2)' }} />}
          label={t('evmDapp.addCreate', { defaultValue: 'Create a new wallet' })}
          onClick={() => {
            onClose();
            setFlow('generate');
          }}
        />
      </RuledList>
    </Sheet>
  );
};

export default AddWalletForSite;
