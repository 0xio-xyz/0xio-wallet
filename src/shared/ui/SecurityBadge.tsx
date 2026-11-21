import { AlertTriangle, Info } from 'src/shared/ui/icons';

interface SecurityBadgeProps {
  type: 'warning' | 'danger' | 'info';
  message: string;
}

const config = {
  warning: {
    bg: 'bg-accent/10',
    border: 'border-accent/30',
    text: 'text-accent',
    Icon: AlertTriangle,
  },
  danger: {
    bg: 'bg-danger/10',
    border: 'border-danger/30',
    text: 'text-danger',
    Icon: AlertTriangle,
  },
  info: {
    bg: 'bg-info/10',
    border: 'border-info/30',
    text: 'text-info',
    Icon: Info,
  },
} as const;

const SecurityBadge = ({ type, message }: SecurityBadgeProps) => {
  const { bg, border, text, Icon } = config[type];

  return (
    <div className={`flex items-center gap-2.5 p-3 rounded-xl border ${bg} ${border}`}>
      <Icon className={`w-4 h-4 shrink-0 ${text}`} />
      <span className={`text-xs font-medium ${text}`}>{message}</span>
    </div>
  );
};

export default SecurityBadge;
