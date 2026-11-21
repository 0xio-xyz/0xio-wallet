import { useState } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useLocation } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { Maximize2 } from 'src/shared/ui/icons';
import IconButton from 'src/shared/ui/IconButton';

const ExpandViewToggle = ({ className = '' }: { className?: string }) => {
  const [isPopup, setIsPopup] = useState(false);
  const location = useLocation();
  const { t } = useTranslation();

  useMountEffect(() => {
    const isExtension = !!(typeof chrome !== 'undefined' && chrome.runtime);
    const isExpanded = new URLSearchParams(window.location.search).get('view') === 'expanded';
    setIsPopup(isExtension && !isExpanded);
  });

  if (!isPopup) return null;

  const handleExpand = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      const targetUrl =
        chrome.runtime.getURL('index.html') +
        '?view=expanded#' +
        location.pathname +
        location.search;

      chrome.tabs.create({ url: targetUrl });
    }
  };

  return (
    <IconButton
      onClick={handleExpand}
      className={`active:scale-95! ${className}`}
      title={t('expandView.expand')}
      aria-label={t('expandView.expandLabel')}
    >
      <Maximize2 size={16} />
    </IconButton>
  );
};

export default ExpandViewToggle;
