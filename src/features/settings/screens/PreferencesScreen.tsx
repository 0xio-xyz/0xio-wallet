import { useState } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useLocation } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { useTheme } from 'src/contexts/ThemeContext';
import Header from 'src/shared/ui/Header';
import {
  RuledList,
  ListRow,
  ToggleRow,
  SectionLabel,
  TextButton,
  PrimaryButton,
  QuietInput,
  QuietSelect,
  CellChoice,
  Modal,
} from 'src/shared/ui/primitives';
import ConfirmDialog from 'src/shared/ui/ConfirmDialog';
import { useConfirm } from 'src/hooks/ui/useConfirm';
import {
  networkService,
  privacyNetworkService,
  detectChain,
} from 'src/services/network/NetworkService';
import {
  ZeroXIOConfig,
  loadCustomNetworks,
  saveCustomNetworks,
  syncCustomNetworks,
  normalizeRpcBase,
  type CustomNetwork,
  type NetworkId,
} from 'src/utils/config';
import { LANGUAGES, setLanguage } from 'src/i18n';
import { logger } from 'src/utils/logger';
import { pvacManager } from 'src/services/pvac/PvacManager';
import { rpcFetch } from 'src/services/network/rpcExchange';

const EMPTY_NET_FORM = {
  name: '',
  rpcUrl: '',
  indexerUrl: '',
  supportsPrivacy: true,
};

