import React from 'react';
import { Mascot } from 'src/shared/ui/Mascot';

interface LoadingSpinnerProps {
  size?: 'small' | 'medium' | 'large';
  text?: string;
  fullScreen?: boolean;
}

const SIZES: Record<string, number> = { small: 24, medium: 48, large: 64 };

const LoadingSpinner = ({
  size = 'medium',
  text = '',
  fullScreen = false,
}: LoadingSpinnerProps) => {
  const content = (
    <div className="flex flex-col items-center justify-center gap-3">
      <Mascot mood="loading" size={fullScreen ? 96 : SIZES[size]} />
      {text && <p className="text-sm font-medium text-content-secondary">{text}</p>}
    </div>
  );

  if (fullScreen) {
    return (
      <div className="fixed inset-0 bg-surface/80 backdrop-blur-sm flex items-center justify-center z-blocking">
        {content}
      </div>
    );
  }

  return content;
};

export default React.memo(LoadingSpinner);
