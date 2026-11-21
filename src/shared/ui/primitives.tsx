import React, { useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown } from 'src/shared/ui/icons';
import { useSheetDrag } from 'src/hooks/ui/useSheetDrag';
import { useSheetEscape } from 'src/hooks/ui/useSheetEscape';
import { Mascot } from 'src/shared/ui/Mascot';

const submitOnEnter = (onSubmit?: () => void) => (e: React.KeyboardEvent<HTMLDivElement>) => {
  if (!onSubmit || e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
  if ((e.target as HTMLElement).tagName !== 'INPUT') return;
  e.preventDefault();
  onSubmit();
};

export const RuledList = ({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) => (
  <div
    className="rounded-[18px]! bg-(--list-bg,var(--bg-1))! overflow-hidden!"
    style={{
      padding: '4px',
      flexShrink: 0,
      boxShadow: 'var(--list-shadow, var(--raise-shadow))',
      ...style,
    }}
  >
    {children}
  </div>
);

export const SectionLabel = ({
  children,
  danger = false,
  first = false,
}: {
  children: React.ReactNode;
  danger?: boolean;
  first?: boolean;
}) => (
  <div
    style={{
      fontSize: '10px',
      fontWeight: 500,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: danger ? 'var(--neg)' : 'var(--fg-3)',
      padding: `${first ? 0 : 18}px 4px 6px`,
    }}
  >
    {children}
  </div>
);

export const ListRow = ({
  label,
  sub,
  hint,
  danger = false,
  onClick,
  right,
  chevron,
  leading,
}: {
  label: React.ReactNode;
  sub?: React.ReactNode;
  hint?: React.ReactNode;
  danger?: boolean;
  onClick?: () => void;
  right?: React.ReactNode;
  chevron?: boolean;
  leading?: React.ReactNode;
}) => {
  const showChevron = chevron ?? (!!onClick && !right);
  const Tag: 'button' | 'div' = onClick ? 'button' : 'div';
  const text = (
    <span className="flex! flex-col! min-w-0!" style={{ gap: '2px' }}>
      <span
        className="truncate!"
        style={{ fontSize: '13px', color: danger ? 'var(--neg)' : 'var(--fg)' }}
      >
        {label}
      </span>
      {sub && (
        <span className="truncate!" style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
          {sub}
        </span>
      )}
    </span>
  );
  return (
    <Tag
      onClick={onClick}
      className={`w-full! flex! items-center! justify-between! rounded-[14px]! ${
        onClick ? 'hover:bg-(--row-hover,var(--bg-2))! transition-colors! duration-150!' : ''
      }`}
      style={{
        minHeight: '44px',
        padding: sub ? '9px 12px' : '0 12px',
        gap: '12px',
        background: 'transparent',
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
      }}
    >
      {leading ? (
        <span className="flex! items-center! min-w-0!" style={{ gap: '10px' }}>
          {leading}
          {text}
        </span>
      ) : (
        text
      )}
      <span className="flex! items-center! shrink-0!" style={{ gap: '6px' }}>
        {hint && <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{hint}</span>}
        {right}
        {showChevron && (
          <ChevronRight
            size={12}
            style={{ color: danger ? 'var(--neg)' : 'var(--fg-3)', opacity: danger ? 0.6 : 1 }}
          />
        )}
      </span>
    </Tag>
  );
};

export const Toggle = ({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label?: string;
}) => (
  <button
    onClick={onChange}
    disabled={disabled}
    role="switch"
    aria-checked={checked}
    aria-label={label}
    style={{
      position: 'relative',
      width: '34px',
      height: '20px',
      borderRadius: '999px',
      border: 'none',
      padding: 0,
      cursor: disabled ? 'not-allowed' : 'pointer',
      background: checked ? 'var(--switch-on)' : 'var(--switch-off)',
      transition: 'background-color 200ms cubic-bezier(0.23, 1, 0.32, 1)',
      opacity: disabled ? 0.5 : 1,
      flexShrink: 0,
    }}
  >
    <span
      style={{
        position: 'absolute',
        top: '2px',
        left: '2px',
        width: '16px',
        height: '16px',
        borderRadius: '999px',
        background: checked ? 'var(--switch-knob-on, #fff)' : '#fff',
        transform: checked ? 'translateX(14px)' : 'none',
        transition: 'transform 200ms cubic-bezier(0.23, 1, 0.32, 1)',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
      }}
    />
  </button>
);

export const ToggleRow = ({
  label,
  sub,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  sub?: React.ReactNode;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) => (
  <ListRow
    label={label}
    sub={sub}
    right={<Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />}
    chevron={false}
  />
);

export const TextTab = ({
  active,
  small = false,
  onClick,
  children,
}: {
  active: boolean;
  small?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    style={{
      background: 'none',
      border: 'none',
      padding: '4px 0',
      cursor: 'pointer',
      fontSize: small ? '11px' : '12px',
      fontWeight: active ? 600 : 500,
      color: active ? 'var(--fg)' : 'var(--fg-3)',
      transition: 'color 150ms',
    }}
  >
    {children}
  </button>
);

export const CellChoice = <T extends string>({
  options,
  value,
  onChange,
  columns,
}: {
  options: { id: T; label: React.ReactNode; sub?: React.ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  columns?: number;
}) => (
  <div
    className="grid! rounded-[10px]! overflow-hidden!"
    style={{
      gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))`,
      gap: '1px',
      background: 'var(--line)',
    }}
  >
    {options.map((o) => {
      const selected = o.id === value;
      return (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`flex! flex-col! items-center! justify-center! transition-colors! ${
            selected ? 'bg-(--bg-2)!' : 'bg-(--bg-1)! hover:bg-(--bg-2)!'
          }`}
          style={{
            minHeight: o.sub ? '56px' : '40px',
            border: 'none',
            cursor: 'pointer',
            gap: '2px',
            padding: '0 6px',
          }}
        >
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: selected ? 'var(--fg)' : 'var(--fg-2)',
            }}
          >
            {o.label}
          </span>
          {o.sub && <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>{o.sub}</span>}
        </button>
      );
    })}
  </div>
);

export const Facts = ({ children, gap = 8 }: { children: React.ReactNode; gap?: number }) => (
  <span className="flex! items-center! min-w-0!" style={{ gap: `${gap}px` }}>
    {children}
  </span>
);

export const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--fg-3)' }}>{children}</span>
);

type NoteTone = 'muted' | 'pos' | 'neg';

export const FieldNote = ({
  children,
  tone = 'muted',
}: {
  children?: React.ReactNode;
  tone?: NoteTone;
}) => (
  <div
    aria-live="polite"
    style={{
      fontSize: '11px',
      lineHeight: '16px',
      height: '16px',
      marginTop: '5px',
      color: tone === 'pos' ? 'var(--pos)' : tone === 'neg' ? 'var(--neg)' : 'var(--fg-3)',
      transition: 'color 150ms ease',
    }}
  >
    {children}
  </div>
);

export const quietField =
  'w-full! h-11! px-3! rounded-[10px]! bg-(--field-bg,var(--bg-1))! border! border-transparent! focus:border-(--line-2)! outline-none! text-[13px]! text-(--fg)! placeholder:text-content-muted!';

export const QuietInput = ({
  label,
  error,
  note,
  noteTone = 'muted',
  className = '',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
  note?: React.ReactNode;
  noteTone?: NoteTone;
}) => (
  <div>
    {label && (
      <div style={{ marginBottom: '6px' }}>
        <FieldLabel>{label}</FieldLabel>
      </div>
    )}
    <input
      {...props}
      className={`${quietField} ${error || (note !== undefined && noteTone === 'neg') ? 'border-(--neg)!' : ''} ${className}`}
    />
    {note !== undefined ? (
      <FieldNote tone={noteTone}>{note}</FieldNote>
    ) : (
      error !== undefined && <FieldNote tone="neg">{error}</FieldNote>
    )}
  </div>
);

export const PasswordField = ({
  label,
  value,
  onChange,
  placeholder,
  shown,
  onToggle,
  error,
  autoFocus,
  autoComplete,
  disabled,
  note,
  noteTone = 'muted',
  showLabel = 'Show',
  hideLabel = 'Hide',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  shown: boolean;
  onToggle: () => void;
  error?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  disabled?: boolean;
  note?: React.ReactNode;
  noteTone?: NoteTone;
  showLabel?: string;
  hideLabel?: string;
}) => (
  <div>
    <div className="flex! items-center! justify-between!" style={{ marginBottom: '6px' }}>
      <FieldLabel>{label}</FieldLabel>
      <TextButton muted size={11} onClick={onToggle} disabled={disabled}>
        {shown ? hideLabel : showLabel}
      </TextButton>
    </div>
    <input
      type={shown ? 'text' : 'password'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      disabled={disabled}
      className={`${quietField} ${error || (note !== undefined && noteTone === 'neg') ? 'border-(--neg)!' : ''}`}
    />
    {note !== undefined ? (
      <FieldNote tone={noteTone}>{note}</FieldNote>
    ) : (
      error !== undefined && <FieldNote tone="neg">{error}</FieldNote>
    )}
  </div>
);

export const QuietTextarea = ({
  label,
  className = '',
  error,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; error?: string }) => (
  <div>
    {label && (
      <div style={{ marginBottom: '6px' }}>
        <FieldLabel>{label}</FieldLabel>
      </div>
    )}
    <textarea
      {...props}
      className={`w-full! rounded-[10px]! bg-(--bg-1)! border! ${error ? 'border-(--neg)!' : 'border-transparent!'} focus:border-(--line-2)! outline-none! text-[13px]! text-(--fg)! placeholder:text-content-muted! ${className}`}
      style={{
        padding: '10px 12px',
        resize: 'none',
        fontFamily: 'inherit',
        lineHeight: 1.5,
        ...props.style,
      }}
    />
    {error !== undefined && <FieldNote tone="neg">{error}</FieldNote>}
  </div>
);

export const QuietSelect = ({
  label,
  value,
  onChange,
  children,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) => (
  <div>
    {label && (
      <div style={{ marginBottom: '6px' }}>
        <FieldLabel>{label}</FieldLabel>
      </div>
    )}
    <div className="relative!">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full! h-11! rounded-[10px]! bg-(--bg-1)! border! border-transparent! focus:border-(--line-2)! outline-none! text-[13px]! text-(--fg)!"
        style={{ appearance: 'none', padding: '0 32px 0 12px', cursor: 'pointer' }}
      >
        {children}
      </select>
      <ChevronDown
        size={12}
        style={{
          color: 'var(--fg-3)',
          position: 'absolute',
          right: '12px',
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
        }}
      />
    </div>
  </div>
);

export const PrimaryButton = ({
  children,
  onClick,
  disabled = false,
  loading = false,
  danger = false,
  positive = false,
  secondary = false,
  style,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  danger?: boolean;
  positive?: boolean;
  secondary?: boolean;
  style?: React.CSSProperties;
}) => (
  <button
    onClick={onClick}
    disabled={disabled || loading}
    className={`press w-full! flex! items-center! justify-center! ${
      danger
        ? 'bg-danger!'
        : positive
          ? 'bg-positive!'
          : secondary
            ? 'bg-(--bg-1)! enabled:hover:bg-(--bg-2)!'
            : 'enabled:hover:bg-accent-hover!'
    }`}
    style={{
      height: '44px',
      borderRadius: '22px',
      border: 'none',
      background: danger || positive || secondary ? undefined : 'var(--accent)',
      boxShadow: danger || positive || secondary || disabled ? 'none' : 'var(--key-shadow)',
      color: secondary ? 'var(--fg)' : 'var(--accent-fg)',
      fontSize: '13px',
      fontWeight: 600,
      gap: '6px',
      cursor: loading ? 'wait' : disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      ...style,
    }}
  >
    {loading && (
      <Mascot
        mood="loading"
        size={20}
        hole={
          danger
            ? 'var(--color-danger)'
            : positive
              ? 'var(--color-positive)'
              : secondary
                ? 'var(--bg-1)'
                : 'var(--accent)'
        }
        className="text-current!"
      />
    )}
    {children}
  </button>
);

export const TextButton = ({
  children,
  onClick,
  muted = false,
  danger = false,
  disabled = false,
  size = 12,
  style,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  muted?: boolean;
  danger?: boolean;
  disabled?: boolean;
  size?: number;
  style?: React.CSSProperties;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className="press hover:opacity-70!"
    style={{
      background: 'none',
      border: 'none',
      padding: 0,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontSize: `${size}px`,
      fontWeight: muted ? 500 : 600,
      color: danger ? 'var(--neg)' : muted ? 'var(--fg-3)' : 'var(--accent)',
      opacity: disabled ? 0.5 : 1,
      ...style,
    }}
  >
    {children}
  </button>
);

export const Modal = ({
  open,
  onClose,
  title,
  sub,
  danger = false,
  closeLabel = 'Close',
  children,
  footer,
  zIndexClass = 'z-modal!',
  onSubmit,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  sub?: React.ReactNode;
  danger?: boolean;
  closeLabel?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: number;
  zIndexClass?: string;
  onSubmit?: () => void;
  dismissible?: boolean;
}) => (
  <Sheet
    open={open}
    onClose={onClose}
    title={title}
    sub={sub}
    danger={danger}
    closeLabel={closeLabel}
    footer={footer}
    zIndexClass={zIndexClass}
    onSubmit={onSubmit}
    dismissible={dismissible}
  >
    {children}
  </Sheet>
);

export const Sheet = ({
  open,
  onClose,
  title,
  sub,
  action,
  children,
  footer,
  pinned,
  maxHeight = '85%',
  onSubmit,
  dismissible = true,
  zIndexClass = 'z-modal!',
  danger = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  sub?: React.ReactNode;
  danger?: boolean;
  action?: React.ReactNode;
  closeLabel?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  pinned?: React.ReactNode;
  maxHeight?: string;
  onSubmit?: () => void;
  dismissible?: boolean;
  zIndexClass?: string;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { panelProps, closing, requestClose } = useSheetDrag(onClose, open, scrollRef);
  const panelRef = panelProps.ref;
  const takeFocus = useCallback(
    (el: HTMLDivElement | null) => {
      panelRef.current = el;
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    },
    [panelRef]
  );
  useSheetEscape(open, dismissible ? requestClose : undefined);
  if (!open) return null;
  const close = dismissible ? requestClose : undefined;
  return (
    <div
      className={`fixed! inset-0! ${zIndexClass} bg-surface-overlay! animate-in! fade-in! duration-200!`}
      style={{ opacity: closing ? 0 : undefined, transition: 'opacity 200ms ease' }}
      onClick={close}
    >
      <div
        data-sheet
        className="absolute! inset-x-0! bottom-0! flex! flex-col! bg-(--bg-1)! rounded-t-[26px]! outline-none! animate-in! slide-in-from-bottom-full! duration-300!"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && close) {
            e.stopPropagation();
            close();
            return;
          }
          submitOnEnter(onSubmit)(e);
        }}
        onClick={(e) => e.stopPropagation()}
        {...panelProps}
        ref={takeFocus}
        onPointerDown={dismissible ? panelProps.onPointerDown : undefined}
        style={{
          ...panelProps.style,
          maxHeight,
          ...(pinned ? { height: maxHeight } : {}),
          padding: '0 16px 16px',
        }}
      >
        <div
          className={`shrink-0! flex! justify-center! ${dismissible ? 'cursor-grab!' : ''}`}
          style={{ padding: '8px 0 10px' }}
        >
          <div className="w-9! h-1! rounded-full! bg-(--line-2)!" />
        </div>
        {(title || action) && (
          <div
            className="shrink-0! flex! items-start! justify-between!"
            style={{ marginBottom: '14px', gap: '12px' }}
          >
            <span className="flex! flex-col! min-w-0!" style={{ gap: '4px' }}>
              <span
                style={{
                  fontSize: '15px',
                  fontWeight: 700,
                  letterSpacing: '-0.1px',
                  color: danger ? 'var(--neg)' : 'var(--fg)',
                }}
              >
                {title}
              </span>
              {sub && (
                <span style={{ fontSize: '12px', color: 'var(--fg-3)', lineHeight: 1.5 }}>
                  {sub}
                </span>
              )}
            </span>
            {action && (
              <span className="shrink-0!" style={{ paddingTop: '1px' }}>
                {action}
              </span>
            )}
          </div>
        )}
        {pinned && (
          <div className="shrink-0!" style={{ marginBottom: '10px' }}>
            {pinned}
          </div>
        )}
        <div
          ref={scrollRef}
          className="flex-1! min-h-0! overflow-x-hidden! overflow-y-auto! scrollbar-hide!"
          style={{ touchAction: 'pan-y' }}
        >
          {children}
        </div>
        {footer && (
          <div className="shrink-0!" style={{ paddingTop: '14px' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
