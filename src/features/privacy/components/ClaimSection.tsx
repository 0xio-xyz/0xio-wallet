import { useTranslation } from 'src/i18n/react';
import FeeValue from 'src/shared/ui/FeeValue';
import { Mascot } from 'src/shared/ui/Mascot';
import { Bone, BoneLine, Loading } from 'src/shared/ui/Skeleton';
import {
  Sheet,
  RuledList,
  ListRow,
  Facts,
  TextButton,
  PrimaryButton,
} from 'src/shared/ui/primitives';
import type { PrivateOutput } from 'src/hooks/privacy/useClaim';
import { getNetworkConfig } from 'src/utils/network';
import type { NetworkId } from 'src/utils/config';

interface ClaimSectionProps {
  claimStatus: string;
  rewardAmount: string;
  claimProgress: string;
  claimingOutputId: number | string | null;
  privateOutputs: PrivateOutput[];
  handleClaim: () => void;
  onReviewSingle: (output: PrivateOutput) => void;
  setClaimStatus: (status: string) => void;
  onRefresh?: () => void;
}

const fmtOct = (raw: number): string => {
  const v = raw / 1000000;
  return parseFloat(v.toFixed(6)).toString();
};

const value = (text: React.ReactNode, strong = false, positive = false) => (
  <span
    style={{
      fontSize: '12px',
      fontWeight: strong ? 600 : 500,
      color: positive ? 'var(--pos)' : 'var(--fg)',
      fontVariantNumeric: 'tabular-nums',
    }}
  >
    {text}
  </span>
);

const Centered = ({ title, action }: { title: string; action?: React.ReactNode }) => (
  <div
    className="flex! flex-col! items-center! text-center!"
    style={{ gap: '4px', padding: '28px 0' }}
  >
    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>{title}</span>
    {action && <div style={{ marginTop: '8px' }}>{action}</div>}
  </div>
);

