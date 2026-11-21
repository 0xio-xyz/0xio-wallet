import { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { cryptoManager } from 'src/services/crypto/CryptoManager';
import { networkService } from 'src/services/network/NetworkService';
import { isOctAddress } from 'src/utils/octra/address';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { PrimaryButton } from 'src/shared/ui/primitives';
import { detectSecret, replaceWord, type Detection } from './readSecret';
import { FlowLayout, FlowCopy, BIG_BUTTON } from './StepParts';
import { middleCut } from './format';

const SECRET_INPUT_MAX = 1024;

export interface ImportedKeys {
  kind: 'phrase' | 'key';
  address: string;
  privateKey: string;
  publicKey: string | null;
  mnemonic: string[] | null;
  isPadded: boolean;
  addressWarning?: string;
}

export type FoundWallet = ImportedKeys | { kind: 'address'; address: string };

const checks = {
  isWord: (w: string) => cryptoManager.isMnemonicWord(w),
  isAddress: (s: string) => isOctAddress(s),
  wordlist: cryptoManager.mnemonicWordlist(),
};

const formatOct = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 });

const chip = {
  height: '28px',
  padding: '0 12px',
  borderRadius: '999px',
  border: 'none',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  alignSelf: 'flex-start',
  flexShrink: 0,
} as const;

