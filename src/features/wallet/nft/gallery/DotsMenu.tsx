import { useState } from 'react';
import { MoreHorizontal } from 'src/shared/ui/icons';
import IconButton from 'src/shared/ui/IconButton';

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

export function DotsMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative! inline-flex!">
      <IconButton aria-label={label} title={label} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={16} />
      </IconButton>
      {open && (
        <>
          <button
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed! inset-0! z-dropdown! cursor-default!"
            style={{ background: 'transparent', border: 'none' }}
          />
          <div
            role="menu"
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            className="absolute! right-0! top-full! z-dropdown! flex! flex-col! animate-in! fade-in! zoom-in-95! duration-150!"
            style={{
              marginTop: '4px',
              minWidth: '200px',
              padding: '5px',
              borderRadius: '12px',
              background: 'var(--bg-2)',
              boxShadow: '0 16px 40px rgba(0, 0, 0, 0.45)',
              transformOrigin: 'top right',
            }}
          >
            {items.map((it) => (
              <button
                key={it.label}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className="flex! items-center! w-full! text-left! rounded-lg! hover:bg-(--line)! transition-colors!"
                style={{
                  height: '34px',
                  padding: '0 12px',
                  fontSize: '13px',
                  color: 'var(--fg)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
