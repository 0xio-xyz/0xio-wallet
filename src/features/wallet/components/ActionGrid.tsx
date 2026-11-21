import React, { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useNavigate } from 'src/lib/router';
import { ArrowUp, ArrowDown, Shield, ArrowUpDown, History } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import { networkCapabilities } from 'src/utils/network';
import useBackupPending from 'src/hooks/wallet/useBackupPending';
import BackupFirstSheet from './BackupFirstSheet';
import { Sheet } from 'src/shared/ui/primitives';
import { OctraGlyph, EvmGlyph } from 'src/shared/ui/ChainGlyph';
import type { HomeView } from 'src/hooks/wallet/useHomeView';

const ActionGrid = ({ view = 'oct', evmOn = false }: { view?: HomeView; evmOn?: boolean }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { networkId, activeWallet } = useWallet();
  const backupPending = useBackupPending(activeWallet);
  const [gate, setGate] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [choose, setChoose] = useState(false);

  const evmOnly = view === 'evm';
  const allQuiet = [
    {
      id: 'bridge',
      icon: ArrowUpDown,
      label: t('widget.bridge', { defaultValue: 'Bridge' }),
      path: '/bridge',
      disabled: false,
    },
    {
      id: 'privacy',
      icon: Shield,
      label: t('widget.privacy'),
      path: '/privacy',
      disabled: evmOnly || !networkCapabilities(networkId).privacy,
    },
    {
      id: 'history',
      icon: History,
      label: t('action.history'),
      path: '/history',
      disabled: false,
    },
  ];

  const receive = () =>
    backupPending
      ? setGate(true)
      : navigate('/receive', { state: { tab: evmOnly ? 'evm' : 'oct' } });
  const dock = [
    { id: 'receive', icon: ArrowDown, label: t('action.receive'), go: receive, disabled: false },
    ...allQuiet.map((q) => ({ ...q, go: () => navigate(q.path) })),
  ];
  const tip = dock.find((d) => d.id === hover);
  const tipIndex = dock.findIndex((d) => d.id === hover);
  const tipText =
    evmOnly && tip?.id === 'privacy'
      ? t('home.evmPublicNote', {
          defaultValue: 'EVM networks are public. Private balances are on Octra only.',
        })
      : (tip?.label ?? '');
  const tipLong = tipText.length > 24;

  return (
    <div className="flex!" style={{ padding: '0 0 12px', gap: '8px' }}>
      <button
        onClick={() =>
          evmOnly
            ? navigate('/send/evm')
            : view === 'all' && evmOn
              ? setChoose(true)
              : navigate('/send')
        }
        className="press flex! shrink-0! items-center! justify-center!"
        style={{
          width: '112px',
          height: '40px',
          gap: '7px',
          borderRadius: '20px',
          border: 'none',
          background: 'var(--fg)',
          color: 'var(--bg)',
          boxShadow: '0 10px 24px -10px rgba(0, 0, 0, 0.6)',
          fontSize: '11px',
          fontWeight: 600,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        <ArrowUp size={14} />
        {t('action.send')}
      </button>
      <div
        className="relative! flex! flex-1! items-center! bg-(--bg-1)!"
        style={{ height: '40px', padding: '0 4px', borderRadius: '20px' }}
        onMouseLeave={() => setHover(null)}
      >
        {dock.map(({ id, icon: Icon, label, go, disabled }) => (
          <button
            key={id}
            onClick={() => !disabled && go()}
            aria-disabled={disabled}
            aria-label={label}
            onMouseEnter={() => setHover(id)}
            onFocus={() => setHover(id)}
            onBlur={() => setHover(null)}
            className={`press grid! flex-1! place-items-center! transition-colors! duration-150! ${
              disabled ? 'cursor-not-allowed!' : 'cursor-pointer! hover:bg-(--bg-2)!'
            }`}
            style={{
              height: '32px',
              borderRadius: '16px',
              border: 'none',
              background: 'transparent',
              color: 'var(--fg)',
              opacity: disabled ? 0.35 : 1,
            }}
          >
            <Icon size={15} />
          </button>
        ))}
        {tip && (
          <span
            role="tooltip"
            className="absolute! z-dropdown! bg-(--bg-3)!"
            style={{
              bottom: 'calc(100% + 6px)',
              ...(tipLong
                ? { right: 0, width: '200px', whiteSpace: 'normal', lineHeight: 1.4 }
                : {
                    left: `calc(4px + (100% - 8px) * ${(tipIndex + 0.5) / dock.length})`,
                    transform: 'translateX(-50%)',
                    whiteSpace: 'nowrap',
                  }),
              padding: '5px 9px',
              borderRadius: '8px',
              boxShadow: '0 8px 20px rgba(0, 0, 0, 0.45)',
              fontSize: '11px',
              color: 'var(--fg)',
              pointerEvents: 'none',
            }}
          >
            {tipText}
          </span>
        )}
      </div>

      <BackupFirstSheet open={gate} onClose={() => setGate(false)} />
      <Sheet
        open={choose}
        onClose={() => setChoose(false)}
        title={t('home.sendOn', { defaultValue: 'Send on' })}
      >
        {[
          {
            id: 'oct',
            name: 'Octra',
            glyph: <OctraGlyph size={16} />,
            path: '/send',
          },
          {
            id: 'evm',
            name: 'EVM',
            glyph: <EvmGlyph size={16} />,
            path: '/send/evm',
          },
        ].map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => {
              setChoose(false);
              navigate(o.path);
            }}
            className="press flex! w-full! items-center! rounded-[16px]! hover:bg-(--bg-2)!"
            style={{
              gap: '12px',
              padding: '12px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              color: 'var(--fg)',
            }}
          >
            <span
              className="grid! place-items-center! rounded-full! bg-(--bg-2)!"
              style={{ width: '36px', height: '36px' }}
            >
              {o.glyph}
            </span>
            <span style={{ fontSize: '14px' }}>{o.name}</span>
          </button>
        ))}
      </Sheet>
    </div>
  );
};

export default React.memo(ActionGrid);
