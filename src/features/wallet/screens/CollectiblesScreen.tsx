import { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useNavigate } from 'src/lib/router';
import Header from 'src/shared/ui/Header';
import { Loading } from 'src/shared/ui/Skeleton';
import { TextButton } from 'src/shared/ui/primitives';
import { useWallet } from 'src/contexts/WalletContext';
import { useNftGallery } from 'src/features/wallet/nft/useNftGallery';
import { deriveGallery, type GalleryPiece } from 'src/features/wallet/nft/gallery/deriveGallery';
import { useNetworkSlowNotice } from 'src/features/wallet/nft/gallery/useNetworkSlow';
import { UndoBar } from 'src/features/wallet/nft/gallery/UndoBar';
import { isCollectionHidden, isPieceHidden } from 'src/features/wallet/nft/hidden';
import { newestFirst } from 'src/features/wallet/nft/firstSeen';
import {
  NftTile,
  CollectionRow,
  NftGridSkeleton,
  NftHomeSkeleton,
} from 'src/features/wallet/nft/gallery/NftTile';
import { PosterCaptureHost } from 'src/features/wallet/nft/gallery/PosterCaptureHost';
import { useItemsLabel } from 'src/features/wallet/nft/gallery/useItemsLabel';
import { DotsMenu } from 'src/features/wallet/nft/gallery/DotsMenu';
import { ImportSheet } from 'src/features/wallet/nft/gallery/ImportSheet';
import { NftPiecePage } from 'src/features/wallet/nft/piece/NftPiecePage';
import { useOnsContract } from 'src/hooks/wallet/useOnsContract';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import { useEvmNfts } from 'src/hooks/wallet/useEvmNfts';
import { chainLogoUrl } from 'src/services/evm/chains';
import { nftKey, type EvmNft } from 'src/services/evm/nfts';
import {
  deriveEvmGallery,
  evmNftName,
  type EvmCollection,
} from 'src/features/wallet/nft/evm/deriveEvmGallery';
import { EvmCollectionRow, EvmNftTile } from 'src/features/wallet/nft/evm/EvmNftParts';
import { EvmNftPage } from 'src/features/wallet/nft/evm/EvmNftPage';
import { writeClipboard } from 'src/utils/secretClipboard';

type View =
  | { kind: 'home' }
  | { kind: 'collection'; contract: string }
  | { kind: 'evmCollection'; key: string }
  | { kind: 'hidden' };

const OCTRA_LOGO = '/chains/octra/logo.webp';

