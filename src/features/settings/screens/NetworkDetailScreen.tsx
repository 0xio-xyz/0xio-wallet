import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import {
  fieldClass,
  hostOf,
  inputProps,
  networkProblem,
  shortUrl,
} from 'src/features/settings/components/networkForm';
import { Caps, Field } from 'src/features/settings/components/networkParts';
import { NetworkLogo } from 'src/features/wallet/components/EvmNetworkPicker';
import { useManagedEvmNetwork } from 'src/hooks/wallet/useManagedNetworks';
import {
  addNetworkRpc,
  removeCustomNetwork,
  removeNetworkRpc,
  resetNetwork,
  setActiveRpc,
  setNetworkEnabled,
  setNetworkExplorer,
  setNetworkSymbol,
  type ManagedEvmNetwork,
} from 'src/services/evm/registry';
import Header from 'src/shared/ui/Header';
import {
  FieldNote,
  ListRow,
  PrimaryButton,
  RuledList,
  Sheet,
  TextButton,
  ToggleRow,
} from 'src/shared/ui/primitives';

type Edit = 'explorer' | 'symbol';
type Confirm = { kind: 'remove' } | { kind: 'reset' } | { kind: 'rpc'; url: string };

const parseId = (v: string | undefined): number | null => {
  const n = v && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const Tag = ({ children }: { children: React.ReactNode }) => (
  <span
    className="truncate! bg-(--bg-2)!"
    style={{
      fontSize: '10.5px',
      fontWeight: 600,
      color: 'var(--fg-2)',
      padding: '2px 8px',
      borderRadius: '999px',
      maxWidth: '170px',
    }}
  >
    {children}
  </span>
);

const RpcRow = ({
  url,
  active,
  own,
  onPick,
  onRemove,
}: {
  url: string;
  active: boolean;
  own: boolean;
  onPick: () => void;
  onRemove: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <div
      className={`flex! items-center! rounded-[14px]! transition-colors! duration-200! ${
        active ? 'bg-(--bg-2)!' : 'hover:bg-(--bg-2)!'
      }`}
      style={{ gap: '12px', paddingRight: '12px' }}
    >
      <button
        type="button"
        onClick={onPick}
        aria-pressed={active}
        className="flex! min-w-0! flex-1! flex-col!"
        style={{
          gap: '2px',
          padding: '9px 0 9px 12px',
          background: 'transparent',
          border: 'none',
          cursor: active ? 'default' : 'pointer',
          textAlign: 'left',
        }}
      >
        <span className="truncate! w-full!" style={{ fontSize: '13px', color: 'var(--fg)' }}>
          {shortUrl(url)}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
          {own
            ? t('networks.addedByYou', { defaultValue: 'Added by you' })
            : t('networks.rpcDefault', { defaultValue: 'Default' })}
        </span>
      </button>
      {active && (
        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--fg-2)' }}>
          {t('networks.active', { defaultValue: 'Active' })}
        </span>
      )}
      {own && (
        <TextButton muted size={12} onClick={onRemove}>
          {t('evmNetworks.remove', { defaultValue: 'Remove' })}
        </TextButton>
      )}
    </div>
  );
};

const AddRpcSheet = ({
  network,
  open,
  onClose,
}: {
  network: ManagedEvmNetwork;
  open: boolean;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);

  const close = () => {
    if (working.current) return;
    setUrl('');
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await addNetworkRpc(network.chainId, url);
      working.current = false;
      close();
    } catch (e) {
      setError(networkProblem(e, t, network.chainId).text);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      dismissible={!busy}
      title={t('networks.addRpcTitle', { defaultValue: 'Add RPC' })}
      onSubmit={() => void submit()}
      footer={
        <PrimaryButton onClick={() => void submit()} loading={busy} disabled={!url.trim()}>
          {busy
            ? t('evmNetworks.checking', { defaultValue: 'Checking RPC' })
            : t('networks.addRpcButton', { defaultValue: 'Add RPC' })}
        </PrimaryButton>
      }
    >
      <Field label={t('evmNetworks.rpcUrl', { defaultValue: 'RPC URL' })} note={error}>
        <input
          {...inputProps}
          value={url}
          maxLength={512}
          inputMode="url"
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          placeholder="https://"
          className={fieldClass(!!error)}
          autoFocus
        />
      </Field>
    </Sheet>
  );
};

