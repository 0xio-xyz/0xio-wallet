import { useState, useRef } from 'react';
import useExitAnimation from 'src/hooks/ui/useExitAnimation';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useLocation, useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { isPasskeyEnabled, authenticateWithPasskey } from 'src/services/crypto/PasskeyService';
import { ZeroXIOConfig } from 'src/utils/config';

import CreateImportScreen from './CreateImportScreen';
import AddWalletFlow, {
  type AddMode,
  type WalletDraft,
} from 'src/features/wallet/add/AddWalletFlow';
import WalletCard from 'src/features/wallet/components/WalletCard';
import Header from 'src/shared/ui/Header';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import {
  RuledList,
  ListRow,
  SectionLabel,
  TextButton,
  PrimaryButton,
  QuietInput,
  Modal,
} from 'src/shared/ui/primitives';
import { logger } from 'src/utils/logger';
import { plainError } from 'src/utils/plainError';

import { WALLET_NAME_MAX } from 'src/services/wallet/WalletStorage';
import { isEvmOn } from 'src/services/evm/walletEvm';
import { useSiteConnections } from 'src/hooks/dapp/useSiteConnections';
import { SiteMark } from 'src/features/dapp/components/ReviewParts';
import { hostOf } from 'src/features/dapp/siteWallets';
import { revokeOctraSite } from 'src/features/dapp/siteActions';

const FLOW_MODES: AddMode[] = ['generate', 'import', 'derive'];

