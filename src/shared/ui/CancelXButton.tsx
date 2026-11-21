import { X } from 'src/shared/ui/icons';

export default function CancelXButton({
  onClick,
  disabled = false,
  size = 44,
  className = '',
}: {
  onClick: () => void;
  disabled?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label="Cancel"
      className={`shrink-0! rounded-xl! border! border-(--border-color)! bg-(--bg-card)! hover:bg-(--bg-input)! flex! items-center! justify-center! transition-colors! cursor-pointer! disabled:opacity-50! ${className}`}
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      <X size={16} className="text-content-muted!" />
    </button>
  );
}
