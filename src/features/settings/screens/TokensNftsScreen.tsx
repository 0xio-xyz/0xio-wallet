import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import Header from 'src/shared/ui/Header';
import { Mascot } from 'src/shared/ui/Mascot';
import { PrimaryButton, RuledList, Sheet, quietField } from 'src/shared/ui/primitives';
import { inputProps } from 'src/features/settings/components/networkForm';
import ImportTokenSheet from 'src/features/wallet/components/ImportTokenSheet';
import { ImportSheet } from 'src/features/wallet/nft/gallery/ImportSheet';
import { useItemsLabel } from 'src/features/wallet/nft/gallery/useItemsLabel';
import { isCollectionHidden, isPieceHidden } from 'src/features/wallet/nft/hidden';
import { useEvmNetworks } from 'src/hooks/wallet/useEvmBalances';
import { toChecksumAddress } from 'src/services/evm/accounts';
import { chainLogoUrl } from 'src/services/evm/chains';
import type { EvmNft } from 'src/services/evm/nfts';
import {
  matchesQuery,
  splitByVerdict,
  type ManageCollectionRow,
  type ManageTokenRow,
} from 'src/features/settings/tokens/manageRows';
import { useManageNfts, useManageTokens } from 'src/features/settings/tokens/useManageData';
import {
  CollectionCover,
  QuietAdd,
  QuietNote,
  SectionHead,
  Segmented,
  SwitchRow,
  TokenMark,
  type ManageTab,
} from 'src/features/settings/tokens/ManageParts';

const OCTRA_LOGO = '/chains/octra/logo.webp';

function useBadge() {
  const { networkId } = useWallet();
  const { networks } = useEvmNetworks(networkId);
  return (chainId: number | null) => {
    if (chainId === null) return OCTRA_LOGO;
    const n = networks.find((x) => x.chainId === chainId);
    return chainLogoUrl(n?.logoChainId ?? chainId);
  };
}

const Loading = () => (
  <div className="flex! justify-center!" style={{ padding: '32px 0' }}>
    <Mascot mood="loading" size={24} />
  </div>
);

function TokensTab() {
  const { t } = useTranslation();
  const { showMessage, showBalanceValues } = useWallet();
  const data = useManageTokens();
  const badge = useBadge();
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [opened, setOpened] = useState<ManageTokenRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const shown = data.rows.filter((r) => matchesQuery(r, query));
  const { regular, spam } = splitByVerdict(shown);

  const toggle = async (row: ManageTokenRow) => {
    if (!(await data.setShown(row, !row.shown))) {
      showMessage(t('manage.saveFailed', { defaultValue: 'Could not save. Try again.' }), 'error');
    }
  };

  const remove = async (r: ManageTokenRow) => {
    setRemoving(true);
    const ok = await data.remove(r);
    setRemoving(false);
    if (ok) setOpened(null);
    else
      showMessage(
        t('manage.removeFailed', { defaultValue: 'Could not remove it. Try again.' }),
        'error'
      );
  };

  const row = (r: ManageTokenRow, tag: string | null) => (
    <SwitchRow
      key={r.id}
      onOpen={r.origin === 'imported' ? () => setOpened(r) : undefined}
      mark={<TokenMark logo={r.logo} symbol={r.symbol} badge={badge(r.chainId)} dim={!r.shown} />}
      title={r.symbol}
      tag={tag}
      sub={r.network}
      value={r.amount === null ? null : showBalanceValues ? r.amount : '••••'}
      on={r.shown}
      label={r.symbol}
      onToggle={() => void toggle(r)}
    />
  );

  return (
    <>
      <input
        {...inputProps}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('manage.searchTokens', {
          count: data.rows.length,
          defaultValue: 'Search {{count}} tokens',
        })}
        aria-label={t('manage.searchTokensLabel', { defaultValue: 'Search tokens' })}
        className={quietField}
      />

      {data.loading ? (
        <Loading />
      ) : (
        <>
          {regular.length > 0 && (
            <>
              <SectionHead
                label={t('manage.shownOnHome', { defaultValue: 'Shown on Home' })}
                count={regular.length}
              />
              <RuledList>
                {regular.map((r) =>
                  row(
                    r,
                    r.origin === 'detected'
                      ? t('manage.detected', { defaultValue: 'Detected' })
                      : r.origin === 'imported'
                        ? t('manage.imported', { defaultValue: 'Imported' })
                        : null
                  )
                )}
              </RuledList>
            </>
          )}
          {spam.length > 0 && (
            <>
              <SectionHead
                label={t('manage.hiddenSpam', { defaultValue: 'Hidden as likely spam' })}
                count={spam.length}
              />
              <RuledList>
                {spam.map((r) => row(r, t('manage.likelySpam', { defaultValue: 'Likely spam' })))}
              </RuledList>
            </>
          )}
          {shown.length === 0 && (
            <QuietNote>
              {query.trim()
                ? t('manage.noTokenMatch', { defaultValue: 'No matching tokens' })
                : t('manage.noTokens', { defaultValue: 'No tokens here yet' })}
            </QuietNote>
          )}
        </>
      )}

      <QuietAdd
        label={t('manage.importToken', { defaultValue: '+ Import token' })}
        onClick={() => setImporting(true)}
      />
      {importing && <ImportTokenSheet onClose={() => setImporting(false)} octra={data.octra} />}
      {opened && (
        <Sheet
          open
          onClose={() => setOpened(null)}
          dismissible={!removing}
          title={opened.symbol}
          sub={opened.network}
          footer={
            <PrimaryButton secondary loading={removing} onClick={() => void remove(opened)}>
              {t('manage.removeToken', { defaultValue: 'Remove token' })}
            </PrimaryButton>
          }
        >
          <div className="flex! flex-col!" style={{ gap: '4px', padding: '0 0 6px' }}>
            <span style={{ fontSize: '13px', color: 'var(--fg-2)' }}>{opened.name}</span>
            <span
              style={{
                fontSize: '12px',
                color: 'var(--fg-3)',
                fontFamily: 'var(--font-mono)',
                wordBreak: 'break-all',
              }}
            >
              {opened.chainId === null ? opened.contract : toChecksumAddress(opened.contract)}
            </span>
          </div>
        </Sheet>
      )}
    </>
  );
}

