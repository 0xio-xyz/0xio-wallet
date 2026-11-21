import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MessageToast, { type ToastType } from 'src/shared/ui/MessageToast';
import { UndoBar } from 'src/features/wallet/nft/gallery/UndoBar';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const pill = () => screen.getByText(/./, { selector: '.toast-text' }).closest('.toast')!;

describe('MessageToast', () => {
  it('renders no close button', () => {
    render(<MessageToast message="Could not send. Try again." type="error" onClose={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText(/close/i)).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Could not send. Try again.');
  });

  it('dismisses on a tap', () => {
    const onClose = vi.fn();
    render(<MessageToast message="Incorrect password." type="error" onClose={onClose} />);
    fireEvent.click(pill());
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses on Escape', () => {
    const onClose = vi.fn();
    render(<MessageToast message="Incorrect password." type="error" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses when dragged down past the threshold, not before', () => {
    const onClose = vi.fn();
    render(<MessageToast message="Incorrect password." type="error" onClose={onClose} />);
    const el = pill();
    fireEvent.pointerDown(el, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: 110 });
    fireEvent.pointerUp(el, { pointerId: 1, clientY: 110 });
    fireEvent.click(el);
    act(() => vi.advanceTimersByTime(400));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(el, { pointerId: 2, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 2, clientY: 140 });
    fireEvent.pointerUp(el, { pointerId: 2, clientY: 140 });
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dissolves an error at 6s', () => {
    const onClose = vi.fn();
    render(<MessageToast message="Could not send." type="error" onClose={onClose} />);
    expect(pill().className).toContain('is-error');
    act(() => vi.advanceTimersByTime(5999));
    expect(pill().className).toContain('is-enter');
    act(() => vi.advanceTimersByTime(1));
    expect(pill().className).toContain('is-exit');
    act(() => vi.advanceTimersByTime(199));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['info', 4000],
    ['success', 4000],
    ['warning', 6000],
    ['error', 6000],
    ['processing', 6000],
  ] as const)('auto-hides %s at %ims with a 200ms exit', (type, ms) => {
    const onClose = vi.fn();
    render(<MessageToast message="Note" type={type} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(ms - 1));
    expect(pill().className).not.toContain('is-exit');
    act(() => vi.advanceTimersByTime(1));
    expect(pill().className).toContain('is-exit');
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fades info after 4s and pauses while hovered', () => {
    const onClose = vi.fn();
    render(<MessageToast message="Migration sent." type="info" onClose={onClose} />);
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.mouseEnter(pill());
    act(() => vi.advanceTimersByTime(10_000));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseLeave(pill());
    act(() => vi.advanceTimersByTime(999));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1 + 200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders success like info', () => {
    const onClose = vi.fn();
    render(<MessageToast message="Done" type="success" onClose={onClose} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(pill().className).toContain('is-info');
    act(() => vi.advanceTimersByTime(4200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resumes after hover when the pointer leaves', () => {
    const onClose = vi.fn();
    render(<MessageToast message="Could not send." type="error" onClose={onClose} />);
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.mouseEnter(pill());
    act(() => vi.advanceTimersByTime(30_000));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerLeave(pill());
    act(() => vi.advanceTimersByTime(3999));
    expect(pill().className).toContain('is-enter');
    act(() => vi.advanceTimersByTime(1 + 200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the window blurs', () => fireEvent.blur(window)],
    ['the popup is hidden', () => fireEvent(document, new Event('visibilitychange'))],
    ['the pointer leaves the page', () => fireEvent.mouseLeave(document.documentElement)],
    ['the pointer moves elsewhere', () => fireEvent.pointerMove(document.body)],
  ])('resumes a hover pause with no mouseleave when %s', (_label, release) => {
    const onClose = vi.fn();
    render(<MessageToast message="Migration sent." type="info" onClose={onClose} />);
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.mouseEnter(pill());
    act(() => vi.advanceTimersByTime(20_000));
    expect(onClose).not.toHaveBeenCalled();
    act(() => release());
    act(() => vi.advanceTimersByTime(3000 + 200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays paused while the pointer moves inside the toast', () => {
    const onClose = vi.fn();
    render(<MessageToast message="Migration sent." type="info" onClose={onClose} />);
    fireEvent.mouseEnter(pill());
    fireEvent.pointerMove(pill().querySelector('.toast-text')!);
    act(() => vi.advanceTimersByTime(20_000));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('auto-hides once under strict mode double effects', () => {
    const onClose = vi.fn();
    render(
      <React.StrictMode>
        <MessageToast message="Done" type="success" onClose={onClose} />
      </React.StrictMode>
    );
    act(() => vi.advanceTimersByTime(4200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('a host that replaces toasts', () => {
    let show: (text: string, type: ToastType) => void = () => {};
    const Host = () => {
      const [msg, setMsg] = useState<{ id: number; text: string; type: ToastType } | null>(null);
      const seq = React.useRef(0);
      show = (text, type) => setMsg({ id: ++seq.current, text, type });
      return msg ? (
        <MessageToast
          key={msg.id}
          message={msg.text}
          type={msg.type}
          onClose={() => setMsg((m) => (m?.id === msg.id ? null : m))}
        />
      ) : null;
    };
    const shown = () => document.querySelectorAll('.toast');

    it('a new toast replacing a paused one dissolves on its own', () => {
      render(<Host />);
      act(() => show('First', 'error'));
      fireEvent.mouseEnter(pill());
      act(() => vi.advanceTimersByTime(10_000));
      act(() => show('Second', 'info'));
      expect(shown()).toHaveLength(1);
      expect(pill().textContent).toContain('Second');
      act(() => vi.advanceTimersByTime(4200));
      expect(shown()).toHaveLength(0);
    });

    it('a late close of the old toast never removes the new one', () => {
      render(<Host />);
      act(() => show('First', 'info'));
      fireEvent.click(pill());
      act(() => vi.advanceTimersByTime(100));
      act(() => show('Second', 'error'));
      act(() => vi.advanceTimersByTime(5000));
      expect(pill().textContent).toContain('Second');
      act(() => vi.advanceTimersByTime(1000 + 200));
      expect(shown()).toHaveLength(0);
    });
  });
});

describe('UndoBar', () => {
  const bar = () => screen.getByRole('status');

  it('times out at 4s with a 200ms exit', () => {
    const onClose = vi.fn();
    render(<UndoBar text="Piece hidden" onUndo={vi.fn()} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(3999));
    expect(bar().className).toContain('animate-in!');
    act(() => vi.advanceTimersByTime(1));
    expect(bar().className).toContain('animate-out!');
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pauses on hover and resumes on leave or blur', () => {
    const onClose = vi.fn();
    render(<UndoBar text="Piece hidden" onUndo={vi.fn()} onClose={onClose} />);
    fireEvent.mouseEnter(bar());
    act(() => vi.advanceTimersByTime(20_000));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseLeave(bar());
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.mouseEnter(bar());
    act(() => vi.advanceTimersByTime(20_000));
    fireEvent.blur(window);
    act(() => vi.advanceTimersByTime(3000 + 200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('undo reverts once and leaves', () => {
    const onUndo = vi.fn();
    const onClose = vi.fn();
    render(<UndoBar text="Piece hidden" onUndo={onUndo} onClose={onClose} />);
    const undo = screen.getByRole('button');
    fireEvent.click(undo);
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
