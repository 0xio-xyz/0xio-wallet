import React, { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { Layers } from 'src/shared/ui/icons';
import { OctraGlyph, EvmGlyph } from 'src/shared/ui/ChainGlyph';
import { middleCut } from 'src/features/wallet/add/format';
import type { HomeView } from 'src/hooks/wallet/useHomeView';

interface Cell {
  id: HomeView;
  name: string;
  address: string | null;
  glyph: React.ReactNode;
}

const HomeNetworkSwitch = ({
  view,
  onChange,
  octraAddress,
  evmAddress,
}: {
  view: HomeView;
  onChange: (view: HomeView) => void;
  octraAddress: string;
  evmAddress: string | null;
}) => {
  const { t } = useTranslation();
  const [hover, setHover] = useState<HomeView | null>(null);

  const cells: Cell[] = [
    {
      id: 'all',
      name: t('home.allNetworks', { defaultValue: 'All networks' }),
      address: null,
      glyph: <Layers size={14} aria-hidden="true" />,
    },
    { id: 'oct', name: 'Octra', address: octraAddress, glyph: <OctraGlyph size={14} /> },
    {
      id: 'evm',
      name: 'EVM',
      address: evmAddress,
      glyph: <EvmGlyph size={14} />,
    },
  ];
  const tip = cells.find((c) => c.id === hover);

  return (
    <div className="relative! shrink-0!" onMouseLeave={() => setHover(null)}>
      <div
        role="radiogroup"
        aria-label={t('home.networkSwitch', { defaultValue: 'Networks shown' })}
        className="flex! bg-(--bg-1)!"
        style={{ gap: '2px', padding: '2px', borderRadius: '9px' }}
      >
        {cells.map((c) => {
          const on = c.id === view;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={c.name}
              onClick={() => onChange(c.id)}
              onMouseEnter={() => setHover(c.id)}
              onFocus={() => setHover(c.id)}
              onBlur={() => setHover(null)}
              className="press grid! place-items-center!"
              style={{
                width: '28px',
                height: '24px',
                borderRadius: '7px',
                border: 'none',
                cursor: 'pointer',
                color: on ? 'var(--fg)' : 'var(--fg-3)',
                background: on ? 'var(--bg-3)' : 'transparent',
              }}
            >
              {c.glyph}
            </button>
          );
        })}
      </div>
      {tip && (
        <div
          role="tooltip"
          className="absolute! z-dropdown! bg-(--bg-3)!"
          style={{
            right: 0,
            top: 'calc(100% + 8px)',
            width: '200px',
            padding: '9px 11px',
            borderRadius: '10px',
            boxShadow: '0 12px 30px rgba(0, 0, 0, 0.45)',
            fontSize: '11px',
            lineHeight: 1.45,
            pointerEvents: 'none',
          }}
        >
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg)' }}>{tip.name}</span>
          {tip.address && (
            <span
              style={{
                marginLeft: '6px',
                fontFamily: 'var(--font-mono)',
                fontSize: '10.5px',
                color: 'var(--fg-3)',
              }}
            >
              {middleCut(tip.address, 6, 4)}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default HomeNetworkSwitch;