export const ImportStep = ({
  existing,
  initialText = '',
  onText,
  busy,
  onNext,
}: {
  existing: string[];
  initialText?: string;
  onText?: (text: string) => void;
  busy: boolean;
  onNext: (found: FoundWallet) => void;
}) => {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const [detection, setDetection] = useState<Detection>({ kind: 'empty' });
  const [failed, setFailed] = useState(false);
  const [found, setFound] = useState<FoundWallet | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useMountEffect(() => {
    if (initialText) read(initialText);
    return () => {
      seq.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  });

  const readBalance = (address: string, run: number) =>
    networkService
      .getBalance(address)
      .then((r) => {
        if (run === seq.current && r.success && r.balance !== null) setBalance(r.balance);
      })
      .catch(() => {});

  const resolve = async (d: Detection, run: number) => {
    try {
      let keys: FoundWallet;
      if (d.kind === 'phrase') {
        const c: any = await cryptoManager.recoverFromMnemonic(d.words.join(' '));
        keys = {
          kind: 'phrase',
          address: c.address,
          privateKey: c.privateKey,
          publicKey: c.publicKey ?? null,
          mnemonic: Array.isArray(c.mnemonic) ? c.mnemonic : d.words,
          isPadded: !!c.isPadded,
          addressWarning: c.addressWarning,
        };
      } else if (d.kind === 'key') {
        const k: any = await cryptoManager.importWallet(d.key);
        keys = {
          kind: 'key',
          address: k.address,
          privateKey: k.privateKey || k.private_key_b64 || d.key,
          publicKey: k.publicKey || k.public_key_b64 || null,
          mnemonic: null,
          isPadded: !!k.isPadded,
          addressWarning: k.addressWarning,
        };
      } else if (d.kind === 'address') {
        keys = { kind: 'address', address: d.address };
      } else {
        return;
      }
      if (run !== seq.current) return;
      setFound(keys);
      void readBalance(keys.address, run);
    } catch {
      if (run === seq.current) setFailed(true);
    }
  };

  const read = (input: string) => {
    const value = input.slice(0, SECRET_INPUT_MAX);
    setText(value);
    onText?.(value);
    const d = detectSecret(value, checks);
    const run = ++seq.current;
    if (timer.current) clearTimeout(timer.current);
    setDetection(d);
    setFound(null);
    setFailed(false);
    setBalance(null);
    if (d.kind === 'phrase' || d.kind === 'key' || d.kind === 'address')
      timer.current = setTimeout(() => void resolve(d, run), d.kind === 'address' ? 0 : 350);
  };

  const paste = () =>
    navigator.clipboard
      .readText()
      .then((v) => read(v.trim()))
      .catch(() => {});

  const duplicate = !!found && existing.includes(found.address);
  const ready = !!found && !duplicate;
  const next = () => found && ready && !busy && onNext(found);

  let note = '';
  let negative = false;
  if (detection.kind === 'typing' && detection.count > 1)
    note = t('addWallet.detectCount', {
      defaultValue: '{{n}} of {{target}} words.',
      n: detection.count,
      target: detection.target,
    });
  else if (detection.kind === 'tooMany') {
    negative = true;
    note = t('addWallet.detectTooMany', {
      defaultValue: '{{n}} words. A recovery phrase has 12 or 24.',
      n: detection.count,
    });
  } else if (detection.kind === 'badWord')
    note = t('addWallet.detectBadWord', {
      defaultValue: '“{{word}}” is not a recovery word.',
      word: detection.word,
    });
  else if (detection.kind === 'phrase') {
    negative = failed;
    note = failed
      ? t('addWallet.phraseInvalid', {
          defaultValue: 'Invalid recovery phrase. Check the words and their order.',
        })
      : t('addWallet.detectWords', {
          defaultValue: '{{n}} words.',
          n: detection.words.length,
        });
  } else if (detection.kind === 'key') {
    negative = failed;
    note = failed
      ? t('addWallet.keyInvalid', { defaultValue: 'Invalid private key' })
      : t('addWallet.detectKey', { defaultValue: 'Private key.' });
  } else if (detection.kind === 'address')
    note = t('addWallet.detectAddress', {
      defaultValue: 'Address. Adds it as a watch-only wallet.',
    });
  else if (detection.kind === 'evmKey') {
    negative = true;
    note = t('addWallet.detectEvmKey', {
      defaultValue:
        'EVM private keys cannot be imported yet. 0xio derives your 0x address from a recovery phrase.',
    });
  } else if (detection.kind === 'evmAddress') {
    negative = true;
    note = t('addWallet.detectEvmAddress', {
      defaultValue: 'This is a 0x address. Watch-only wallets support Octra addresses only.',
    });
  }

  const kindLabel =
    found?.kind === 'address'
      ? t('addWallet.kindViewOnly', { defaultValue: 'Watch-only' })
      : found?.kind === 'key'
        ? t('addWallet.kindKey', { defaultValue: 'Private key' })
        : t('addWallet.kindPhrase', { defaultValue: 'Recovery phrase' });

  return (
    <FlowLayout
      footer={
        <PrimaryButton onClick={next} disabled={!ready} loading={busy} style={BIG_BUTTON}>
          {t('common.continue', { defaultValue: 'Continue' })}
        </PrimaryButton>
      }
    >
      <FlowCopy title={t('addWallet.addTitle', { defaultValue: 'Add your wallet' })} />

      <div
        className="flex! flex-col! rounded-xl! border! border-transparent! bg-(--bg-1)! focus-within:border-(--fg-3)!"
        style={{ padding: '12px 14px', gap: '8px' }}
      >
        <textarea
          value={text}
          maxLength={SECRET_INPUT_MAX}
          onChange={(e) => read(e.target.value)}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={t('addWallet.fieldLabel', { defaultValue: 'Phrase, key or address' })}
          placeholder={t('addWallet.fieldPlaceholder', {
            defaultValue: '12 words, a private key or an oct address',
          })}
          className="w-full! outline-none!"
          style={{
            height: '92px',
            padding: 0,
            border: 'none',
            background: 'transparent',
            resize: 'none',
            fontFamily: 'var(--font-mono)',
            fontSize: '12.5px',
            lineHeight: 1.6,
            color: 'var(--fg)',
          }}
        />
        <button
          type="button"
          onClick={paste}
          className="press bg-(--bg-2)! hover:bg-(--line-2)!"
          style={{ ...chip, color: 'var(--fg)' }}
        >
          {t('addWallet.paste', { defaultValue: 'Paste' })}
        </button>
      </div>

      <p
        aria-live="polite"
        style={{
          margin: '8px 0 0',
          minHeight: '34px',
          fontSize: '12px',
          lineHeight: 1.4,
          color: negative ? 'var(--neg)' : 'var(--fg-2)',
        }}
      >
        {note}
      </p>

      {detection.kind === 'badWord' && detection.suggestion && (
        <button
          type="button"
          onClick={() => read(replaceWord(text, detection.index, detection.suggestion as string))}
          className="press"
          style={{
            ...chip,
            marginTop: '10px',
            background: 'color-mix(in oklab, var(--accent) 16%, transparent)',
            color: 'var(--accent)',
          }}
        >
          {t('addWallet.useWord', {
            defaultValue: 'Use “{{word}}”',
            word: detection.suggestion,
          })}
        </button>
      )}

      {found && (
        <div
          className="animate-in! fade-in! slide-in-from-bottom-1! flex! items-center! rounded-xl! bg-(--bg-1)! duration-200!"
          style={{ gap: '12px', padding: '14px', marginTop: '10px' }}
        >
          <WalletAvatar address={found.address} size={36} />
          <span className="flex! min-w-0! flex-1! flex-col!" style={{ gap: '3px' }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                color: 'var(--fg)',
                whiteSpace: 'nowrap',
              }}
            >
              {middleCut(found.address, 10, 6)}
            </span>
            <span style={{ fontSize: '12px', color: duplicate ? 'var(--neg)' : 'var(--fg-3)' }}>
              {duplicate
                ? t('addWallet.alreadyAdded', { defaultValue: 'Already added' })
                : kindLabel}
            </span>
          </span>
          {balance !== null && !duplicate && (
            <span
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--fg)',
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatOct(balance)}{' '}
              <span style={{ color: 'var(--fg-3)', fontWeight: 500 }}>OCT</span>
            </span>
          )}
        </div>
      )}
    </FlowLayout>
  );
};
