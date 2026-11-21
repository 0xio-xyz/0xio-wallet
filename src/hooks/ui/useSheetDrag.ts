import { useCallback, useRef, useState } from 'react';

const DISMISS_THRESHOLD = 100;
const VELOCITY_THRESHOLD = 0.5;
const DIRECTION_LOCK = 10;

export function useSheetDrag(
  onClose: () => void,
  open: boolean,
  scrollRef?: React.RefObject<HTMLElement | null>
) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  const startY = useRef(0);
  const startX = useRef(0);
  const startT = useRef(0);
  const claimed = useRef(false);
  const active = useRef(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const prevOpen = useRef(open);
  if (open && !prevOpen.current) {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    claimed.current = false;
    active.current = false;
    if (offset !== 0) setOffset(0);
    if (dragging) setDragging(false);
    if (closing) setClosing(false);
  }
  prevOpen.current = open;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable="true"]'))
      return;
    active.current = true;
    claimed.current = false;
    startY.current = e.clientY;
    startX.current = e.clientX;
    startT.current = e.timeStamp;
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!active.current) return;
      const dy = e.clientY - startY.current;
      const dx = e.clientX - startX.current;
      if (!claimed.current) {
        if (scrollRef?.current && scrollRef.current.scrollTop > 1) return;
        if (dy > DIRECTION_LOCK && dy > Math.abs(dx) * 1.5) {
          claimed.current = true;
          setDragging(true);
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        } else if (dy < -DIRECTION_LOCK || Math.abs(dx) > Math.abs(dy)) {
          active.current = false;
          return;
        }
        return;
      }
      setOffset(Math.max(0, dy));
    },
    [scrollRef]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      active.current = false;
      if (!claimed.current) return;
      claimed.current = false;
      setDragging(false);
      const dy = Math.max(0, e.clientY - startY.current);
      const dt = e.timeStamp - startT.current;
      const vy = dt > 0 ? dy / dt : 0;
      const h = panelRef.current?.offsetHeight ?? 400;
      if (dy > DISMISS_THRESHOLD || vy > VELOCITY_THRESHOLD) {
        setClosing(true);
        setOffset(h);
        dismissTimer.current = setTimeout(onClose, 200);
      } else {
        setOffset(0);
      }
    },
    [onClose]
  );

  const requestClose = useCallback(() => {
    if (dismissTimer.current) return;
    const h = panelRef.current?.offsetHeight ?? 400;
    setClosing(true);
    setOffset(h);
    dismissTimer.current = setTimeout(onClose, 200);
  }, [onClose]);

  const panelProps = {
    ref: panelRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    style: {
      transform: offset ? `translateY(${offset}px)` : undefined,
      transition: dragging ? 'none' : 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
      touchAction: 'none' as const,
    } as React.CSSProperties,
  };

  return { panelProps, offset, dragging, closing, requestClose };
}
