import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { Sheet, PrimaryButton, quietField } from 'src/shared/ui/primitives';
import { isEvmContractInput, useEvmTokenImport } from 'src/hooks/wallet/useEvmTokenImport';
import { EvmTokenPreview } from 'src/features/wallet/components/EvmTokenPreview';
import {
  DetectedNetwork,
  NetworkSearchSheet,
} from 'src/features/wallet/components/EvmNetworkPicker';
import { isOctAddress, normalizeAddress, OCT_ADDRESS_LENGTH } from 'src/utils/octra/address';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import type { OctraTokens } from 'src/hooks/wallet/useOctraTokens';
import { resolveNetworkPin } from 'src/services/network/txScope';
import {
  fetchTokenMeta,
  getImportedAddresses,
  rememberTokenMeta,
  saveImportedAddresses,
} from 'src/services/tokens/octraTokens';
import {
  evmVisKey,
  octraVisKey,
  readVisibility,
  setTokenShown,
  visContract,
} from 'src/services/tokens/tokenVisibility';

async function showAgain(key: string, contract: string): Promise<void> {
  const vis = (await readVisibility([key]))[key] ?? {};
  if (vis[visContract(key, contract)] !== false) return;
  await setTokenShown(key, contract, true).catch((): undefined => undefined);
}

export default function ImportTokenSheet({
  onClose,
  octra,
}: {
  onClose: () => void;
  octra: Pick<OctraTokens, 'listed' | 'imported' | 'reloadImported'>;
}) {
  const { t } = useTranslation();
  const { networkId, activeWallet } = useWallet();
  const { evmAddress } = useHomeView();
  const evmImport = useEvmTokenImport({ octraNetworkId: networkId, owner: evmAddress });
  const [importAddress, setImportAddress] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState('');
  const [importPreview, setImportPreview] = useState<{
    address: string;
    symbol: string;
    name: string;
    decimals: number;
  } | null>(null);
  const importIsEvm = isEvmContractInput(importAddress);
  const evmImportBusy =
    evmImport.phase === 'detecting' ||
    evmImport.phase === 'reading' ||
    evmImport.phase === 'adding';

  const handleScanImport = async () => {
    const addr = importAddress;
    if (!addr || importLoading) return;
    if (!isOctAddress(addr)) {
      setImportError(
        t('token.importBadAddress', { defaultValue: 'Enter a valid contract address' })
      );
      return;
    }
    setImportLoading(true);
    setImportError('');
    setImportPreview(null);
    try {
      const lowerAddr = addr.toLowerCase();
      const stored = await getImportedAddresses(networkId);
      if (
        octra.listed.some((x) => x.address.toLowerCase() === lowerAddr) ||
        stored.some((a) => a.toLowerCase() === lowerAddr) ||
        (octra.imported ?? []).some((x) => x.contractAddress.toLowerCase() === lowerAddr)
      ) {
        setImportError(t('token.importAlreadyAdded'));
        return;
      }
      const info = await fetchTokenMeta(addr, await resolveNetworkPin(networkId));
      if (!info) {
        setImportError(t('token.importNotValid'));
        return;
      }
      rememberTokenMeta(networkId, addr, info);
      setImportPreview({ ...info, address: addr });
    } catch {
      setImportError(t('token.importFailed'));
    } finally {
      setImportLoading(false);
    }
  };

  const handleEvmImport = async () => {
    const preview = evmImport.preview;
    if (preview) {
      if (!(await evmImport.add())) return;
      if (evmAddress && preview.address) {
        await showAgain(evmVisKey(preview.chainId, evmAddress), preview.address);
      }
      onClose();
      setImportAddress('');
      return;
    }
    await evmImport.find();
  };

  const handleConfirmImport = async () => {
    if (!networkId || !importPreview) return;
    const addr = importPreview.address;
    const existing = await getImportedAddresses(networkId);
    if (!existing.includes(addr)) {
      await saveImportedAddresses(networkId, [...existing, addr]);
    }
    if (activeWallet?.address) await showAgain(octraVisKey(networkId, activeWallet.address), addr);
    onClose();
    setImportAddress('');
    setImportPreview(null);
    setImportError('');
    octra.reloadImported();
  };

  const submitImport = () => {
    if (importIsEvm) void handleEvmImport();
    else if (importPreview) void handleConfirmImport();
    else void handleScanImport();
  };

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={t('token.importTokenTitle')}
        onSubmit={submitImport}
        footer={
          importIsEvm ? (
            <PrimaryButton
              onClick={() => void handleEvmImport()}
              loading={evmImportBusy}
              disabled={!evmImport.network || !importAddress.trim()}
            >
              {evmImport.phase === 'detecting' || evmImport.phase === 'reading'
                ? t('nft.checking', 'Checking')
                : evmImport.preview
                  ? t('token.importConfirm')
                  : t('token.lookUp', { defaultValue: 'Look up' })}
            </PrimaryButton>
          ) : importPreview ? (
            <PrimaryButton onClick={handleConfirmImport}>{t('token.importConfirm')}</PrimaryButton>
          ) : (
            <PrimaryButton
              onClick={handleScanImport}
              loading={importLoading}
              disabled={!importAddress.trim()}
            >
              {t('token.lookUp', { defaultValue: 'Look up' })}
            </PrimaryButton>
          )
        }
      >
        <div className="flex! flex-col!" style={{ gap: '10px' }}>
          <input
            type="text"
            value={importAddress}
            maxLength={OCT_ADDRESS_LENGTH}
            onChange={(e) => {
              const next = normalizeAddress(e.target.value).slice(0, OCT_ADDRESS_LENGTH);
              setImportAddress(next);
              evmImport.setAddress(next);
              setImportPreview(null);
              setImportError('');
            }}
            placeholder={t('token.importToken')}
            aria-label={t('token.importToken')}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            autoFocus
            className={quietField}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
          />
          <p
            style={{
              margin: 0,
              minHeight: '16px',
              fontSize: '12px',
              lineHeight: '16px',
              color: 'var(--neg)',
            }}
          >
            {importIsEvm ? (evmImport.problem ?? '') : importError}
          </p>
          {importIsEvm && (
            <>
              <DetectedNetwork detect={evmImport.detect} onPick={evmImport.pickNetwork} />
              <EvmTokenPreview imp={evmImport} />
            </>
          )}
          {!importIsEvm && importPreview && (
            <div
              className="flex! flex-col! rounded-xl! bg-(--bg-1)!"
              style={{ gap: '3px', padding: '12px' }}
            >
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: 'var(--fg)',
                  overflowWrap: 'anywhere',
                }}
              >
                {importPreview.name}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--fg-3)', overflowWrap: 'anywhere' }}>
                {importPreview.symbol} ({importPreview.decimals} decimals)
              </span>
            </div>
          )}
        </div>
      </Sheet>
      <NetworkSearchSheet detect={evmImport.detect} onPick={evmImport.pickNetwork} />
    </>
  );
}