const WalletListScreen = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    wallets,
    activeWallet,
    switchWallet,
    showMessage,
    walletStorage,
    passwordManager,
    refreshWallets,
  } = useWallet();

  const sites = useSiteConnections();
  const isMounted = useRef(true);
  useMountEffect(() => {
    walletStorage
      .linkEvmAccounts()
      .then((changed) => {
        if (changed && isMounted.current) return refreshWallets();
      })
      .catch((e) => logger.warn('[WalletList] could not link added accounts to EVM', e));
    return () => {
      isMounted.current = false;
    };
  });

  const [view, setView] = useState('list');
  const location = useLocation();
  const startImport = (location.state as { add?: string } | null)?.add === 'import';
  const [showModal, setShowModal] = useState(startImport);
  const [modalType, setModalType] = useState(startImport ? 'import' : '');
  const [isLoading, setIsLoading] = useState(false);
  const [walletName, setWalletName] = useState('');
  const [errors, setErrors] = useState<{ walletName?: string }>({});
  const [selectedWallet, setSelectedWallet] = useState(null);
  const [paddedDraft, setPaddedDraft] = useState<WalletDraft | null>(null);
  const [paddedSaving, setPaddedSaving] = useState(false);
  const paddedAnswer = useRef<((saved: boolean) => void) | null>(null);

  const [deletePassword, setDeletePassword] = useState('');
  const [deletePasskeyEnabled, setDeletePasskeyEnabled] = useState(false);
  const [deletePasswordEnabled, setDeletePasswordEnabled] = useState(false);
  const [deletePasskeyLoading, setDeletePasskeyLoading] = useState(false);
  const [deleteAuthError, setDeleteAuthError] = useState('');
  const [deleteShowFallback, setDeleteShowFallback] = useState(false);

  const handleShowAddOptions = () => {
    if (wallets.length >= ZeroXIOConfig.WALLET.MAX_WALLETS) {
      showMessage(t('toast.walletLimit'), 'error');
      return;
    }
    setView('add_options');
  };

  const handleBackToList = () => {
    setView('list');
  };

  const handleGoBack = () => {
    if (view === 'add_options') {
      setView('list');
    } else {
      navigate('/');
    }
  };

  const handleOpenModal = (type: string) => {
    setModalType(type);
    setShowModal(true);
    setWalletName('');
    setErrors({});
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setModalType('');
    setWalletName('');
    setErrors({});
  };

  const { closing: modalClosing, requestClose: dismissModal } = useExitAnimation(handleCloseModal);

  const answerPadded = (saved: boolean) => {
    paddedAnswer.current?.(saved);
    paddedAnswer.current = null;
    setPaddedDraft(null);
  };

  const handleConfirmPaddedImport = async () => {
    if (!paddedDraft) return;
    setPaddedSaving(true);
    let saved = false;
    try {
      saved = await storeAdded(paddedDraft);
    } finally {
      if (isMounted.current) setPaddedSaving(false);
      answerPadded(saved);
    }
  };

  const loadMnemonic = async (walletId: string): Promise<string | null> => {
    const sessionKey = await passwordManager.getSessionKey();
    if (!sessionKey) throw new Error(t('wallet.sessionExpired'));
    const data: any = await walletStorage.loadWallet(walletId, sessionKey);
    if (!data?.mnemonic) return null;
    return Array.isArray(data.mnemonic) ? data.mnemonic.join(' ') : data.mnemonic;
  };

  const storeAdded = async (draft: WalletDraft): Promise<boolean> => {
    try {
      const sessionKey = await passwordManager.getSessionKey();
      if (!sessionKey) throw new Error(t('wallet.sessionExpired'));
      if (draft.addressWarning) showMessage(t('toast.paddedWarning'), 'warning');

      await walletStorage.saveWallet(
        {
          name: draft.name,
          address: draft.address,
          type: draft.type,
          privateKey: draft.privateKey,
          publicKey: draft.publicKey,
          mnemonic: draft.mnemonic,
          source: draft.source,
          isActive: wallets.length === 0,
          isPadded: draft.isPadded || false,
          needsBackup: draft.needsBackup,
          evm: draft.evm,
        },
        sessionKey
      );
      if (!isMounted.current) return false;

      if (modalType === 'derive') {
        await refreshWallets();
        dismissModal();
        setView('list');
        return false;
      }

      // switchWallet first so epoch increments before refreshWallets fires refreshBalance
      await switchWallet(draft.address);
      await refreshWallets();
      return true;
    } catch (error: any) {
      logger.error(error);
      if (isMounted.current) showMessage(plainError(error, t('toast.walletSaveFailed')), 'error');
      return false;
    }
  };

  const saveAdded = async (draft: WalletDraft): Promise<boolean> => {
    if (wallets.some((w) => w.address === draft.address)) {
      showMessage(t('wallet.addressAlreadyExists'), 'error');
      return false;
    }
    if (!draft.isPadded) return storeAdded(draft);
    setPaddedDraft(draft);
    return new Promise<boolean>((resolve) => {
      paddedAnswer.current = resolve;
    });
  };

  const openAdded = () => {
    dismissModal();
    setView('list');
    navigate('/');
  };

  const handleRenameWallet = async () => {
    if (!walletName.trim()) {
      setErrors({ walletName: t('wallet.nameRequired') });
      return;
    }
    setIsLoading(true);
    try {
      const existingWallets = await walletStorage.loadAllWallets();

      const isDuplicate = existingWallets.some(
        (w) =>
          w.name.toLowerCase() === walletName.trim().toLowerCase() && w.id !== selectedWallet.id
      );

      if (isDuplicate) {
        setErrors({ walletName: t('wallet.walletNameExists') });
        setIsLoading(false);
        return;
      }

      await walletStorage.updateWalletName(selectedWallet.id, walletName.trim());

      if (isMounted.current) {
        dismissModal();
        await refreshWallets();
      }
    } catch (error) {
      logger.error('Rename failed:', error);
      if (isMounted.current) showMessage(t('toast.renameFailed'), 'error');
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  };

  const doDeleteWallet = async () => {
    if (!selectedWallet) return;
    setIsLoading(true);
    try {
      const success = await walletStorage.deleteWallet(selectedWallet.id);
      if (success) {
        for (const site of sites.octra.filter((o) => o.address === selectedWallet.address)) {
          await revokeOctraSite(site.origin, site.key).catch(() => {});
        }
        if (isMounted.current) {
          dismissModal();
          await refreshWallets();
        }
      } else {
        if (isMounted.current) showMessage(t('toast.walletDeleteFailed'), 'error');
      }
    } catch (error) {
      if (isMounted.current) showMessage(plainError(error, t('toast.walletDeleteFailed')), 'error');
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  };

  const handlePasskeyDelete = async () => {
    setDeletePasskeyLoading(true);
    setDeleteAuthError('');
    try {
      const pw = await authenticateWithPasskey();
      if (pw) {
        await doDeleteWallet();
      } else {
        setDeleteAuthError('Passkey authentication failed');
      }
    } catch {
      setDeleteAuthError('Passkey failed. Use your password.');
    } finally {
      if (isMounted.current) setDeletePasskeyLoading(false);
    }
  };

  const handleDeleteWallet = async () => {
    if (!selectedWallet) return;

    const storage = await chrome.storage.local.get(['hashedPassword', 'salt']);
    if (storage.hashedPassword) {
      if (!deletePassword.trim()) {
        setDeleteAuthError('Enter your password to confirm');
        return;
      }
      const valid = await passwordManager.verifyPassword(
        deletePassword,
        storage.hashedPassword,
        storage.salt
      );
      if (!valid) {
        setDeleteAuthError('Incorrect password');
        return;
      }
    }

    await doDeleteWallet();
  };

  const isFullPanel = FLOW_MODES.includes(modalType as AddMode);
  const seedWallets = wallets.filter((w: any) => w.mnemonic && w.type !== 'watch');
  const deriveFrom =
    seedWallets.find((w: any) => w.address === activeWallet?.address) ?? seedWallets[0];
  const deleteAction =
    !deletePasskeyEnabled && !deletePasswordEnabled
      ? doDeleteWallet
      : deletePasskeyEnabled && !deleteShowFallback
        ? handlePasskeyDelete
        : handleDeleteWallet;
  const selectedSites = selectedWallet
    ? [
        ...new Set([
          ...Object.values(sites.evm)
            .filter((site) => site.accounts[selectedWallet.id])
            .map((site) => site.origin),
          ...sites.octra.filter((o) => o.address === selectedWallet.address).map((o) => o.origin),
        ]),
      ]
    : [];
  const walletRow = selectedWallet && (
    <RuledList>
      <ListRow
        leading={<WalletAvatar address={selectedWallet.address} size={32} />}
        label={selectedWallet.name}
        sub={selectedWallet.address}
        chevron={false}
      />
    </RuledList>
  );

  return (
    <div className="flex! flex-col! h-full! bg-(--bg)! relative! overflow-hidden!">
      <Header
        title={view === 'list' ? t('wallet.wallets') : t('createImport.addWallet')}
        showBack
        showSettings={false}
        onBack={handleGoBack}
      />

      <main
        key={view}
        className="flex-1! min-h-0! overflow-y-auto! scrollbar-hide! animate-in! fade-in! duration-200!"
      >
        {view === 'list' ? (
          <div className="space-y-4! pb-10! mx-(--gutter)!">
            <div className="sticky! top-0! z-sticky! bg-(--bg-main)! pt-2! pb-2! flex! items-center! justify-between! mb-2! -mx-(--gutter)! px-(--gutter)!">
              <span className="text-[10px]! font-bold! tracking-widest! text-content-muted uppercase!">
                {t('wallet.availableWallets')}
              </span>
              <span className="text-[10px]! font-mono! text-content-secondary bg-(--bg-card) px-2! py-1! rounded-full!">
                {wallets.length} / {ZeroXIOConfig.WALLET.MAX_WALLETS}
              </span>
            </div>

            {wallets.map((wallet, index) => (
              <WalletCard
                key={wallet.address}
                wallet={wallet}
                index={index}
                isLast={index === wallets.length - 1}
                isActive={activeWallet?.address === wallet.address}
                dropUp={wallets.length >= 5 && index >= wallets.length - 2}
                onSwitch={switchWallet}
                onMenuAction={(action: string, selectedWallet: any) => {
                  setSelectedWallet(selectedWallet);
                  if (action === 'rename') {
                    setWalletName(selectedWallet.name);
                    setModalType('rename');
                    setShowModal(true);
                  } else if (action === 'delete') {
                    if (wallets.length === 1) {
                      showMessage(t('toast.cannotDeleteLast'), 'error');
                      return;
                    }
                    setDeletePassword('');
                    setDeleteAuthError('');
                    setDeleteShowFallback(false);
                    isPasskeyEnabled().then(setDeletePasskeyEnabled);
                    chrome.storage.local
                      .get(['hashedPassword'])
                      .then((s) => setDeletePasswordEnabled(!!s.hashedPassword));
                    setModalType('delete');
                    setShowModal(true);
                  }
                }}
                evmAddress={
                  isEvmOn(wallet, wallets) ? (wallet.metadata.evm?.address ?? null) : null
                }
              />
            ))}
          </div>
        ) : (
          <CreateImportScreen
            onCreate={() => handleOpenModal('generate')}
            onImport={() => handleOpenModal('import')}
            onDerive={deriveFrom ? () => handleOpenModal('derive') : undefined}
            onCancel={handleBackToList}
          />
        )}
      </main>

      {view === 'list' && wallets.length < ZeroXIOConfig.WALLET.MAX_WALLETS && (
        <div className="shrink-0! px-(--gutter)!" style={{ padding: '10px 0 16px' }}>
          <button
            onClick={handleShowAddOptions}
            className="flex! items-center! justify-center! gap-2! w-full!"
            style={{
              height: '44px',
              borderRadius: '10px',
              background: 'var(--bg-1)',
              border: 'none',
              color: 'var(--fg)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            + Add wallet
          </button>
        </div>
      )}

      {view === 'add_options' && (
        <div className="shrink-0! px-(--gutter)!" style={{ padding: '10px 0 16px' }}>
          <button
            onClick={handleBackToList}
            className="flex! items-center! justify-center! gap-2! w-full!"
            style={{
              height: '44px',
              borderRadius: '10px',
              background: 'var(--bg-1)',
              border: 'none',
              color: 'var(--fg)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      )}

      {showModal && isFullPanel && (
        <div
          className="absolute! inset-0! z-modal! flex! flex-col! bg-(--bg)! animate-in! fade-in! duration-200!"
          style={{ opacity: modalClosing ? 0 : undefined, transition: 'opacity 200ms ease' }}
        >
          <AddWalletFlow
            key={modalType}
            mode={modalType as AddMode}
            firstRun={false}
            wallets={wallets}
            activeAddress={activeWallet?.address}
            loadMnemonic={loadMnemonic}
            exitIcon="close"
            onExit={dismissModal}
            onDone={saveAdded}
            onOpen={openAdded}
          />
        </div>
      )}

      <Modal
        open={showModal && modalType === 'rename'}
        onClose={dismissModal}
        dismissible={!isLoading}
        title="Rename wallet"
        closeLabel={t('common.close')}
        onSubmit={() => !isLoading && handleRenameWallet()}
        footer={
          <PrimaryButton onClick={handleRenameWallet} loading={isLoading}>
            {isLoading ? 'Saving' : 'Rename'}
          </PrimaryButton>
        }
      >
        <div className="flex! flex-col!" style={{ gap: '14px' }}>
          {walletRow}
          <QuietInput
            label="New name"
            value={walletName}
            maxLength={WALLET_NAME_MAX}
            onChange={(e) => setWalletName(e.target.value)}
            placeholder={t('wallet.walletNamePlaceholder')}
            autoFocus
            error={errors.walletName ?? ''}
          />
        </div>
      </Modal>

      <Modal
        open={showModal && modalType === 'delete'}
        onClose={dismissModal}
        dismissible={!isLoading && !deletePasskeyLoading}
        title="Delete wallet"
        danger
        closeLabel={t('common.close')}
        onSubmit={() => !isLoading && !deletePasskeyLoading && deleteAction()}
        footer={
          <PrimaryButton
            danger
            onClick={deleteAction}
            loading={isLoading}
            disabled={deletePasskeyLoading}
          >
            {isLoading ? t('wallet.deleting') : 'Delete'}
          </PrimaryButton>
        }
      >
        <div className="flex! flex-col!" style={{ gap: '14px' }}>
          {walletRow}
          {selectedSites.length > 0 && (
            <div>
              <SectionLabel first>
                {t('wallet.connectedTo', { defaultValue: 'Connected to' })}
              </SectionLabel>
              <RuledList>
                {selectedSites.map((origin) => (
                  <ListRow
                    key={origin}
                    leading={<SiteMark origin={origin} size={24} />}
                    label={hostOf(origin)}
                    chevron={false}
                  />
                ))}
              </RuledList>
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--fg-3)',
                  marginTop: '8px',
                  lineHeight: 1.5,
                }}
              >
                {t('wallet.sitesOnRemove', {
                  defaultValue:
                    'Those sites stop seeing this address. A site with other wallets keeps them; a site with none is disconnected.',
                })}
              </div>
            </div>
          )}
          <div>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--neg)' }}>
              {t('wallet.permanentAction')}
            </div>
            <div
              style={{ fontSize: '11px', color: 'var(--fg-3)', marginTop: '3px', lineHeight: 1.5 }}
            >
              {t('wallet.permanentActionDesc')}
            </div>
          </div>
          {(deletePasskeyEnabled || deletePasswordEnabled) &&
            (deletePasskeyEnabled && !deleteShowFallback ? (
              <div className="flex! flex-col! items-center!" style={{ gap: '10px' }}>
                <PrimaryButton
                  secondary
                  onClick={handlePasskeyDelete}
                  loading={deletePasskeyLoading}
                  disabled={isLoading}
                >
                  {deletePasskeyLoading ? 'Authenticating' : 'Confirm with passkey'}
                </PrimaryButton>
                {deletePasswordEnabled && (
                  <TextButton muted size={11} onClick={() => setDeleteShowFallback(true)}>
                    Use password instead
                  </TextButton>
                )}
              </div>
            ) : (
              <QuietInput
                label="Confirm password"
                type="password"
                value={deletePassword}
                onChange={(e) => {
                  setDeletePassword(e.target.value);
                  setDeleteAuthError('');
                }}
                placeholder="Enter your password"
                autoFocus
                error={deleteAuthError || undefined}
              />
            ))}
        </div>
      </Modal>

      <Modal
        open={!!paddedDraft}
        onClose={() => !paddedSaving && answerPadded(false)}
        dismissible={!paddedSaving}
        title={t('wallet.paddingDetected')}
        closeLabel={t('common.close')}
        zIndexClass="z-nested!"
        footer={
          <div className="flex! flex-col! items-center!" style={{ gap: '10px' }}>
            <PrimaryButton secondary onClick={handleConfirmPaddedImport} loading={paddedSaving}>
              {t('wallet.importAnyway')}
            </PrimaryButton>
            <TextButton muted onClick={() => answerPadded(false)} disabled={paddedSaving}>
              {t('common.cancel', 'Cancel')}
            </TextButton>
          </div>
        }
      >
        <p style={{ fontSize: '12px', color: 'var(--fg-2)', lineHeight: 1.5, margin: '0 0 10px' }}>
          {t('wallet.paddingDesc')}
        </p>
        <div style={{ fontSize: '11px', color: 'var(--fg-3)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--fg-2)' }}>{t('wallet.paddingRecommendation')}</span>{' '}
          {t('wallet.paddingAdvice')}
        </div>
      </Modal>
    </div>
  );
};

export default WalletListScreen;
