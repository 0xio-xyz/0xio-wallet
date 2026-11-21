import { useTranslation } from 'src/i18n/react';
import { useDesktopSync } from 'src/hooks/wallet/useDesktopSync';
import { useStartDesktopPairing } from 'src/hooks/wallet/useStartDesktopPairing';
import { PrimaryButton, Sheet } from 'src/shared/ui/primitives';
import { Mascot } from 'src/shared/ui/Mascot';

const PLACEHOLDER = ['••• •••', '••• •••', '••• •••'];
const FADE = { animationDuration: '220ms', animationTimingFunction: 'ease-out' };

const DesktopPairSheet = () => {
  const { t } = useTranslation();
  const { pairSheet, cancelPair, pickPairCode, submitPairPick } = useDesktopSync();
  const startPairing = useStartDesktopPairing();
  const phase = pairSheet?.phase;
  const stopped = phase === 'wrong' || phase === 'refused' || phase === 'timeout';
  const paired = phase === 'paired';
  const codes = pairSheet?.codes ?? null;
  const choosing = phase === 'choosing' && !!codes;

  const status =
    phase === 'connecting'
      ? t('desktopPair.connecting', { defaultValue: 'Connecting to 0xio Desktop' })
      : phase === 'waiting'
        ? t('desktopPair.approve', { defaultValue: 'Approve on 0xio Desktop' })
        : phase === 'wrong'
          ? t('desktopPair.wrong', { defaultValue: 'Wrong code. Pairing stopped' })
          : phase === 'refused'
            ? t('desktopPair.refused', { defaultValue: 'Refused on 0xio Desktop' })
            : phase === 'timeout'
              ? t('desktopPair.timeout', { defaultValue: 'Pairing timed out' })
              : '';

  const retry = (): void => void startPairing();

  return (
    <Sheet open={!!pairSheet} onClose={cancelPair} dismissible={!paired}>
      <div className="flex! flex-col!" style={{ height: '322px' }}>
        <div
          key={paired ? 'paired' : 'pick'}
          className="shrink-0! animate-in! fade-in!"
          style={{
            height: '22px',
            padding: '0 4px',
            fontSize: '15px',
            fontWeight: 700,
            letterSpacing: '-0.1px',
            color: 'var(--fg)',
            ...FADE,
          }}
        >
          {paired
            ? t('desktopPair.paired', { defaultValue: 'Paired' })
            : t('desktopPair.title', { defaultValue: 'Pick the code on 0xio Desktop' })}
        </div>
        <div className="flex-1! min-h-0! flex! flex-col! items-center! justify-center!">
          {paired ? (
            <span
              className="animate-in! fade-in!"
              style={{ color: 'var(--fg)', display: 'flex', ...FADE }}
            >
              <Mascot mood="still" size={56} hole="var(--bg-1)" />
            </span>
          ) : (
            <div
              className="w-full! flex! flex-col!"
              style={{
                gap: '4px',
                opacity: stopped ? 0.4 : 1,
                transition: 'opacity 200ms ease-out',
              }}
            >
              {(codes ?? PLACEHOLDER).map((code, i) => {
                const on = pairSheet?.picked === i;
                return (
                  <button
                    key={codes ? `c${i}` : `p${i}`}
                    type="button"
                    aria-pressed={on}
                    disabled={!choosing}
                    onClick={() => pickPairCode(i)}
                    className={`w-full! flex! items-center! justify-center! animate-in! fade-in! ${
                      on ? 'bg-(--bg-3)!' : choosing ? 'hover:bg-(--bg-2)!' : ''
                    }`}
                    style={{
                      height: '52px',
                      borderRadius: '14px',
                      border: 'none',
                      padding: '0 16px',
                      background: on ? undefined : 'transparent',
                      fontSize: '22px',
                      fontWeight: 600,
                      letterSpacing: '0.06em',
                      fontVariantNumeric: 'tabular-nums',
                      color: codes ? 'var(--fg)' : 'var(--fg-3)',
                      cursor: choosing ? 'pointer' : 'default',
                      transition: 'background 200ms ease-out',
                      ...FADE,
                    }}
                  >
                    {code}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div
          key={status}
          aria-live="polite"
          className="shrink-0! animate-in! fade-in!"
          style={{
            height: '18px',
            lineHeight: '18px',
            fontSize: '12px',
            textAlign: 'center',
            color: stopped ? 'var(--neg)' : 'var(--fg-3)',
            ...FADE,
          }}
        >
          {status}
        </div>
        <div
          className="shrink-0! flex!"
          style={{
            height: '58px',
            gap: '10px',
            paddingTop: '14px',
            visibility: paired ? 'hidden' : 'visible',
          }}
        >
          <button
            type="button"
            onClick={cancelPair}
            className="press flex-1! flex! items-center! justify-center! bg-(--bg-2)! hover:bg-(--bg-3)!"
            style={{
              height: '44px',
              borderRadius: '22px',
              border: 'none',
              color: 'var(--fg)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'background 200ms ease-out',
            }}
          >
            {stopped
              ? t('desktopPair.close', { defaultValue: 'Close' })
              : t('desktopPair.cancel', { defaultValue: 'Cancel' })}
          </button>
          <div className="flex-1!">
            {stopped ? (
              <PrimaryButton onClick={retry}>
                {t('desktopPair.retry', { defaultValue: 'Try again' })}
              </PrimaryButton>
            ) : phase === 'waiting' ? (
              <PrimaryButton disabled loading>
                {t('desktopPair.waiting', { defaultValue: 'Waiting' })}
              </PrimaryButton>
            ) : (
              <PrimaryButton
                disabled={!choosing || pairSheet?.picked == null}
                onClick={submitPairPick}
              >
                {t('desktopPair.pair', { defaultValue: 'Pair' })}
              </PrimaryButton>
            )}
          </div>
        </div>
      </div>
    </Sheet>
  );
};

export default DesktopPairSheet;
