import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import type { Wallet } from 'src/types/wallet';
import type { NetworkId } from 'src/utils/config';
import { pvacManager } from 'src/services/pvac/PvacManager';
import { privacyNetworkService } from 'src/services/network/NetworkService';
import { passwordManager } from 'src/services/crypto/PasswordManager';
import { rawToOct } from 'src/services/privacy/setupPrivate';
import { Mascot } from 'src/shared/ui/Mascot';
import { PrimaryButton, Sheet } from 'src/shared/ui/primitives';

type Phase = 'idle' | 'busy' | 'error';

const BUTTON = { height: '48px', borderRadius: '12px', fontSize: '14px' } as const;

const SetupPrivateSheet = ({
  open,
  wallet,
  networkId,
  feeRaw,
  onClose,
  onDone,
}: {
  open: boolean;
  wallet: Wallet;
  networkId: NetworkId;
  feeRaw: string;
  onClose: () => void;
  onDone: () => void;
}) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');

  const close = () => {
    if (phase === 'busy') return;
    setPhase('idle');
    setError('');
    onClose();
  };

  const turnOn = async () => {
    const { address, privateKey, publicKey } = wallet;
    if (!privateKey || phase === 'busy') return;
    setPhase('busy');
    setError('');
    await passwordManager.suppressAutoLock();
    try {
      await pvacManager.initialize(privateKey);
      const register = () =>
        pvacManager.verifyRegistration(
          address,
          privateKey,
          publicKey ?? undefined,
          privacyNetworkService,
          true,
          networkId,
          feeRaw
        );
      // A check already in flight answers for this call; once it settles, register for real.
      if (!(await register()) && !(await register())) {
        throw new Error(
          t('main.setupPrivateFailed', { defaultValue: 'Could not turn on private balance.' })
        );
      }
      setPhase('idle');
      onDone();
    } catch (err: unknown) {
      if ((err as Error)?.name === 'PvacSetupPending') {
        setPhase('idle');
        onDone();
        return;
      }
      setError(
        (err as Error)?.message ||
          t('main.setupPrivateFailed', { defaultValue: 'Could not turn on private balance.' })
      );
      setPhase('error');
    } finally {
      passwordManager.resumeAutoLock();
    }
  };

  const busy = phase === 'busy';

  return (
    <Sheet
      open={open}
      onClose={close}
      dismissible={!busy}
      footer={
        busy ? (
          <div
            className="relative! flex! items-center! justify-center! overflow-hidden!"
            style={{ ...BUTTON, background: 'var(--bg-1)' }}
            role="status"
          >
            <span
              className="setup-fill absolute! inset-0!"
              style={{ background: 'color-mix(in oklab, var(--accent) 22%, transparent)' }}
            />
            <span className="relative!" style={{ fontWeight: 600, color: 'var(--fg)' }}>
              {t('main.turningOn', { defaultValue: 'Turning on' })}
            </span>
          </div>
        ) : (
          <div className="grid! grid-cols-2!" style={{ gap: '10px' }}>
            <PrimaryButton secondary onClick={close} style={BUTTON}>
              {phase === 'error'
                ? t('common.close', { defaultValue: 'Close' })
                : t('main.notNow', { defaultValue: 'Not now' })}
            </PrimaryButton>
            <PrimaryButton onClick={turnOn} style={BUTTON}>
              {phase === 'error'
                ? t('main.tryAgain', { defaultValue: 'Try again' })
                : t('main.turnOn', { defaultValue: 'Turn on' })}
            </PrimaryButton>
          </div>
        )
      }
    >
      <div
        className="flex! flex-col! items-center! text-center!"
        style={{ gap: '8px', paddingTop: '4px' }}
      >
        <Mascot mood={busy ? 'encrypt' : 'still'} size={44} />
        <span style={{ fontSize: '18px', fontWeight: 700, color: 'var(--fg)', marginTop: '4px' }}>
          {t('main.setupPrivateTitle', { defaultValue: 'Turn on private balance' })}
        </span>
        <span
          style={{ fontSize: '12px', color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}
        >
          {t('main.setupPrivateFee', {
            defaultValue: 'One-time network fee {{fee}} OCT',
            fee: rawToOct(feeRaw),
          })}
        </span>
        {phase === 'error' && (
          <span
            role="alert"
            style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--neg)', marginTop: '2px' }}
          >
            {error}
          </span>
        )}
      </div>
    </Sheet>
  );
};

export default SetupPrivateSheet;
