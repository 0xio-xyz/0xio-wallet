import React, { useRef, useState } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import useToastTimer, { toastDuration } from 'src/hooks/ui/useToastTimer';

export type ToastType = 'success' | 'error' | 'warning' | 'processing' | 'info';

interface MessageToastProps {
  message: string;
  type?: ToastType;
  onClose: () => void;
  duration?: number;
}

const DISMISS_DRAG = 24;
const TAP_SLOP = 6;

const MessageToast = ({ message, type = 'info', onClose, duration }: MessageToastProps) => {
  const isError = type === 'error';
  const { ref, leaving, dismiss, pause, resume } = useToastTimer<HTMLDivElement>(
    duration ?? toastDuration(type),
    onClose
  );
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);

  const pointer = useRef<{ id: number; y: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);

  useMountEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (leaving) return;
    pointer.current = { id: e.pointerId, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p || p.id !== e.pointerId) return;
    const dy = e.clientY - p.y;
    if (Math.abs(dy) > TAP_SLOP) p.moved = true;
    setDrag(dy > 0 ? dy : dy / 4);
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p || p.id !== e.pointerId) return;
    pointer.current = null;
    setDragging(false);
    const dy = e.clientY - p.y;
    if (p.moved) swallowClick.current = true;
    if (dy > DISMISS_DRAG) {
      dismiss();
      return;
    }
    setDrag(0);
  };

  const onClick = () => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    dismiss();
  };

  if (!message) return null;

  return (
    <div className="toast-host">
      <div
        className={`toast-drag${dragging ? ' is-dragging' : ''}`}
        style={drag ? { transform: `translateY(${drag}px)` } : undefined}
      >
        <div
          ref={ref}
          className={`toast ${isError ? 'is-error' : 'is-info'} ${leaving ? 'is-exit' : 'is-enter'}`}
          role={isError ? 'alert' : 'status'}
          aria-live={isError ? 'assertive' : 'polite'}
          onClick={onClick}
          onMouseEnter={pause}
          onMouseLeave={resume}
          onPointerLeave={resume}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <span className="toast-dot" aria-hidden="true" />
          <span className="toast-text">{message}</span>
        </div>
      </div>
    </div>
  );
};

export default React.memo(MessageToast);
