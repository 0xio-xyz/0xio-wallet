import React, { useState, useRef } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { X } from 'src/shared/ui/icons';
import { Mascot } from 'src/shared/ui/Mascot';

interface ConfirmActionButtonProps {
  onConfirm: () => void;
  label: string;
  confirmLabel?: string;
  loadingLabel?: string;
  icon?: React.ReactNode;
  loadingFill?: string;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  confirmClassName?: string;
  cancelClassName?: string;
  timeout?: number;
}

const ConfirmActionButton = ({
  onConfirm,
  label,
  confirmLabel = 'CONFIRM',
  loadingLabel = 'PROCESSING...',
  icon,
  loadingFill = 'var(--primary)',
  disabled = false,
  loading = false,
  className = '',
  confirmClassName = '',
  cancelClassName = '',
  timeout = 5000,
}: ConfirmActionButtonProps) => {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useMountEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  });

  const handleInitialClick = () => {
    if (disabled || loading) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setConfirming(false), timeout);
    setConfirming(true);
  };

  const handleConfirm = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setConfirming(false);
    onConfirm();
  };

  const handleCancel = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setConfirming(false);
  };

  if (loading) {
    return (
      <button disabled className={`${className} disabled:opacity-50 disabled:cursor-not-allowed`}>
        <Mascot mood="loading" size={20} hole={loadingFill} className="text-current!" />
        {loadingLabel}
      </button>
    );
  }

  if (confirming) {
    return (
      <div className="flex gap-2 w-full animate-in fade-in duration-200">
        <button
          onClick={handleCancel}
          className={`shrink-0 w-11 h-11 rounded-xl border border-(--border-color) bg-(--bg-card) hover:bg-(--bg-input) flex items-center justify-center transition-all cursor-pointer ${cancelClassName}`}
          aria-label="Cancel"
        >
          <X size={16} className="text-content-muted" />
        </button>
        <button
          onClick={handleConfirm}
          className={`flex-1 h-11 rounded-xl flex items-center justify-center font-bold text-sm uppercase tracking-wider transition-all cursor-pointer ${confirmClassName || 'bg-positive border border-positive text-accent-fg hover:brightness-110'}`}
          aria-label={confirmLabel}
        >
          {confirmLabel}
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleInitialClick}
      disabled={disabled}
      className={`${className} ${disabled ? 'disabled:opacity-50 disabled:cursor-not-allowed' : ''}`}
    >
      {icon}
      {label}
    </button>
  );
};

export default React.memo(ConfirmActionButton);
