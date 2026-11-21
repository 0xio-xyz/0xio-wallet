import React, { useRef } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';

export const StepLayout = ({
  children,
  footer,
  onSubmit,
}: {
  children: React.ReactNode;
  footer: React.ReactNode;
  onSubmit?: () => void;
}) => (
  <div
    className="flex-1! min-h-0! flex! flex-col!"
    onKeyDown={(e) => {
      if (!onSubmit || e.key !== 'Enter' || e.nativeEvent.isComposing) return;
      if ((e.target as HTMLElement).tagName !== 'INPUT') return;
      e.preventDefault();
      onSubmit();
    }}
  >
    <div
      className="flex-1! min-h-0! overflow-y-auto! scrollbar-hide! flex! flex-col!"
      style={{ padding: '18px var(--gutter) 12px', gap: '16px' }}
    >
      {children}
    </div>
    <div
      className="shrink-0! flex! flex-col!"
      style={{ padding: '12px var(--gutter) 16px', gap: '12px' }}
    >
      {footer}
    </div>
  </div>
);

export const StepIntro = ({ title, sub }: { title: React.ReactNode; sub?: React.ReactNode }) => (
  <div className="flex! flex-col!" style={{ gap: '6px' }}>
    <h2
      style={{
        margin: 0,
        fontSize: '18px',
        fontWeight: 700,
        letterSpacing: '-0.2px',
        color: 'var(--fg)',
      }}
    >
      {title}
    </h2>
    {sub && (
      <p style={{ margin: 0, fontSize: '12.5px', lineHeight: 1.5, color: 'var(--fg-3)' }}>{sub}</p>
    )}
  </div>
);

export const StatusLine = ({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'pos' | 'neg';
  children?: React.ReactNode;
}) => (
  <span
    aria-live="polite"
    className="flex! items-center!"
    style={{
      gap: '8px',
      minHeight: '18px',
      fontSize: '12px',
      color: tone === 'neg' ? 'var(--neg)' : 'var(--fg-2)',
    }}
  >
    {children && tone !== 'muted' && (
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '3px',
          flexShrink: 0,
          background: tone === 'pos' ? 'var(--pos)' : 'var(--neg)',
        }}
      />
    )}
    {children}
  </span>
);

export const BIG_BUTTON = { height: '48px', borderRadius: '24px', fontSize: '14px' } as const;

const useStepFocus = (on: boolean) => {
  const ref = useRef<HTMLHeadingElement>(null);
  useMountEffect(() => {
    if (on) ref.current?.focus({ preventScroll: true });
  });
  return ref;
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '22px',
  lineHeight: '28px',
  fontWeight: 700,
  letterSpacing: '-0.4px',
  color: 'var(--fg)',
  outline: 'none',
};
const subStyle: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: '13.5px',
  lineHeight: '20px',
  color: 'var(--fg-2)',
};

export const FlowCopy = ({
  title,
  sub,
  focusTitle = false,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  focusTitle?: boolean;
}) => {
  const ref = useStepFocus(focusTitle);
  return (
    <div className="shrink-0!" style={{ minHeight: '94px', paddingBottom: '20px' }}>
      <h1 ref={ref} tabIndex={focusTitle ? -1 : undefined} style={titleStyle}>
        {title}
      </h1>
      {sub && <p style={subStyle}>{sub}</p>}
    </div>
  );
};

export const FlowHero = ({
  art,
  title,
  sub,
  visible = true,
  children,
}: {
  art: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  visible?: boolean;
  children?: React.ReactNode;
}) => {
  const ref = useStepFocus(true);
  return (
    <>
      <div
        className="flex! justify-center! items-center!"
        style={{ height: '72px', marginTop: '18px' }}
      >
        {art}
      </div>
      <div
        className="flex! flex-col!"
        style={{
          marginTop: '22px',
          opacity: visible ? 1 : 0,
          transition: 'opacity 200ms ease-out',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h1 ref={ref} tabIndex={-1} style={titleStyle}>
            {title}
          </h1>
          {sub && <p style={subStyle}>{sub}</p>}
        </div>
        {children}
      </div>
    </>
  );
};

export const FlowLayout = ({
  children,
  footer,
  onSubmit,
  center = false,
}: {
  children: React.ReactNode;
  footer: React.ReactNode;
  onSubmit?: () => void;
  center?: boolean;
}) => (
  <div
    className="flex-1! min-h-0! flex! flex-col!"
    onKeyDown={(e) => {
      if (!onSubmit || e.key !== 'Enter' || e.nativeEvent.isComposing) return;
      if ((e.target as HTMLElement).tagName !== 'INPUT') return;
      e.preventDefault();
      onSubmit();
    }}
  >
    <div
      className={`flow-body flex-1! min-h-0! overflow-y-auto! scrollbar-hide! flex! flex-col! ${
        center ? 'items-center! justify-center! text-center!' : ''
      }`}
      style={{ padding: '8px var(--flow-gutter, 20px) 0', gap: center ? '14px' : '0' }}
    >
      {children}
    </div>
    <div
      className="shrink-0! flex! flex-col!"
      style={{ padding: '12px var(--flow-gutter, 20px) 20px', gap: '10px' }}
    >
      {footer}
    </div>
  </div>
);
