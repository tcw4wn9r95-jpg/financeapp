import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Notify = (message: string, kind?: 'ok' | 'error') => void;
const ToastContext = createContext<Notify>(() => {});

/** Status messages announced to screen readers through a polite live region. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'error'; n: number } | null>(null);
  const notify = useCallback<Notify>((text, kind = 'ok') => {
    setMsg((m) => ({ text, kind, n: (m?.n ?? 0) + 1 }));
    setTimeout(() => setMsg((m) => (m && m.text === text ? null : m)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {msg && (
          <div key={msg.n} className={`toast toast-${msg.kind}`}>
            <span aria-hidden="true">{msg.kind === 'ok' ? '✓ ' : '⚠ '}</span>
            {msg.text}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
