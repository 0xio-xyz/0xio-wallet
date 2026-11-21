import { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { cryptoManager } from 'src/services/crypto/CryptoManager';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import {
  FieldLabel,
  PrimaryButton,
  QuietInput,
  QuietSelect,
  TextButton,
} from 'src/shared/ui/primitives';
import { StepLayout, StatusLine } from './StepParts';
import { shortAddress } from './format';
import { WALLET_NAME_MAX } from 'src/services/wallet/WalletStorage';

const MAX_ACCOUNT_NUMBER = 1000;

export interface ParentWallet {
  id: string;
  name: string;
  address: string;
}

export interface DerivedAccount {
  index: number;
  address: string;
  privateKey: string;
  publicKey: string | null;
}

const SEARCH_LIMIT = 30;

/** Account 1 is the parent itself, so account n is derivation index n - 1. */
export const AccountStep = ({
  parents,
  initialParentId,
  existing,
  loadMnemonic,
  name,
  onName,
  busy,
  onNext,
}: {
  parents: ParentWallet[];
  initialParentId: string;
  existing: string[];
  loadMnemonic: (walletId: string) => Promise<string | null>;
  name: string;
  onName: (v: string, touched: boolean) => void;
  busy: boolean;
  onNext: (account: DerivedAccount, parent: ParentWallet) => void;
}) => {
  const { t } = useTranslation();
  const [parentId, setParentId] = useState(initialParentId);
  const [account, setAccount] = useState<DerivedAccount | null>(null);
  const [custom, setCustom] = useState(false);
  const [number, setNumber] = useState('');
  const [working, setWorking] = useState(true);
  const [problem, setProblem] = useState('');
  const mnemonic = useRef<{ id: string; phrase: string } | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parent = parents.find((p) => p.id === parentId) ?? parents[0];

  const phraseFor = async (id: string) => {
    if (mnemonic.current?.id === id) return mnemonic.current.phrase;
    const phrase = await loadMnemonic(id);
    if (!phrase) throw new Error('no phrase');
    mnemonic.current = { id, phrase };
    return phrase;
  };

  const derive = async (phrase: string, index: number): Promise<DerivedAccount> => {
    const d: any = await cryptoManager.deriveAccountAtIndex(phrase, index);
    return { index, address: d.address, privateKey: d.privateKey, publicKey: d.publicKey ?? null };
  };

  const findNext = async (p: ParentWallet) => {
    const run = ++seq.current;
    setWorking(true);
    setProblem('');
    setAccount(null);
    try {
      const phrase = await phraseFor(p.id);
      for (let i = 1; i <= SEARCH_LIMIT; i++) {
        const a = await derive(phrase, i);
        if (run !== seq.current) return;
        if (cryptoManager.verifyAddressFormat(a.address) && !existing.includes(a.address)) {
          setAccount(a);
          setNumber(String(i + 1));
          onName(`${p.name} ${i + 1}`, false);
          return;
        }
      }
      setProblem(
        t('addWallet.noFreeAccount', {
          defaultValue: 'No unused account number nearby. Enter one.',
        })
      );
      setCustom(true);
    } catch {
      if (run === seq.current)
        setProblem(
          t('addWallet.phraseUnavailable', {
            defaultValue: 'This wallet has no recovery phrase',
          })
        );
    } finally {
      if (run === seq.current) setWorking(false);
    }
  };

  useMountEffect(() => {
    if (parent) void findNext(parent);
    return () => {
      seq.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  });

  const onParent = (id: string) => {
    setParentId(id);
    setCustom(false);
    const p = parents.find((x) => x.id === id);
    if (p) void findNext(p);
  };

  const onNumber = (input: string) => {
    const value = input
      .replace(/\D/g, '')
      .replace(/^0+(?=\d)/, '')
      .slice(0, 4);
    setNumber(value);
    setAccount(null);
    setProblem('');
    const run = ++seq.current;
    if (timer.current) clearTimeout(timer.current);
    const n = Number(value);
    if (!value || n < 2) {
      if (value)
        setProblem(
          t('addWallet.accountFloor', {
            defaultValue: 'Account 1 is this wallet. Enter 2 or higher.',
          })
        );
      return;
    }
    if (n > MAX_ACCOUNT_NUMBER) {
      setProblem(t('addWallet.accountCeiling', { defaultValue: 'Enter 1000 or lower.' }));
      return;
    }
    setWorking(true);
    timer.current = setTimeout(async () => {
      try {
        const a = await derive(await phraseFor(parent.id), n - 1);
        if (run !== seq.current) return;
        if (!cryptoManager.verifyAddressFormat(a.address)) {
          setProblem(
            t('addWallet.accountShort', {
              defaultValue:
                'This account number derives an address the network rejects. Enter another.',
            })
          );
          return;
        }
        setAccount(a);
        onName(`${parent.name} ${n}`, false);
      } catch {
        if (run === seq.current)
          setProblem(
            t('addWallet.deriveFailed', { defaultValue: 'Could not derive this account' })
          );
      } finally {
        if (run === seq.current) setWorking(false);
      }
    }, 300);
  };

  const duplicate = !!account && existing.includes(account.address);
  const ready = !!account && !duplicate && !working && name.trim().length > 0;
  const next = () => account && parent && ready && !busy && onNext(account, parent);

  return (
    <StepLayout
      onSubmit={next}
      footer={
        <PrimaryButton onClick={next} disabled={!ready} loading={busy}>
          {t('addWallet.addAccountCta', { defaultValue: 'Add account' })}
        </PrimaryButton>
      }
    >
      {parents.length > 1 ? (
        <QuietSelect
          label={t('addWallet.from', { defaultValue: 'From' })}
          value={parentId}
          onChange={onParent}
        >
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </QuietSelect>
      ) : (
        parent && (
          <div>
            <div style={{ marginBottom: '6px' }}>
              <FieldLabel>{t('addWallet.from', { defaultValue: 'From' })}</FieldLabel>
            </div>
            <div
              className="flex! items-center! rounded-xl! bg-(--bg-1)!"
              style={{ gap: '12px', padding: '12px' }}
            >
              <WalletAvatar address={parent.address} size={32} />
              <span className="flex! min-w-0! flex-col!" style={{ gap: '3px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
                  {parent.name}
                </span>
                <span
                  style={{
                    fontSize: '11.5px',
                    color: 'var(--fg-3)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {shortAddress(parent.address)}
                </span>
              </span>
            </div>
          </div>
        )
      )}

      <div
        className="flex! flex-col! rounded-xl!"
        style={{ gap: '6px', padding: '14px', minHeight: '64px', boxSizing: 'border-box' }}
      >
        <span className="flex! items-baseline! justify-between!">
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
            {t('addWallet.accountN', { defaultValue: 'Account {{n}}', n: number || '...' })}
          </span>
          {!custom && account && (
            <span style={{ fontSize: '11.5px', color: 'var(--fg-3)' }}>
              {t('addWallet.nextFree', { defaultValue: 'next unused' })}
            </span>
          )}
        </span>
        <span
          style={{
            fontSize: '12px',
            color: account ? 'var(--fg-2)' : 'var(--fg-3)',
            fontFamily: 'var(--font-mono)',
            wordBreak: 'break-all',
          }}
        >
          {account
            ? account.address
            : working
              ? t('addWallet.working', { defaultValue: 'Deriving' })
              : ''}
        </span>
      </div>

      {custom ? (
        <QuietInput
          label={t('addWallet.accountNumber', { defaultValue: 'Account number' })}
          type="text"
          inputMode="numeric"
          maxLength={4}
          value={number}
          onChange={(e) => onNumber(e.target.value)}
          note={
            duplicate ? t('addWallet.alreadyAdded', { defaultValue: 'Already added' }) : problem
          }
          noteTone={duplicate || problem ? 'neg' : 'muted'}
        />
      ) : (
        <>
          {problem && <StatusLine tone="neg">{problem}</StatusLine>}
          <TextButton
            muted
            size={12}
            onClick={() => setCustom(true)}
            style={{
              alignSelf: 'flex-start',
              textDecoration: 'underline',
              textUnderlineOffset: '3px',
            }}
          >
            {t('addWallet.otherNumber', { defaultValue: 'Use another account number' })}
          </TextButton>
        </>
      )}

      <QuietInput
        label={t('addWallet.nameLabel', { defaultValue: 'Wallet name' })}
        value={name}
        maxLength={WALLET_NAME_MAX}
        onChange={(e) => onName(e.target.value, true)}
      />
    </StepLayout>
  );
};
