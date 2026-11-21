import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import { Modal, PasswordField, PrimaryButton, QuietInput } from 'src/shared/ui/primitives';
import { logger } from 'src/utils/logger';
import { plainError } from 'src/utils/plainError';

const CreatePasswordModal = ({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (password: string) => void | Promise<void>;
}) => {
  const { t } = useTranslation();
  const { showMessage, refreshWallets, clearMigrationState } = useWallet();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [working, setWorking] = useState(false);

  const reset = () => {
    setPassword('');
    setConfirmPassword('');
    setShown(false);
    setAttempted(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const longEnough = password.length >= 8;
  const mismatch =
    confirmPassword.length > 0 &&
    confirmPassword !== password &&
    (confirmPassword.length >= password.length || attempted);
  const missing = attempted && longEnough && !confirmPassword;

  const submit = async () => {
    if (working) return;
    setAttempted(true);
    if (!longEnough || password !== confirmPassword) return;
    setWorking(true);
    try {
      await passwordManager.changePassword('', password);
      const created = password;
      reset();
      clearMigrationState();
      await refreshWallets();
      await onCreated(created);
    } catch (err) {
      logger.error('Error handling password:', err);
      showMessage(plainError(err, t('toast.passwordUpdateFailed')), 'error');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal
      open={open}
      onSubmit={submit}
      onClose={close}
      dismissible={!working}
      title={t('security.createPassword')}
      closeLabel={t('common.close')}
      footer={
        <PrimaryButton onClick={submit} loading={working}>
          {t('security.create')}
        </PrimaryButton>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <PasswordField
          label={t('security.passwordLabel')}
          value={password}
          onChange={setPassword}
          autoFocus
          autoComplete="new-password"
          disabled={working}
          note={t('security.passwordRule')}
          noteTone={longEnough ? 'pos' : attempted ? 'neg' : 'muted'}
          shown={shown}
          onToggle={() => setShown(!shown)}
          showLabel={t('common.show')}
          hideLabel={t('common.hide')}
        />
        <QuietInput
          label={t('security.confirmPassword')}
          type={shown ? 'text' : 'password'}
          spellCheck={false}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          disabled={working}
          note={
            mismatch ? t('security.passwordMismatch') : missing ? t('security.confirmAgain') : ''
          }
          noteTone={mismatch || missing ? 'neg' : 'muted'}
        />
      </div>
    </Modal>
  );
};

export default CreatePasswordModal;
