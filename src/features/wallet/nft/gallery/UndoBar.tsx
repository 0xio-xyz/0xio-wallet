import { useTranslation } from 'src/i18n/react';
import useToastTimer, { TOAST_SHORT_MS } from 'src/hooks/ui/useToastTimer';

export function UndoBar({
  text,
  onUndo,
  onClose,
}: {
  text: string;
  onUndo: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { ref, leaving, dismiss, pause, resume } = useToastTimer<HTMLDivElement>(
    TOAST_SHORT_MS,
    onClose
  );

  return (
    <div
      ref={ref}
      role="status"
      className={`absolute! z-sticky! flex! items-center! justify-between! duration-200! ${
        leaving
          ? 'animate-out! fade-out! slide-out-to-bottom-2! pointer-events-none!'
          : 'animate-in! fade-in! slide-in-from-bottom-2!'
      }`}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onPointerLeave={resume}
      style={{
        left: 'var(--gutter)',
        right: 'var(--gutter)',
        bottom: '14px',
        gap: '12px',
        height: '44px',
        padding: '0 6px 0 14px',
        borderRadius: '12px',
        background: 'var(--bg-2)',
        boxShadow: '0 12px 30px rgba(0, 0, 0, 0.45)',
        fontSize: '13px',
        color: 'var(--fg)',
      }}
    >
      <span className="truncate!">{text}</span>
      <button
        onClick={() => {
          if (leaving) return;
          onUndo();
          dismiss();
        }}
        className="press shrink-0! hover:bg-(--line-2)! transition-colors!"
        style={{
          height: '32px',
          padding: '0 12px',
          borderRadius: '10px',
          background: 'var(--line)',
          border: 'none',
          cursor: 'pointer',
          fontSize: '13px',
          fontWeight: 600,
          color: 'var(--fg)',
        }}
      >
        {t('nft.undo', { defaultValue: 'Undo' })}
      </button>
    </div>
  );
}