export default function CollectiblesScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showMessage, activeWallet } = useWallet();
  const g = useNftGallery();
  const labels = useItemsLabel();
  useNetworkSlowNotice(() =>
    showMessage(
      t('nft.networkSlow', {
        defaultValue: 'Network congested. Loading and confirmations may be slow.',
      }),
      'warning'
    )
  );
  const { view: homeView, evmOn, evmAddress } = useHomeView();
  const showOct = homeView !== 'evm';
  const showEvm = evmOn && homeView !== 'oct';
  const evm = useEvmNfts(evmAddress, g.networkId, showEvm);
  const evmG = deriveEvmGallery(showEvm ? evm.items : [], evm.hidden);
  const evmNetwork = (chainId: number) => evm.networks.find((n) => n.chainId === chainId) ?? null;
  const evmLogo = (chainId: number) => chainLogoUrl(evmNetwork(chainId)?.logoChainId ?? chainId);
  const badges = showOct && showEvm;

  const scope = `${g.networkId}:${g.wallet}:${evmAddress ?? ''}:${homeView}`;
  const [viewAt, setViewAt] = useState<{ scope: string; view: View }>({
    scope,
    view: { kind: 'home' },
  });
  const [openAt, setOpenAt] = useState<{ scope: string; piece: GalleryPiece } | null>(null);
  const [openEvmAt, setOpenEvmAt] = useState<{ scope: string; key: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [undo, setUndo] = useState<{ id: number; text: string; revert: () => void } | null>(null);
  const undoSeq = useRef(0);

  const names = useOnsContract(g.networkId);
  const octra = deriveGallery(
    g.collections.map((c) =>
      c.contractAddress === names
        ? { ...c, name: t('nft.onsCollection', { defaultValue: 'Octra names' }) }
        : c
    ),
    g.ids,
    g.hidden
  );
  const { collections, visible } = octra;
  const hiddenPieces = showOct ? octra.hiddenPieces : [];
  const rows = showOct ? octra.rows : [];
  const octHiddenCount = showOct ? octra.hiddenCount : 0;
  const hiddenCount = octHiddenCount + evmG.hiddenItems.length;
  const newest = showOct ? newestFirst(visible, g.firstSeen, g.networkId, g.wallet, 3) : [];
  const evmCollections = evmG.collections;
  const listRows: (
    | { kind: 'oct'; row: (typeof rows)[number]; count: number; name: string }
    | { kind: 'evm'; coll: EvmCollection; count: number; name: string }
  )[] = [
    ...rows.map((row) => ({
      kind: 'oct' as const,
      row,
      count: row.count,
      name: row.collection.name,
    })),
    ...evmCollections.map((coll) => ({
      kind: 'evm' as const,
      coll,
      count: coll.pieces.length,
      name: coll.name,
    })),
  ].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );

  const raw = viewAt.scope === scope ? viewAt.view : { kind: 'home' as const };
  const view: View =
    raw.kind === 'collection' && !rows.some((r) => r.collection.contractAddress === raw.contract)
      ? { kind: 'home' }
      : raw.kind === 'evmCollection' && !evmCollections.some((c) => c.key === raw.key)
        ? { kind: 'home' }
        : raw.kind === 'hidden' &&
            hiddenCount === 0 &&
            hiddenPieces.length === 0 &&
            evmG.hiddenItems.length === 0
          ? { kind: 'home' }
          : raw;
  const setView = (v: View) => setViewAt({ scope, view: v });
  const open = openAt?.scope === scope ? openAt.piece : null;
  const openEvm =
    openEvmAt?.scope === scope
      ? (evm.items.find((n) => nftKey(n) === openEvmAt.key) ?? null)
      : null;
  const openEvmNetwork = openEvm ? evmNetwork(openEvm.chainId) : null;
  const openEvmColl =
    view.kind === 'evmCollection' ? (evmCollections.find((c) => c.key === view.key) ?? null) : null;
  const openColl =
    view.kind === 'collection'
      ? (collections.find((c) => c.contractAddress === view.contract) ?? null)
      : null;

  const offerUndo = (text: string, revert: () => void) => {
    setUndo({ id: ++undoSeq.current, text, revert });
  };
  const failedHide = () =>
    showMessage(
      t('nft.visibilityFailed', { defaultValue: 'Could not update visibility' }),
      'error'
    );

  const hidePiece = async (p: { contract: string; tokenId: string }, name: string) => {
    if (!(await g.hidePiece(p.contract, p.tokenId, true))) return failedHide();
    offerUndo(t('nft.hiddenName', { name, defaultValue: '{{name}} hidden' }), () => {
      void g.hidePiece(p.contract, p.tokenId, false);
    });
  };
  const hideCollection = async (contract: string, name: string) => {
    if (!(await g.hideCollection(contract, true))) return failedHide();
    offerUndo(t('nft.hiddenName', { name, defaultValue: '{{name}} hidden' }), () => {
      void g.hideCollection(contract, false);
    });
  };
  const hideEvmPiece = async (n: EvmNft) => {
    if (!(await evm.hidePiece(n, true))) return failedHide();
    offerUndo(t('nft.hiddenName', { name: evmNftName(n), defaultValue: '{{name}} hidden' }), () => {
      void evm.hidePiece(n, false);
    });
  };
  const hideEvmCollection = async (c: EvmCollection) => {
    if (!(await evm.hideCollection(c.chainId, c.contract, true))) return failedHide();
    offerUndo(t('nft.hiddenName', { name: c.name, defaultValue: '{{name}} hidden' }), () => {
      void evm.hideCollection(c.chainId, c.contract, false);
    });
  };
  const importEvm = async (n: EvmNft) => {
    const h = evm.hidden[n.chainId];
    if (h && isCollectionHidden(h, n.contract))
      await evm.hideCollection(n.chainId, n.contract, false);
    if (h && isPieceHidden(h, n.contract, n.tokenId)) await evm.hidePiece(n, false);
    evm.refresh();
  };
  const copy = (text: string): void => {
    writeClipboard(text).catch(() => {});
  };

  const tile = (p: GalleryPiece, hiddenAction?: { label: string; onClick: () => void }) => (
    <NftTile
      key={`${p.contract}:${p.tokenId}`}
      contract={p.contract}
      tokenId={p.tokenId}
      onOpen={() => setOpenAt({ scope, piece: p })}
      onGone={() => g.dropPiece(p.contract, p.tokenId)}
      hiddenAction={hiddenAction}
    />
  );
  const evmTile = (n: EvmNft, hiddenAction?: { label: string; onClick: () => void }) => (
    <EvmNftTile
      key={nftKey(n)}
      nft={n}
      onOpen={() => setOpenEvmAt({ scope, key: nftKey(n) })}
      hiddenAction={hiddenAction}
    />
  );
  const heading = (text: string) => (
    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)', marginBottom: '8px' }}>
      {text}
    </span>
  );
  const quiet = (text: string) => (
    <div
      className="h-full! flex! flex-col! items-center! justify-center! text-center!"
      style={{ gap: '8px', padding: '32px 24px' }}
    >
      <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{text}</span>
    </div>
  );
  const loadingLabel = t('common.loading', { defaultValue: 'Loading' });
  const loading = (
    <Loading label={loadingLabel}>
      <NftGridSkeleton />
    </Loading>
  );

  let title = t('nft.title', { defaultValue: 'NFTs' });
  let right: React.ReactNode = (
    <TextButton muted onClick={() => setImportOpen(true)}>
      {t('nft.import', { defaultValue: 'Import' })}
    </TextButton>
  );
  let body: React.ReactNode;

  if (view.kind === 'collection' && openColl) {
    const c = openColl;
    title = c.name;
    right = (
      <DotsMenu
        label={t('common.moreOptions', { defaultValue: 'More options' })}
        items={[
          {
            label: t('nft.hideCollection', { defaultValue: 'Hide this collection' }),
            onSelect: () => {
              setView({ kind: 'home' });
              void hideCollection(c.contractAddress, c.name);
            },
          },
          {
            label: t('nft.copyContractAddress', { defaultValue: 'Copy contract address' }),
            onSelect: () => copy(c.contractAddress),
          },
        ]}
      />
    );
    const pieces = visible.filter((p) => p.contract === c.contractAddress);
    body =
      pieces.length > 0 ? (
        <div className="grid! grid-cols-2!" style={{ gap: '12px' }}>
          {pieces.map((p) => tile(p))}
        </div>
      ) : g.failed[c.contractAddress] ? (
        <div
          className="flex! flex-col! items-center! text-center!"
          style={{ gap: '6px', padding: '32px 0' }}
        >
          <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
            {t('nft.loadFailed', { defaultValue: 'Could not load this collection from the node.' })}
          </span>
          <TextButton size={11} onClick={g.retryScan}>
            {t('common.retry', { defaultValue: 'Retry' })}
          </TextButton>
        </div>
      ) : g.ids[c.contractAddress] ? (
        quiet(t('nft.noOwnedNfts', { defaultValue: 'No NFTs owned in this collection' }))
      ) : (
        loading
      );
  } else if (view.kind === 'evmCollection' && openEvmColl) {
    const c = openEvmColl;
    title = c.name;
    right = (
      <DotsMenu
        label={t('common.moreOptions', { defaultValue: 'More options' })}
        items={[
          {
            label: t('nft.hideCollection', { defaultValue: 'Hide this collection' }),
            onSelect: () => {
              setView({ kind: 'home' });
              void hideEvmCollection(c);
            },
          },
          {
            label: t('nft.copyContractAddress', { defaultValue: 'Copy contract address' }),
            onSelect: () => copy(c.contract),
          },
        ]}
      />
    );
    body = (
      <div className="grid! grid-cols-2!" style={{ gap: '12px' }}>
        {c.pieces.map((n) => evmTile(n))}
      </div>
    );
  } else if (view.kind === 'hidden') {
    title = t('nft.hidden', { defaultValue: 'Hidden' });
    right = null;
    body =
      hiddenPieces.length === 0 && evmG.hiddenItems.length === 0 ? (
        loading
      ) : (
        <div className="grid! grid-cols-2!" style={{ gap: '12px' }}>
          {evmG.hiddenItems.map((n) => {
            const h = evm.hidden[n.chainId];
            const collHidden = !!h && isCollectionHidden(h, n.contract);
            const coll = n.collection ?? evmNftName(n);
            return evmTile(n, {
              label: collHidden
                ? t('nft.showName', { name: coll, defaultValue: 'Show {{name}}' })
                : t('common.show', { defaultValue: 'Show' }),
              onClick: () =>
                void (
                  collHidden
                    ? evm.hideCollection(n.chainId, n.contract, false)
                    : evm.hidePiece(n, false)
                ).then((ok) => ok || failedHide()),
            });
          })}
          {hiddenPieces.map((p) => {
            const collHidden = isCollectionHidden(g.hidden, p.contract);
            return tile(p, {
              label: collHidden
                ? t('nft.showName', { name: p.collection, defaultValue: 'Show {{name}}' })
                : t('common.show', { defaultValue: 'Show' }),
              onClick: () =>
                void (
                  collHidden
                    ? g.hideCollection(p.contract, false)
                    : g.hidePiece(p.contract, p.tokenId, false)
                ).then((ok) => ok || failedHide()),
            });
          })}
        </div>
      );
  } else if (
    listRows.length === 0 &&
    ((showOct && g.initialLoading && collections.length === 0) ||
      (showEvm && evm.loading && evm.items.length === 0))
  ) {
    body = (
      <Loading label={loadingLabel} className="flex! flex-col!" style={{ gap: '20px' }}>
        <NftHomeSkeleton />
      </Loading>
    );
  } else if (listRows.length === 0 && hiddenCount === 0) {
    body = (
      <div
        className="flex-1! flex! flex-col! items-center! justify-center! text-center!"
        style={{ gap: '4px', padding: '0 24px' }}
      >
        <span style={{ fontSize: '13px', color: 'var(--fg)' }}>
          {t('nft.emptyTitle', { defaultValue: 'No NFTs yet' })}
        </span>
      </div>
    );
  } else {
    body = (
      <>
        {newest.length > 0 && (
          <section className="flex! flex-col!">
            {heading(t('nft.newest', { defaultValue: 'Newest' }))}
            <div className="grid! grid-cols-3!" style={{ gap: '10px' }}>
              {newest.map((p) => tile(p))}
            </div>
          </section>
        )}
        <section className="flex! flex-col!">
          {listRows.length > 0 && heading(t('nft.collections', { defaultValue: 'Collections' }))}
          {listRows.map((r) =>
            r.kind === 'oct' ? (
              <CollectionRow
                key={r.row.collection.contractAddress}
                contract={r.row.collection.contractAddress}
                name={r.row.collection.name}
                count={labels.items(r.count)}
                thumbs={r.row.thumbs}
                badge={badges ? OCTRA_LOGO : null}
                onOpen={() =>
                  setView({ kind: 'collection', contract: r.row.collection.contractAddress })
                }
              />
            ) : (
              <EvmCollectionRow
                key={r.coll.key}
                name={r.coll.name}
                count={labels.items(r.count)}
                thumbs={r.coll.pieces.slice(0, 3)}
                logo={evmLogo(r.coll.chainId)}
                onOpen={() => setView({ kind: 'evmCollection', key: r.coll.key })}
              />
            )
          )}
          {hiddenCount > 0 && (
            <CollectionRow
              contract=""
              name={t('nft.hidden', { defaultValue: 'Hidden' })}
              count={labels.pieces(hiddenCount)}
              thumbs={[]}
              muted
              onOpen={() => setView({ kind: 'hidden' })}
            />
          )}
          {showEvm && evm.failedChains.length > 0 && (
            <p style={{ margin: '6px 0 0', fontSize: '11px', color: 'var(--fg-3)' }}>
              {t('evmNft.unreachable', {
                names: evm.networks
                  .filter((n) => evm.failedChains.includes(n.chainId))
                  .map((n) => n.name)
                  .join(' and '),
                defaultValue: '{{names}} unreachable. Some NFTs may be missing.',
              })}
            </p>
          )}
        </section>
      </>
    );
  }

  return (
    <div
      className="relative! w-full! h-full! flex! flex-col! overflow-hidden!"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      <Header
        title={title}
        showBack
        onBack={() => (view.kind === 'home' ? navigate(-1) : setView({ kind: 'home' }))}
        showSettings={false}
        rightAction={right ?? <div style={{ width: '32px' }} />}
      />
      <div
        key={
          view.kind === 'collection'
            ? view.contract
            : view.kind === 'evmCollection'
              ? view.key
              : view.kind
        }
        className="flex-1! min-h-0! overflow-y-auto! scrollbar-hide!"
      >
        <div
          className="min-h-full! flex! flex-col! animate-in! fade-in! duration-200!"
          style={{ gap: '20px', padding: '2px var(--gutter) 24px' }}
        >
          {body}
        </div>
      </div>

      {undo && (
        <UndoBar
          key={undo.id}
          text={undo.text}
          onUndo={undo.revert}
          onClose={() => setUndo((u) => (u?.id === undo.id ? null : u))}
        />
      )}

      <PosterCaptureHost paused={!!open} />

      {open && (
        <NftPiecePage
          key={`${scope}:${open.contract}:${open.tokenId}`}
          contract={open.contract}
          tokenId={open.tokenId}
          collection={open.collection}
          onClose={() => setOpenAt(null)}
          onHidePiece={(name) => {
            setOpenAt(null);
            void hidePiece(open, name);
          }}
          onHideCollection={() => {
            setOpenAt(null);
            void hideCollection(open.contract, open.collection);
          }}
          onGone={() => {
            setOpenAt(null);
            g.dropPiece(open.contract, open.tokenId);
            g.reload();
          }}
        />
      )}

      {openEvm && openEvmNetwork && (
        <EvmNftPage
          key={`${scope}:${nftKey(openEvm)}`}
          nft={openEvm}
          network={openEvmNetwork}
          canSend={!!evmAddress && activeWallet?.type !== 'watch'}
          onClose={() => setOpenEvmAt(null)}
          onHide={() => {
            setOpenEvmAt(null);
            void hideEvmPiece(openEvm);
          }}
          onSent={(sent) => {
            setOpenEvmAt(null);
            evm.dropItem(openEvm, sent);
            evm.refresh();
          }}
        />
      )}

      {importOpen && (
        <ImportSheet
          ownAddress={g.wallet}
          shown={new Set(octra.rows.map((r) => r.collection.contractAddress.toLowerCase()))}
          onImport={g.importCollection}
          evmOwner={evmOn ? evmAddress : null}
          onImportEvm={importEvm}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  );
}
