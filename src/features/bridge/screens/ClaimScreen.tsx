import React, { useState } from 'react';
import { ChevronRight, ExternalLink } from 'src/shared/ui/icons';
import { Navigate, useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import Header from 'src/shared/ui/Header';
import BridgeReviewSheet from 'src/features/bridge/components/BridgeReviewSheet';
import FindTransferSheet from 'src/features/bridge/components/FindTransferSheet';
import { FindButton } from 'src/features/bridge/components/HeaderPill';
import { useBridgeFlow } from 'src/features/bridge/useBridgeFlow';
import {
  WEB_BRIDGE_URL,
  defaultClaimTab,
  fmtRaw,
  type ClaimTab,
} from 'src/features/bridge/transfersView';
import { EvmTokenIcon } from 'src/features/wallet/components/TokenList';
import { PrimaryButton, RuledList, Sheet, TextButton } from 'src/shared/ui/primitives';
import { BRIDGE } from 'src/services/bridge/constants';
import { curatedEvmTokens } from 'src/services/evm/tokens';
import { CLAIM_DROPPED, type BridgeTransfer } from 'src/services/bridge/transfers';
import { evmTxUrl } from 'src/services/evm/history';

const W_OCT = curatedEvmTokens(1).find(
  (tok) => tok.address?.toLowerCase() === BRIDGE.wOCT.toLowerCase()
) ?? {
  chainId: 1,
  address: BRIDGE.wOCT,
  symbol: 'wOCT',
  name: 'Wrapped OCT',
  decimals: 6,
  logo: '/chains/octra/logo.webp',
};

const WEB_BRIDGE_HOST = new URL(WEB_BRIDGE_URL).host;

const TABS: readonly ClaimTab[] = ['ready', 'moving', 'done'];

const WayRow = ({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className="flex! w-full! items-center! justify-between! rounded-[14px]! text-left! transition-colors! duration-200! hover:bg-(--bg-2)!"
    style={{
      height: '52px',
      padding: '0 12px',
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      fontSize: '14px',
      color: 'var(--fg)',
    }}
  >
    {label}
    <span className="flex! shrink-0!" style={{ color: 'var(--fg-3)' }}>
      {icon}
    </span>
  </button>
);

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const openWeb = () => window.open(WEB_BRIDGE_URL, '_blank', 'noopener');

const TransferRow = ({
  tr,
  sub,
  subTone = 'muted',
  right,
}: {
  tr: BridgeTransfer;
  sub: string;
  subTone?: 'muted' | 'neg';
  right?: React.ReactNode;
}) => (
  <div className="flex! items-center!" style={{ gap: '12px', padding: '13px 0' }}>
    <EvmTokenIcon row={{ chainId: 1, token: W_OCT }} size={30} />
    <span className="flex! min-w-0! flex-1! flex-col!">
      <span
        className="truncate!"
        style={{
          fontSize: '20px',
          fontWeight: 300,
          lineHeight: 1.15,
          letterSpacing: '-0.03em',
          color: 'var(--fg)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {fmtRaw(BigInt(tr.amountRaw))}
        <span
          style={{ marginLeft: '6px', fontSize: '10px', letterSpacing: 0, color: 'var(--fg-3)' }}
        >
          wOCT
        </span>
      </span>
      <span
        style={{
          marginTop: '3px',
          fontSize: '11px',
          lineHeight: 1.45,
          color: subTone === 'neg' ? 'var(--neg)' : 'var(--fg-3)',
        }}
      >
        {sub}
      </span>
    </span>
    {right && <span className="shrink-0!">{right}</span>}
  </div>
);

const Segments = ({
  value,
  options,
  onChange,
}: {
  value: ClaimTab;
  options: { id: ClaimTab; label: string; count: number }[];
  onChange: (id: ClaimTab) => void;
}) => (
  <div
    role="tablist"
    className="flex! rounded-xl! bg-(--bg-1)!"
    style={{ padding: '3px', gap: '2px' }}
  >
    {options.map((o) => {
      const on = o.id === value;
      return (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={on}
          onClick={() => onChange(o.id)}
          className={`press flex! flex-1! items-center! justify-center! rounded-[9px]! ${
            on ? 'bg-(--bg-3)! text-(--fg)!' : 'bg-transparent! text-(--fg-3)! hover:text-(--fg-2)!'
          }`}
          style={{
            height: '30px',
            gap: '6px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            transition: 'background-color 200ms ease-out, color 200ms ease-out',
          }}
        >
          {o.label}
          {o.count > 0 && (
            <span style={{ fontWeight: on ? 600 : 400, fontVariantNumeric: 'tabular-nums' }}>
              {o.count}
            </span>
          )}
        </button>
      );
    })}
  </div>
);

const KEY_STYLE: React.CSSProperties = {
  height: '34px',
  width: 'auto',
  padding: '0 18px',
  borderRadius: '17px',
  fontSize: '11px',
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
};

const ClaimScreen = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const flow = useBridgeFlow();
  const [findOpen, setFindOpen] = useState(false);
  const [addEvmOpen, setAddEvmOpen] = useState(false);
  const [picked, setPicked] = useState<{ scope: string; tab: ClaimTab } | null>(null);

  if (!flow.ready) return <Navigate to="/bridge" replace />;

  const { groups, keyless } = flow;
  const scope = `${flow.networkId}:${flow.activeWallet?.id ?? ''}`;
  const tab =
    picked?.scope === scope ? picked.tab : flow.loaded ? defaultClaimTab(groups) : 'ready';
  const rows = groups[tab];

  const labels: Record<ClaimTab, string> = {
    ready: t('bridge.readyTab', { defaultValue: 'Ready' }),
    moving: t('bridge.movingTitle', { defaultValue: 'In progress' }),
    done: t('bridge.doneTitle', { defaultValue: 'Completed' }),
  };
  const empty: Record<ClaimTab, string> = {
    ready: t('bridge.emptyReady', { defaultValue: 'Nothing ready to claim' }),
    moving: t('bridge.emptyMoving', { defaultValue: 'Nothing in progress' }),
    done: t('bridge.emptyDone', { defaultValue: 'No completed transfers' }),
  };

  const row = (tr: BridgeTransfer) => {
    if (tab === 'ready')
      return (
        <TransferRow
          key={tr.id}
          tr={tr}
          sub={
            tr.note === 'claim_failed' || tr.note === CLAIM_DROPPED
              ? flow.statusText(tr)
              : t('bridge.lockedOn', {
                  defaultValue: 'Sent to Ethereum {{date}}',
                  date: day(tr.createdAt),
                })
          }
          right={
            keyless ? undefined : (
              <PrimaryButton
                onClick={() => void flow.openClaim(tr)}
                disabled={flow.busy}
                loading={flow.preparing === tr.id}
                style={KEY_STYLE}
              >
                {t('bridge.claim', { defaultValue: 'Claim' })}
              </PrimaryButton>
            )
          }
        />
      );
    if (tab === 'moving')
      return (
        <TransferRow
          key={tr.id}
          tr={tr}
          sub={flow.statusText(tr)}
          right={
            <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>{day(tr.createdAt)}</span>
          }
        />
      );
    const link = tr.claimHash ? evmTxUrl(1, tr.claimHash) : null;
    return (
      <TransferRow
        key={tr.id}
        tr={tr}
        subTone={tr.status === 'failed' ? 'neg' : 'muted'}
        sub={
          tr.status === 'failed'
            ? flow.statusText(tr)
            : t('bridge.claimedOn', { defaultValue: 'Claimed {{date}}', date: day(tr.updatedAt) })
        }
        right={
          link ? (
            <TextButton size={12} onClick={() => window.open(link, '_blank', 'noopener')}>
              {t('bridge.explorer', { defaultValue: 'Explorer' })}
            </TextButton>
          ) : undefined
        }
      />
    );
  };

  return (
    <div className="flex! h-full! flex-col! bg-(--bg)!">
      <Header
        title={t('bridge.claim', { defaultValue: 'Claim' })}
        showBack
        showSettings={false}
        onBack={() => navigate('/bridge')}
        rightAction={
          <FindButton
            label={t('bridge.findTitle', { defaultValue: 'Find a transfer' })}
            onClick={() => setFindOpen(true)}
          />
        }
      />
      <div className="shrink-0!" style={{ padding: '2px var(--gutter) 12px' }}>
        {keyless && (
          <div
            className="rounded-[18px]! bg-(--bg-1)!"
            style={{ padding: '12px 14px', marginBottom: '12px' }}
          >
            <p style={{ margin: 0, fontSize: '12.5px', lineHeight: 1.5, color: 'var(--fg-2)' }}>
              {t('bridge.noEvmKey', {
                defaultValue:
                  'No EVM wallet detected. Claim with any EVM wallet at {{host}}, or add your EVM phrase to 0xio.',
                host: WEB_BRIDGE_HOST,
              })}
            </p>
            <div className="flex! items-center!" style={{ gap: '18px', marginTop: '10px' }}>
              <TextButton size={12} onClick={openWeb}>
                {t('bridge.openHost', { defaultValue: 'Open {{host}}', host: WEB_BRIDGE_HOST })}
              </TextButton>
              <TextButton size={12} onClick={() => setAddEvmOpen(true)}>
                {t('bridge.addEvm', { defaultValue: 'Add EVM' })}
              </TextButton>
            </div>
          </div>
        )}
        <Segments
          value={tab}
          options={TABS.map((id) => ({ id, label: labels[id], count: groups[id].length }))}
          onChange={(id) => setPicked({ scope, tab: id })}
        />
      </div>
      <div
        className="flex! min-h-0! flex-1! flex-col! overflow-y-auto! scrollbar-hide!"
        style={{ padding: '2px var(--gutter) 20px' }}
      >
        <div
          key={tab}
          role="tabpanel"
          className="flex! flex-1! flex-col! animate-in! fade-in! duration-200! ease-out!"
        >
          {rows.length > 0 ? (
            <RuledList style={{ padding: '2px 14px' }}>{rows.map(row)}</RuledList>
          ) : (
            flow.loaded && (
              <p
                className="grid! flex-1! place-items-center! text-center!"
                style={{ margin: 0, fontSize: '12.5px', color: 'var(--fg-3)' }}
              >
                {empty[tab]}
              </p>
            )
          )}
        </div>
      </div>

      <FindTransferSheet flow={flow} open={findOpen} onClose={() => setFindOpen(false)} />

      <Sheet
        open={addEvmOpen}
        onClose={() => setAddEvmOpen(false)}
        title={t('bridge.addEvmTitle', { defaultValue: 'Add EVM' })}
      >
        <div className="flex! flex-col!" style={{ gap: '2px' }}>
          <WayRow
            label={t('bridge.importPhrase', { defaultValue: 'Import recovery phrase' })}
            icon={<ChevronRight size={12} />}
            onClick={() => navigate('/walletlist', { state: { add: 'import' } })}
          />
          <WayRow
            label={t('bridge.claimOnHost', {
              defaultValue: 'Claim on {{host}}',
              host: WEB_BRIDGE_HOST,
            })}
            icon={<ExternalLink size={12} />}
            onClick={openWeb}
          />
        </div>
      </Sheet>

      <BridgeReviewSheet flow={flow} />
    </div>
  );
};

export default ClaimScreen;
