import { useState, useMemo, useRef } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useTranslation } from 'src/i18n/react';
import { Plus, Edit2, Trash2, Star, User, Globe, Building2, Tag } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import { addressBookService } from 'src/services/wallet/AddressBookService';
import { walletStorage } from 'src/services/wallet/WalletStorage';
import Header from 'src/shared/ui/Header';
import {
  RuledList,
  ListRow,
  SectionLabel,
  TextButton,
  PrimaryButton,
  QuietInput,
  QuietTextarea,
  CellChoice,
  FieldLabel,
  quietField,
  Facts,
  Sheet,
} from 'src/shared/ui/primitives';
import IconButton from 'src/shared/ui/IconButton';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { NamedAddress } from 'src/shared/ui/PrimaryName';
import ConfirmDialog from 'src/shared/ui/ConfirmDialog';
import { useConfirm } from 'src/hooks/ui/useConfirm';
import { logger } from 'src/utils/logger';
import { plainError } from 'src/utils/plainError';
import useCopied from 'src/hooks/ui/useCopied';
import { isOctAddress, normalizeAddress, OCT_ADDRESS_LENGTH } from 'src/utils/octra/address';
import { isEvmAddress } from 'src/services/evm/tx';

const CATEGORIES = [
  {
    id: 'personal',
    label: 'Personal',
    icon: User,
    color: 'text-info!',
    bg: 'bg-info/10!',
    border: 'border-asset-private-border!',
    gradient: 'from-info! to-info/60!',
  },
  {
    id: 'exchange',
    label: 'Exchange',
    icon: Building2,
    color: 'text-positive!',
    bg: 'bg-positive/10!',
    border: 'border-asset-public-border!',
    gradient: 'from-positive! to-positive/60!',
  },
  {
    id: 'dapp',
    label: 'DApp',
    icon: Globe,
    color: 'text-asset-private-light!',
    bg: 'bg-asset-private-bg!',
    border: 'border-asset-private-border!',
    gradient: 'from-asset-private! to-asset-private/60!',
  },
  {
    id: 'other',
    label: 'Other',
    icon: Tag,
    color: 'text-content-secondary!',
    bg: 'bg-content-muted/10!',
    border: 'border-content-muted/20!',
    gradient: 'from-content-muted! to-content-muted/60!',
  },
];

