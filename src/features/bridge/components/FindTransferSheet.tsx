import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import {
  FieldNote,
  ListRow,
  PrimaryButton,
  RuledList,
  Sheet,
  TextButton,
  quietField,
} from 'src/shared/ui/primitives';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import { useWallet } from 'src/contexts/WalletContext';
import type { BridgeFlow } from 'src/features/bridge/useBridgeFlow';

const FindTransferSheet = ({
  flow,
  open,
  onClose,
}: {
  flow: BridgeFlow;
  open: boolean;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const { showMessage } = useWallet();
  const [step, setStep] = useState<'menu' | 'hash'>('menu');
  const [hashInput, setHashInput] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scanFailed = () =>
    showMessage(
      t('bridge.scanFailed', { defaultValue: 'Could not reach the networks. Try again later.' }),
      'error'
    );

  const close = () => {
    if (busy || flow.scanning) return;
    setStep('menu');
    setHashInput('');
    setNote(null);
    onClose();
  };

  const find = () => {
    setNote(null);
    void flow
      .recover()
      .then((n) => {
        if (n > 0) close();
        else setNote(t('bridge.noneFound', { defaultValue: 'No other transfers found.' }));
      })
      .catch(scanFailed);
  };

  const addHash = () => {
    if (!hashInput.trim() || busy) return;
    setBusy(true);
    setNote(null);
    void flow
      .addByHash(hashInput)
      .then((ok) => {
        setBusy(false);
        if (ok) close();
        else
          setNote(
            t('bridge.hashNotFound', {
              defaultValue: 'No bridge transfer found for this hash.',
            })
          );
      })
      .catch(() => {
        setBusy(false);
        scanFailed();
      });
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      dismissible={!busy && !flow.scanning}
      title={
        step === 'hash'
          ? t('bridge.byHashTitle', { defaultValue: 'Add a transfer' })
          : t('bridge.findTitle', { defaultValue: 'Find a transfer' })
      }
      action={
        step === 'hash' ? (
          <TextButton
            size={12}
            muted
            disabled={busy}
            onClick={() => {
              setStep('menu');
              setNote(null);
            }}
          >
            {t('common.back', { defaultValue: 'Back' })}
          </TextButton>
        ) : undefined
      }
      onSubmit={step === 'hash' ? addHash : undefined}
      footer={
        step === 'hash' ? (
          <PrimaryButton
            loading={busy}
            disabled={!hashInput.trim()}
            style={BIG_BUTTON}
            onClick={addHash}
          >
            {t('bridge.add', { defaultValue: 'Add' })}
          </PrimaryButton>
        ) : undefined
      }
    >
      {step === 'menu' ? (
        <RuledList>
          <ListRow
            label={
              flow.scanning
                ? t('bridge.scanning', { defaultValue: 'Searching' })
                : t('bridge.findMine', { defaultValue: 'Find my transfers' })
            }
            onClick={flow.scanning ? undefined : find}
            chevron={!flow.scanning}
          />
          <ListRow
            label={t('bridge.byHash', { defaultValue: 'Add by hash' })}
            onClick={
              flow.scanning
                ? undefined
                : () => {
                    setNote(null);
                    setStep('hash');
                  }
            }
            chevron={!flow.scanning}
          />
        </RuledList>
      ) : (
        <input
          value={hashInput}
          onChange={(e) => setHashInput(e.target.value.replace(/\s+/g, '').slice(0, 66))}
          placeholder={t('bridge.hashPlaceholder', { defaultValue: 'Transaction hash' })}
          aria-label={t('bridge.hashPlaceholder', { defaultValue: 'Transaction hash' })}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          className={quietField}
          style={{
            height: '46px',
            borderRadius: '16px',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
          }}
        />
      )}
      <div style={{ padding: '0 4px' }}>
        <FieldNote tone={step === 'hash' ? 'neg' : 'muted'}>{note ?? ''}</FieldNote>
      </div>
    </Sheet>
  );
};

export default FindTransferSheet;
