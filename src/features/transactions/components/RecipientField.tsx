import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'src/i18n/react';
import { useRecipientContacts } from 'src/hooks/wallet/useRecipientContacts';
import { FieldLabel, quietField } from 'src/shared/ui/primitives';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { isOctAddress, normalizeAddress, OCT_ADDRESS_LENGTH } from 'src/utils/octra/address';

export interface RecipientFieldProps {
  value: string;
  onChange: (v: string) => void;
  ownAddress?: string;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
}

export default function RecipientField({
  value,
  onChange,
  ownAddress,
  disabled,
  label,
  placeholder,
}: RecipientFieldProps): JSX.Element {
  const { t } = useTranslation();
  const [showDropdown, setShowDropdown] = useState(false);
  const { contacts } = useRecipientContacts(showDropdown, ownAddress);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const MENU_MAX_H = 160;

  // effect:audited - measure the field while the list is open; re-measure on resize and on any
  // scroll (capture) since the sheet body scrolls independently of the window.
  useLayoutEffect(() => {
    if (!showDropdown) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      const openUp = below < MENU_MAX_H + 8 && r.top > below;
      setPlace(
        openUp
          ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4 }
          : { left: r.left, width: r.width, top: r.bottom + 4 }
      );
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [showDropdown]);

  // effect:audited - close the recipient dropdown on an outside click. Document listener scoped to
  // the open dropdown (added on open, removed on close).
  useEffect(() => {
    if (!showDropdown) return;
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (dropdownRef.current?.contains(node) || inputRef.current?.contains(node)) return;
      setShowDropdown(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showDropdown]);

  const invalid =
    value.startsWith('oct') && value.length >= OCT_ADDRESS_LENGTH && !isOctAddress(value);
  return (
    <div>
      <div style={{ marginBottom: '6px' }}>
        <FieldLabel>{label ?? t('common.recipient')}</FieldLabel>
      </div>
      <div className="relative!">
        <input
          ref={inputRef}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? t('common.addressPlaceholder')}
          onChange={(e) => {
            const compact = normalizeAddress(e.target.value);
            const v = /^oct[1-9A-HJ-NP-Za-km-z]{30,}$/.test(compact)
              ? compact.slice(0, OCT_ADDRESS_LENGTH)
              : e.target.value.slice(0, 64);
            onChange(v);
            setShowDropdown(v.length < OCT_ADDRESS_LENGTH);
          }}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-invalid={invalid}
          onFocus={() => setShowDropdown(true)}
          className={`${quietField} font-mono! ${invalid ? 'border-(--neg)!' : ''}`}
        />
        {showDropdown &&
          contacts.length > 0 &&
          place &&
          createPortal(
            <div
              ref={dropdownRef}
              onPointerDown={(e) => e.stopPropagation()}
              className="fixed! z-blocking! overflow-y-auto! scrollbar-hide! rounded-[10px]! bg-(--bg-1)! border! border-(--line) shadow-xl!"
              style={{
                left: place.left,
                width: place.width,
                top: place.top,
                bottom: place.bottom,
                maxHeight: `${MENU_MAX_H}px`,
              }}
            >
              {contacts
                .filter(
                  (c) =>
                    !value ||
                    c.address.toLowerCase().includes(value.toLowerCase()) ||
                    c.name.toLowerCase().includes(value.toLowerCase())
                )
                .slice(0, 6)
                .map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      onChange(c.address);
                      setShowDropdown(false);
                    }}
                    className="w-full! flex! items-center! justify-between! text-left! hover:bg-(--bg-2)! transition-colors!"
                    style={{
                      gap: '8px',
                      padding: '9px 12px',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <span className="flex! items-center! min-w-0!" style={{ gap: '6px' }}>
                      <WalletAvatar address={c.address} size={20} />
                      <span
                        className="truncate!"
                        style={{ fontSize: '12px', fontWeight: 500, color: 'var(--fg)' }}
                      >
                        {c.name}
                      </span>
                    </span>
                    <span
                      className="shrink-0! font-mono!"
                      style={{ fontSize: '11px', color: 'var(--fg-3)' }}
                    >
                      {c.address.slice(0, 8)}…{c.address.slice(-4)}
                    </span>
                  </button>
                ))}
            </div>,
            document.body
          )}
      </div>
      {invalid && (
        <div style={{ fontSize: '11px', color: 'var(--neg)', marginTop: '4px' }}>
          {t('common.invalidAddress')}
        </div>
      )}
    </div>
  );
}