const EditSheet = ({
  network,
  field,
  onClose,
}: {
  network: ManagedEvmNetwork;
  field: Edit | null;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current =
    field === 'explorer'
      ? (network.explorerUrl ?? '')
      : field === 'symbol'
        ? network.nativeSymbol
        : '';
  const shown = value ?? current;

  const close = () => {
    if (busy) return;
    setValue(null);
    setError(null);
    onClose();
  };

  const save = async () => {
    if (busy || !field) return;
    setBusy(true);
    setError(null);
    try {
      if (field === 'explorer') await setNetworkExplorer(network.chainId, shown);
      else await setNetworkSymbol(network.chainId, shown);
      setBusy(false);
      setValue(null);
      onClose();
    } catch (e) {
      setError(networkProblem(e, t).text);
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={field !== null}
      onClose={close}
      dismissible={!busy}
      title={
        field === 'explorer'
          ? t('networks.explorer', { defaultValue: 'Explorer' })
          : t('networks.symbol', { defaultValue: 'Symbol' })
      }
      onSubmit={() => void save()}
      footer={
        <PrimaryButton onClick={() => void save()} loading={busy}>
          {t('networks.save', { defaultValue: 'Save' })}
        </PrimaryButton>
      }
    >
      <Field
        label={
          field === 'explorer'
            ? t('networks.explorerUrl', { defaultValue: 'Explorer URL' })
            : t('evmNetworks.symbol', { defaultValue: 'Currency symbol' })
        }
        note={error}
      >
        <input
          {...inputProps}
          value={shown}
          maxLength={field === 'explorer' ? 512 : 11}
          inputMode={field === 'explorer' ? 'url' : 'text'}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder={field === 'explorer' ? 'https://' : 'ETH'}
          className={fieldClass(!!error)}
          autoFocus
        />
      </Field>
    </Sheet>
  );
};

const ConfirmSheet = ({
  network,
  confirm,
  onClose,
  onDone,
}: {
  network: ManagedEvmNetwork;
  confirm: Confirm | null;
  onClose: () => void;
  onDone: (kind: Confirm['kind']) => void;
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      if (confirm.kind === 'remove') await removeCustomNetwork(network.chainId);
      else if (confirm.kind === 'reset') await resetNetwork(network.chainId);
      else await removeNetworkRpc(network.chainId, confirm.url);
      setBusy(false);
      onDone(confirm.kind);
    } catch {
      setBusy(false);
      setFailed(true);
    }
  };

  const close = () => {
    if (busy) return;
    setFailed(false);
    onClose();
  };

  const copy =
    confirm?.kind === 'remove'
      ? {
          title: t('evmNetworks.removeTitle', {
            name: network.name,
            defaultValue: 'Remove {{name}}?',
          }),
          sub: t('evmNetworks.removeSub', {
            defaultValue:
              'Its balances stop showing in the wallet. Funds stay on chain and you can add it again later.',
          }),
          action: t('evmNetworks.remove', { defaultValue: 'Remove' }),
          danger: true,
        }
      : confirm?.kind === 'reset'
        ? {
            title: t('networks.resetTitle', {
              name: network.name,
              defaultValue: 'Reset {{name}}?',
            }),
            sub: t('networks.resetSub', {
              defaultValue:
                'Its own RPC and explorer come back and it turns on. RPCs you added are removed.',
            }),
            action: t('networks.reset', { defaultValue: 'Reset' }),
            danger: false,
          }
        : {
            title: t('networks.removeRpcTitle', { defaultValue: 'Remove this RPC?' }),
            sub: confirm?.kind === 'rpc' ? shortUrl(confirm.url) : '',
            action: t('evmNetworks.remove', { defaultValue: 'Remove' }),
            danger: true,
          };

  return (
    <Sheet
      open={confirm !== null}
      onClose={close}
      danger={copy.danger}
      dismissible={!busy}
      title={copy.title}
      sub={copy.sub}
    >
      <div className="flex! flex-col!" style={{ gap: '8px' }}>
        <PrimaryButton danger={copy.danger} loading={busy} onClick={() => void run()}>
          {copy.action}
        </PrimaryButton>
        <PrimaryButton secondary disabled={busy} onClick={close}>
          {t('evmNetworks.keep', { defaultValue: 'Keep' })}
        </PrimaryButton>
        <FieldNote tone="neg">
          {failed ? t('networks.saveFailed', { defaultValue: 'Could not save. Try again.' }) : ''}
        </FieldNote>
      </div>
    </Sheet>
  );
};

const NetworkDetailScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showMessage } = useWallet();
  const chainId = parseId(useParams().chainId);
  const { network, loaded, change } = useManagedEvmNetwork(chainId);
  const [addingRpc, setAddingRpc] = useState(false);
  const [editing, setEditing] = useState<Edit | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const failed = () =>
    showMessage(t('networks.saveFailed', { defaultValue: 'Could not save. Try again.' }), 'error');

  if (!network) {
    return (
      <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
        <Header title="" showBack showSettings={false} />
        {loaded && (
          <p style={{ padding: '14px var(--gutter)', fontSize: '12.5px', color: 'var(--fg-3)' }}>
            {t('networks.notFound', { defaultValue: 'This network is not in the wallet.' })}
          </p>
        )}
      </div>
    );
  }

  const tag = network.builtin
    ? t('networks.builtIn', { defaultValue: 'Built in' })
    : network.addedBy
      ? t('networks.addedBySite', {
          site: hostOf(network.addedBy),
          defaultValue: 'Added by {{site}}',
        })
      : t('networks.addedByYou', { defaultValue: 'Added by you' });

  const toggle = async () => {
    const enabled = !network.enabled;
    if (!(await change({ enabled }, () => setNetworkEnabled(network.chainId, enabled)))) failed();
  };

  const pick = async (url: string) => {
    if (url === network.rpcUrl) return;
    if (!(await change({ rpcUrl: url }, () => setActiveRpc(network.chainId, url)))) failed();
  };

  const rpcs = [network.defaultRpcUrl, ...network.userRpcs];

  return (
    <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
      <Header title="" showBack showSettings={false} />
      <div
        className="flex-1! overflow-y-auto! scrollbar-hide!"
        style={{ padding: '2px var(--gutter) 24px' }}
      >
        <div className="flex! items-center!" style={{ gap: '12px', padding: '0 4px 16px' }}>
          <NetworkLogo network={network} size={40} />
          <span className="flex! min-w-0! flex-col!" style={{ gap: '4px' }}>
            <span
              className="truncate!"
              style={{ fontSize: '17px', fontWeight: 700, color: 'var(--fg)' }}
            >
              {network.name}
            </span>
            <span className="flex! min-w-0! items-center!" style={{ gap: '8px' }}>
              <span style={{ fontSize: '12px', color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>
                {t('networks.chainWithSymbol', {
                  id: network.chainId,
                  symbol: network.nativeSymbol,
                  defaultValue: 'Chain {{id}} ({{symbol}})',
                })}
              </span>
              <Tag>{tag}</Tag>
            </span>
          </span>
        </div>

        <RuledList>
          <ToggleRow
            label={t('networks.showAndCheck', { defaultValue: 'Show and check balances' })}
            checked={network.enabled}
            onChange={() => void toggle()}
          />
        </RuledList>

        <Caps
          right={
            <TextButton size={12} onClick={() => setAddingRpc(true)}>
              {t('networks.addRpc', { defaultValue: '+ Add RPC' })}
            </TextButton>
          }
        >
          RPC
        </Caps>
        <RuledList>
          {rpcs.map((url) => (
            <RpcRow
              key={url}
              url={url}
              active={url === network.rpcUrl}
              own={url !== network.defaultRpcUrl}
              onPick={() => void pick(url)}
              onRemove={() => setConfirm({ kind: 'rpc', url })}
            />
          ))}
        </RuledList>

        <Caps>{t('networks.details', { defaultValue: 'Details' })}</Caps>
        <RuledList>
          <ListRow
            label={t('networks.explorer', { defaultValue: 'Explorer' })}
            hint={
              network.explorerUrl
                ? hostOf(network.explorerUrl)
                : t('networks.none', { defaultValue: 'None' })
            }
            onClick={() => setEditing('explorer')}
            chevron
          />
          <ListRow
            label={t('networks.symbol', { defaultValue: 'Symbol' })}
            hint={network.nativeSymbol}
            onClick={network.builtin ? undefined : () => setEditing('symbol')}
            chevron={!network.builtin}
          />
          <ListRow
            label={t('networks.chainId', { defaultValue: 'Chain ID' })}
            hint={String(network.chainId)}
            chevron={false}
          />
        </RuledList>

        <div className="flex! justify-center!" style={{ paddingTop: '22px' }}>
          {network.builtin ? (
            <TextButton muted size={12.5} onClick={() => setConfirm({ kind: 'reset' })}>
              {t('networks.resetToDefault', { defaultValue: 'Reset to default' })}
            </TextButton>
          ) : (
            <TextButton danger size={12.5} onClick={() => setConfirm({ kind: 'remove' })}>
              {t('networks.removeNetwork', { defaultValue: 'Remove network' })}
            </TextButton>
          )}
        </div>
      </div>

      <AddRpcSheet network={network} open={addingRpc} onClose={() => setAddingRpc(false)} />
      <EditSheet network={network} field={editing} onClose={() => setEditing(null)} />
      <ConfirmSheet
        network={network}
        confirm={confirm}
        onClose={() => setConfirm(null)}
        onDone={(kind) => {
          setConfirm(null);
          if (kind === 'remove') navigate(-1);
        }}
      />
    </div>
  );
};

export default NetworkDetailScreen;
