import { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import type { TFunction } from 'src/i18n/core';
import { useWallet } from 'src/contexts/WalletContext';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import { toChecksumAddress } from 'src/services/evm/accounts';
import { fetchTokenBalance } from 'src/services/evm/balances';
import type { EvmNetwork } from 'src/services/evm/networks';
import { nftTransferData, type EvmNft } from 'src/services/evm/nfts';
import { networkTxUrl } from 'src/services/evm/registry';
import { waitForReceipt, type PreparedTransfer } from 'src/services/evm/send';
import { prepareCall, signAndBroadcast } from 'src/services/evm/signer';
import { nativeEvmToken } from 'src/services/evm/tokens';
import { isEvmAddress } from 'src/services/evm/tx';
import { middleCut } from 'src/features/wallet/add/format';
import { Mascot } from 'src/shared/ui/Mascot';
import { FieldNote, PrimaryButton, Sheet, TextButton, quietField } from 'src/shared/ui/primitives';
import { fromUnits } from 'src/utils/amount';
import { logger } from 'src/utils/logger';
import { EvmNftArt } from 'src/features/wallet/nft/evm/EvmNftParts';
import FeeFigureText from 'src/features/bridge/components/FeeFigureText';
import { feeFigure } from 'src/features/bridge/bridgeUsd';
import { useNativePrice } from 'src/hooks/wallet/useNativePrice';
import { evmNftName } from 'src/features/wallet/nft/evm/deriveEvmGallery';

type Step = 'form' | 'review' | 'sending' | 'pending' | 'done' | 'failed';

interface Bound {
  walletId: string;
  from: string;
  chainId: number;
}

const trim = (amount: string, places = 8) => {
  const [int, frac = ''] = amount.split('.');
  const cut = frac.slice(0, places).replace(/0+$/, '');
  if (!cut && /[1-9]/.test(frac) && int === '0') return `< 0.${'0'.repeat(places - 1)}1`;
  return cut ? `${int}.${cut}` : int;
};

function recipientProblem(
  value: string,
  own: string | null,
  contract: string,
  t: TFunction
): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!isEvmAddress(v)) {
    return t('evmSend.badAddress', {
      defaultValue: 'Invalid address. Enter 0x followed by 40 hex characters.',
    });
  }
  const body = v.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && toChecksumAddress(v) !== v) {
    return t('evmSend.badChecksum', {
      defaultValue: 'Invalid address checksum. Check that it was copied correctly.',
    });
  }
  if (own && v.toLowerCase() === own.toLowerCase()) {
    return t('evmNft.toSelf', { defaultValue: 'Cannot transfer to your own address' });
  }
  if (v.toLowerCase() === contract.toLowerCase()) {
    return t('evmNft.toContract', {
      defaultValue: 'This is the collection contract. NFTs transferred there are lost.',
    });
  }
  return null;
}

const ReviewRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex! items-start! justify-between!" style={{ padding: '10px 4px', gap: '14px' }}>
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
      }}
    >
      {value}
    </span>
  </div>
);

