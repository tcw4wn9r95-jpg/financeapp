import { useEffect, useId, useRef, type ReactNode } from 'react';
import { t } from '../../i18n';

/**
 * Modal built on <dialog>: the browser traps focus, Esc closes, and focus goes
 * back to the opener on close.
 */
export function Dialog({ open, title, onClose, children, wide = false }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      const opener = document.activeElement as HTMLElement | null;
      d.showModal();
      return () => opener?.focus?.();
    }
    if (!open && d.open) d.close();
    return undefined;
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <header className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}>
              ×
            </button>
          </header>
          <div className="dialog-body">{children}</div>
        </>
      )}
    </dialog>
  );
}
