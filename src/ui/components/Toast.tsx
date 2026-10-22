import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

/** An optional button on the message, e.g. "Undo" (D-73). */
export interface ToastAction {
  label: string;
  run: () => void;
}
type Notify = (message: string, kind?: 'ok' | 'error', action?: ToastAction) => void;
const ToastContext = createContext<Notify>(() => {});

/** Status messages announced to screen readers through a polite live region. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'error'; n: number; action?: ToastAction } | null>(null);
  const notify = useCallback<Notify>((text, kind = 'ok', action) => {
    setMsg((m) => ({ text, kind, n: (m?.n ?? 0) + 1, ...(action ? { action } : {}) }));
    // A message with a button stays a little longer, so there is time to tap it.
    setTimeout(() => setMsg((m) => (m && m.text === text ? null : m)), action ? 8000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {msg && (
          <div key={msg.n} className={`toast toast-${msg.kind}`}>
            <span aria-hidden="true">{msg.kind === 'ok' ? '✓ ' : '⚠ '}</span>
            {msg.text}
            {msg.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  msg.action!.run();
                  setMsg(null);
                }}
              >
                {msg.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
