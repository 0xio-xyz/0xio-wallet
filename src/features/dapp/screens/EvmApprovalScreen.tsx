import { useRef, useState } from 'react';
import { useParams } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import type { TFunction } from 'src/i18n/core';
import { ArrowRight, Pencil } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import { unlockErrorMessage } from 'src/features/security/unlockError';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useDismiss } from 'src/hooks/ui/useDismiss';
import { Mascot } from 'src/shared/ui/Mascot';
import {
  FieldNote,
  PrimaryButton,
  RuledList,
  TextButton,
  quietField,
} from 'src/shared/ui/primitives';
import {
  applyApproveEdit,
  parseApproveAmount,
  type ApproveAmountProblem,
  type ApproveEdit,
} from 'src/services/evm/approveEdit';
import type { KnownCall } from 'src/services/evm/calldata';
import type {
  EvmApprovalChain,
  EvmApprovalWithId,
  EvmReviewWallet,
} from 'src/services/evm/dappTypes';
import { fromUnits } from 'src/utils/amount';
import FeeFigureText from 'src/features/bridge/components/FeeFigureText';
import { feeFigure } from 'src/features/bridge/bridgeUsd';
import { useNativePrice } from 'src/hooks/wallet/useNativePrice';
import { NetworkLogo } from 'src/features/wallet/components/EvmNetworkPicker';
import { Caps, Note, ReviewHeading, Row, SiteHead, WalletValue } from '../components/ReviewParts';
import EvmConnectBody from '../components/EvmConnectBody';
import { connectHeading, evmChoices, hostOf, mono, type ConnectMode } from '../siteWallets';
import AddWalletForSite from '../components/AddWalletForSite';

const trim = (amount: string, places = 6) => {
  const [int, frac = ''] = amount.split('.');
  const cut = frac.slice(0, places).replace(/0+$/, '');
  if (!cut && /[1-9]/.test(frac) && int === '0') return `< 0.${'0'.repeat(places - 1)}1`;
  return cut ? `${int}.${cut}` : int;
};

const units = (raw: string, decimals: number, places = 6) =>
  trim(fromUnits(BigInt(raw), decimals), places);

const amountProblemText = (problem: ApproveAmountProblem, t: TFunction, decimals: number) => {
  switch (problem) {
    case 'empty':
    case 'invalid':
      return t('evmDapp.amountInvalid', { defaultValue: 'Enter an amount' });
    case 'zero':
      return t('evmDapp.amountZero', { defaultValue: 'Amount must be greater than 0' });
    case 'decimals':
      return t('evmDapp.amountDecimals', {
        places: decimals,
        defaultValue: 'Max {{places}} decimals',
      });
    case 'tooLarge':
      return t('evmDapp.amountTooLarge', { defaultValue: 'Amount too large' });
    case 'above':
      return t('evmDapp.amountAbove', {
        defaultValue: 'Max is the requested amount or Unlimited',
      });
  }
};

const EDIT_BOX: React.CSSProperties = {
  width: '128px',
  height: '28px',
  borderRadius: '9px',
  border: 'none',
  background: 'var(--bg-2)',
  fontSize: '13px',
  padding: '0 9px',
};