export function EvmNftSendSheet({
  nft,
  network,
  onSent,
  onClose,
}: {
  nft: EvmNft;
  network: EvmNetwork;
  onSent: (sent: bigint) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { activeWallet } = useWallet();
  const { evmAddress } = useHomeView();
  const [step, setStep] = useState<Step>('form');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('1');
  const [prepared, setPrepared] = useState<PreparedTransfer | null>(null);
  const nativePrice = useNativePrice(network);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const bound = useRef<Bound | null>(null);
  const runRef = useRef(0);

  const multi = nft.standard === 'ERC-1155';
  const held = BigInt(nft.amount);
  const units = /^\d{1,78}$/.test(amount) ? BigInt(amount) : 0n;
  const sendUnits = multi ? units : 1n;
  const toProblem = recipientProblem(to, evmAddress, nft.contract, t);
  const amountProblem =
    multi && units > held
      ? t('evmNft.youHold', { count: Number(held), defaultValue: 'You hold {{count}}' })
      : null;
  const ready =
    !!activeWallet &&
    !!evmAddress &&
    isEvmAddress(to.trim()) &&
    !toProblem &&
    sendUnits > 0n &&
    sendUnits <= held &&
    !busy;

  const review = async () => {
    if (!ready || !activeWallet || !evmAddress) return;
    const run = ++runRef.current;
    setBusy(true);
    setProblem(null);
    try {
      const data = nftTransferData(nft, evmAddress, to.trim(), sendUnits);
      const [p, native] = await Promise.all([
        prepareCall(network, { from: evmAddress, to: nft.contract, data }),
        fetchTokenBalance(evmAddress, network, nativeEvmToken(network)),
      ]);
      if (run !== runRef.current) return;
      if (p.totalNative > native) {
        setProblem(
          t('evmSend.noGas', {
            defaultValue: 'Insufficient {{symbol}} on {{chain}} for network fee',
            symbol: network.nativeSymbol,
            chain: network.name,
          })
        );
        return;
      }
      bound.current = { walletId: activeWallet.id, from: evmAddress, chainId: network.chainId };
      setPrepared(p);
      setStep('review');
    } catch (e) {
      logger.warn('[EvmNftSend] prepare failed', e);
      if (run !== runRef.current) return;
      setProblem(
        t('evmNft.prepareFailed', {
          defaultValue:
            'Could not prepare this transfer. Check the address and that you still hold it.',
        })
      );
    } finally {
      if (run === runRef.current) setBusy(false);
    }
  };

  const send = async () => {
    const b = bound.current;
    if (!prepared || !b || !activeWallet || !evmAddress) return;
    if (
      b.walletId !== activeWallet.id ||
      b.from.toLowerCase() !== evmAddress.toLowerCase() ||
      b.chainId !== network.chainId ||
      prepared.tx.chainId !== network.chainId
    ) {
      setProblem(
        t('evmNft.scopeChanged', { defaultValue: 'The wallet or network changed. Review again.' })
      );
      setStep('form');
      return;
    }
    setStep('sending');
    let txHash: string | null = null;
    try {
      txHash = await signAndBroadcast(network, prepared.tx, {
        id: activeWallet.id,
        evmIndex: activeWallet.metadata?.evm?.index ?? 0,
        evmAddress,
      });
      setHash(txHash);
      setStep('pending');
      const receipt = await waitForReceipt(network, txHash, { timeoutMs: 300_000 });
      setStep(receipt.status === 'success' ? 'done' : 'failed');
    } catch (e) {
      logger.warn('[EvmNftSend] send failed', e);
      if (txHash) return;
      setProblem(
        e instanceof Error && /locked/i.test(e.message)
          ? t('evmSend.locked', { defaultValue: 'Unlock 0xio and try again.' })
          : t('evmSend.sendFailed', { defaultValue: 'Transfer not sent. Try again.' })
      );
      setStep('review');
    }
  };

  const close = () => {
    if (step === 'sending') return;
    if (step === 'pending' || step === 'done') onSent(sendUnits);
    else onClose();
  };

  const name = evmNftName(nft);
  const link = hash ? networkTxUrl(network, hash) : null;
  const thumb = (
    <span
      className="relative! shrink-0! overflow-hidden! bg-(--bg-2)!"
      style={{ width: '52px', height: '52px', borderRadius: '12px' }}
    >
      <EvmNftArt nft={nft} />
    </span>
  );
  const heading = (
    <div className="flex! items-center!" style={{ gap: '12px', padding: '2px 4px 14px' }}>
      {thumb}
      <span className="flex! min-w-0! flex-col!" style={{ gap: '2px' }}>
        <span
          className="truncate!"
          style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg)' }}
        >
          {multi && sendUnits > 1n ? `${sendUnits.toString()} × ${name}` : name}
        </span>
        <span className="truncate!" style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
          {nft.collection ?? network.name}
        </span>
      </span>
    </div>
  );

  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (step === 'pending' || step === 'done' || step === 'failed') {
    body = (
      <div
        className="flex! flex-col! items-center! text-center!"
        style={{ gap: '12px', padding: '16px 4px 8px' }}
      >
        <Mascot mood={step === 'pending' ? 'loading' : 'awake'} size={48} hole="var(--bg-1)" />
        <div style={{ fontSize: '18px', fontWeight: 300, color: 'var(--fg)' }}>
          {step === 'pending'
            ? t('nft.transferring', { defaultValue: 'Transferring' })
            : step === 'done'
              ? t('nft.transferred', { defaultValue: 'Transferred' })
              : t('evmSend.failed', { defaultValue: 'Failed' })}
        </div>
        <div style={{ fontSize: '12.5px', color: 'var(--fg-3)', lineHeight: 1.5 }}>
          {name} {t('evmSend.toShort', { defaultValue: 'to' })} {middleCut(to.trim(), 6, 4)}
        </div>
        {link && (
          <TextButton onClick={() => window.open(link, '_blank', 'noopener')}>
            {t('evmSend.viewExplorer', { defaultValue: 'View on explorer' })}
          </TextButton>
        )}
      </div>
    );
    footer = (
      <PrimaryButton secondary onClick={close}>
        {t('common.done', { defaultValue: 'Done' })}
      </PrimaryButton>
    );
  } else if ((step === 'review' || step === 'sending') && prepared) {
    body = (
      <>
        {heading}
        <div className="rounded-[18px]! bg-(--bg-2)!" style={{ padding: '4px 10px' }}>
          <ReviewRow label={t('evmSend.to', { defaultValue: 'To' })} value={to.trim()} />
          <ReviewRow
            label={t('evmSend.network', { defaultValue: 'Network' })}
            value={network.name}
          />
          <ReviewRow
            label={t('evmNft.tokenId', { defaultValue: 'Token ID' })}
            value={<span className="font-mono!">{nft.tokenId}</span>}
          />
          {multi && (
            <ReviewRow
              label={t('evmSend.amount', { defaultValue: 'Amount' })}
              value={sendUnits.toString()}
            />
          )}
          <ReviewRow
            label={t('evmSend.networkFee', { defaultValue: 'Network fee' })}
            value={
              <FeeFigureText
                fee={feeFigure(
                  prepared.feeWei,
                  18,
                  `${trim(fromUnits(prepared.feeWei, 18))} ${network.nativeSymbol}`,
                  nativePrice
                )}
              />
            }
          />
        </div>
        <p
          style={{
            margin: '12px 4px 0',
            fontSize: '11.5px',
            lineHeight: 1.5,
            color: 'var(--fg-3)',
          }}
        >
          {t('evmSend.reviewNote', {
            defaultValue:
              'EVM transfers are public and irreversible. The final fee is usually below the max fee.',
          })}
        </p>
        <FieldNote tone="neg">{problem ?? ''}</FieldNote>
      </>
    );
    footer = (
      <div className="grid! grid-cols-2!" style={{ gap: '10px' }}>
        <PrimaryButton
          secondary
          onClick={() => {
            setProblem(null);
            setStep('form');
          }}
          disabled={step === 'sending'}
        >
          {t('common.back', { defaultValue: 'Back' })}
        </PrimaryButton>
        <PrimaryButton onClick={() => void send()} loading={step === 'sending'}>
          {t('nft.transfer', { defaultValue: 'Transfer' })}
        </PrimaryButton>
      </div>
    );
  } else {
    body = (
      <>
        {heading}
        <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
          {t('evmSend.to', { defaultValue: 'To' })}
        </span>
        <input
          value={to}
          onChange={(e) => {
            setTo(e.target.value.replace(/\s+/g, '').slice(0, 64));
            setProblem(null);
          }}
          placeholder={t('evmSend.toPlaceholder', { defaultValue: '0x address' })}
          aria-label={t('evmSend.to', { defaultValue: 'To' })}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          className={`${quietField.replace('bg-(--bg-1)!', 'bg-(--bg-2)!')} ${toProblem ? 'border-(--neg)!' : ''}`}
          style={{ marginTop: '8px', fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}
        />
        <FieldNote tone="neg">{toProblem ?? ''}</FieldNote>
        {multi && (
          <div style={{ marginTop: '8px' }}>
            <div className="flex! items-center! justify-between!">
              <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
                {t('evmSend.amount', { defaultValue: 'Amount' })}
              </span>
              <TextButton size={12} onClick={() => setAmount(held.toString())}>
                {t('evmSend.max', { defaultValue: 'Max' })}
              </TextButton>
            </div>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, '').slice(0, 78))}
              inputMode="numeric"
              placeholder="1"
              aria-label={t('evmSend.amount', { defaultValue: 'Amount' })}
              className={`${quietField.replace('bg-(--bg-1)!', 'bg-(--bg-2)!')} ${amountProblem ? 'border-(--neg)!' : ''}`}
              style={{ marginTop: '8px', fontVariantNumeric: 'tabular-nums' }}
            />
            <FieldNote tone={amountProblem ? 'neg' : 'muted'}>
              {amountProblem ??
                t('evmNft.youHold', { count: Number(held), defaultValue: 'You hold {{count}}' })}
            </FieldNote>
          </div>
        )}
        <FieldNote tone="neg">{problem ?? ''}</FieldNote>
      </>
    );
    footer = (
      <PrimaryButton onClick={() => void review()} disabled={!ready} loading={busy}>
        {t('evmSend.review', { defaultValue: 'Review' })}
      </PrimaryButton>
    );
  }

  return (
    <Sheet
      open
      onClose={close}
      dismissible={step !== 'sending'}
      zIndexClass="z-picker!"
      title={
        step === 'review' || step === 'sending'
          ? t('evmNft.reviewTitle', { defaultValue: 'Review transfer' })
          : t('nft.transfer', { defaultValue: 'Transfer' })
      }
      onSubmit={step === 'form' ? () => void review() : undefined}
      footer={footer}
    >
      {body}
    </Sheet>
  );
}
