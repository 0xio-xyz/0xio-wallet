import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { useWallet } from 'src/contexts/WalletContext';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { networkService } from 'src/services/network/NetworkService';
import { resolveNetworkPin } from 'src/services/network/txScope';
import { sanitizeText } from 'src/lib/sanitize';
import type { NetworkId } from 'src/utils/config';

const middleCut = (address: string) =>
  address.length > 20 ? `${address.slice(0, 8)}...${address.slice(-6)}` : address;

const SignerBalance = ({ address, networkId }: { address: string; networkId?: string }) => {
  const [balance, setBalance] = useState<number | null>(null);

  useMountEffect(() => {
    let live = true;
    (async () => {
      try {
        const pin = await resolveNetworkPin(networkId as NetworkId | undefined);
        const res = await networkService.getBalance(address, false, pin);
        if (live && res.success && typeof res.balance === 'number') setBalance(res.balance);
      } catch {}
    })();
    return () => {
      live = false;
    };
  });

  if (balance == null) return null;
  const parts = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).formatToParts(
    balance
  );
  const isDecimal = (p: Intl.NumberFormatPart) => p.type === 'decimal' || p.type === 'fraction';
  const whole = parts
    .filter((p) => !isDecimal(p))
    .map((p) => p.value)
    .join('');
  const decimals = parts
    .filter(isDecimal)
    .map((p) => p.value)
    .join('');
  return (
    <span
      style={{
        fontSize: '13px',
        fontWeight: 600,
        color: 'var(--fg)',
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 0,
      }}
    >
      {whole}
      {decimals && <span style={{ color: 'var(--fg-3)' }}>{decimals}</span>} OCT
    </span>
  );
};

interface SignerRowProps {
  address: string;
  networkId?: string;
  pickable: boolean;
  disabled?: boolean;
  onPick: (address: string) => void;
}

const SignerRow = ({ address, networkId, pickable, disabled, onPick }: SignerRowProps) => {
  const { t } = useTranslation();
  const { wallets } = useWallet();
  const [open, setOpen] = useState(false);

  const signable = wallets.filter((w) => w.type !== 'watch' && !!w.privateKey);
  const canPick = pickable && !disabled && signable.length > 1;
  const name = wallets.find((w) => w.address === address)?.name || t('common.wallet');

  return (
    <div style={{ position: 'relative' }}>
      {open && canPick && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 20 }}
            aria-hidden="true"
          />
          <div
            role="listbox"
            aria-label={t('dapp.signWith', { defaultValue: 'Sign with' })}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 'calc(100% + 8px)',
              zIndex: 21,
              padding: '6px',
              borderRadius: '14px',
              backgroundColor: 'var(--bg-1)',
              border: 'none',
              boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
              maxHeight: '260px',
              overflowY: 'auto',
            }}
          >
            <span
              style={{
                display: 'block',
                padding: '6px 8px',
                fontSize: '12px',
                color: 'var(--fg-3)',
              }}
            >
              {t('dapp.signWith', { defaultValue: 'Sign with' })}
            </span>
            {signable.map((w) => (
              <button
                key={w.id}
                type="button"
                role="option"
                aria-selected={w.address === address}
                onClick={() => {
                  onPick(w.address);
                  setOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  padding: '8px',
                  borderRadius: '10px',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: 'var(--fg)',
                  fontSize: '13px',
                  backgroundColor: w.address === address ? 'var(--bg-2)' : 'transparent',
                }}
              >
                <WalletAvatar address={w.address} size={20} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {sanitizeText(w.name)}
                </span>
              </button>
            ))}
            <span
              style={{
                display: 'block',
                padding: '6px 8px 4px',
                fontSize: '12px',
                color: 'var(--fg-3)',
              }}
            >
              {t('dapp.signWithNote', { defaultValue: 'The site moves to the wallet you pick' })}
            </span>
          </div>
        </>
      )}
      <button
        type="button"
        onClick={() => canPick && setOpen((v) => !v)}
        aria-haspopup={canPick ? 'listbox' : undefined}
        aria-expanded={canPick ? open : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          width: '100%',
          padding: '12px 14px',
          borderRadius: '14px',
          border: 'none',
          backgroundColor: 'var(--bg-1)',
          textAlign: 'left',
          cursor: canPick ? 'pointer' : 'default',
          color: 'var(--fg)',
        }}
      >
        <WalletAvatar address={address} size={28} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          <span
            style={{
              fontSize: '13.5px',
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sanitizeText(name)}
          </span>
          <span
            style={{ fontSize: '11.5px', fontFamily: 'var(--font-mono)', color: 'var(--fg-3)' }}
          >
            {middleCut(address)}
          </span>
        </span>
        <SignerBalance
          key={`${networkId ?? ''}:${address}`}
          address={address}
          networkId={networkId}
        />
      </button>
    </div>
  );
};

export default SignerRow;