function NftsTab() {
  const { t } = useTranslation();
  const { showMessage } = useWallet();
  const data = useManageNfts();
  const labels = useItemsLabel();
  const badge = useBadge();
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const { gallery: g, evm } = data;

  const shown = data.rows.filter((r) =>
    matchesQuery({ name: r.name, network: r.network, contract: r.contract }, query)
  );
  const { regular, spam } = splitByVerdict(shown);

  const toggle = async (row: ManageCollectionRow) => {
    if (!(await data.setShown(row, !row.shown))) {
      showMessage(t('manage.saveFailed', { defaultValue: 'Could not save. Try again.' }), 'error');
    }
  };

  const importEvm = async (n: EvmNft) => {
    const h = evm.hidden[n.chainId];
    if (h && isCollectionHidden(h, n.contract)) {
      await evm.hideCollection(n.chainId, n.contract, false);
    }
    if (h && isPieceHidden(h, n.contract, n.tokenId)) await evm.hidePiece(n, false);
    evm.refresh();
  };

  const row = (r: ManageCollectionRow, tag: string | null) => (
    <SwitchRow
      key={r.id}
      mark={
        <CollectionCover
          contract={r.contract}
          coverId={r.coverId}
          coverNft={r.coverNft}
          badge={badge(r.chainId)}
          dim={!r.shown}
        />
      }
      title={r.name}
      tag={tag}
      sub={r.network}
      value={labels.items(r.count)}
      on={r.shown}
      label={r.name}
      onToggle={() => void toggle(r)}
    />
  );

  return (
    <>
      <input
        {...inputProps}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('manage.searchNfts', {
          count: data.rows.length,
          defaultValue: 'Search {{count}} collections',
        })}
        aria-label={t('manage.searchNftsLabel', { defaultValue: 'Search collections' })}
        className={quietField}
      />

      {data.loading && data.rows.length === 0 ? (
        <Loading />
      ) : (
        <>
          {regular.length > 0 && (
            <>
              <SectionHead
                label={t('manage.shownOnHome', { defaultValue: 'Shown on Home' })}
                count={regular.length}
              />
              <RuledList>{regular.map((r) => row(r, null))}</RuledList>
            </>
          )}
          {spam.length > 0 && (
            <>
              <SectionHead
                label={t('manage.hiddenSpam', { defaultValue: 'Hidden as likely spam' })}
                count={spam.length}
              />
              <RuledList>
                {spam.map((r) => row(r, t('manage.likelySpam', { defaultValue: 'Likely spam' })))}
              </RuledList>
            </>
          )}
          {shown.length === 0 && (
            <QuietNote>
              {query.trim()
                ? t('manage.noNftMatch', { defaultValue: 'No matching collections' })
                : t('manage.noNfts', { defaultValue: 'No NFTs here yet' })}
            </QuietNote>
          )}
        </>
      )}

      <QuietAdd
        label={t('manage.importNft', { defaultValue: '+ Import NFT' })}
        onClick={() => setImporting(true)}
      />
      {importing && (
        <ImportSheet
          ownAddress={g.wallet}
          shown={
            new Set(
              data.rows
                .filter((r) => r.kind === 'oct' && r.shown)
                .map((r) => r.contract.toLowerCase())
            )
          }
          onImport={g.importCollection}
          evmOwner={data.evmOn ? data.evmAddress : null}
          onImportEvm={importEvm}
          onClose={() => setImporting(false)}
        />
      )}
    </>
  );
}

const TokensNftsScreen = () => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ManageTab>('tokens');

  return (
    <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
      <Header
        title={t('manage.title', { defaultValue: 'Tokens and NFTs' })}
        showBack
        showSettings={false}
      />
      <div className="shrink-0!" style={{ padding: '2px var(--gutter) 6px' }}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { id: 'tokens', label: t('manage.tokens', { defaultValue: 'Tokens' }) },
            { id: 'nfts', label: t('manage.nfts', { defaultValue: 'NFTs' }) },
          ]}
        />
      </div>
      <div
        key={tab}
        className="flex-1! overflow-y-auto! scrollbar-hide! animate-in! fade-in! duration-200!"
        style={{ padding: '6px var(--gutter) 24px' }}
      >
        {tab === 'tokens' ? <TokensTab /> : <NftsTab />}
      </div>
    </div>
  );
};

export default TokensNftsScreen;
