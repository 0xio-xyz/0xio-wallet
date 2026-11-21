import { useRef, useState } from 'react';
import { useNavigate, useLocation } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import { registerPasskey, getLastPasskeyError } from 'src/services/crypto/PasskeyService';
import AddWalletFlow, {
  type AddMode,
  type WalletDraft,
  type Protection,
} from 'src/features/wallet/add/AddWalletFlow';
import { PrimaryButton, TextButton, Modal } from 'src/shared/ui/primitives';
import { logger } from 'src/utils/logger';
import { plainError } from 'src/utils/plainError';

const MODES: AddMode[] = ['generate', 'import'];

const SetupScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { showMessage } = useWallet();
  const requested = location.state?.mode as AddMode | undefined;
  const [mode] = useState<AddMode>(requested && MODES.includes(requested) ? requested : 'generate');
  const [padded, setPadded] = useState<{ draft: WalletDraft; protection: Protection } | null>(null);
  const [saving, setSaving] = useState(false);
  const paddedAnswer = useRef<((saved: boolean) => void) | null>(null);

  const save = async (draft: WalletDraft, protection: Protection) => {
    await passwordManager.initializeVault(protection.password, {
      name: draft.name,
      address: draft.address,
      type: draft.type,
      privateKey: draft.privateKey,
      publicKey: draft.publicKey,
      mnemonic: draft.mnemonic,
      source: draft.source,
      isPadded: draft.isPadded || false,
      isActive: true,
      needsBackup: draft.needsBackup,
      evm: draft.evm,
    });
    passwordManager.setupActivityTracking();

    if (draft.addressWarning) showMessage(t('toast.paddedWarning'), 'warning');

    if (protection.passkey && !(await registerPasskey(protection.password))) {
      showMessage(
        getLastPasskeyError() === 'no_prf'
          ? t('addWallet.passkeyNoPrf', {
              defaultValue:
                'This passkey cannot protect your password. You can still unlock with the password.',
            })
          : t('addWallet.passkeyFailed', {
              defaultValue: 'Passkey not added. Set it up later in Settings.',
            }),
        'warning'
      );
    }
  };

  const onDone = async (draft: WalletDraft, protection?: Protection): Promise<boolean> => {
    if (!protection) return false;
    if (draft.isPadded) {
      setPadded({ draft, protection });
      return new Promise<boolean>((resolve) => {
        paddedAnswer.current = resolve;
      });
    }
    try {
      await save(draft, protection);
      return true;
    } catch (error: any) {
      logger.error('Setup error:', error);
      showMessage(plainError(error, t('toast.createFailed')), 'error');
      return false;
    }
  };

  const answerPadded = (saved: boolean) => {
    paddedAnswer.current?.(saved);
    paddedAnswer.current = null;
    setPadded(null);
  };

  const confirmPadded = async () => {
    if (!padded) return;
    setSaving(true);
    let saved = false;
    try {
      await save(padded.draft, padded.protection);
      saved = true;
    } catch (error: any) {
      logger.error('Import error:', error);
      showMessage(plainError(error, t('toast.importFailed')), 'error');
    } finally {
      setSaving(false);
      answerPadded(saved);
    }
  };

  return (
    <div className="relative! flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
      <AddWalletFlow
        mode={mode}
        firstRun
        onExit={() => navigate(-1)}
        onDone={onDone}
        onOpen={() => navigate('/', { replace: true })}
      />

      <Modal
        open={!!padded}
        onClose={() => !saving && answerPadded(false)}
        dismissible={!saving}
        title={t('wallet.paddingDetected')}
        sub={t('wallet.paddingSubtitle')}
        closeLabel={t('common.close')}
        footer={
          <div className="flex! flex-col! items-center!" style={{ gap: '10px' }}>
            <PrimaryButton secondary onClick={confirmPadded} loading={saving}>
              {t('wallet.importAnyway')}
            </PrimaryButton>
            <TextButton muted onClick={() => answerPadded(false)} disabled={saving}>
              {t('common.cancel', 'Cancel')}
            </TextButton>
          </div>
        }
      />
    </div>
  );
};

export default SetupScreen;