const ApproveAmountRow = ({
  label,
  shown,
  unlimited,
  editing,
  text,
  onStart,
  onText,
  onUnlimited,
  onDone,
  onCancel,
}: {
  label: string;
  shown: string;
  unlimited: boolean;
  editing: boolean;
  text: string;
  onStart: () => void;
  onText: (v: string) => void;
  onUnlimited: (on: boolean) => void;
  onDone: () => void;
  onCancel: () => void;
}) => {
  const { t } = useTranslation();
  const ref = useDismiss<HTMLDivElement>(editing, onDone);
  const unlimitedText = t('evmDapp.unlimited', { defaultValue: 'Unlimited' });
  return (
    <div
      ref={ref}
      className="flex! items-center! justify-between!"
      style={{ padding: '6px 6px 6px 10px', gap: '10px' }}
    >
      <span className="tab-caps" style={{ color: 'var(--fg-3)', flexShrink: 0 }}>
        {label}
      </span>
      <span className="flex! min-w-0! items-center!" style={{ gap: '6px', height: '28px' }}>
        {editing ? (
          <>
            {unlimited ? (
              <button
                type="button"
                onClick={() => onUnlimited(false)}
                className="press"
                style={{
                  ...EDIT_BOX,
                  color: 'var(--accent)',
                  fontWeight: 600,
                  textAlign: 'right',
                  cursor: 'text',
                }}
              >
                {unlimitedText}
              </button>
            ) : (
              <input
                autoFocus
                value={text}
                inputMode="decimal"
                spellCheck={false}
                autoComplete="off"
                maxLength={90}
                aria-label={label}
                onChange={(e) => onText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onDone();
                  }
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    onCancel();
                  }
                }}
                style={{
                  ...EDIT_BOX,
                  color: 'var(--fg)',
                  fontFamily: 'var(--font-mono)',
                  textAlign: 'right',
                  outline: 'none',
                }}
              />
            )}
            <button
              type="button"
              aria-pressed={unlimited}
              aria-label={unlimitedText}
              title={unlimitedText}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onUnlimited(!unlimited)}
              className="press grid! place-items-center!"
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '9px',
                border: 'none',
                cursor: 'pointer',
                fontSize: '15px',
                lineHeight: 1,
                background: unlimited
                  ? 'color-mix(in oklab, var(--accent) 18%, var(--bg-2))'
                  : 'var(--bg-2)',
                color: unlimited ? 'var(--accent)' : 'var(--fg-2)',
                transition: 'background-color 200ms ease-out, color 200ms ease-out',
              }}
            >
              ∞
            </button>
          </>
        ) : (
          <>
            <span
              className="truncate!"
              style={{
                fontSize: '13px',
                color: unlimited ? 'var(--accent)' : 'var(--fg)',
                fontWeight: unlimited ? 600 : 400,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {shown}
            </span>
            <button
              type="button"
              onClick={onStart}
              aria-label={t('evmDapp.editAmount', { defaultValue: 'Edit amount' })}
              title={t('evmDapp.editAmount', { defaultValue: 'Edit amount' })}
              className="press grid! place-items-center! rounded-[9px]! transition-colors! duration-200! hover:bg-(--bg-2)!"
              style={{
                width: '28px',
                height: '28px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <Pencil size={13} style={{ color: 'var(--fg-3)' }} />
            </button>
          </>
        )}
      </span>
    </div>
  );
};

const Value = ({ value, depth }: { value: unknown; depth: number }) => {
  if (value === null || value === undefined) return <span style={{ color: 'var(--fg-3)' }}>-</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span style={{ color: 'var(--fg-3)' }}>[ ]</span>;
    return (
      <div style={{ paddingLeft: depth ? '10px' : 0 }}>
        {value.map((v, i) => (
          <Field key={i} name={`${i + 1}`} value={v} depth={depth + 1} />
        ))}
      </div>
    );
  }
  if (typeof value === 'object') {
    return (
      <div style={{ paddingLeft: depth ? '10px' : 0 }}>
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <Field key={k} name={k} value={v} depth={depth + 1} />
        ))}
      </div>
    );
  }
  return (
    <span style={{ ...mono, color: 'var(--fg)', overflowWrap: 'anywhere' }}>{String(value)}</span>
  );
};

const Field = ({ name, value, depth }: { name: string; value: unknown; depth: number }) => {
  const nested = value !== null && typeof value === 'object';
  return (
    <div style={{ padding: '5px 0' }}>
      <div
        className={nested ? '' : 'flex! justify-between!'}
        style={{ gap: '12px', alignItems: 'baseline' }}
      >
        <span style={{ fontSize: '11.5px', color: 'var(--fg-3)', flexShrink: 0 }}>{name}</span>
        {!nested && (
          <span style={{ textAlign: 'right', minWidth: 0 }}>
            <Value value={value} depth={depth} />
          </span>
        )}
      </div>
      {nested && <Value value={value} depth={depth} />}
    </div>
  );
};

const callName = (call: KnownCall | null, selector: string | null, t: TFunction) => {
  if (!selector) return null;
  const names: Record<KnownCall['kind'], string> = {
    transfer: t('evmDapp.fnTransfer', { defaultValue: 'Token transfer' }),
    approve: t('evmDapp.fnApprove', { defaultValue: 'Token approval' }),
    increaseAllowance: t('evmDapp.fnIncrease', { defaultValue: 'Increase allowance' }),
    transferFrom: t('evmDapp.fnTransferFrom', { defaultValue: 'Transfer from' }),
    setApprovalForAll: t('evmDapp.fnApproveAll', { defaultValue: 'Set approval for all' }),
  };
  return call ? names[call.kind] : t('evmDapp.fnUnknown', { defaultValue: 'Unknown call' });
};

