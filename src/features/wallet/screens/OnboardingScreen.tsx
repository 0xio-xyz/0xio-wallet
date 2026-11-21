import { useRef } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation, Trans } from 'src/i18n/react';
import ExpandViewToggle from 'src/shared/ui/ExpandViewToggle';
import { IdleMascot, type MascotHandle } from 'src/shared/ui/Mascot';
import { PrimaryButton, TextButton } from 'src/shared/ui/primitives';

const TERMS_URL = 'https://0xio.xyz/terms';
const PRIVACY_URL = 'https://0xio.xyz/privacy';

const legalLink = {
  color: 'var(--fg-2)',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
} as const;

const OnboardingScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mascotRef = useRef<MascotHandle>(null);
  const go = (mode: string) => navigate('/setup', { state: { mode } });

  return (
    <div
      className="flex! h-full! flex-col! overflow-hidden! bg-(--bg)!"
      onPointerDownCapture={() => mascotRef.current?.poke()}
      onKeyDownCapture={() => mascotRef.current?.poke()}
    >
      <div
        className="flex! shrink-0! items-center! justify-end!"
        style={{ padding: '12px 16px', height: '52px' }}
      >
        <ExpandViewToggle />
      </div>

      <div
        className="flex! flex-1! flex-col! items-center! justify-center! text-center!"
        style={{ padding: '0 var(--gutter)', gap: '20px' }}
      >
        <IdleMascot ref={mascotRef} mood="peek" size={112} />
        <div className="flex! flex-col!" style={{ gap: '8px' }}>
          <h1
            style={{
              margin: 0,
              fontSize: '28px',
              fontWeight: 700,
              letterSpacing: '-0.6px',
              color: 'var(--fg)',
            }}
          >
            {t('onboarding.title', { defaultValue: '0xio Wallet' })}
          </h1>
          <p style={{ margin: 0, fontSize: '14px', color: 'var(--fg-2)' }}>
            {t('onboarding.tagline', { defaultValue: 'Where privacy meets simplicity' })}
          </p>
        </div>
      </div>

      <div className="flex! shrink-0! flex-col!" style={{ padding: '12px 20px 20px', gap: '10px' }}>
        <PrimaryButton
          onClick={() => go('generate')}
          style={{ height: '48px', borderRadius: '12px', fontSize: '14px' }}
        >
          {t('onboarding.createWallet', { defaultValue: 'Create a wallet' })}
        </PrimaryButton>
        <TextButton
          muted
          size={14}
          onClick={() => go('import')}
          style={{ height: '40px', fontWeight: 600, color: 'var(--fg-2)' }}
        >
          {t('onboarding.haveWallet', { defaultValue: 'I already have a wallet' })}
        </TextButton>
        <p
          style={{
            margin: '2px 0 0',
            fontSize: '11.5px',
            lineHeight: 1.5,
            textAlign: 'center',
            color: 'var(--fg-3)',
          }}
        >
          <Trans
            i18nKey="onboarding.terms"
            defaults="By continuing, you agree to the <terms>Terms of Service</terms> and <privacy>Privacy Policy</privacy>."
            components={{
              terms: (
                <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" style={legalLink} />
              ),
              privacy: (
                <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={legalLink} />
              ),
            }}
          />
        </p>
      </div>
    </div>
  );
};

export default OnboardingScreen;
