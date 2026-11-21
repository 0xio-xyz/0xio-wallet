import React from 'react';

const sizeClasses: Record<string, string> = {
  sm: 'p-1.5',
  md: 'p-2',
  lg: 'p-2.5',
};

const IconButton = ({
  children,
  onClick,
  size = 'md',
  disabled = false,
  className = '',
  title,
  'aria-label': ariaLabel,
}: {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  className?: string;
  title?: string;
  'aria-label'?: string;
}) => {
  const base =
    'inline-flex items-center justify-center rounded-lg text-content-secondary hover:text-(--fg) hover:bg-(--bg-1) transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

  const classes = [base, sizeClasses[size] || sizeClasses.md, className].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={classes}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
};

export default React.memo(IconButton);
