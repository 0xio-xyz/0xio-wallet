import { useCallback, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Copy } from 'src/shared/ui/icons';
import { useCopied } from 'src/hooks/ui/useCopied';
import { useOverflowing } from 'src/hooks/ui/useOverflowing';
import { useSheetEscape } from 'src/hooks/ui/useSheetEscape';
import { Sheet, TextButton } from './primitives';
import OutlineTag from './OutlineTag';
import type { CallData } from './callRows';
import { writeClipboard } from 'src/utils/secretClipboard';

export interface TxDetailRow {
  label: string;
  value: string;
  tone?: string;
  mono?: boolean;
  copy?: string;
  logo?: string | null;
}

export const middleOf = (value: string, head = 10, tail = 8) =>
  value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;

export const whenOf = (timestamp: number) => {
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const CARD = 'rounded-[14px]! bg-(--bg-2)!';
const CARD_STYLE = { padding: '4px 14px' } as const;
const CLAMP_LINES = 6;

const CallBlock = ({
  label,
  aside,
  value,
  friendly,
  mono = true,
  copied,
  onCopy,
}: {
  label: string;
  aside?: string;
  value: string;
  friendly?: string;
  mono?: boolean;
  copied?: boolean;
  onCopy?: () => void;
}) => {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const [clampRef, clamped] = useOverflowing<HTMLSpanElement>();
  const lines = (
    <>
      {friendly && (
        <span
          className="block!"
          style={{ fontSize: '12px', color: 'var(--fg)', overflowWrap: 'anywhere' }}
        >
          {friendly}
        </span>
      )}
      <span
        ref={clampRef}
        style={{
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: all ? 'none' : CLAMP_LINES,
          overflow: 'hidden',
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          fontSize: friendly ? '10.5px' : mono ? '11.5px' : '12px',
          lineHeight: 1.5,
          color: friendly ? 'var(--fg-3)' : 'var(--fg)',
          overflowWrap: 'anywhere',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </>
  );
  return (
    <div style={{ padding: '10px 0' }}>
      <div className="flex! items-baseline! justify-between!" style={{ gap: '12px' }}>
        <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{label}</span>
        {(copied || aside) && (
          <span
            className="shrink-0!"
            style={{
              fontSize: '10.5px',
              color: 'var(--fg-3)',
              fontFamily: copied ? undefined : 'var(--font-mono)',
            }}
          >
            {copied ? t('toast.copied', { defaultValue: 'Copied' }) : aside}
          </span>
        )}
      </div>
      {onCopy ? (
        <button
          type="button"
          onClick={onCopy}
          className="flex! flex-col! w-full! text-left! hover:opacity-80! transition-opacity!"
          style={{
            gap: '2px',
            marginTop: '4px',
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
        >
          {lines}
        </button>
      ) : (
        <div className="flex! flex-col!" style={{ gap: '2px', marginTop: '4px' }}>
          {lines}
        </div>
      )}
      {clamped && !all && (
        <TextButton onClick={() => setAll(true)} size={11.5} style={{ marginTop: '6px' }}>
          {t('deployReview.showAll', { defaultValue: 'Show all' })}
        </TextButton>
      )}
    </div>
  );
};

export const TxDetails = ({
  open,
  onClose,
  amount,
  amountTone,
  sub,
  rows,
  hash,
  explorerUrl,
  tag,
  callData,
  callDataPending,
}: {
  tag?: string | null;
  callData?: CallData | null;
  callDataPending?: boolean;
  open: boolean;
  onClose: () => void;
  amount: string;
  amountTone: string;
  sub: string;
  rows: TxDetailRow[];
  hash: string;
  explorerUrl: string | null;
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copiedRow, setCopiedRow] = useState<number | null>(null);
  const [brokenLogos, setBrokenLogos] = useState<string[]>([]);
  const [page, setPage] = useState<{ hash: string; call: boolean } | null>(null);
  const callCopy = useCopied();
  const hasCallData = !!callData && (callData.args.length > 0 || !!callData.input);
  const onCallPage = hasCallData && page?.hash === hash && page.call;
  const returned = page?.hash === hash && !page.call;

  const back = () => setPage({ hash, call: false });
  useSheetEscape(open && onCallPage, back);

  const toTop = useCallback((el: HTMLDivElement | null) => {
    if (el?.parentElement) el.parentElement.scrollTop = 0;
  }, []);
  const focusOnMount = useCallback(
    (el: HTMLButtonElement | null) => el?.focus({ preventScroll: true }),
    []
  );
  const focusRow = useCallback(
    (el: HTMLButtonElement | null) => {
      if (returned) el?.focus({ preventScroll: true });
    },
    [returned]
  );

  const copyRow = async (index: number, text: string) => {
    try {
      await writeClipboard(text);
      setCopiedRow(index);
      setTimeout(() => setCopiedRow((c) => (c === index ? null : c)), 1500);
    } catch {
      setCopiedRow(null);
    }
  };

  const copy = async () => {
    try {
      await writeClipboard(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const block = (id: string, text: string) => ({
    copied: callCopy.isCopied(id),
    onCopy: () => {
      void callCopy.copy(text, id);
    },
  });

  const callPage = callData && (
    <div
      key="call"
      ref={toTop}
      className="sheet-page-push"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        back();
      }}
    >
      <div className="flex! items-center!" style={{ gap: '4px', margin: '0 0 14px -6px' }}>
        <button
          ref={focusOnMount}
          type="button"
          aria-label={t('common.back', { defaultValue: 'Back' })}
          onClick={back}
          className="press flex! items-center! justify-center! rounded-full! bg-transparent! hover:bg-(--bg-2)!"
          style={{
            width: '28px',
            height: '28px',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'var(--fg-2)',
          }}
        >
          <ChevronLeft size={18} />
        </button>
        <span
          style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-0.1px', color: 'var(--fg)' }}
        >
          {t('txDetail.callData', { defaultValue: 'Call data' })}
        </span>
      </div>

      {(callData.method || callData.functionName || callData.selector || callData.contract) && (
        <div className={CARD} style={CARD_STYLE}>
          {callData.method && (
            <CallBlock
              label={t('txDetail.method', { defaultValue: 'Method' })}
              value={callData.method}
              mono={false}
            />
          )}
          {callData.functionName && (
            <CallBlock
              label={t('evmDapp.function', { defaultValue: 'Function' })}
              value={callData.functionName}
              {...block('function', callData.functionName)}
            />
          )}
          {callData.selector && (
            <CallBlock
              label={t('txDetail.selector', { defaultValue: 'Selector' })}
              value={callData.selector}
              {...block('selector', callData.selector)}
            />
          )}
          {callData.contract && (
            <CallBlock
              label={t('txDetail.contract', { defaultValue: 'Contract' })}
              friendly={callData.contract.name ?? undefined}
              value={callData.contract.address}
              {...block('contract', callData.contract.address)}
            />
          )}
        </div>
      )}

      <div className={CARD} style={{ ...CARD_STYLE, marginTop: '10px' }}>
        {callData.args.map((arg) => (
          <CallBlock
            key={arg.index}
            label={arg.label}
            aside={arg.type}
            friendly={arg.friendly}
            value={arg.value}
            {...block(`arg-${arg.index}`, arg.value)}
          />
        ))}
        {callData.input && (
          <CallBlock
            label={t('txDetail.inputData', { defaultValue: 'Input data' })}
            value={callData.input}
            {...block('input', callData.input)}
          />
        )}
      </div>
    </div>
  );

  const detailsPage = (
    <div key="details" ref={toTop} className={returned ? 'sheet-page-pop' : undefined}>
      <div className="flex! flex-col! items-center!" style={{ gap: '6px', padding: '4px 0 14px' }}>
        <div className="flex! items-center! justify-center! gap-1.5! min-w-0! max-w-full!">
          <span
            className="min-w-0!"
            style={{
              fontSize: '24px',
              fontWeight: 400,
              letterSpacing: '-0.02em',
              color: amountTone,
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'center',
              overflowWrap: 'anywhere',
            }}
          >
            {amount}
          </span>
          {tag && <OutlineTag label={tag} />}
        </div>
        <span
          style={{ fontSize: '11.5px', color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}
        >
          {sub}
        </span>
      </div>

      <div className={CARD} style={CARD_STYLE}>
        {rows.map((row, index) => {
          const logo = row.logo && !brokenLogos.includes(row.logo) ? row.logo : null;
          const text = (
            <span
              className="truncate!"
              style={{
                fontSize: '12px',
                color: row.tone ?? 'var(--fg)',
                fontFamily: row.mono && copiedRow !== index ? 'var(--font-mono)' : undefined,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {copiedRow === index ? t('toast.copied', { defaultValue: 'Copied' }) : row.value}
            </span>
          );
          return (
            <div
              key={`${row.label}-${index}`}
              className="flex! items-center! justify-between!"
              style={{ padding: '9px 0', gap: '12px', minHeight: '34px' }}
            >
              <span style={{ fontSize: '12px', color: 'var(--fg-3)', flexShrink: 0 }}>
                {row.label}
              </span>
              <span className="flex! items-center! min-w-0!" style={{ gap: '6px' }}>
                {logo && (
                  <img
                    src={logo}
                    alt=""
                    width={14}
                    height={14}
                    onError={() => setBrokenLogos((b) => [...b, logo])}
                    className="rounded-full! object-cover! shrink-0!"
                    style={{ width: '14px', height: '14px' }}
                  />
                )}
                {row.copy ? (
                  <button
                    type="button"
                    onClick={() => void copyRow(index, row.copy!)}
                    title={row.copy}
                    className="flex! min-w-0! hover:opacity-80! transition-opacity!"
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  >
                    {text}
                  </button>
                ) : (
                  text
                )}
              </span>
            </div>
          );
        })}
        {(hasCallData || callDataPending) && (
          <button
            ref={focusRow}
            type="button"
            disabled={!hasCallData}
            onClick={() => setPage({ hash, call: true })}
            className="flex! w-full! items-center! justify-between! enabled:hover:opacity-80! transition-opacity! disabled:opacity-50!"
            style={{
              gap: '12px',
              padding: '9px 0',
              minHeight: '34px',
              background: 'none',
              border: 'none',
              cursor: hasCallData ? 'pointer' : 'default',
              fontSize: '12px',
              color: 'var(--fg-3)',
            }}
          >
            <span>{t('txDetail.viewCallData', { defaultValue: 'View call data' })}</span>
            <ChevronRight size={14} />
          </button>
        )}
      </div>

      <div className="flex!" style={{ gap: '8px', paddingTop: '14px' }}>
        <button
          type="button"
          onClick={() => void copy()}
          className="press flex! flex-1! items-center! justify-center! bg-(--bg-2)! hover:bg-(--bg-3)!"
          style={{
            gap: '7px',
            height: '40px',
            borderRadius: '20px',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--fg)',
          }}
        >
          <Copy size={13} />
          <span style={{ fontSize: '12.5px' }}>
            {copied
              ? t('toast.copied', { defaultValue: 'Copied' })
              : t('txDetail.copyHash', { defaultValue: 'Copy hash' })}
          </span>
        </button>
        {explorerUrl && (
          <button
            type="button"
            onClick={() => window.open(explorerUrl, '_blank', 'noopener')}
            className="press flex! flex-1! items-center! justify-center! bg-(--bg-2)! hover:bg-(--bg-3)!"
            style={{
              gap: '7px',
              height: '40px',
              borderRadius: '20px',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--fg)',
            }}
          >
            <ArrowUpRight size={14} />
            <span style={{ fontSize: '12.5px' }}>
              {t('txDetail.explorer', { defaultValue: 'View in explorer' })}
            </span>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} maxHeight="92%">
      {onCallPage ? callPage : detailsPage}
    </Sheet>
  );
};
