import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import {
  Sheet,
  RuledList,
  ListRow,
  PrimaryButton,
  QuietInput,
  Facts,
} from 'src/shared/ui/primitives';
import { logger } from 'src/utils/logger';
import { validateNftContract } from 'src/features/wallet/nft/nftData';
import { normalizeAddress, OCT_ADDRESS_LENGTH } from 'src/utils/octra/address';
import { useEvmNftImport, type EvmNftImport } from 'src/hooks/wallet/useEvmNftImport';
import type { EvmNft } from 'src/services/evm/nfts';
import {
  DetectedNetwork,
  NetworkSearchSheet,
} from 'src/features/wallet/components/EvmNetworkPicker';
import { evmNftName } from 'src/features/wallet/nft/evm/deriveEvmGallery';
import { EvmNftArt } from 'src/features/wallet/nft/evm/EvmNftParts';

interface Props {
  ownAddress: string;
  shown: Set<string>;
  onImport: (address: string) => Promise<void>;
  evmOwner: string | null;
  onImportEvm: (nft: EvmNft) => Promise<void>;
  onClose: () => void;
}

function EvmPreview({ imp }: { imp: EvmNftImport }) {
  const { t } = useTranslation();
  const p = imp.preview;
  if (!p) return null;
  return (
    <div
      className="flex! items-center! bg-(--bg-2)! animate-in! fade-in! duration-200!"
      style={{ gap: '12px', padding: '10px', borderRadius: '14px' }}
    >
      <span
        className="relative! shrink-0! overflow-hidden! bg-(--bg-3)!"
        style={{ width: '56px', height: '56px', borderRadius: '10px' }}
      >
        <EvmNftArt nft={p} />
      </span>
      <span className="flex! min-w-0! flex-col!" style={{ gap: '3px' }}>
        <span
          className="truncate!"
          style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--fg)' }}
        >
          {evmNftName(p)}
        </span>
        <span className="truncate!" style={{ fontSize: '11.5px', color: 'var(--fg-3)' }}>
          {p.standard === 'ERC-721'
            ? t('evmNft.owned721', { defaultValue: 'ERC-721 owned by this wallet' })
            : t('evmNft.owned1155', {
                count: Number(p.amount),
                defaultValue: '{{count}} owned by this wallet (ERC-1155)',
              })}
        </span>
      </span>
    </div>
  );
}

