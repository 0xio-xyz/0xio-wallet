import { useState } from 'react';
import { Copy, ExternalLink } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import IconButton from 'src/shared/ui/IconButton';
import { getExplorerAddressUrl } from 'src/utils/network';
import { logger } from 'src/utils/logger';
import { writeClipboard } from 'src/utils/secretClipboard';

const AddressDisplay = () => {
  const { activeWallet, networkId } = useWallet();
  const [copied, setCopied] = useState(false);

  const truncate = (str: string, start = 6, end = 4) => {
    if (!str) return '';
    if (str.length <= start + end) return str;
    return `${str.substring(0, start)}...${str.substring(str.length - end)}`;
  };

  const handleCopy = async () => {
    if (!activeWallet?.address) return;

    try {
      await writeClipboard(activeWallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      logger.error('Failed to copy:', err);
    }
  };

  const handleExplorer = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activeWallet?.address) return;
    const url = getExplorerAddressUrl(networkId, activeWallet.address);
    if (url) window.open(url, '_blank', 'noopener');
  };

  if (!activeWallet?.address)
    return <div className="text-content-muted text-xs animate-pulse">Loading...</div>;

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleCopy}
        className="group flex items-center gap-2 px-3 py-1.5 bg-(--bg-address) hover:bg-(--bg-highlight) border border-(--border-color) rounded-[10px] transition-all duration-200 cursor-pointer active:scale-95"
        title="Copy"
      >
        <span className="relative inline-flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-2 ${copied ? 'invisible' : ''}`}
            aria-hidden={copied}
          >
            <span className="font-mono text-xs text-(--text-address) group-hover:text-(--text-main) transition-colors">
              {truncate(activeWallet.address)}
            </span>
            <Copy size={12} className="text-content-muted group-hover:text-(--text-main)" />
          </span>
          {copied && (
            <span
              className="absolute inset-0 flex items-center justify-center text-xs font-medium text-(--text-main)"
              role="status"
            >
              Copied
            </span>
          )}
        </span>
      </button>

      <IconButton
        onClick={handleExplorer}
        size="sm"
        className="hover:text-(--info)"
        title="View in explorer"
        aria-label="View in explorer"
      >
        <ExternalLink size={12} />
      </IconButton>
    </div>
  );
};

export default AddressDisplay;
