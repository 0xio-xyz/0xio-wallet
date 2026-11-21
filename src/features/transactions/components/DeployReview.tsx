import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { Globe } from 'src/shared/ui/icons';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import SignerRow from 'src/features/dapp/components/SignerRow';
import {
  FieldNote,
  PrimaryButton,
  RuledList,
  TextButton,
  quietField,
} from 'src/shared/ui/primitives';
import { fromUnits } from 'src/utils/amount';
import {
  deployReviewError,
  parseDeployOu,
  type DeployReviewParams,
} from 'src/utils/octra/deployTx';
import { sanitizeUrl } from 'src/lib/sanitize';

const PARAMS_PREVIEW_CHARS = 240;

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: '12px' };

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const formatOct = (units: bigint) => {
  const [int, frac] = fromUnits(units).split('.');
  return frac ? `${group(int)}.${frac}` : group(int);
};

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 2 : 1)} KB`;

const readable = (params: string) => {
  try {
    return JSON.stringify(JSON.parse(params), null, 2);
  } catch {
    return params;
  }
};

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div
    className="flex! items-start! justify-between!"
    style={{ padding: '10px 10px', gap: '14px' }}
  >
    <span className="tab-caps" style={{ color: 'var(--fg-3)', paddingTop: '2px', flexShrink: 0 }}>
      {label}
    </span>
    <span
      style={{
        fontSize: '13px',
        color: 'var(--fg)',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        overflowWrap: 'anywhere',
        minWidth: 0,
      }}
    >
      {children}
    </span>
  </div>
);

const Note = ({ children }: { children: React.ReactNode }) => (
  <div
    className="rounded-[18px]! bg-(--bg-1)!"
    style={{ padding: '12px 14px', fontSize: '12px', lineHeight: 1.5, color: 'var(--fg-2)' }}
  >
    {children}
  </div>
);

const SiteIcon = ({ favicon }: { favicon?: string }) => {
  const [broken, setBroken] = useState(false);
  const src = sanitizeUrl(favicon);
  return (
    <span
      className="flex! shrink-0! items-center! justify-center! rounded-full! bg-(--bg-1)!"
      style={{ width: '36px', height: '36px' }}
    >
      {src && !broken ? (
        <img
          src={src}
          alt=""
          onError={() => setBroken(true)}
          style={{ width: '20px', height: '20px', borderRadius: '5px', objectFit: 'contain' }}
        />
      ) : (
        <Globe size={16} style={{ color: 'var(--fg-3)' }} />
      )}
    </span>
  );
};

export interface DeployReviewRequest {
  origin?: string;
  favicon?: string;
  walletAddress?: string;
  networkId?: string;
  networkMismatch?: boolean;
  dappNetwork?: string | null;
  params?: DeployReviewParams;
}

const DeployReview = ({
  req,
  networkLabel,
  needsUnlock,
  password,
  onPassword,
  passkey,
  error,
  busy,
  onApprove,
  onReject,
}: {
  req: DeployReviewRequest;
  networkLabel: string;
  needsUnlock: boolean;
  password: string;
  onPassword: (value: string) => void;
  passkey: { enabled: boolean; loading: boolean; onUse: () => void } | null;
  error: string;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) => {
  const { t } = useTranslation();
  const [showAllParams, setShowAllParams] = useState(false);

  const problem = deployReviewError(req.params);
  const p = req.params ?? {};
  const codeBytes = typeof p.codeBytes === 'number' ? p.codeBytes : 0;
  const contractAddress = typeof p.contractAddress === 'string' ? p.contractAddress : '';
  const ou = parseDeployOu(p.ou);
  const params = typeof p.constructorParams === 'string' ? readable(p.constructorParams) : '';
  const longParams = params.length > PARAMS_PREVIEW_CHARS;
  const shownParams =
    longParams && !showAllParams ? `${params.slice(0, PARAMS_PREVIEW_CHARS)}...` : params;
  const origin = req.origin ?? '';

  return (
    <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
      <div
        className="flex-1! overflow-y-auto! scrollbar-hide!"
        style={{ padding: '20px var(--gutter) 12px' }}
      >
        <div className="tab-caps" style={{ color: 'var(--fg-3)' }}>
          {t('deployReview.caps', { defaultValue: 'Deploy request' })}
        </div>
        <div className="flex! items-center!" style={{ gap: '10px', marginTop: '12px' }}>
          <SiteIcon favicon={req.favicon} />
          <div className="flex! min-w-0! flex-col!" style={{ gap: '2px' }}>
            <span className="truncate!" style={{ fontSize: '15px', color: 'var(--fg)' }}>
              {hostOf(origin)}
            </span>
            <span className="truncate!" style={{ fontSize: '11.5px', color: 'var(--fg-3)' }}>
              {origin}
            </span>
          </div>
        </div>
        <div
          style={{
            margin: '18px 4px 16px',
            fontSize: '20px',
            fontWeight: 300,
            letterSpacing: '-0.01em',
            lineHeight: 1.25,
            color: 'var(--fg)',
          }}
        >
          {t('deployReview.title', { defaultValue: 'Deploy a contract' })}
        </div>

        <RuledList>
          <Row label={t('deployReview.network', { defaultValue: 'Network' })}>{networkLabel}</Row>
          <Row label={t('deployReview.codeSize', { defaultValue: 'Code size' })}>
            {codeBytes > 0
              ? t('deployReview.codeSizeValue', {
                  defaultValue: '{{size}} ({{bytes}} bytes)',
                  size: formatSize(codeBytes),
                  bytes: group(String(codeBytes)),
                })
              : '-'}
          </Row>
          <Row label={t('deployReview.address', { defaultValue: 'Contract address' })}>
            <span style={mono}>{contractAddress || '-'}</span>
          </Row>
          <Row label={t('deployReview.fee', { defaultValue: 'Network fee' })}>
            {ou != null ? (
              <span className="flex! flex-col! items-end!" style={{ gap: '2px' }}>
                <span>{formatOct(ou)} OCT</span>
                <span style={{ fontSize: '11.5px', color: 'var(--fg-3)' }}>
                  {t('deployReview.feeOu', {
                    defaultValue: '{{ou}} OU',
                    ou: group(ou.toString()),
                  })}
                </span>
              </span>
            ) : (
              '-'
            )}
          </Row>
        </RuledList>

        {params && (
          <>
            <div className="tab-caps" style={{ color: 'var(--fg-3)', margin: '18px 4px 8px' }}>
              {t('deployReview.params', { defaultValue: 'Constructor parameters' })}
            </div>
            <div
              className="rounded-[18px]! bg-(--bg-1)!"
              style={{
                padding: '12px 14px',
                maxHeight: showAllParams ? '220px' : undefined,
                overflowY: showAllParams ? 'auto' : undefined,
                ...mono,
                fontSize: '11.5px',
                lineHeight: 1.5,
                color: 'var(--fg)',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}
            >
              {shownParams}
            </div>
            {longParams && (
              <div style={{ margin: '8px 4px 0' }}>
                <TextButton onClick={() => setShowAllParams((v) => !v)} size={12}>
                  {showAllParams
                    ? t('deployReview.showLess', { defaultValue: 'Show less' })
                    : t('deployReview.showAll', { defaultValue: 'Show all' })}
                </TextButton>
              </div>
            )}
          </>
        )}

        {req.networkMismatch && req.dappNetwork && (
          <div style={{ marginTop: '12px' }}>
            <Note>
              {t('deployReview.mismatch', {
                defaultValue: 'This site expects {{site}}. The wallet is on {{wallet}}.',
                site: req.dappNetwork,
                wallet: networkLabel,
              })}
            </Note>
          </div>
        )}

        <div style={{ marginTop: '12px' }}>
          <Note>
            {t('deployReview.note', {
              defaultValue:
                'The code is stored on chain permanently and anyone can call it. Deploy only code you trust.',
            })}
          </Note>
        </div>

        {req.walletAddress && (
          <div style={{ marginTop: '12px' }}>
            <SignerRow
              address={req.walletAddress}
              networkId={req.networkId}
              pickable={false}
              disabled={busy}
              onPick={() => {}}
            />
          </div>
        )}
      </div>

      <div style={{ flexShrink: 0, padding: '8px var(--gutter) 20px' }}>
        {needsUnlock && (
          <>
            <input
              type="password"
              value={password}
              onChange={(e) => onPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password) onApprove();
              }}
              autoComplete="current-password"
              placeholder={t('deployReview.password', { defaultValue: 'Password' })}
              aria-label={t('deployReview.password', { defaultValue: 'Password' })}
              className={quietField}
              style={{ height: '48px', borderRadius: '16px', marginBottom: '10px' }}
            />
            {passkey?.enabled && (
              <div style={{ margin: '0 4px 4px' }}>
                <TextButton onClick={passkey.onUse} disabled={passkey.loading} muted size={12}>
                  {passkey.loading
                    ? t('lock.verifying', { defaultValue: 'Verifying…' })
                    : t('lock.unlockWithPasskey', { defaultValue: 'Passkey' })}
                </TextButton>
              </div>
            )}
          </>
        )}
        <FieldNote tone="neg">{problem || error}</FieldNote>
        <div className="flex!" style={{ gap: '10px', marginTop: '6px' }}>
          <PrimaryButton secondary onClick={onReject} disabled={busy} style={BIG_BUTTON}>
            {t('deployReview.cancel', { defaultValue: 'Reject' })}
          </PrimaryButton>
          <PrimaryButton
            onClick={onApprove}
            loading={busy}
            disabled={!!problem || (needsUnlock && !password)}
            style={BIG_BUTTON}
          >
            {t('deployReview.deploy', { defaultValue: 'Deploy' })}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
};

export default DeployReview;
