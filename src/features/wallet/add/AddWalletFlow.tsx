import React, { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { ChevronLeft, X } from 'src/shared/ui/icons';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { cryptoManager } from 'src/services/crypto/CryptoManager';
import { isWebAuthnAvailable } from 'src/services/crypto/PasskeyService';
import { useWallet } from 'src/contexts/WalletContext';
import IconButton from 'src/shared/ui/IconButton';
import { TextButton } from 'src/shared/ui/primitives';
import { ImportStep, type FoundWallet } from './ImportStep';
import { AccountStep, type DerivedAccount, type ParentWallet } from './AccountStep';
import { PasswordStep, PasskeyStep, type Protection } from './ProtectStep';
import { ReadyStep } from './ReadyStep';
import { NetworksStep } from './NetworksStep';
import { deriveEvmAddress, isStandardPhrase } from 'src/services/evm/accounts';
import type { EvmMeta } from 'src/services/evm/walletEvm';
import { stepEnter } from './format';
import { uniqueWalletName } from 'src/utils/walletName';
import { WALLET_NAME_MAX } from 'src/services/wallet/WalletStorage';

export type { Protection } from './ProtectStep';

export type AddMode = 'generate' | 'import' | 'derive';

export interface WalletDraft {
  name: string;
  address: string;
  type: 'standard' | 'watch';
  privateKey: string | null;
  publicKey: string | null;
  mnemonic: string[] | null;
  source: string;
  isPadded?: boolean;
  addressWarning?: string;
  needsBackup?: boolean;
  evm?: EvmMeta;
}

type StepId = 'secret' | 'networks' | 'password' | 'confirm' | 'passkey' | 'account' | 'ready';

const stepsFor = (
  mode: AddMode,
  firstRun: boolean,
  passkey: boolean,
  phrase: boolean
): StepId[] => {
  if (mode === 'derive') return ['account'];
  const protect: StepId[] = firstRun
    ? ['password', 'confirm', ...(passkey ? (['passkey'] as StepId[]) : [])]
    : [];
  const start: StepId[] =
    mode === 'import' ? ['secret', ...(phrase ? (['networks'] as StepId[]) : [])] : ['networks'];
  return [...start, ...protect, 'ready'];
};

interface ListedWallet {
  id?: string;
  name: string;
  address: string;
  type?: string;
  mnemonic?: unknown;
}

const AddWalletFlow = ({
  mode,
  firstRun,
  wallets = [],
  activeAddress,
  loadMnemonic,
  exitIcon = 'back',
  onExit,
  onDone,
  onOpen,
}: {
  mode: AddMode;
  firstRun: boolean;
  wallets?: ListedWallet[];
  activeAddress?: string;
  loadMnemonic?: (walletId: string) => Promise<string | null>;
  exitIcon?: 'back' | 'close';
  onExit: () => void;
  onDone: (draft: WalletDraft, protection?: Protection) => Promise<boolean>;
  onOpen?: () => void;
}) => {
  const { t } = useTranslation();
  const { showMessage } = useWallet();
  const [passkeyOffered] = useState(() => firstRun && isWebAuthnAvailable());
  const [found, setFound] = useState<FoundWallet | null>(null);
  const [evmOn, setEvmOn] = useState(true);
  const steps = stepsFor(mode, firstRun, passkeyOffered, found?.kind === 'phrase');
  const existing = wallets.map((w) => w.address);
  const names = wallets.map((w) => w.name);
  const freeName = (base: string) => uniqueWalletName(base, names, WALLET_NAME_MAX);

  const [at, setAt] = useState(0);
  const [dir, setDir] = useState<'fwd' | 'back' | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [secretText, setSecretText] = useState('');
  const [saved, setSaved] = useState<WalletDraft | null>(null);
  const [accountName, setAccountName] = useState('');
  const accountNameTouched = useRef(false);
  const keypair = useRef<Promise<any> | null>(null);
  const alive = useRef(true);

  const nameFor = (kind: 'generate' | FoundWallet['kind']) => {
    if (kind === 'address') return freeName(t('wallet.watchWallet'));
    if (kind === 'generate')
      return freeName(
        firstRun
          ? t('wallet.mainVault')
          : `${t('addWallet.walletBase', { defaultValue: 'Wallet' })} ${wallets.length + 1}`
      );
    return freeName(t('wallet.importedWallet'));
  };

  const generatedDraft = async (): Promise<WalletDraft | null> => {
    const kp = await keypair.current?.catch((): null => null);
    if (!kp) {
      showMessage(
        t('addWallet.generateFailed', {
          defaultValue: 'Could not create a key. Go back and try again.',
        }),
        'error'
      );
      return null;
    }
    return {
      name: nameFor('generate'),
      address: kp.address,
      type: 'standard',
      privateKey: kp.private_key_b64,
      publicKey: kp.public_key_b64 ?? null,
      mnemonic: Array.isArray(kp.mnemonic) ? kp.mnemonic : null,
      source: 'generated',
      needsBackup: true,
    };
  };

  const foundDraft = (f: FoundWallet): WalletDraft =>
    f.kind === 'address'
      ? {
          name: nameFor('address'),
          address: f.address,
          type: 'watch',
          privateKey: null,
          publicKey: null,
          mnemonic: null,
          source: 'watch',
        }
      : {
          name: nameFor(f.kind),
          address: f.address,
          type: 'standard',
          privateKey: f.privateKey,
          publicKey: f.publicKey,
          mnemonic: f.mnemonic,
          source: f.kind === 'phrase' ? 'imported_phrase' : 'imported_key',
          isPadded: f.isPadded,
          addressWarning: f.addressWarning,
        };

  const go = (to: number) => {
    setDir(to > at ? 'fwd' : 'back');
    setAt(to);
  };
  const toReady = () => go(steps.indexOf('ready'));

  const save = async (draft: WalletDraft | null, protection?: Protection) => {
    if (!draft) return false;
    setBusy(true);
    try {
      const ok = await onDone(draft, protection);
      if (ok && alive.current) setSaved(draft);
      return ok;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const withEvm = async (draft: WalletDraft | null): Promise<WalletDraft | null> => {
    if (!draft?.mnemonic || draft.type === 'watch') return draft;
    try {
      const address = await deriveEvmAddress(draft.mnemonic, 0);
      return { ...draft, evm: { enabled: evmOn, address, index: 0 } };
    } catch {
      showMessage(
        t('addWallet.evmFailed', { defaultValue: 'Could not derive the EVM address. Try again.' }),
        'error'
      );
      return null;
    }
  };

  /**
   * An account from a phrase wallet: EVM on, at the same number as its Octra account, so the
   * phrase shows the same 0x addresses in MetaMask. The phrase stays with the parent wallet.
   */
  const derivedDraft = async (
    account: DerivedAccount,
    parent: ParentWallet
  ): Promise<WalletDraft> => {
    const draft: WalletDraft = {
      name: freeName(accountName),
      address: account.address,
      type: 'standard',
      privateKey: account.privateKey,
      publicKey: account.publicKey,
      mnemonic: null,
      source: 'derived',
    };
    try {
      const phrase = await loadMnemonic?.(parent.id);
      if (!phrase) return draft;
      const address = await deriveEvmAddress(phrase, account.index);
      return {
        ...draft,
        evm: { enabled: true, address, index: account.index, sourceWalletId: parent.id },
      };
    } catch {
      return draft;
    }
  };

  const saveNew = async (protection?: Protection) => {
    const draft = await withEvm(
      mode === 'generate' ? await generatedDraft() : found && foundDraft(found)
    );
    if ((await save(draft, protection)) && alive.current) toReady();
  };

  useMountEffect(() => {
    if (mode === 'generate') keypair.current = cryptoManager.generateKeyPair();
    return () => {
      alive.current = false;
    };
  });

  const back = () => {
    if (at === 0) onExit();
    else go(at - 1);
  };

  const step = steps[at];
  const parents: ParentWallet[] = wallets
    .filter((w) => w.mnemonic && w.type !== 'watch' && w.id)
    .map((w) => ({ id: w.id as string, name: w.name, address: w.address }));
  const initialParent =
    parents.find((p) => p.address === activeAddress)?.id ?? parents[0]?.id ?? '';

  let body: React.ReactNode = null;
  if (step === 'secret')
    body = (
      <ImportStep
        existing={existing}
        initialText={secretText}
        onText={setSecretText}
        busy={busy}
        onNext={(f) => {
          setFound(f);
          if (firstRun || f.kind === 'phrase') go(at + 1);
          else
            void save(foundDraft(f)).then((ok) => {
              if (ok && alive.current) toReady();
            });
        }}
      />
    );
  else if (step === 'networks')
    body = (
      <NetworksStep
        evm={evmOn}
        onEvm={setEvmOn}
        legacyPhrase={
          found?.kind === 'phrase' && !!found.mnemonic && !isStandardPhrase(found.mnemonic)
        }
        busy={busy}
        onNext={() => {
          if (busy) return;
          if (firstRun) go(at + 1);
          else void saveNew();
        }}
      />
    );
  else if (step === 'password')
    body = (
      <PasswordStep
        phase="create"
        value={password}
        onChange={setPassword}
        first={password}
        busy={false}
        onNext={() => {
          setAgain('');
          go(at + 1);
        }}
      />
    );
  else if (step === 'confirm')
    body = (
      <PasswordStep
        phase="confirm"
        value={again}
        onChange={setAgain}
        first={password}
        busy={busy}
        onNext={() => {
          if (passkeyOffered) go(at + 1);
          else void saveNew({ password, passkey: false });
        }}
      />
    );
  else if (step === 'passkey')
    body = <PasskeyStep busy={busy} onChoose={(passkey) => void saveNew({ password, passkey })} />;
  else if (step === 'account' && loadMnemonic)
    body = (
      <AccountStep
        parents={parents}
        initialParentId={initialParent}
        existing={existing}
        loadMnemonic={loadMnemonic}
        name={accountName}
        onName={(v, touched) => {
          if (touched) accountNameTouched.current = true;
          if (touched) setAccountName(v);
          else if (!accountNameTouched.current) setAccountName(freeName(v));
        }}
        busy={busy}
        onNext={(account, parent) => {
          setBusy(true);
          void derivedDraft(account, parent).then(save, () => {
            if (alive.current) setBusy(false);
          });
        }}
      />
    );
  else if (step === 'ready')
    body = (
      <ReadyStep
        name={saved?.name ?? ''}
        address={saved?.address ?? null}
        evmAddress={saved?.evm?.enabled ? saved.evm.address : null}
        viewOnly={saved?.type === 'watch'}
        saved={!!saved}
        onOpen={() => onOpen?.()}
      />
    );

  const oneWay = step === 'passkey' || (step === 'ready' && !!saved);
  const exitWithIcon = at === 0 && exitIcon === 'close';

  return (
    <div className="flex! h-full! min-h-0! flex-col! bg-(--bg)!">
      <div
        className="flex! shrink-0! items-center!"
        style={{ height: 'var(--header-height, 52px)', padding: '0 10px 0 6px', gap: '6px' }}
      >
        {!oneWay && (
          <IconButton
            onClick={back}
            aria-label={
              exitWithIcon
                ? t('common.close', { defaultValue: 'Close' })
                : t('common.back', { defaultValue: 'Back' })
            }
          >
            {exitWithIcon ? <X size={15} /> : <ChevronLeft size={17} />}
          </IconButton>
        )}
        {mode === 'derive' && (
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
            {t('addWallet.addAccount', { defaultValue: 'Add account' })}
          </span>
        )}
        {step === 'passkey' && (
          <TextButton
            muted
            size={13}
            disabled={busy}
            onClick={() => void saveNew({ password, passkey: false })}
            style={{ marginLeft: 'auto', height: '44px', padding: '0 10px', fontWeight: 600 }}
          >
            {t('addWallet.notNow', { defaultValue: 'Not now' })}
          </TextButton>
        )}
      </div>
      <div key={step} className={`flex! min-h-0! flex-1! flex-col! ${stepEnter(dir)}`}>
        {body}
      </div>
    </div>
  );
};

export default AddWalletFlow;