export function ImportSheet({
  ownAddress,
  shown,
  onImport,
  evmOwner,
  onImportEvm,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [address, setAddress] = useState('');
  const evm = useEvmNftImport(evmOwner);
  const isEvm = /^0x/i.test(address.trim());
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{
    name: string;
    symbol: string;
    totalSupply: string | null;
  } | null>(null);

  const find = async () => {
    const addr = address.trim();
    if (!addr || busy) return;
    if (!addr.startsWith('oct') || addr.length !== 47) {
      setError(
        t('nft.importBadAddress', {
          defaultValue:
            'Invalid address. A contract address starts with oct and has 47 characters.',
        })
      );
      return;
    }
    if (addr === ownAddress) {
      setError(
        t('nft.importOwnAddress', {
          defaultValue: 'This is a wallet address, not a collection contract.',
        })
      );
      return;
    }
    if (shown.has(addr.toLowerCase())) {
      setError(t('nft.importAlreadyShown', { defaultValue: 'Collection already added' }));
      return;
    }
    setBusy(true);
    setSlow(false);
    setError('');
    setPreview(null);
    const slowTimer = setTimeout(() => setSlow(true), 20_000);
    try {
      const info = await validateNftContract(addr);
      if (!info) setError(t('nft.importNotValid', { defaultValue: 'Invalid NFT contract' }));
      else setPreview(info);
    } catch (e) {
      logger.error(`[NFT Import] find failed: ${e}`);
      const node = e instanceof Error && e.message === 'NODE_UNREACHABLE';
      setError(
        node
          ? t('nft.importNodeDown', {
              defaultValue: 'Node not responding. Try again later.',
            })
          : t('nft.importFailed', { defaultValue: 'Could not read the contract' })
      );
    } finally {
      clearTimeout(slowTimer);
      setBusy(false);
      setSlow(false);
    }
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onImport(address.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const confirmEvm = async () => {
    if (busy || evm.phase !== 'ready') return;
    setBusy(true);
    try {
      const nft = await evm.add();
      if (!nft) return;
      await onImportEvm(nft);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (isEvm) void confirmEvm();
    else if (preview) void confirm();
    else void find();
  };

  const evmChecking = evm.detect.phase === 'detecting' || evm.phase === 'checking';

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        dismissible={!busy || (!preview && !isEvm)}
        title={t('nft.importCollectionTitle', { defaultValue: 'Import collection' })}
        onSubmit={submit}
        footer={
          isEvm ? (
            <PrimaryButton
              onClick={() => void confirmEvm()}
              disabled={evm.phase !== 'ready'}
              loading={busy || evmChecking}
            >
              {evmChecking
                ? t('nft.checking', { defaultValue: 'Checking' })
                : t('nft.importConfirm', { defaultValue: 'Import' })}
            </PrimaryButton>
          ) : preview ? (
            <PrimaryButton onClick={() => void confirm()} loading={busy}>
              {t('nft.importConfirm', { defaultValue: 'Import' })}
            </PrimaryButton>
          ) : (
            <PrimaryButton onClick={() => void find()} disabled={!address.trim()} loading={busy}>
              {busy
                ? t('nft.checking', { defaultValue: 'Checking' })
                : t('nft.find', { defaultValue: 'Find' })}
            </PrimaryButton>
          )
        }
      >
        <div className="flex! flex-col!" style={{ gap: '10px' }}>
          <QuietInput
            label={t('nft.contractAddress', { defaultValue: 'Contract address' })}
            value={address}
            maxLength={OCT_ADDRESS_LENGTH}
            onChange={(e) => {
              const next = normalizeAddress(e.target.value).slice(0, OCT_ADDRESS_LENGTH);
              setAddress(next);
              evm.setAddress(/^0x/i.test(next) ? next : '');
              setError('');
              setPreview(null);
            }}
            placeholder={t('nft.importPlaceholder', { defaultValue: 'oct or 0x address' })}
            className="font-mono!"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            autoFocus
            disabled={busy}
            note={
              isEvm
                ? (evm.problem ?? '')
                : busy && slow
                  ? t('nft.importSlow', {
                      defaultValue: 'Slow node. This can take up to 90 seconds.',
                    })
                  : error
            }
            noteTone={!isEvm && busy && slow ? 'muted' : 'neg'}
          />
          {isEvm && (
            <>
              <DetectedNetwork detect={evm.detect} onPick={evm.pickNetwork} />
              <QuietInput
                label={t('evmNft.tokenId', { defaultValue: 'Token ID' })}
                value={evm.tokenId}
                onChange={(e) => evm.setTokenId(e.target.value)}
                inputMode="numeric"
                placeholder="1"
                className="font-mono!"
                spellCheck={false}
                autoComplete="off"
              />
              <EvmPreview imp={evm} />
            </>
          )}
          {!isEvm && preview && (
            <RuledList>
              <ListRow
                label={preview.name}
                sub={
                  <Facts>
                    {preview.symbol && <span>{preview.symbol}</span>}
                    {preview.totalSupply && (
                      <span>
                        {t('nft.totalSupply', {
                          n: preview.totalSupply,
                          defaultValue: '{{n}} total',
                        })}
                      </span>
                    )}
                  </Facts>
                }
                chevron={false}
              />
            </RuledList>
          )}
        </div>
      </Sheet>
      <NetworkSearchSheet detect={evm.detect} onPick={evm.pickNetwork} />
    </>
  );
}