const PreferencesScreen = ({ view = 'appearance' }: { view?: 'appearance' | 'network' }) => {
  const { t, i18n } = useTranslation();
  const { showMessage, refreshBalance, activeWallet } = useWallet();
  const { theme, setTheme } = useTheme();
  const { confirm, dialogState, handleConfirm, handleCancel } = useConfirm();

  const [selectedLanguage, setSelectedLanguage] = useState(i18n.language);
  const [selectedNetwork, setSelectedNetwork] = useState('mainnet');
  const [customNets, setCustomNets] = useState<CustomNetwork[]>([]);
  const [netModalOpen, setNetModalOpen] = useState(false);
  const [netFormOpen, setNetFormOpen] = useState(false);
  const [editingNetId, setEditingNetId] = useState<string | null>(null);
  const [netForm, setNetForm] = useState(EMPTY_NET_FORM);
  const [validatingNet, setValidatingNet] = useState(false);
  const [cacheTTL, setCacheTTL] = useState(15);
  const [rpcProxyEnabled, setRpcProxyEnabled] = useState(false);
  const location = useLocation();
  const editTarget = (location.state as { editNetwork?: string } | null)?.editNetwork;

  useMountEffect(() => {
    loadSettings();
    const onStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes['0xio_current_network']) {
        setSelectedNetwork(changes['0xio_current_network'].newValue || 'mainnet');
      }
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  });

  const loadSettings = async () => {
    try {
      const result = await chrome.storage.local.get([
        '0xio_current_network',
        'app_language',
        '0xio_rpc_proxy',
      ]);
      setSelectedNetwork(result['0xio_current_network'] || 'mainnet');
      if (result.app_language) setSelectedLanguage(result.app_language);
      const nets = await loadCustomNetworks();
      setCustomNets(nets);
      const target = nets.find((n) => n.id === editTarget);
      if (target) {
        startEditNetwork(target);
        setNetModalOpen(true);
      }
      setCacheTTL(pvacManager.cacheTTLMinutes);
      setRpcProxyEnabled(result['0xio_rpc_proxy'] === true);
    } catch (err) {
      logger.error('Error loading settings:', err);
    }
  };

  const customNetName = (id: string) => customNets.find((n) => n.id === id)?.name || 'Custom';

  const resetNetForm = () => {
    setNetForm(EMPTY_NET_FORM);
    setEditingNetId(null);
    setNetFormOpen(false);
  };

  const startEditNetwork = (net: CustomNetwork) => {
    setNetForm({
      name: net.name,
      rpcUrl: net.rpc_url,
      indexerUrl: net.indexer_url,
      supportsPrivacy: net.supports_privacy,
    });
    setEditingNetId(net.id);
    setNetFormOpen(true);
  };

  const handleSaveNetwork = async () => {
    if (!netForm.name.trim() || !netForm.rpcUrl.trim() || validatingNet) return;
    const rpcUrl = normalizeRpcBase(netForm.rpcUrl);
    const indexerInput = netForm.indexerUrl.trim();
    const isHttpUrl = (u: string) => {
      try {
        const parsed = new URL(u);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && u.length <= 256;
      } catch {
        return false;
      }
    };
    if (!isHttpUrl(rpcUrl) || (indexerInput && !isHttpUrl(indexerInput))) {
      showMessage(t('toast.netInvalidUrl'), 'error');
      return;
    }

    const prev = editingNetId ? customNets.find((n) => n.id === editingNetId) : undefined;
    // Every cache, budget, nonce and pending record is keyed by network id. A new RPC may be a
    // different chain, so it gets a new id: nothing kept for the old endpoint carries over.
    const urlChanged = !!prev && normalizeRpcBase(prev.rpc_url) !== rpcUrl;

    // A custom RPC is fully trusted with the user's traffic: it sees all activity and anything signed
    // while connected to it can be replayed onto another Octra network. Get informed consent once, and
    // call out plain http (readable/tamperable in transit) - loopback excepted, that's a local dev node.
    if (!editingNetId || urlChanged) {
      const host = new URL(rpcUrl).hostname;
      const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
      const insecure = rpcUrl.startsWith('http://') && !loopback;
      const ok = await confirm({
        title: t('preferences.netTrustTitle', 'Add this network?'),
        message:
          t(
            'preferences.netTrustMsg',
            'Custom RPCs can see your wallet activity and signed transactions, which may be replayed on other Octra networks. Only use trusted nodes and prefer HTTPS.'
          ) +
          (insecure
            ? '\n\n' +
              t(
                'preferences.netInsecureMsg',
                'This endpoint uses plain http, so the connection can be read or altered in transit.'
              )
            : ''),
        type: 'warning',
        confirmText: t('preferences.netTrustConfirm', 'Add network'),
      });
      if (!ok) return;
    }

    // Chrome only lets the wallet fetch whitelisted hosts; ask for this origin explicitly
    // (optional_host_permissions). Must run inside this click's user gesture.
    try {
      const origins = [`${new URL(rpcUrl).origin}/*`];
      const indexer0 = netForm.indexerUrl.trim();
      if (indexer0) origins.push(`${new URL(indexer0).origin}/*`);
      const granted = await chrome.permissions.request({ origins });
      if (!granted) {
        showMessage(t('toast.netPermDenied'), 'error');
        return;
      }
    } catch (e) {
      logger.warn('optional host permission request failed:', e);
    }

    setValidatingNet(true);
    try {
      const res = await rpcFetch(
        `${rpcUrl}/rpc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'octra_recommendedFee',
            params: ['key_switch'],
            id: 1,
          }),
        },
        { timeoutMs: 10_000, once: true }
      );
      const data = await res.json();
      if (!data?.result) {
        logger.warn('Custom RPC check failed:', data?.error);
        showMessage(t('toast.netNotOctra'), 'error');
        return;
      }
    } catch (e) {
      logger.warn('Custom RPC unreachable:', e);
      showMessage(t('toast.netUnreachable'), 'error');
      return;
    } finally {
      setValidatingNet(false);
    }

    // Octra has no chain-id, so detection only fingerprints the endpoint's OWN account data - which the
    // endpoint fully controls. It is an informational hint, never an authenticated identity, so it must
    // not grant trust or silently enable privacy; the user's own toggle decides supports_privacy.
    const supportsPrivacy = netForm.supportsPrivacy;
    if (!editingNetId) {
      try {
        const chain = await detectChain(rpcUrl, activeWallet?.address ?? '');
        if (chain === 'mainnet' || chain === 'devnet') {
          showMessage(
            t('toast.netLooksLike', {
              network: chain === 'mainnet' ? t('networks.mainnet') : t('networks.devnet'),
            }),
            'info'
          );
        }
      } catch {}
    }

    const id = editingNetId && !urlChanged ? editingNetId : `custom_${Date.now()}`;
    const indexer = netForm.indexerUrl.trim().replace(/\/$/, '');
    const newNet: CustomNetwork = {
      id,
      name: netForm.name.trim(),
      rpc_url: rpcUrl,
      explorer_url: indexer ? `${indexer}/tx.html?hash=` : (prev?.explorer_url ?? ''),
      explorer_address_url: indexer
        ? `${indexer}/address.html?addr=`
        : (prev?.explorer_address_url ?? ''),
      indexer_url: indexer,
      supports_privacy: supportsPrivacy,
      color: prev?.color ?? '#9b8cff',
      contract_address: prev?.contract_address,
    };
    const updated = editingNetId
      ? customNets.map((n) => (n.id === editingNetId ? newNet : n))
      : [...customNets, newNet];
    setCustomNets(updated);
    const movesSelection = urlChanged && editingNetId === selectedNetwork;
    if (movesSelection) {
      await chrome.storage.local.set({
        [ZeroXIOConfig.STORAGE.KEYS.CUSTOM_NETWORKS]: updated,
        [ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK]: id,
      });
      syncCustomNetworks(updated);
      setSelectedNetwork(id);
    } else {
      await saveCustomNetworks(updated);
    }
    if (editingNetId && editingNetId === selectedNetwork) {
      networkService.balanceCache.clear();
      networkService.txDetailCache.clear();
      privacyNetworkService.clearDecryptCache();
      refreshBalance(undefined, undefined, true, id as NetworkId);
    }
    resetNetForm();
  };

  const handleDeleteNetwork = async (net: CustomNetwork) => {
    const ok = await confirm({
      title: t('preferences.netDeleteTitle', 'Remove network'),
      message: t('preferences.netDeleteMsg', 'Remove "{{name}}"? Wallets are unaffected.', {
        name: net.name,
      }),
      type: 'danger',
      confirmText: t('common.remove', 'Remove'),
    });
    if (!ok) return;
    const updated = customNets.filter((n) => n.id !== net.id);
    setCustomNets(updated);
    await saveCustomNetworks(updated);
    if (selectedNetwork === net.id) await handleNetworkChange('mainnet');
    if (editingNetId === net.id) resetNetForm();
    try {
      const origin = new URL(net.rpc_url).origin;
      const stillUsed = updated.some((n) => {
        try {
          return new URL(n.rpc_url).origin === origin;
        } catch {
          return false;
        }
      });
      if (!stillUsed) await chrome.permissions.remove({ origins: [`${origin}/*`] });
    } catch {}
  };

  const handleLanguageChange = async (langCode: string) => {
    setSelectedLanguage(langCode);
    try {
      await setLanguage(langCode);
    } catch (err) {
      logger.error('Error saving language:', err);
      showMessage(t('toast.settingSaveFailed'), 'error');
    }
  };

  const handleCacheTTLChange = async (minutes: number) => {
    setCacheTTL(minutes);
    try {
      await pvacManager.setCacheTTLMinutes(minutes);
    } catch (err) {
      logger.error('Error saving cache TTL:', err);
    }
  };

  const handleNetworkChange = async (networkId: string) => {
    logger.debug(`[Preferences] Network change: ${selectedNetwork} -> ${networkId}`);
    setSelectedNetwork(networkId);
    try {
      await chrome.storage.local.set({ '0xio_current_network': networkId });
      networkService.balanceCache.clear();
      networkService.txDetailCache.clear();
      privacyNetworkService.clearDecryptCache();
      refreshBalance(undefined, undefined, true, networkId as NetworkId);
    } catch (err) {
      logger.error('Error saving network:', err);
      showMessage(t('toast.settingSaveFailed'), 'error');
    }
  };

  const closeNetModal = () => {
    resetNetForm();
    setNetModalOpen(false);
  };
  const activeNodeName =
    selectedNetwork === 'mainnet'
      ? t('preferences.octraMainnet')
      : selectedNetwork === 'devnet'
        ? t('preferences.octraDevnet')
        : customNetName(selectedNetwork);
  const canSaveNet = !validatingNet && !!netForm.name.trim() && !!netForm.rpcUrl.trim();

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

      <Modal
        open={netModalOpen}
        onSubmit={() => netFormOpen && canSaveNet && handleSaveNetwork()}
        onClose={closeNetModal}
        closeLabel={t('common.close', 'Close')}
        maxWidth={340}
        title={
          netFormOpen
            ? editingNetId
              ? t('preferences.editNetwork', 'Edit network')
              : t('preferences.addNetwork', 'Add network')
            : t('preferences.customNetworks', 'Custom networks')
        }
      >
        {!netFormOpen && (
          <>
            {customNets.length > 0 && (
              <RuledList>
                {customNets.map((net) => {
                  const active = selectedNetwork === net.id;
                  let host = net.rpc_url;
                  try {
                    host = new URL(net.rpc_url).host;
                  } catch {}
                  return (
                    <ListRow
                      key={net.id}
                      label={
                        <>
                          {net.name}
                          {active && (
                            <span
                              style={{ fontSize: '11px', color: 'var(--pos)', marginLeft: '6px' }}
                            >
                              {t('preferences.active', 'Active')}
                            </span>
                          )}
                          {net.supports_privacy && (
                            <span
                              style={{ fontSize: '11px', color: 'var(--fg-3)', marginLeft: '6px' }}
                            >
                              {t('preferences.privacyOn', 'privacy')}
                            </span>
                          )}
                        </>
                      }
                      sub={host}
                      right={
                        <span className="flex! items-center!" style={{ gap: '12px' }}>
                          <TextButton muted onClick={() => startEditNetwork(net)}>
                            {t('common.edit', 'Edit')}
                          </TextButton>
                          <TextButton muted onClick={() => handleDeleteNetwork(net)}>
                            {t('common.remove', 'Remove')}
                          </TextButton>
                        </span>
                      }
                      chevron={false}
                    />
                  );
                })}
              </RuledList>
            )}
            <div style={{ paddingTop: customNets.length ? '12px' : 0 }}>
              <TextButton
                onClick={() => {
                  setNetForm(EMPTY_NET_FORM);
                  setEditingNetId(null);
                  setNetFormOpen(true);
                }}
              >
                {t('preferences.addNetwork', 'Add network')}
              </TextButton>
            </div>
          </>
        )}

        {netFormOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <QuietInput
              label={t('preferences.netName', 'Name')}
              type="text"
              value={netForm.name}
              maxLength={32}
              onChange={(e) => setNetForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="My Octra node"
            />
            <QuietInput
              label="RPC URL"
              type="text"
              value={netForm.rpcUrl}
              maxLength={256}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setNetForm((f) => ({ ...f, rpcUrl: e.target.value }))}
              placeholder="https://rpc.example.com"
            />
            <QuietInput
              label={t('preferences.netIndexer', 'Explorer or indexer URL (optional)')}
              type="text"
              value={netForm.indexerUrl}
              maxLength={256}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setNetForm((f) => ({ ...f, indexerUrl: e.target.value }))}
              placeholder="https://scan.example.com"
            />
            <RuledList>
              <ToggleRow
                label={t('preferences.netPrivacy', 'Supports privacy features (PVAC)')}
                checked={netForm.supportsPrivacy}
                onChange={() => setNetForm((f) => ({ ...f, supportsPrivacy: !f.supportsPrivacy }))}
              />
            </RuledList>
            <PrimaryButton
              onClick={handleSaveNetwork}
              disabled={!canSaveNet}
              loading={validatingNet}
            >
              {validatingNet
                ? t('preferences.netValidating', 'Checking RPC')
                : editingNetId
                  ? t('common.save')
                  : t('preferences.addNetwork', 'Add network')}
            </PrimaryButton>
            <div className="flex! justify-center!">
              <TextButton
                muted
                onClick={() => {
                  resetNetForm();
                  if (customNets.length === 0) setNetModalOpen(false);
                }}
              >
                {t('common.cancel', 'Cancel')}
              </TextButton>
            </div>
          </div>
        )}
      </Modal>

      <Header
        title={
          view === 'network'
            ? t('settings.network', { defaultValue: 'Network' })
            : t('settings.appearance', { defaultValue: 'Appearance' })
        }
        showBack
        showSettings={false}
      />

      <div
        className="flex-1! overflow-y-auto! scrollbar-hide!"
        style={{ padding: '4px var(--gutter) 24px' }}
      >
        {view === 'appearance' && (
          <>
            <SectionLabel first>{t('preferences.language')}</SectionLabel>
            <QuietSelect value={selectedLanguage} onChange={handleLanguageChange}>
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </QuietSelect>

            <SectionLabel>{t('preferences.theme', 'Theme')}</SectionLabel>
            <CellChoice
              value={theme}
              onChange={(id) => setTheme(id)}
              options={[
                { id: 'dim', label: t('preferences.dim') },
                { id: 'light', label: t('preferences.light') },
                { id: 'octra', label: t('preferences.octra') },
              ]}
            />
          </>
        )}
        {view === 'network' && (
          <>
            <SectionLabel first>{t('preferences.connection')}</SectionLabel>
            <QuietSelect value={selectedNetwork} onChange={handleNetworkChange}>
              <option value="mainnet">{t('preferences.mainnetStandard')}</option>
              <option value="devnet">{t('preferences.devnetPrivacy')}</option>
              {customNets.map((net) => (
                <option key={net.id} value={net.id}>
                  {net.name}
                </option>
              ))}
            </QuietSelect>
            <RuledList style={{ marginTop: '12px' }}>
              <ListRow
                label={t('preferences.customNetworks', 'Custom networks')}
                hint={customNets.length ? String(customNets.length) : undefined}
                onClick={() => {
                  if (customNets.length === 0) {
                    setNetForm(EMPTY_NET_FORM);
                    setEditingNetId(null);
                    setNetFormOpen(true);
                  }
                  setNetModalOpen(true);
                }}
              />
              <ListRow label={t('preferences.activeNode')} hint={activeNodeName} />
            </RuledList>

            <SectionLabel>{t('preferences.hfhe')}</SectionLabel>
            <QuietSelect
              label={t('preferences.pvacCacheTTL')}
              value={String(cacheTTL)}
              onChange={(v) => handleCacheTTLChange(Number(v))}
            >
              <option value="5">{t('preferences.minutes', { count: 5 })}</option>
              <option value="10">{t('preferences.minutes', { count: 10 })}</option>
              <option value="15">
                {t('preferences.minutes', { count: 15 })} ({t('preferences.default')})
              </option>
              <option value="30">{t('preferences.minutes', { count: 30 })}</option>
              <option value="60">{t('preferences.minutes', { count: 60 })}</option>
            </QuietSelect>

            <SectionLabel>Advanced</SectionLabel>
            <RuledList>
              <ToggleRow
                label="RPC proxy"
                checked={rpcProxyEnabled}
                onChange={async () => {
                  const next = !rpcProxyEnabled;
                  setRpcProxyEnabled(next);
                  await chrome.storage.local.set({ '0xio_rpc_proxy': next });
                }}
              />
            </RuledList>
          </>
        )}
      </div>
    </div>
  );
};

export default PreferencesScreen;
