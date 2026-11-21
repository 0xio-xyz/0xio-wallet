import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { chainLogoUrl } from 'src/services/evm/chains';
import type { EvmNetwork } from 'src/services/evm/networks';
import type { NetworkDetect } from 'src/hooks/wallet/useNetworkDetect';
import { Mascot } from 'src/shared/ui/Mascot';
import { FieldLabel, Sheet, TextButton, quietField } from 'src/shared/ui/primitives';

export const NetworkLogo = ({
  network,
  size = 22,
}: {
  network: Pick<EvmNetwork, 'logoChainId' | 'name'>;
  size?: number;
}) => {
  const src = chainLogoUrl(network.logoChainId);
  return src ? (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className="rounded-full! shrink-0!"
      style={{ width: `${size}px`, height: `${size}px` }}
    />
  ) : (
    <span
      className="grid! place-items-center! rounded-full! bg-(--bg-3)! shrink-0!"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${Math.round(size * 0.45)}px`,
        fontWeight: 700,
        color: 'var(--fg-2)',
      }}
    >
      {network.name.slice(0, 1).toUpperCase()}
    </span>
  );
};

const rowStyle: React.CSSProperties = {
  gap: '10px',
  padding: '10px 12px',
  borderRadius: '12px',
  border: 'none',
  textAlign: 'left',
  width: '100%',
};

const NetworkText = ({ name, sub }: { name: string; sub: string }) => (
  <span className="flex! min-w-0! flex-1! flex-col!" style={{ gap: '2px' }}>
    <span className="truncate!" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
      {name}
    </span>
    <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>{sub}</span>
  </span>
);

export const NetworkRow = ({
  network,
  selected = false,
  onClick,
}: {
  network: EvmNetwork;
  selected?: boolean;
  onClick: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`press flex! items-center! cursor-pointer! transition-colors! duration-200! hover:bg-(--bg-2)! ${
        selected ? 'bg-(--bg-2)!' : 'bg-transparent!'
      }`}
      style={rowStyle}
    >
      <NetworkLogo network={network} />
      <NetworkText
        name={network.name}
        sub={t('evmDetect.chainId', { id: network.chainId, defaultValue: 'Chain {{id}}' })}
      />
    </button>
  );
};

export function DetectedNetwork({
  detect,
  onPick,
}: {
  detect: NetworkDetect;
  onPick: (network: EvmNetwork) => void;
}) {
  const { t } = useTranslation();
  const label = t('evmTokens.network', { defaultValue: 'Network' });
  if (detect.phase === 'idle' && !detect.network) return null;

  if (detect.phase === 'detecting') {
    return (
      <div className="flex! flex-col!" style={{ gap: '6px' }}>
        <FieldLabel>{label}</FieldLabel>
        <div className="flex! items-center! bg-(--bg-2)!" style={{ ...rowStyle, height: '52px' }}>
          <Mascot mood="loading" size={18} hole="var(--bg-2)" />
          <span style={{ fontSize: '12.5px', color: 'var(--fg-3)' }}>
            {t('evmDetect.checking', {
              count: detect.asked,
              defaultValue: 'Checking {{count}} networks',
            })}
          </span>
        </div>
      </div>
    );
  }

  if (detect.network) {
    const found = !!detect.match;
    return (
      <div className="flex! flex-col! animate-in! fade-in! duration-200!" style={{ gap: '6px' }}>
        <FieldLabel>{label}</FieldLabel>
        <div className="flex! items-center! bg-(--bg-2)!" style={rowStyle}>
          <NetworkLogo network={detect.network} />
          <NetworkText
            name={detect.network.name}
            sub={
              found
                ? t('evmDetect.foundHere', { defaultValue: 'Found here' })
                : t('evmDetect.chainId', {
                    id: detect.network.chainId,
                    defaultValue: 'Chain {{id}}',
                  })
            }
          />
          <TextButton size={12} onClick={detect.openSearch}>
            {t('evmDetect.change', { defaultValue: 'Change' })}
          </TextButton>
        </div>
      </div>
    );
  }

  if (detect.matches.length > 1) {
    return (
      <div className="flex! flex-col! animate-in! fade-in! duration-200!" style={{ gap: '6px' }}>
        <FieldLabel>
          {t('evmDetect.foundOn', {
            count: detect.matches.length,
            defaultValue: 'Found on {{count}} networks. Select one',
          })}
        </FieldLabel>
        <div className="flex! flex-col!" style={{ gap: '2px' }}>
          {detect.matches.map((m) => (
            <NetworkRow
              key={m.network.chainId}
              network={m.network}
              onClick={() => onPick(m.network)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex! flex-col! animate-in! fade-in! duration-200!" style={{ gap: '6px' }}>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex! items-center! bg-(--bg-2)!" style={{ ...rowStyle, height: '52px' }}>
        <span className="flex-1!" style={{ fontSize: '12.5px', color: 'var(--fg-3)' }}>
          {detect.unreachable.length > 0
            ? t('evmDetect.notFoundSome', {
                count: detect.unreachable.length,
                defaultValue: 'Not found. {{count}} networks did not respond',
              })
            : t('evmDetect.notFound', { defaultValue: 'Not found on any known network' })}
        </span>
        <TextButton size={12} onClick={detect.openSearch}>
          {t('evmDetect.choose', { defaultValue: 'Choose' })}
        </TextButton>
      </div>
    </div>
  );
}

const SectionCaps = ({ children }: { children: React.ReactNode }) => (
  <span
    className="tab-caps"
    style={{ display: 'block', color: 'var(--fg-3)', padding: '10px 4px 6px' }}
  >
    {children}
  </span>
);

export function NetworkSearchSheet({
  detect,
  onPick,
}: {
  detect: NetworkDetect;
  onPick: (network: EvmNetwork) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const close = () => {
    setQuery('');
    detect.closeSearch();
  };
  const pick = (n: EvmNetwork) => {
    setQuery('');
    onPick(n);
  };
  const q = query.trim().toLowerCase();
  const sorted = [...detect.networks].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
  const shown = q
    ? sorted.filter((n) => n.name.toLowerCase().includes(q) || String(n.chainId).includes(q))
    : sorted;
  const recent = q
    ? []
    : detect.recent
        .map((id) => detect.networks.find((n) => n.chainId === id))
        .filter((n): n is EvmNetwork => !!n);
  const selected = detect.network?.chainId;
  const row = (n: EvmNetwork, prefix: string) => (
    <NetworkRow
      key={`${prefix}${n.chainId}`}
      network={n}
      selected={n.chainId === selected}
      onClick={() => pick(n)}
    />
  );

  return (
    <Sheet
      open={detect.searchOpen}
      onClose={close}
      zIndexClass="z-picker!"
      title={t('evmDetect.chooseTitle', { defaultValue: 'Choose a network' })}
      pinned={
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value.slice(0, 40))}
          placeholder={t('evmDetect.search', { defaultValue: 'Search networks' })}
          aria-label={t('evmDetect.search', { defaultValue: 'Search networks' })}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          className={quietField.replace('bg-(--bg-1)!', 'bg-(--bg-2)!')}
        />
      }
    >
      {recent.length > 0 && (
        <>
          <SectionCaps>{t('evmDetect.recent', { defaultValue: 'Recent' })}</SectionCaps>
          {recent.map((n) => row(n, 'r'))}
        </>
      )}
      {!q && (
        <SectionCaps>{t('evmDetect.allAz', { defaultValue: 'All networks A to Z' })}</SectionCaps>
      )}
      {shown.length === 0 ? (
        <p style={{ margin: '12px 4px', fontSize: '12.5px', color: 'var(--fg-3)' }}>
          {t('evmDetect.noResults', { defaultValue: 'No matching networks' })}
        </p>
      ) : (
        shown.map((n) => row(n, 'a'))
      )}
    </Sheet>
  );
}