const EvmApprovalScreen = () => {
  const { t } = useTranslation();
  const { approvalId } = useParams();
  const { isLocked, unlockWallet, passwordSkipped, wallets } = useWallet();
  const [pick, setPick] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [req, setReq] = useState<EvmApprovalWithId | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [showData, setShowData] = useState(false);
  const [amountEdit, setAmountEdit] = useState<{ text: string; unlimited: boolean } | null>(null);
  const [editingAmount, setEditingAmount] = useState(false);
  const nativePrice = useNativePrice(req?.kind === 'sendTx' ? req.chain : null);
  const answered = useRef(false);

  const approveCall =
    req?.kind === 'sendTx' &&
    (req.call?.kind === 'approve' || req.call?.kind === 'increaseAllowance')
      ? req.call
      : null;
  const approveDecimals = req?.kind === 'sendTx' ? (req.token?.decimals ?? 0) : 0;
  const parsedAmount =
    approveCall && amountEdit && !amountEdit.unlimited
      ? parseApproveAmount(amountEdit.text, approveDecimals, BigInt(approveCall.amount))
      : null;
  const amountProblem = parsedAmount && 'problem' in parsedAmount ? parsedAmount.problem : null;
  const approveEdit: ApproveEdit | null =
    !approveCall || !amountEdit
      ? null
      : amountEdit.unlimited
        ? { unlimited: true }
        : parsedAmount && 'units' in parsedAmount
          ? { unlimited: false, amount: parsedAmount.units.toString() }
          : null;

  const answer = async (approved: boolean) => {
    answered.current = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'EVM_APPROVAL_RESPONSE',
        approvalId,
        approved,
        ...(approved && approveEdit ? { edit: approveEdit } : {}),
        ...(approved && connectPick ? { walletId: connectPick } : {}),
      });
    } finally {
      window.close();
    }
  };

  const startAmountEdit = () => {
    if (!approveCall) return;
    if (!amountEdit) {
      setAmountEdit({
        text: approveCall.unlimited ? '' : fromUnits(BigInt(approveCall.amount), approveDecimals),
        unlimited: approveCall.unlimited,
      });
    }
    setEditingAmount(true);
  };

  const finishAmountEdit = () => {
    if (amountEdit && !amountEdit.unlimited && !amountEdit.text.trim()) {
      setAmountEdit(null);
    } else if (amountProblem) {
      return;
    }
    setEditingAmount(false);
  };

  useMountEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'EVM_APPROVAL_DATA', approvalId })
      .then((res: { data?: EvmApprovalWithId | null }) => {
        if (!res?.data) window.close();
        else {
          setReq(res.data);
          if (res.data.kind === 'connect') setPick(res.data.preselect);
        }
      })
      .catch(() => window.close())
      .finally(() => setLoading(false));
    const onUnload = () => {
      if (!answered.current) {
        chrome.runtime.sendMessage({ type: 'EVM_APPROVAL_RESPONSE', approvalId, approved: false });
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  });

  const needsUnlock = isLocked && !passwordSkipped;

  const choices: { wallet: (typeof wallets)[number]; address: string }[] =
    req?.kind === 'connect' && !req.open.address
      ? wallets.length
        ? evmChoices(wallets)
        : req.wallets.map((w) => ({
            wallet: { id: w.walletId, name: w.name, address: w.octra } as (typeof wallets)[number],
            address: w.address,
          }))
      : [];
  const connectMode: ConnectMode | null =
    req?.kind !== 'connect'
      ? null
      : req.open.address
        ? {
            kind: 'fixed',
            choice: {
              wallet:
                wallets.find((w) => w.id === req.open.walletId) ??
                ({
                  id: req.open.walletId,
                  name: req.open.name,
                  address: req.open.octra,
                } as (typeof wallets)[number]),
              address: req.open.address,
            },
          }
        : choices.length
          ? { kind: 'pick' }
          : { kind: 'empty' };
  const connectPick =
    connectMode?.kind === 'pick' && choices.some((c) => c.wallet.id === pick) ? pick : null;

  const unlock = async (): Promise<boolean> => {
    if (!needsUnlock) return true;
    try {
      await unlockWallet(password);
      setPassword('');
      return true;
    } catch (e) {
      setError(unlockErrorMessage(e, t));
      return false;
    }
  };

  const approve = async () => {
    if (busy || amountProblem) return;
    setBusy(true);
    setError('');
    if (!(await unlock())) {
      setBusy(false);
      return;
    }
    if (connectMode?.kind === 'empty') {
      setBusy(false);
      void chrome.runtime.sendMessage({ type: 'EVM_APPROVAL_EXTEND', approvalId }).catch(() => {});
      setAdding(true);
      return;
    }
    await answer(true);
  };

  if (loading || !req) {
    return (
      <div className="flex! h-full! w-full! items-center! justify-center! bg-(--bg)!">
        <Mascot mood="loading" size={48} />
      </div>
    );
  }

  const host = hostOf(req.origin);
  let caps = '';
  let heading = '';
  let action = '';
  let blocked = false;
  let blockedReason = '';
  let body: React.ReactNode = null;

  switch (req.kind) {
    case 'connect':
      caps = t('evmDapp.connectCaps', { defaultValue: 'Connection request' });
      heading = connectHeading(connectMode!, t);
      action =
        connectMode!.kind === 'empty'
          ? t('evmDapp.addTitle', { defaultValue: 'Add a wallet' })
          : t('evmDapp.connect', { defaultValue: 'Connect' });
      blocked = connectMode!.kind === 'pick' && !connectPick;
      body = (
        <EvmConnectBody
          origin={req.origin}
          chainName={req.chain.name}
          mode={connectMode!}
          open={
            wallets.find((w) => w.id === req.open.walletId) ??
            ({
              id: req.open.walletId,
              name: req.open.name,
              address: req.open.octra,
            } as (typeof wallets)[number])
          }
          choices={choices}
          pick={connectPick}
          onPick={setPick}
          wallets={wallets}
        />
      );
      break;
    case 'switchSide': {
      const toSide =
        req.side === 'mainnet'
          ? t('footer.mainnet', { defaultValue: 'Mainnet' })
          : t('footer.testnet', { defaultValue: 'Testnet' });
      const fromSide =
        req.side === 'mainnet'
          ? t('footer.testnet', { defaultValue: 'Testnet' })
          : t('footer.mainnet', { defaultValue: 'Mainnet' });
      caps = t('evmDapp.switchCaps', { defaultValue: 'Network request' });
      heading = t('evmDapp.sideTitle', { side: toSide, defaultValue: 'Switch 0xio to {{side}}' });
      action =
        req.side === 'mainnet'
          ? t('evmDapp.toMainnet', { defaultValue: 'Switch to Mainnet' })
          : t('evmDapp.toTestnet', { defaultValue: 'Switch to Testnet' });
      body = (
        <>
          <div className="flex! items-center!" style={{ gap: '8px' }}>
            <SideCard
              label={t('evmDapp.from', { defaultValue: 'From' })}
              chain={req.from}
              side={fromSide}
            />
            <ArrowRight size={14} style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
            <SideCard
              label={t('evmDapp.to', { defaultValue: 'To' })}
              chain={req.to}
              side={toSide}
            />
          </div>
          <div className="flex! flex-col!" style={{ marginTop: '12px', gap: '10px' }}>
            <Note>
              {t(req.side === 'mainnet' ? 'evmDapp.sideWantsMainnet' : 'evmDapp.sideWantsTestnet', {
                host,
                chain: req.to.name,
                side: fromSide,
                defaultValue:
                  req.side === 'mainnet'
                    ? '{{host}} wants {{chain}}, a mainnet. 0xio is on {{side}}.'
                    : '{{host}} wants {{chain}}, a testnet. 0xio is on {{side}}.',
              })}
            </Note>
            <Note>
              {t('evmDapp.sideNote', {
                side: toSide,
                other: fromSide,
                defaultValue:
                  'Home, balances and every connected site move to {{side}}. {{other}} sites see their network change.',
              })}
            </Note>
          </div>
        </>
      );
      break;
    }
    case 'switchChain':
      caps = t('evmDapp.switchCaps', { defaultValue: 'Network request' });
      heading = t('evmDapp.switchTitle', { defaultValue: 'Switch network' });
      action = t('evmDapp.switch', { defaultValue: 'Switch' });
      body = (
        <RuledList>
          <Row label={t('evmDapp.from', { defaultValue: 'From' })}>{req.from.name}</Row>
          <Row label={t('evmDapp.to', { defaultValue: 'To' })}>{req.to.name}</Row>
          <Row label={t('evmDapp.chainId', { defaultValue: 'Chain ID' })}>{req.to.chainId}</Row>
        </RuledList>
      );
      break;
    case 'addChain':
      caps = t('evmDapp.addChainCaps', { defaultValue: 'Network request' });
      heading = t('evmDapp.addChainTitle', { defaultValue: 'Add a network' });
      action = t('evmDapp.addChain', { defaultValue: 'Add and switch' });
      body = (
        <>
          <RuledList>
            <Row label={t('evmDapp.name', { defaultValue: 'Name' })}>{req.name}</Row>
            <Row label={t('evmDapp.chainId', { defaultValue: 'Chain ID' })}>{req.chainId}</Row>
            <Row label={t('evmDapp.rpc', { defaultValue: 'RPC' })}>
              <span style={mono}>{req.rpcUrl}</span>
            </Row>
            <Row label={t('evmDapp.currency', { defaultValue: 'Currency' })}>{req.symbol}</Row>
            {req.explorerUrl && (
              <Row label={t('evmDapp.explorer', { defaultValue: 'Explorer' })}>
                <span style={mono}>{req.explorerUrl}</span>
              </Row>
            )}
          </RuledList>
          <div style={{ marginTop: '12px' }}>
            <Note>
              {t('evmDapp.addChainNote', {
                defaultValue:
                  'Add networks only from sites you trust. This RPC can see your address and your activity on this network.',
              })}
            </Note>
          </div>
        </>
      );
      break;
    case 'watchAsset':
      caps = t('evmDapp.watchCaps', { defaultValue: 'Token request' });
      heading = t('evmDapp.watchTitle', { defaultValue: 'Add token' });
      action = t('evmDapp.addToken', { defaultValue: 'Add token' });
      body = (
        <>
          <RuledList>
            <Row label={t('evmDapp.token', { defaultValue: 'Token' })}>{req.symbol}</Row>
            <Row label={t('evmDapp.name', { defaultValue: 'Name' })}>{req.name}</Row>
            <Row label={t('evmDapp.contract', { defaultValue: 'Contract' })}>
              <span style={mono}>{req.address}</span>
            </Row>
            <Row label={t('evmDapp.decimals', { defaultValue: 'Decimals' })}>{req.decimals}</Row>
            <Row label={t('evmDapp.network', { defaultValue: 'Network' })}>{req.chain.name}</Row>
          </RuledList>
          <div style={{ marginTop: '12px' }}>
            <Note>
              {t('evmDapp.watchNote', {
                defaultValue:
                  'Token names are not unique. Verify the contract address before you trust its balance.',
              })}
            </Note>
          </div>
        </>
      );
      break;
    case 'personalSign':
      caps = t('evmDapp.signCaps', { defaultValue: 'Signature request' });
      heading = t('evmDapp.signTitle', { defaultValue: 'Sign message' });
      action = t('evmDapp.sign', { defaultValue: 'Sign' });
      body = (
        <>
          <SigningWith signer={req.signer} open={req.openWallet} />
          <Caps>
            {req.text === null
              ? t('evmDapp.messageHex', { defaultValue: 'Message (hex)' })
              : t('evmDapp.message', { defaultValue: 'Message' })}
          </Caps>
          <div
            className="rounded-[18px]! bg-(--bg-1)!"
            style={{ padding: '12px 14px', maxHeight: '220px', overflowY: 'auto' }}
          >
            <pre
              style={{
                ...mono,
                margin: 0,
                color: 'var(--fg)',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                lineHeight: 1.5,
              }}
            >
              {req.text ?? req.hex}
            </pre>
          </div>
          {req.text === null && (
            <div style={{ marginTop: '12px' }}>
              <Note strong>
                {t('evmDapp.hexNote', {
                  defaultValue:
                    'This message is not human-readable. Sign only if you trust {{host}}.',
                  host,
                })}
              </Note>
            </div>
          )}
        </>
      );
      break;
    case 'typedData':
      caps = t('evmDapp.signCaps', { defaultValue: 'Signature request' });
      heading = req.permit
        ? t('evmDapp.permitTitle', { defaultValue: 'Sign token permit' })
        : t('evmDapp.typedTitle', { defaultValue: 'Sign {{type}}', type: req.primaryType });
      action = t('evmDapp.sign', { defaultValue: 'Sign' });
      body = (
        <>
          {req.permit && (
            <div style={{ marginBottom: '12px' }}>
              <Note strong>
                {t('evmDapp.permitNote', {
                  defaultValue:
                    'This permit lets the spender below transfer your tokens without a separate approval. Sign only if you trust {{host}}.',
                  host,
                })}
              </Note>
            </div>
          )}
          <SigningWith signer={req.signer} open={req.openWallet} />
          <div style={{ marginTop: '12px' }}>
            <RuledList>
              <Row label={t('evmDapp.network', { defaultValue: 'Network' })}>{req.chain.name}</Row>
            </RuledList>
          </div>
          <Caps>{t('evmDapp.domain', { defaultValue: 'Domain' })}</Caps>
          <div className="rounded-[18px]! bg-(--bg-1)!" style={{ padding: '8px 14px' }}>
            <Value value={req.domain} depth={0} />
          </div>
          <Caps>{req.primaryType}</Caps>
          <div className="rounded-[18px]! bg-(--bg-1)!" style={{ padding: '8px 14px' }}>
            <Value value={req.message} depth={0} />
          </div>
        </>
      );
      break;
    case 'sendTx': {
      caps = t('evmDapp.txCaps', { defaultValue: 'Transaction request' });
      action = req.deploy
        ? t('evmDapp.deploy', { defaultValue: 'Deploy' })
        : t('evmDapp.send', { defaultValue: 'Send' });
      const sym = req.chain.nativeSymbol;
      const tok = req.token;
      const call = req.call;
      const tokenAmount = (raw: string) =>
        tok
          ? `${units(raw, tok.decimals)} ${tok.symbol}`
          : `${raw} ${t('evmDapp.baseUnits', { defaultValue: 'base units' })}`;
      const short = req.balance !== null && BigInt(req.total) > BigInt(req.balance);
      blocked = short;
      if (short) {
        blockedReason = t('evmDapp.noFunds', {
          defaultValue: 'Insufficient {{symbol}} on {{chain}} for amount and network fee',
          symbol: sym,
          chain: req.chain.name,
        });
      }
      const valueText = `${units(req.value, 18, 8)} ${sym}`;
      heading = req.deploy
        ? t('evmDapp.deployTitle', { defaultValue: 'Deploy a contract' })
        : call?.kind === 'transfer'
          ? tokenAmount(call.amount)
          : call?.kind === 'approve' || call?.kind === 'increaseAllowance'
            ? t('evmDapp.approveTitle', {
                defaultValue: 'Approve {{token}} spending',
                token: tok?.symbol ?? t('evmDapp.aToken', { defaultValue: 'token' }),
              })
            : req.value !== '0'
              ? valueText
              : req.contract
                ? t('evmDapp.callTitle', { defaultValue: 'Contract call' })
                : valueText;
      const fn = callName(call, req.selector, t);
      const signedUnlimited = approveCall
        ? amountEdit
          ? amountEdit.unlimited
          : approveCall.unlimited
        : false;
      let signedData = req.data;
      try {
        signedData = applyApproveEdit(req.data, approveEdit);
      } catch {
        signedData = req.data;
      }
      body = (
        <>
          <SigningWith signer={req.signer} open={req.openWallet} />
          <div style={{ marginTop: '12px' }} />
          <RuledList>
            <Row
              label={
                req.deploy
                  ? t('evmDapp.newContract', { defaultValue: 'New contract' })
                  : req.contract
                    ? t('evmDapp.contract', { defaultValue: 'Contract' })
                    : t('evmDapp.to', { defaultValue: 'To' })
              }
            >
              <span style={mono}>{req.to}</span>
            </Row>
            {req.deploy && (
              <Row label={t('evmDapp.codeSize', { defaultValue: 'Code size' })}>
                {req.deploy.codeSize.toLocaleString()}{' '}
                {t('evmDapp.bytes', { defaultValue: 'bytes' })}
              </Row>
            )}
            {req.value !== '0' && (
              <Row label={t('evmDapp.value', { defaultValue: 'Value' })}>{valueText}</Row>
            )}
            {fn && (
              <Row label={t('evmDapp.function', { defaultValue: 'Function' })}>
                {fn} <span style={{ ...mono, color: 'var(--fg-3)' }}>({req.selector})</span>
              </Row>
            )}
            {call?.kind === 'transfer' && (
              <Row label={t('evmDapp.recipient', { defaultValue: 'Recipient' })}>
                <span style={mono}>{call.to}</span>
              </Row>
            )}
            {call?.kind === 'transferFrom' && (
              <>
                <Row label={t('evmDapp.from', { defaultValue: 'From' })}>
                  <span style={mono}>{call.from}</span>
                </Row>
                <Row label={t('evmDapp.recipient', { defaultValue: 'Recipient' })}>
                  <span style={mono}>{call.to}</span>
                </Row>
                <Row label={t('evmDapp.amount', { defaultValue: 'Amount' })}>
                  {tokenAmount(call.amount)}
                </Row>
              </>
            )}
            {(call?.kind === 'approve' || call?.kind === 'increaseAllowance') && (
              <>
                <Row label={t('evmDapp.spender', { defaultValue: 'Spender' })}>
                  <span style={mono}>{call.spender}</span>
                </Row>
                <ApproveAmountRow
                  label={t('evmDapp.amount', { defaultValue: 'Amount' })}
                  shown={
                    signedUnlimited
                      ? t('evmDapp.unlimited', { defaultValue: 'Unlimited' })
                      : tokenAmount(
                          approveEdit?.unlimited === false ? approveEdit.amount : call.amount
                        )
                  }
                  unlimited={editingAmount ? !!amountEdit?.unlimited : signedUnlimited}
                  editing={editingAmount}
                  text={amountEdit?.text ?? ''}
                  onStart={startAmountEdit}
                  onText={(text) => setAmountEdit((e) => ({ unlimited: false, ...e, text }))}
                  onUnlimited={(on) =>
                    setAmountEdit((e) => ({ text: e?.text ?? '', unlimited: on }))
                  }
                  onDone={finishAmountEdit}
                  onCancel={() => {
                    setAmountEdit(null);
                    setEditingAmount(false);
                  }}
                />
              </>
            )}
            {call?.kind === 'setApprovalForAll' && (
              <>
                <Row label={t('evmDapp.operator', { defaultValue: 'Operator' })}>
                  <span style={mono}>{call.operator}</span>
                </Row>
                <Row label={t('evmDapp.access', { defaultValue: 'Access' })}>
                  {call.approved
                    ? t('evmDapp.allItems', { defaultValue: 'Every item in this collection' })
                    : t('evmDapp.revoked', { defaultValue: 'Revoked' })}
                </Row>
              </>
            )}
            <Row label={t('evmDapp.network', { defaultValue: 'Network' })}>{req.chain.name}</Row>
            <Row label={t('evmDapp.networkFee', { defaultValue: 'Network fee' })}>
              <FeeFigureText
                fee={feeFigure(BigInt(req.fee), 18, `${units(req.fee, 18, 8)} ${sym}`, nativePrice)}
              />
              {req.feeFromSite && (
                <div style={{ fontSize: '11px', color: 'var(--fg-3)', marginTop: '2px' }}>
                  {t('evmDapp.feeFromSite', { defaultValue: 'Suggested by site' })}
                </div>
              )}
            </Row>
            <Row label={t('evmDapp.maxTotal', { defaultValue: 'Max total' })}>
              <FeeFigureText
                fee={feeFigure(
                  BigInt(req.total),
                  18,
                  `${units(req.total, 18, 8)} ${sym}`,
                  nativePrice
                )}
              />
            </Row>
          </RuledList>

          {signedUnlimited && (
            <div style={{ marginTop: '12px' }}>
              <Note strong>
                {t('evmDapp.unlimitedNote', {
                  defaultValue:
                    'Unlimited approval. The spender can transfer all of this token from your address until you revoke it.',
                })}
              </Note>
            </div>
          )}
          {call?.kind === 'setApprovalForAll' && call.approved && (
            <div style={{ marginTop: '12px' }}>
              <Note strong>
                {t('evmDapp.approveAllNote', {
                  defaultValue:
                    'The operator can transfer every item you hold in this collection until you revoke it.',
                })}
              </Note>
            </div>
          )}
          {req.deploy && (
            <div style={{ marginTop: '12px' }}>
              <Note strong>
                {t('evmDapp.deployNote', {
                  defaultValue:
                    'This creates a new contract from code {{host}} provided. 0xio cannot read what the code does. Deploy it only if you trust the site.',
                  host,
                })}
              </Note>
            </div>
          )}
          {req.selector && !call && (
            <div style={{ marginTop: '12px' }}>
              <Note strong>
                {t('evmDapp.unknownNote', {
                  defaultValue:
                    '0xio cannot decode this contract call. Confirm only if you trust {{host}}.',
                  host,
                })}
              </Note>
            </div>
          )}

          {req.data !== '0x' && (
            <div style={{ marginTop: '12px', padding: '0 4px' }}>
              <TextButton onClick={() => setShowData((v) => !v)} size={12}>
                {showData
                  ? t('evmDapp.hideData', { defaultValue: 'Hide data' })
                  : t('evmDapp.showData', {
                      defaultValue: 'Show data ({{n}} bytes)',
                      n: (req.data.length - 2) / 2,
                    })}
              </TextButton>
              {showData && (
                <div
                  className="rounded-[18px]! bg-(--bg-1)!"
                  style={{
                    marginTop: '8px',
                    padding: '12px 14px',
                    maxHeight: '160px',
                    overflowY: 'auto',
                    ...mono,
                    fontSize: '11px',
                    color: 'var(--fg-2)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {signedData}
                </div>
              )}
            </div>
          )}

          <p
            style={{
              margin: '12px 4px 0',
              fontSize: '11.5px',
              lineHeight: 1.5,
              color: 'var(--fg-3)',
            }}
          >
            {t('evmDapp.txNote', {
              defaultValue:
                'EVM transactions are public and irreversible. The final fee is usually below the max fee.',
            })}
          </p>
        </>
      );
      break;
    }
  }

  return (
    <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
      <div
        className="flex-1! overflow-y-auto! scrollbar-hide!"
        style={{ padding: '20px var(--gutter) 12px' }}
      >
        <div className="tab-caps" style={{ color: 'var(--fg-3)' }}>
          {caps}
        </div>
        <SiteHead origin={req.origin} favicon={req.favicon} />
        <ReviewHeading big={req.kind === 'sendTx'}>{heading}</ReviewHeading>
        {body}
      </div>

      <div style={{ flexShrink: 0, padding: '8px var(--gutter) 20px' }}>
        {needsUnlock && (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && password) void approve();
            }}
            autoComplete="current-password"
            placeholder={t('evmDapp.password', { defaultValue: 'Password' })}
            aria-label={t('evmDapp.password', { defaultValue: 'Password' })}
            className={quietField}
            style={{ height: '48px', borderRadius: '16px', marginBottom: '10px' }}
          />
        )}
        <FieldNote tone="neg">
          {error ||
            (amountProblem ? amountProblemText(amountProblem, t, approveDecimals) : '') ||
            blockedReason}
        </FieldNote>
        <div className="flex!" style={{ gap: '10px', marginTop: '6px' }}>
          <PrimaryButton
            secondary
            onClick={() => void answer(false)}
            disabled={busy}
            style={BIG_BUTTON}
          >
            {connectMode?.kind === 'empty'
              ? t('common.close', { defaultValue: 'Close' })
              : t('evmDapp.cancel', { defaultValue: 'Reject' })}
          </PrimaryButton>
          <PrimaryButton
            onClick={() => void approve()}
            loading={busy}
            disabled={blocked || !!amountProblem || (needsUnlock && !password)}
            style={BIG_BUTTON}
          >
            {action}
          </PrimaryButton>
        </div>
      </div>
      {req.kind === 'connect' && (
        <AddWalletForSite
          open={adding}
          onClose={() => setAdding(false)}
          onAdded={(walletId) => setPick(walletId)}
        />
      )}
    </div>
  );
};

