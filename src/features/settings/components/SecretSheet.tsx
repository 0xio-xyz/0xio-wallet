import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import useCopied from 'src/hooks/ui/useCopied';
import { PrimaryButton, Sheet, TextButton, TextTab } from 'src/shared/ui/primitives';
import { logger } from 'src/utils/logger';
import { qrDataUrl as makeQrUrl } from 'src/lib/qr';

const QR_SIZE = 150;
// Until Reveal, only a decoy sits under the blur, never the secret: nothing readable, and no QR of
// it, exists on the page before the user asks. Same rule as the mobile app.
const DECOY_QR = 'octra-hidden-credential';

const qrDataUrl = (text: string) => makeQrUrl(text, { level: 'M', margin: 1, width: QR_SIZE * 2 });

const SecretSheet = ({
  kind,
  value: octraValue,
  evmValue,
  words,
  onClose,
  onCopy,
  onBackedUp,
}: {
  kind: 'privateKey' | 'mnemonic';
  value: string;
  evmValue?: string | null;
  words: string[];
  onClose: () => void;
  onCopy: (which: 'octra' | 'evm') => Promise<boolean> | boolean | void;
  onBackedUp?: () => void;
}) => {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const [asQr, setAsQr] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [decoyQr] = useState(() => qrDataUrl(DECOY_QR));
  const [chain, setChain] = useState<'octra' | 'evm'>('octra');
  const value = chain === 'evm' && evmValue ? evmValue : octraValue;
  const { isCopied, flash } = useCopied();
  const copyLabel = isCopied()
    ? t('toast.copied')
    : kind === 'mnemonic'
      ? t('security.copyPhrase')
      : t('security.copyKeyAction');
  const copyNow = async () => {
    if ((await onCopy(chain)) !== false) flash();
  };

  useMountEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const makeQr = async (text = value) => {
    try {
      setQr(qrDataUrl(text));
    } catch (e) {
      logger.error('[SecretSheet] QR generation failed', e);
    }
  };

  const reveal = () => {
    setShown(true);
    if (asQr) void makeQr();
  };

  const toggleQr = () => {
    if (!asQr && shown) void makeQr();
    setAsQr(!asQr);
  };

  const pickChain = (next: 'octra' | 'evm') => {
    if (next === chain) return;
    setChain(next);
    setQr(null);
    if (asQr && shown) void makeQr(next === 'evm' && evmValue ? evmValue : octraValue);
  };

  const isPhrase = kind === 'mnemonic';
  const listed = shown ? words : words.map(() => '•••••');

  const body = asQr ? (
    <div className="flex! flex-col! items-center!" style={{ gap: '10px', padding: '6px 0 4px' }}>
      <div style={{ background: '#ffffff', padding: '10px', borderRadius: '12px', lineHeight: 0 }}>
        {(shown ? qr : decoyQr) ? (
          <img
            src={(shown ? qr : decoyQr) ?? undefined}
            width={QR_SIZE}
            height={QR_SIZE}
            alt=""
            draggable={false}
            style={{ display: 'block' }}
          />
        ) : (
          <span style={{ display: 'block', width: QR_SIZE, height: QR_SIZE }} />
        )}
      </div>
    </div>
  ) : isPhrase ? (
    <div className="grid! grid-cols-2!" style={{ columnGap: '18px', padding: '4px 2px' }}>
      {listed.map((word, i) => (
        <div
          key={i}
          className="flex! items-baseline!"
          style={{ gap: '10px', height: '30px', fontSize: '14px', color: 'var(--fg)' }}
        >
          <span
            style={{
              width: '16px',
              textAlign: 'right',
              fontSize: '11px',
              color: 'var(--fg-3)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {i + 1}
          </span>
          <span className="truncate!">{word}</span>
        </div>
      ))}
    </div>
  ) : (
    <div
      style={{
        padding: '6px 2px',
        fontFamily: 'var(--font-mono)',
        fontSize: '13px',
        lineHeight: 1.7,
        letterSpacing: '0.02em',
        wordBreak: 'break-all',
        color: 'var(--fg)',
      }}
    >
      {shown ? value : '•'.repeat(Math.min(Math.max(value.length, 44), 64))}
    </div>
  );

  return (
    <Sheet
      open
      onClose={onClose}
      title={isPhrase ? t('security.recoveryPhrase') : t('security.privateKey')}
      action={
        <TextButton onClick={toggleQr}>
          {asQr
            ? isPhrase
              ? t('security.showWords')
              : t('security.showKey')
            : t('security.showQrCode')}
        </TextButton>
      }
      footer={
        shown && onBackedUp ? (
          <div className="flex! flex-col! items-center!" style={{ gap: '10px' }}>
            <PrimaryButton onClick={onBackedUp}>
              {t('security.wroteItDown', { defaultValue: 'I have written it down' })}
            </PrimaryButton>
            <TextButton muted size={12} onClick={copyNow}>
              {copyLabel}
            </TextButton>
          </div>
        ) : (
          <PrimaryButton onClick={shown ? copyNow : reveal}>
            {shown ? copyLabel : t('security.reveal')}
          </PrimaryButton>
        )
      }
    >
      {!isPhrase && evmValue && (
        <div className="flex!" style={{ gap: '18px', padding: '0 2px 10px' }}>
          <TextTab active={chain === 'octra'} onClick={() => pickChain('octra')}>
            Octra
          </TextTab>
          <TextTab active={chain === 'evm'} onClick={() => pickChain('evm')}>
            EVM
          </TextTab>
        </div>
      )}
      <div className="flex! flex-col! justify-center!" style={{ minHeight: '230px' }}>
        <div className="relative! overflow-hidden! rounded-xl!">
          <div
            aria-hidden={!shown}
            style={{
              filter: shown ? 'none' : 'blur(6px)',
              userSelect: shown ? 'text' : 'none',
              transition: 'filter 200ms ease',
            }}
          >
            {body}
          </div>
          {!shown && (
            <button
              type="button"
              onClick={reveal}
              className="press absolute! left-1/2! top-1/2! -translate-x-1/2! -translate-y-1/2!"
              style={{
                background: 'var(--bg-2)',
                color: 'var(--fg)',
                border: 'none',
                borderRadius: '999px',
                padding: '7px 14px',
                fontSize: '12px',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
              }}
            >
              {t('security.clickToReveal')}
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
};

export default SecretSheet;
