import { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import {
  fieldClass,
  hostOf,
  inputProps,
  networkProblem,
  type NetworkField,
} from 'src/features/settings/components/networkForm';
import { Caps, Field } from 'src/features/settings/components/networkParts';
import { NetworkLogo } from 'src/features/wallet/components/EvmNetworkPicker';
import { isHttpsUrl } from 'src/services/evm/networkPrefs';
import { loadChainList, searchChainList, type ChainListEntry } from 'src/services/evm/chainList';
import { isBuiltinChain } from 'src/services/evm/registry';
import { Mascot } from 'src/shared/ui/Mascot';
import { EVM_NETWORK_PRESETS, presetFor, type EvmNetworkPreset } from 'src/services/evm/presets';
import {
  EvmNetworkError,
  addCustomNetwork,
  findNetwork,
  probeChainId,
  type ManagedEvmNetwork,
} from 'src/services/evm/registry';
import {
  FieldNote,
  ListRow,
  PrimaryButton,
  RuledList,
  Sheet,
  TextButton,
  Toggle,
  quietField,
} from 'src/shared/ui/primitives';

type View = 'list' | 'rpc' | 'details';

type ListState = 'idle' | 'loading' | 'ready' | 'failed';

const matches = (q: string, name: string, chainId: number) =>
  !q || name.toLowerCase().includes(q) || String(chainId).includes(q);

const AddPill = ({
  busy,
  disabled,
  onClick,
  label,
  text,
}: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
  text: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    className="press enabled:hover:opacity-85!"
    style={{
      height: '26px',
      minWidth: '52px',
      padding: '0 12px',
      borderRadius: '13px',
      border: 'none',
      background: 'var(--accent)',
      color: 'var(--accent-fg)',
      fontSize: '11px',
      fontWeight: 700,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      display: 'grid',
      placeItems: 'center',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled && !busy ? 0.5 : 1,
      transition: 'opacity 200ms ease-out',
    }}
  >
    {busy ? (
      <Mascot mood="loading" size={14} hole="var(--accent)" className="text-current!" />
    ) : (
      text
    )}
  </button>
);

const AddNetworkSheet = ({
  open,
  onClose,
  side,
  known,
}: {
  open: boolean;
  onClose: () => void;
  side: 'mainnet' | 'devnet';
  known: ManagedEvmNetwork[];
}) => {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('list');
  const [query, setQuery] = useState('');
  const [presetBusy, setPresetBusy] = useState<number | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [rpc, setRpc] = useState('');
  const [chainId, setChainId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [explorer, setExplorer] = useState('');
  const [testnet, setTestnet] = useState(side === 'devnet');
  const [errors, setErrors] = useState<Partial<Record<NetworkField, string>>>({});
  const [busy, setBusy] = useState<'probe' | 'add' | null>(null);
  const [chainList, setChainList] = useState<ChainListEntry[]>([]);
  const [listState, setListState] = useState<ListState>('idle');
  const [fromList, setFromList] = useState<ChainListEntry | null>(null);
  const working = useRef(false);

  const inFlight = busy !== null || presetBusy !== null;
  const q = query.trim().toLowerCase();
  const presets = EVM_NETWORK_PRESETS.filter(
    (p) => p.testnet === (side === 'devnet') && matches(q, p.name, p.chainId)
  );
  const added = (id: number) => known.some((n) => n.chainId === id);
  const preset = chainId === null ? null : presetFor(chainId);
  const listed = q
    ? searchChainList(chainList, q, {
        testnet: side === 'devnet',
        exclude: new Set(presets.map((p) => p.chainId)),
      }).filter((n) => !isBuiltinChain(n.chainId))
    : [];

  const search = (value: string) => {
    setQuery(value);
    if (!value.trim() || listState === 'loading' || listState === 'ready') return;
    setListState('loading');
    loadChainList()
      .then((list) => {
        setChainList(list);
        setListState('ready');
      })
      .catch(() => setListState('failed'));
  };

  const reset = () => {
    setView('list');
    setQuery('');
    setPresetError(null);
    setRpc('');
    setChainId(null);
    setName('');
    setSymbol('');
    setExplorer('');
    setTestnet(side === 'devnet');
    setErrors({});
    setFromList(null);
  };

  const close = () => {
    if (working.current) return;
    reset();
    onClose();
  };

  const edit =
    (field: NetworkField, set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
      set(e.target.value);
      setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
    };

  const addPreset = async (p: EvmNetworkPreset) => {
    if (working.current) return;
    working.current = true;
    setPresetBusy(p.chainId);
    setPresetError(null);
    try {
      await addCustomNetwork({ ...p });
    } catch (e) {
      setPresetError(
        e instanceof EvmNetworkError && e.problem !== 'rpc' && e.problem !== 'mismatch'
          ? networkProblem(e, t).text
          : t('evmNetworks.presetFailed', {
              name: p.name,
              defaultValue: '{{name}} unreachable. Try again.',
            })
      );
    } finally {
      working.current = false;
      setPresetBusy(null);
    }
  };

  const pickListed = async (n: ChainListEntry) => {
    if (working.current) return;
    working.current = true;
    setPresetBusy(n.chainId);
    setPresetError(null);
    let served: number | null = null;
    try {
      const have = await findNetwork(n.chainId);
      if (have) {
        setPresetError(
          t('networks.alreadyHere', {
            name: have.name,
            defaultValue: '{{name}} is already here. Add this RPC from its page.',
          })
        );
        return;
      }
      for (const url of n.rpcs) {
        try {
          const id = await probeChainId(url);
          if (id !== n.chainId) {
            served = id;
            continue;
          }
          setRpc(url);
          setChainId(n.chainId);
          setName(n.name);
          setSymbol(n.symbol);
          setExplorer(n.explorer ?? '');
          setTestnet(n.testnet);
          setErrors({});
          setFromList(n);
          setView('details');
          return;
        } catch {}
      }
      setPresetError(
        served !== null
          ? t('networks.rpcMismatch', {
              served,
              id: n.chainId,
              defaultValue: 'RPC returned chain ID {{served}}, expected {{id}}',
            })
          : t('evmNetworks.presetFailed', {
              name: n.name,
              defaultValue: '{{name}} unreachable. Try again.',
            })
      );
    } finally {
      working.current = false;
      setPresetBusy(null);
    }
  };

  const readRpc = async () => {
    if (working.current) return;
    const url = rpc.trim();
    if (!isHttpsUrl(url)) {
      setErrors({ rpc: t('evmNetworks.httpsOnly', { defaultValue: 'Enter an https:// URL' }) });
      return;
    }
    working.current = true;
    setBusy('probe');
    setErrors({});
    try {
      const id = await probeChainId(url);
      const have = await findNetwork(id);
      if (have) {
        setErrors({
          rpc: t('networks.alreadyHere', {
            name: have.name,
            defaultValue: '{{name}} is already here. Add this RPC from its page.',
          }),
        });
        return;
      }
      const p = presetFor(id);
      setChainId(id);
      setName(p?.name ?? '');
      setSymbol(p?.nativeSymbol ?? '');
      setExplorer(p?.explorerUrl ?? '');
      setTestnet(p ? p.testnet : side === 'devnet');
      setView('details');
    } catch {
      setErrors({
        rpc: t('evmNetworks.rpcFailed', { defaultValue: 'RPC not responding. Check the URL.' }),
      });
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const submit = async () => {
    if (working.current || chainId === null) return;
    const next: Partial<Record<NetworkField, string>> = {};
    if (!name.trim()) next.name = t('evmNetworks.nameNeeded', { defaultValue: 'Enter a name' });
    if (!symbol.trim())
      next.symbol = t('evmNetworks.symbolNeeded', { defaultValue: 'Enter the currency symbol' });
    if (explorer.trim() && !isHttpsUrl(explorer.trim()))
      next.explorer = t('evmNetworks.httpsOnly', { defaultValue: 'Enter an https:// URL' });
    setErrors(next);
    if (Object.keys(next).length) return;
    working.current = true;
    setBusy('add');
    try {
      await addCustomNetwork({
        chainId,
        name,
        rpcUrl: rpc,
        nativeSymbol: symbol,
        nativeName:
          preset?.nativeSymbol === symbol.trim()
            ? preset.nativeName
            : fromList?.symbol === symbol.trim()
              ? fromList.nativeName
              : undefined,
        testnet,
        explorerUrl: explorer.trim() || undefined,
        logoChainId: preset?.logoChainId,
      });
      working.current = false;
      close();
    } catch (e) {
      const p = networkProblem(e, t, chainId);
      setErrors({ [p.field === 'chainId' ? 'rpc' : p.field]: p.text });
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const back = (
    <TextButton
      muted
      size={12}
      disabled={busy !== null}
      onClick={() => {
        setErrors({});
        if (view === 'details' && fromList) {
          setFromList(null);
          setView('list');
          return;
        }
        setView(view === 'details' ? 'rpc' : 'list');
      }}
    >
      {t('common.back', { defaultValue: 'Back' })}
    </TextButton>
  );

  if (view === 'list') {
    return (
      <Sheet
        open={open}
        onClose={close}
        dismissible={!inFlight}
        title={t('evmNetworks.addTitle', { defaultValue: 'Add a network' })}
        pinned={
          <input
            {...inputProps}
            value={query}
            onChange={(e) => search(e.target.value)}
            placeholder={t('networks.searchChains', { defaultValue: 'Search networks' })}
            aria-label={t('networks.searchChains', { defaultValue: 'Search networks' })}
            className={quietField}
          />
        }
      >
        <Caps first>{t('networks.popular', { defaultValue: 'Popular' })}</Caps>
        {presets.length > 0 ? (
          <RuledList>
            {presets.map((p) => (
              <ListRow
                key={p.chainId}
                leading={<NetworkLogo network={p} size={26} />}
                label={p.name}
                sub={t('networks.chainLabel', { id: p.chainId, defaultValue: 'Chain {{id}}' })}
                right={
                  added(p.chainId) ? (
                    <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
                      {t('networks.added', { defaultValue: 'Added' })}
                    </span>
                  ) : (
                    <AddPill
                      busy={presetBusy === p.chainId}
                      disabled={inFlight}
                      onClick={() => void addPreset(p)}
                      label={t('networks.addNamed', {
                        name: p.name,
                        defaultValue: 'Add {{name}}',
                      })}
                      text={t('networks.addPill', { defaultValue: 'Add' })}
                    />
                  )
                }
                chevron={false}
              />
            ))}
          </RuledList>
        ) : (
          <p style={{ margin: 0, padding: '6px 4px', fontSize: '12px', color: 'var(--fg-3)' }}>
            {t('networks.noChains', { defaultValue: 'No matching networks' })}
          </p>
        )}
        {q && (
          <>
            <Caps>{t('networks.fromChainlist', { defaultValue: 'From chainlist.org' })}</Caps>
            {listed.length > 0 ? (
              <RuledList>
                {listed.map((n) => (
                  <ListRow
                    key={n.chainId}
                    leading={
                      <NetworkLogo network={{ name: n.name, logoChainId: n.chainId }} size={26} />
                    }
                    label={n.name}
                    sub={t('networks.chainWithSymbol', {
                      id: n.chainId,
                      symbol: n.symbol,
                      defaultValue: 'Chain {{id}} ({{symbol}})',
                    })}
                    right={
                      added(n.chainId) ? (
                        <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
                          {t('networks.added', { defaultValue: 'Added' })}
                        </span>
                      ) : (
                        <AddPill
                          busy={presetBusy === n.chainId}
                          disabled={inFlight}
                          onClick={() => void pickListed(n)}
                          label={t('networks.addNamed', {
                            name: n.name,
                            defaultValue: 'Add {{name}}',
                          })}
                          text={t('networks.addPill', { defaultValue: 'Add' })}
                        />
                      )
                    }
                    chevron={false}
                  />
                ))}
              </RuledList>
            ) : (
              <div
                className="flex! items-center!"
                style={{
                  minHeight: '58px',
                  padding: '0 4px',
                  fontSize: '12px',
                  color: 'var(--fg-3)',
                }}
              >
                {listState === 'loading' || listState === 'idle' ? (
                  <Mascot mood="loading" size={18} />
                ) : listState === 'failed' ? (
                  t('networks.listFailed', { defaultValue: 'Could not load the network list' })
                ) : (
                  t('networks.listNoMatch', { defaultValue: 'No matching networks' })
                )}
              </div>
            )}
          </>
        )}
        <FieldNote tone="neg">{presetError ?? ''}</FieldNote>
        <RuledList style={{ marginTop: '6px' }}>
          <ListRow
            label={t('evmNetworks.custom', { defaultValue: 'Custom network' })}
            onClick={() => {
              if (inFlight) return;
              setPresetError(null);
              setView('rpc');
            }}
          />
        </RuledList>
      </Sheet>
    );
  }

  if (view === 'rpc') {
    return (
      <Sheet
        open={open}
        onClose={close}
        dismissible={busy === null}
        title={t('evmNetworks.custom', { defaultValue: 'Custom network' })}
        action={back}
        onSubmit={() => void readRpc()}
        footer={
          <PrimaryButton
            onClick={() => void readRpc()}
            loading={busy === 'probe'}
            disabled={!rpc.trim()}
          >
            {busy === 'probe'
              ? t('networks.readingRpc', { defaultValue: 'Checking RPC' })
              : t('networks.continue', { defaultValue: 'Continue' })}
          </PrimaryButton>
        }
      >
        <Field label={t('evmNetworks.rpcUrl', { defaultValue: 'RPC URL' })} note={errors.rpc}>
          <input
            {...inputProps}
            value={rpc}
            maxLength={512}
            inputMode="url"
            onChange={edit('rpc', setRpc)}
            placeholder="https://"
            className={fieldClass(!!errors.rpc)}
            autoFocus
          />
        </Field>
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      dismissible={busy === null}
      title={
        fromList
          ? t('networks.addNamed', { name: fromList.name, defaultValue: 'Add {{name}}' })
          : t('evmNetworks.custom', { defaultValue: 'Custom network' })
      }
      action={back}
      onSubmit={() => void submit()}
      footer={
        <PrimaryButton onClick={() => void submit()} loading={busy === 'add'}>
          {busy === 'add'
            ? t('evmNetworks.checking', { defaultValue: 'Checking RPC' })
            : t('evmNetworks.addButton', { defaultValue: 'Add network' })}
        </PrimaryButton>
      }
    >
      <div
        className="flex! items-center! bg-(--bg-2)! rounded-[14px]!"
        style={{ gap: '10px', padding: '10px 12px', marginBottom: '14px' }}
      >
        <NetworkLogo
          network={{ name: name || '?', logoChainId: preset?.logoChainId ?? chainId ?? 0 }}
          size={26}
        />
        <span className="flex! min-w-0! flex-col!" style={{ gap: '2px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
            {t('networks.chainLabel', { id: chainId, defaultValue: 'Chain {{id}}' })}
          </span>
          <span className="truncate!" style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
            {hostOf(rpc.trim())}
          </span>
        </span>
      </div>
      <FieldNote tone="neg">{errors.rpc ?? ''}</FieldNote>
      <Field label={t('evmNetworks.name', { defaultValue: 'Network name' })} note={errors.name}>
        <input
          {...inputProps}
          value={name}
          maxLength={40}
          onChange={edit('name', setName)}
          placeholder={t('networks.namePlaceholder', { defaultValue: 'My chain' })}
          className={fieldClass(!!errors.name)}
          autoFocus={!name}
        />
      </Field>
      <Field
        label={t('evmNetworks.symbol', { defaultValue: 'Currency symbol' })}
        note={errors.symbol}
      >
        <input
          {...inputProps}
          value={symbol}
          maxLength={11}
          onChange={edit('symbol', setSymbol)}
          placeholder="ETH"
          className={fieldClass(!!errors.symbol)}
        />
      </Field>
      <Field
        label={t('evmNetworks.explorer', { defaultValue: 'Block explorer (optional)' })}
        note={errors.explorer}
      >
        <input
          {...inputProps}
          value={explorer}
          maxLength={512}
          inputMode="url"
          onChange={edit('explorer', setExplorer)}
          placeholder="https://"
          className={fieldClass(!!errors.explorer)}
        />
      </Field>
      <div
        className="flex! items-center! justify-between! bg-(--bg-2)! rounded-[10px]!"
        style={{ padding: '0 12px', minHeight: '44px' }}
      >
        <span style={{ fontSize: '13px', color: 'var(--fg)' }}>
          {t('evmNetworks.testnet', { defaultValue: 'Testnet' })}
        </span>
        <Toggle
          checked={testnet}
          onChange={() => setTestnet((v) => !v)}
          label={t('evmNetworks.testnet', { defaultValue: 'Testnet' })}
        />
      </div>
    </Sheet>
  );
};

export default AddNetworkSheet;
