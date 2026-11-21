import React from 'react';

interface InputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'onChange'
> {
  type?: string;
  value: string | number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  label?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  icon?: React.ReactNode;
  className?: string;
}

const Input = ({
  type = 'text',
  value,
  onChange,
  placeholder = '',
  label = '',
  error,
  disabled = false,
  required = false,
  icon = null,
  className = '',
  ...props
}: InputProps) => {
  return (
    <div className={`input-container ${className}`}>
      {label && (
        <label className="input-label">
          {label} {required && <span className="input-required">*</span>}
        </label>
      )}
      <div className="input-wrapper">
        {icon && <span className="input-icon">{icon}</span>}
        <input
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          className={`form-input ${error ? 'input-error' : ''} ${icon ? 'input-with-icon' : ''}`}
          {...props}
        />
      </div>
      {error !== undefined && (
        <p className="input-error-message" style={{ minHeight: '1.4em' }}>
          {error}
        </p>
      )}
    </div>
  );
};

export default React.memo(Input);
