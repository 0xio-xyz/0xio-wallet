import { useTranslation } from 'src/i18n/react';
import { RuledList, ListRow } from 'src/shared/ui/primitives';

const CreateImportScreen = ({
  onCreate,
  onImport,
  onDerive,
}: {
  onCreate: () => void;
  onImport: () => void;
  onDerive?: () => void;
  onCancel?: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <div style={{ padding: '4px var(--gutter) 24px' }}>
      <RuledList>
        <ListRow
          label={t('addWallet.createTitle', { defaultValue: 'Create wallet' })}
          onClick={onCreate}
        />
        {onDerive && (
          <ListRow
            label={t('addWallet.addAccount', { defaultValue: 'Add account' })}
            onClick={onDerive}
          />
        )}
        <ListRow
          label={t('addWallet.importWallet', { defaultValue: 'Import wallet' })}
          onClick={onImport}
        />
      </RuledList>
    </div>
  );
};

export default CreateImportScreen;
