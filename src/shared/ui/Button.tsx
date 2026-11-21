import React from 'react';
import { Mascot } from 'src/shared/ui/Mascot';

const variantMap: Record<string, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

const holeMap: Record<string, string> = {
  primary: 'var(--accent)',
  secondary: 'var(--bg-1)',
  ghost: 'var(--bg)',
  danger: 'var(--neg)',
};

const Button = ({
  children,
  onClick,
  variant = 'primary',
  fullWidth = false,
  disabled = false,
  loading = false,
  size,
  icon = null,
  type = 'button' as const,
  className = '',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: string;
  fullWidth?: boolean;
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'lg';
  icon?: React.ReactNode;
  type?: 'button' | 'submit' | 'reset';
  className?: string;
}) => {
  const classes = [
    'btn',
    variantMap[variant] || variantMap.primary,
    fullWidth ? 'btn-full' : '',
    size === 'lg' ? 'btn-lg' : size === 'sm' ? 'btn-sm' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={classes} onClick={onClick} disabled={disabled || loading}>
      {loading && (
        <Mascot
          mood="loading"
          size={size === 'sm' ? 16 : 20}
          hole={holeMap[variant] || holeMap.primary}
          className="text-current!"
        />
      )}
      {icon && !loading && <span className="flex items-center">{icon}</span>}
      {children}
    </button>
  );
};

export default React.memo(Button);