const ClaimSection = ({
  claimStatus,
  rewardAmount,
  claimProgress,
  claimingOutputId,
  privateOutputs,
  handleClaim: _handleClaim, // eslint-disable-line @typescript-eslint/no-unused-vars
  onReviewSingle,
  setClaimStatus: _setClaimStatus, // eslint-disable-line @typescript-eslint/no-unused-vars
  onRefresh,
}: ClaimSectionProps) => {
  const { t } = useTranslation();

  if (claimStatus === 'checking') {
    return (
      <Loading label={t('common.loading', { defaultValue: 'Loading' })}>
        <div className="flex! items-end! justify-between!" style={{ padding: '2px 0 12px' }}>
          <div className="flex! flex-col!" style={{ gap: '3px' }}>
            <span style={{ display: 'block', fontSize: '22px', lineHeight: 1.1 }}>
              <Bone w={120} h={22} />
            </span>
            <BoneLine size={11} w={128} h={10} />
          </div>
          <BoneLine size={11} w={60} h={10} />
        </div>
        <RuledList>
          {[0, 1, 2].map((i) => (
            <ListRow
              key={i}
              label={<Bone w={84} h={12} />}
              sub={<Bone w={96} h={9} />}
              right={<Bone w={40} h={12} />}
              chevron={false}
            />
          ))}
        </RuledList>
      </Loading>
    );
  }
  if (claimStatus === 'no_rewards') {
    return (
      <Centered
        title={t('claim.noTransfersFound')}
        action={
          onRefresh && (
            <TextButton onClick={onRefresh}>
              {t('claim.refreshScan', { defaultValue: 'Scan again' })}
            </TextButton>
          )
        }
      />
    );
  }
  if (claimStatus === 'claiming') {
    return (
      <div className="flex! flex-col! items-center!" style={{ gap: '10px', padding: '28px 0' }}>
        <Mascot mood="loading" size={24} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
          {t('claim.claimingTransfers')}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
          {claimProgress || t('privacy.decryptingClaiming')}
        </span>
      </div>
    );
  }
  if (claimStatus === 'success') {
    return <Centered title={t('claim.success')} />;
  }
  if (claimStatus !== 'eligible') return null;

  return (
    <div>
      <div className="flex! items-end! justify-between!" style={{ padding: '2px 0 12px' }}>
        <div className="flex! flex-col!" style={{ gap: '3px' }}>
          <span
            style={{
              fontSize: '22px',
              fontWeight: 600,
              color: 'var(--pos)',
              lineHeight: 1.1,
              letterSpacing: '-0.01em',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {parseFloat(rewardAmount)} OCT
          </span>
          <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
            {privateOutputs.length} private transfer{privateOutputs.length !== 1 ? 's' : ''} found
          </span>
        </div>
        {onRefresh && (
          <TextButton muted size={11} onClick={onRefresh}>
            {t('claim.refreshScan', { defaultValue: 'Scan again' })}
          </TextButton>
        )}
      </div>
      <RuledList>
        {privateOutputs.map((output) => {
          const isClaiming = claimingOutputId === output.id;
          return (
            <ListRow
              key={output.id}
              label={`${fmtOct(output.amount)} pOCT`}
              sub={
                <Facts>
                  <span>#{output.id}</span>
                  <span>epoch {output.epoch}</span>
                </Facts>
              }
              right={
                <TextButton
                  onClick={() => onReviewSingle(output)}
                  disabled={claimingOutputId !== null}
                  style={{ color: isClaiming ? 'var(--fg-3)' : 'var(--pos)' }}
                >
                  {isClaiming ? 'Claiming' : 'Claim'}
                </TextButton>
              }
              chevron={false}
            />
          );
        })}
      </RuledList>
    </div>
  );
};

export const ClaimReview = ({
  isOpen,
  onClose,
  privateOutputs,
  networkId,
  fee,
  feeLoading,
  isBusy,
  progressLabel,
  onConfirm,
}: {
  isOpen: boolean;
  onClose: () => void;
  privateOutputs: PrivateOutput[];
  networkId: string;
  fee: string | null;
  feeLoading: boolean;
  isBusy: boolean;
  progressLabel?: string;
  onConfirm: () => void;
}) => {
  const { t } = useTranslation();
  const totalRaw = privateOutputs.reduce((s, o) => s + o.amount, 0);
  return (
    <Sheet
      open={isOpen && privateOutputs.length > 0}
      onClose={onClose}
      title="Review claim"
      closeLabel={t('common.close')}
      footer={
        <PrimaryButton onClick={onConfirm} loading={isBusy} positive disabled={fee === null}>
          {isBusy
            ? progressLabel || 'Claiming'
            : `Claim ${privateOutputs.length > 1 ? `all (${privateOutputs.length})` : 'now'}`}
        </PrimaryButton>
      }
    >
      <div className="flex! flex-col!" style={{ padding: '2px 0 14px', gap: '3px' }}>
        <span
          style={{
            fontSize: '26px',
            fontWeight: 600,
            color: 'var(--pos)',
            lineHeight: 1.1,
            letterSpacing: '-0.01em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          +{fmtOct(totalRaw)} pOCT
        </span>
        <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
          {privateOutputs.length} transfer{privateOutputs.length !== 1 ? 's' : ''}
        </span>
      </div>
      <RuledList>
        {privateOutputs.map((o) => (
          <ListRow
            key={o.id}
            label={
              <Facts>
                <span>#{o.id}</span>
                <span style={{ color: 'var(--fg-3)' }}>epoch {o.epoch}</span>
              </Facts>
            }
            right={value(`${fmtOct(o.amount)} pOCT`)}
            chevron={false}
          />
        ))}
        <ListRow
          label="Network"
          right={value(getNetworkConfig(networkId as NetworkId).name)}
          chevron={false}
        />
        <ListRow
          label="Operation"
          right={value('Stealth claim and FHE re-encrypt')}
          chevron={false}
        />
        <ListRow
          label={t('claim.feePerClaim')}
          right={value(
            fee === null ? <FeeValue state={feeLoading ? 'loading' : 'failed'} /> : `${fee} OCT`
          )}
          chevron={false}
        />
        <ListRow
          label="You receive"
          right={value(`+${fmtOct(totalRaw)} pOCT`, true, true)}
          chevron={false}
        />
      </RuledList>
    </Sheet>
  );
};

export const ClaimBottomBar = ({
  claimStatus,
  claimingOutputId,
  privateOutputs,
  setClaimStatus,
  onRefresh,
  onReviewClaim,
}: Pick<
  ClaimSectionProps,
  'claimStatus' | 'claimingOutputId' | 'privateOutputs' | 'setClaimStatus' | 'onRefresh'
> & { onReviewClaim: () => void }) => {
  const { t } = useTranslation();
  if (claimStatus === 'success') {
    return (
      <PrimaryButton
        secondary
        onClick={() => {
          setClaimStatus('idle');
          onRefresh?.();
        }}
      >
        {t('claim.scanAgain', { defaultValue: 'Scan for more' })}
      </PrimaryButton>
    );
  }
  /* One claim per pass: each claim adds two encryption layers, and at four the balance needs a
     migrate before the next; a batch would walk it to the unrecoverable cap. */
  return (
    <PrimaryButton
      onClick={onReviewClaim}
      disabled={claimStatus !== 'eligible' || claimingOutputId !== null}
    >
      {privateOutputs.length > 1 ? `Review claim (1 of ${privateOutputs.length})` : 'Review claim'}
    </PrimaryButton>
  );
};

export default ClaimSection;