const SigningWith = ({
  signer,
  open,
}: {
  signer: EvmReviewWallet;
  open: { walletId: string; name: string; octra: string } | null;
}) => {
  const { t } = useTranslation();
  const { wallets } = useWallet();
  const avatar = wallets.find((w) => w.id === signer.walletId)?.address ?? signer.octra;
  return (
    <>
      <div className="tab-caps" style={{ color: 'var(--fg-3)', margin: '0 4px 8px' }}>
        {t('evmDapp.signingWith', { defaultValue: 'Signing with' })}
      </div>
      <RuledList>
        <Row label={t('evmDapp.wallet', { defaultValue: 'Wallet' })}>
          <WalletValue name={signer.name} avatar={avatar} address={signer.address} />
        </Row>
      </RuledList>
      <OpenInWallet open={open} />
    </>
  );
};

const OpenInWallet = ({
  open,
}: {
  open: { walletId: string; name: string; octra: string } | null;
}) => {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div style={{ marginTop: '4px', padding: '0 4px' }}>
      <Row label={t('evmDapp.openInWallet', { defaultValue: 'Open in 0xio' })}>
        <WalletValue name={open.name} avatar={open.octra} />
      </Row>
    </div>
  );
};

const SideCard = ({
  label,
  chain,
  side,
}: {
  label: string;
  chain: EvmApprovalChain;
  side: string;
}) => (
  <div
    className="flex-1! min-w-0! rounded-[18px]! bg-(--bg-1)!"
    style={{ padding: '12px 14px', boxShadow: 'var(--raise-shadow)' }}
  >
    <div className="tab-caps" style={{ color: 'var(--fg-3)' }}>
      {label}
    </div>
    <div className="flex! items-center! min-w-0!" style={{ gap: '8px', marginTop: '10px' }}>
      <NetworkLogo
        network={{ logoChainId: chain.logoChainId ?? chain.chainId, name: chain.name }}
        size={20}
      />
      <span className="truncate!" style={{ fontSize: '14px', color: 'var(--fg)' }}>
        {chain.name}
      </span>
    </div>
    <div style={{ marginTop: '8px' }}>
      {chain.testnet ? (
        <span
          className="rounded-full!"
          style={{
            fontSize: '10.5px',
            padding: '1px 7px',
            color: 'var(--fg-2)',
            boxShadow: 'inset 0 0 0 1px var(--fg-3)',
          }}
        >
          {side}
        </span>
      ) : (
        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--fg)' }}>{side}</span>
      )}
    </div>
  </div>
);

export default EvmApprovalScreen;