const AddressBookScreen = () => {
  const { t } = useTranslation();
  const { showMessage, networkId } = useWallet();
  const { confirm, dialogState, handleConfirm, handleCancel } = useConfirm();
  const { copy, isCopied } = useCopied();

  const [contacts, setContacts] = useState([]);
  const saving = useRef(false);
  const [myWallets, setMyWallets] = useState<Array<{ id: string; name: string; address: string }>>(
    []
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState('add');
  const [editingContact, setEditingContact] = useState(null);

  const [formData, setFormData] = useState({
    name: '',
    address: '',
    memo: '',
    category: 'other',
    isFavorite: false,
  });
  const [formErrors, setFormErrors] = useState<{ name?: string; address?: string; memo?: string }>(
    {}
  );

  useMountEffect(() => {
    loadContacts();
  });

  const loadContacts = async () => {
    try {
      setLoading(true);
      await addressBookService.initialize();
      const allContacts = await addressBookService.getAllContacts();
      setContacts(allContacts);
      try {
        const wallets = await walletStorage.loadAllWallets();
        setMyWallets(
          wallets.map((w) => ({
            id: w.id,
            name: w.name || `Wallet (${w.address.slice(0, 8)}…)`,
            address: w.address,
          }))
        );
      } catch {}
    } catch (error) {
      logger.error('Failed to load contacts:', error);
      showMessage(t('toast.contactsLoadFailed'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const sortContacts = (
    contactList: Array<{
      id: string;
      name: string;
      address: string;
      isFavorite: boolean;
      category: string;
      memo?: string;
    }>
  ) => {
    return [...contactList].sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return a.name.localeCompare(b.name);
    });
  };

  const filteredContacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? contacts.filter(
          (c: { name: string; address: string; memo?: string }) =>
            c.name.toLowerCase().includes(q) ||
            c.address.toLowerCase().includes(q) ||
            (c.memo && c.memo.toLowerCase().includes(q))
        )
      : contacts;
    return sortContacts(filtered);
  }, [searchQuery, contacts]);

  const filteredWallets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? myWallets.filter(
          (w) => w.name.toLowerCase().includes(q) || w.address.toLowerCase().includes(q)
        )
      : myWallets;
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [searchQuery, myWallets]);

  const handleOpenAddModal = () => {
    setModalMode('add');
    setEditingContact(null);
    setFormData({ name: '', address: '', memo: '', category: 'personal', isFavorite: false });
    setFormErrors({});
    setShowModal(true);
  };

  const handleOpenEditModal = (contact: {
    id: string;
    name: string;
    address: string;
    memo?: string;
    category: string;
    isFavorite: boolean;
  }) => {
    setModalMode('edit');
    setEditingContact(contact);
    setFormData({
      name: contact.name,
      address: contact.address,
      memo: contact.memo || '',
      category: contact.category,
      isFavorite: contact.isFavorite,
    });
    setFormErrors({});
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingContact(null);
    setFormData({ name: '', address: '', memo: '', category: 'personal', isFavorite: false });
    setFormErrors({});
  };

  const validateForm = () => {
    const errors: { name?: string; address?: string; memo?: string } = {};
    if (!formData.name.trim()) errors.name = t('addressBook.nameRequired');
    else if (formData.name.trim().length > 50) errors.name = t('addressBook.nameMaxLength');
    if (!formData.address) errors.address = t('addressBook.addressRequired');
    else if (!isOctAddress(formData.address) && !isEvmAddress(formData.address))
      errors.address = t('addressBook.invalidAnyAddress', {
        defaultValue: 'Enter an Octra or 0x address',
      });
    if (formData.memo && formData.memo.length > 200) errors.memo = t('addressBook.memoMaxLength');
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async () => {
    if (saving.current || !validateForm()) return;
    saving.current = true;
    const data = { ...formData, name: formData.name.trim(), memo: formData.memo.trim() };
    try {
      if (modalMode === 'add') {
        await addressBookService.addContact(data);
      } else {
        await addressBookService.updateContact(editingContact.id, data);
      }
      handleCloseModal();
      await loadContacts();
    } catch (error) {
      logger.error('Error saving contact:', error);
      const dup = /already exists as "(.*)"/.exec(error instanceof Error ? error.message : '');
      if (dup) setFormErrors({ address: t('toast.contactDuplicate', { name: dup[1] }) });
      else showMessage(t('toast.contactSaveFailed'), 'error');
    } finally {
      saving.current = false;
    }
  };

  const handleDelete = async (contact: { id: string; name: string }) => {
    const confirmed = await confirm({
      title: t('addressBook.deleteContact'),
      message: t('addressBook.deleteConfirm', { name: contact.name }),
      type: 'danger',
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
    });

    if (!confirmed) return;

    try {
      await addressBookService.deleteContact(contact.id);
      await loadContacts();
    } catch (_error) {
      showMessage(t('toast.contactDeleteFailed'), 'error');
    }
  };

  const handleToggleFavorite = async (contact: { id: string }) => {
    try {
      await addressBookService.toggleFavorite(contact.id);
      await loadContacts();
    } catch (_error) {
      showMessage(t('toast.contactFavoriteFailed'), 'error');
    }
  };

  const handleCopyAddress = async (key: string, address: string) => {
    if (!(await copy(address, key))) showMessage(t('toast.copyFailed'), 'error');
  };

  const handleExport = async () => {
    try {
      const jsonData = await addressBookService.exportContacts();
      const blob = new Blob([jsonData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `0xio-contacts-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      logger.error('Contact export failed:', error);
      showMessage(t('toast.contactsExportFailed'), 'error');
    }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      try {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const text = await file.text();
        await addressBookService.importContacts(text, true);
        await loadContacts();
      } catch (error) {
        showMessage(plainError(error, t('toast.contactsImportFailed')), 'error');
      }
    };
    input.click();
  };

  const contactRow = (c: {
    key: string;
    name: string;
    address: string;
    memo?: string;
    favorite?: boolean;
    actions?: React.ReactNode;
  }) => (
    <ListRow
      key={c.key}
      leading={<WalletAvatar address={c.address} size={32} />}
      label={
        <span className="flex! items-center!" style={{ gap: '6px' }}>
          <span className="truncate!">{c.name}</span>
          {c.favorite && (
            <Star size={11} filled style={{ color: 'var(--accent)', flexShrink: 0 }} />
          )}
        </span>
      }
      sub={
        <Facts>
          <NamedAddress address={c.address} networkId={networkId}>
            <button
              onClick={() => handleCopyAddress(c.key, c.address)}
              className="hover:text-(--fg)! transition-colors!"
              title={t('common.copyAddress')}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontSize: '11px',
                color: 'var(--fg-3)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {isCopied(c.key)
                ? t('toast.copied')
                : `${c.address.slice(0, 10)}…${c.address.slice(-8)}`}
            </button>
          </NamedAddress>
          {c.memo && <span className="truncate!">{c.memo}</span>}
        </Facts>
      }
      right={c.actions}
      chevron={false}
    />
  );

  return (
    <div className="h-full! overflow-hidden! flex! flex-col! bg-(--bg)! text-(--fg)!">
      <ConfirmDialog
        isOpen={dialogState.isOpen}
        title={dialogState.title}
        message={dialogState.message}
        type={dialogState.type as 'warning' | 'danger' | 'info'}
        confirmText={dialogState.confirmText}
        cancelText={dialogState.cancelText}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />

      <Header
        title={t('addressBook.title')}
        showBack
        showSettings={false}
        rightAction={
          <IconButton
            onClick={handleOpenAddModal}
            title={t('addressBook.addContact')}
            aria-label={t('addressBook.addContact')}
          >
            <Plus size={16} />
          </IconButton>
        }
      />

      <div className="flex-1! flex! flex-col! min-h-0!" style={{ padding: '4px var(--gutter) 0' }}>
        <input
          type="text"
          placeholder={t('addressBook.search')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className={quietField}
        />
        <div
          className="shrink-0! flex! items-center! justify-between!"
          style={{ padding: '10px 4px 6px' }}
        >
          <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
            {contacts.length} {t('addressBook.saved').toLowerCase()}
          </span>
          <span className="flex! items-center!" style={{ gap: '14px' }}>
            <TextButton muted onClick={handleImport}>
              {t('addressBook.import')}
            </TextButton>
            <TextButton muted onClick={handleExport}>
              {t('addressBook.export')}
            </TextButton>
          </span>
        </div>

        <div
          className="flex-1! overflow-y-auto! scrollbar-hide! min-h-0!"
          style={{ paddingBottom: '24px' }}
        >
          {loading ? (
            <div className="flex! items-center! justify-center!" style={{ height: '128px' }}>
              <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                {t('addressBook.loadingContacts')}
              </span>
            </div>
          ) : (
            <>
              {filteredWallets.length > 0 && (
                <>
                  <SectionLabel first>
                    {t('addressBook.myWallets', { defaultValue: 'My wallets' })}
                  </SectionLabel>
                  <RuledList>
                    {filteredWallets.map((wallet) =>
                      contactRow({
                        key: `wallet_${wallet.id}`,
                        name: wallet.name,
                        address: wallet.address,
                      })
                    )}
                  </RuledList>
                </>
              )}

              {filteredContacts.length === 0 ? (
                <div
                  className="flex! flex-col! items-center! text-center!"
                  style={{ gap: '4px', padding: '28px 0' }}
                >
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
                    {t('addressBook.noContacts')}
                  </span>
                  {!searchQuery && (
                    <TextButton onClick={handleOpenAddModal} style={{ marginTop: '8px' }}>
                      {t('addressBook.addContact')}
                    </TextButton>
                  )}
                </div>
              ) : (
                <>
                  <SectionLabel first={filteredWallets.length === 0}>
                    {t('addressBook.contactList')}
                  </SectionLabel>
                  <RuledList>
                    {filteredContacts.map((contact) =>
                      contactRow({
                        key: contact.id,
                        name: contact.name,
                        address: contact.address,
                        memo: contact.memo,
                        favorite: contact.isFavorite,
                        actions: (
                          <span className="flex! items-center!" style={{ gap: '2px' }}>
                            <IconButton
                              size="sm"
                              onClick={() => handleToggleFavorite(contact)}
                              aria-label="Toggle favorite"
                              className={contact.isFavorite ? 'text-accent!' : ''}
                            >
                              <Star size={14} filled={contact.isFavorite} />
                            </IconButton>
                            <IconButton
                              size="sm"
                              onClick={() => handleOpenEditModal(contact)}
                              aria-label="Edit contact"
                            >
                              <Edit2 size={14} />
                            </IconButton>
                            <IconButton
                              size="sm"
                              onClick={() => handleDelete(contact)}
                              aria-label="Delete contact"
                              className="hover:text-(--neg)!"
                            >
                              <Trash2 size={14} />
                            </IconButton>
                          </span>
                        ),
                      })
                    )}
                  </RuledList>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <Sheet
        open={showModal}
        onSubmit={handleSubmit}
        onClose={handleCloseModal}
        title={modalMode === 'add' ? t('addressBook.addContact') : t('addressBook.editContact')}
        closeLabel={t('common.close')}
        footer={
          <PrimaryButton onClick={handleSubmit}>
            {modalMode === 'add' ? t('addressBook.saveContact') : t('addressBook.update')}
          </PrimaryButton>
        }
      >
        <div className="flex! flex-col!" style={{ gap: '14px' }}>
          <div>
            <div style={{ marginBottom: '6px' }}>
              <FieldLabel>{t('addressBook.category')}</FieldLabel>
            </div>
            <CellChoice
              columns={2}
              value={formData.category}
              onChange={(id) => setFormData({ ...formData, category: id })}
              options={CATEGORIES.map((cat) => ({ id: cat.id, label: t(`addressBook.${cat.id}`) }))}
            />
          </div>
          <QuietInput
            label={t('addressBook.name')}
            type="text"
            value={formData.name}
            maxLength={50}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder={t('addressBook.contactName')}
            error={formErrors.name ?? ''}
          />
          <QuietInput
            label={t('addressBook.address')}
            type="text"
            value={formData.address}
            maxLength={OCT_ADDRESS_LENGTH}
            onChange={(e) =>
              setFormData({
                ...formData,
                address: normalizeAddress(e.target.value).slice(0, OCT_ADDRESS_LENGTH),
              })
            }
            placeholder="oct... or 0x..."
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            error={formErrors.address ?? ''}
          />
          <QuietTextarea
            label={t('addressBook.memo')}
            value={formData.memo}
            maxLength={200}
            onChange={(e) => setFormData({ ...formData, memo: e.target.value })}
            placeholder={t('addressBook.addNote')}
            rows={2}
            error={formErrors.memo ?? ''}
          />
        </div>
      </Sheet>
    </div>
  );
};

export default AddressBookScreen;
