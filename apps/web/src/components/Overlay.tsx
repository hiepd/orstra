import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useEscape } from '../lib/escape';
import { CheckToast, CloseIcon, StuckCircle } from './Icons';

/* ---------- Modal ---------- */

export function Modal({
  crumb,
  title,
  onClose,
  children,
  footer,
  width,
}: {
  crumb?: ReactNode;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  footer: ReactNode;
  width?: number;
}) {
  useEscape(onClose);
  return (
    <>
      <div className="lx-scrim lx-top" onClick={onClose} />
      <div className="lx-modal" role="dialog" aria-modal="true" aria-label={title} style={width ? { width } : undefined}>
        <div className="lx-mh">
          {crumb}
          <button className="lx-ib" style={{ marginLeft: 'auto' }} aria-label="Close" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="lx-mb">
          <h2>{title}</h2>
          {children}
        </div>
        <div className="lx-mf">
          <span className="lx-hint">Esc to cancel</span>
          <div className="lx-push" style={{ display: 'flex', gap: 6 }}>
            {footer}
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- Peek (side panel) ---------- */

export function Peek({ header, onClose, children, footer, label }: { header: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; label: string }) {
  useEscape(onClose);
  return (
    <>
      <div className="lx-scrim" onClick={onClose} />
      <aside className="lx-peek" role="dialog" aria-modal="true" aria-label={label}>
        <div className="lx-peh">
          {header}
          <button className="lx-ib" style={{ marginLeft: 'auto' }} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="lx-peb">{children}</div>
        {footer}
      </aside>
    </>
  );
}

/* ---------- Menu (closes on outside click / Escape) ---------- */

export function Menu({ onClose, style, children, label }: { onClose: () => void; style?: CSSProperties; children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Defer so the click that opened the menu doesn't close it.
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="lx-menu" role="menu" aria-label={label} style={style}>
      {children}
    </div>
  );
}

/* ---------- Toasts ---------- */

type Toast = { id: number; text: string; error?: boolean };
const ToastCtx = createContext<(text: string, opts?: { error?: boolean }) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, opts?: { error?: boolean }) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, text, error: opts?.error }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts?.error ? 5000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="lx-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="lx-toast" role="status">
            {t.error ? <StuckCircle label="Error" /> : <CheckToast />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
