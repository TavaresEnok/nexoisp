import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

// ---- Ícones (traço simples, desenhados para este projeto; sem dependência externa) ----
const ICONS: Record<string, string> = {
  home: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6',
  users: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 20v-1a4 4 0 0 0-3-3.8M15.5 4.2a3.5 3.5 0 0 1 0 6.6',
  gauge: 'M12 14l4-5M4.5 18a9 9 0 1 1 15 0M12 14a1 1 0 1 0 0 .01',
  doc: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  chat: 'M4 5h16v11H9l-5 4z',
  funnel: 'M3 5h18l-7 8v6l-4 2v-8z',
  phone: 'M8 3h8v18H8zM11 18h2',
  wrench: 'M14.5 6.5a4 4 0 0 0 5 5L11 20a2.1 2.1 0 0 1-3-3zM6 8l-3-3 2-2 3 3',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  plug: 'M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3',
  box: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  scale: 'M12 4v16M6 20h12M5 8h14M5 8l-3 6a3 3 0 0 0 6 0zM19 8l-3 6a3 3 0 0 0 6 0z',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  pulse: 'M3 12h4l2-6 4 12 2-6h6',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  onu: 'M4 14h16v5H4zM8 16.5h.01M12 16.5h.01M7 14V9M12 14V6M17 14V9',
  fiber: 'M4 7h6l4 10h6M4 17h6l1.3-3.2M14 7h6',
  ip: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  building: 'M4 21V5l8-2v18M12 9h8v12M8 8h.01M8 12h.01M8 16h.01M16 13h.01M16 17h.01M2 21h20',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-4-4',
  chev: 'M6 9l6 6 6-6',
  x: 'M6 6l12 12M18 6L6 18',
  menu: 'M4 6h16M4 12h16M4 18h16',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  moon: 'M20 14A8 8 0 1 1 10 4a6.5 6.5 0 0 0 10 10',
  out: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  check: 'M5 12l5 5 9-10',
};
export function Icon({ name, title }: { name: keyof typeof ICONS | string; title?: string }) {
  return <svg className="ico" viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>{title && <title>{title}</title>}<path d={ICONS[name] ?? ICONS.list} /></svg>;
}
/** Marca: três fibras saindo de um ponto (o "nexo"). */
export function Brand() {
  return (
    <span className="brand">
      <svg viewBox="0 0 28 28" aria-hidden="true" fill="none" strokeWidth="2.6" strokeLinecap="round">
        <path d="M6 14C13 14 14 5 23 5" stroke="var(--fiber-blue)" /><path d="M6 14h17" stroke="var(--fiber-aqua)" /><path d="M6 14c7 0 8 9 17 9" stroke="var(--fiber-orange)" />
        <circle cx="5.5" cy="14" r="3" fill="currentColor" />
      </svg>
      <b>Nexo<span>ISP</span></b>
    </span>
  );
}

// ---- Confirmações, perguntas e avisos dentro do sistema (no lugar das janelas do navegador) ----
type Ask = { kind: 'confirm' | 'prompt'; message: string; label?: string; action?: string; danger?: boolean; resolve: (v: any) => void };
type Toast = { id: number; text: string; err: boolean };
let pushAsk: (a: Ask) => void = () => {};
let pushToast: (t: Omit<Toast, 'id'>) => void = () => {};
export const dialog = {
  confirm: (message: string, opts: { action?: string; danger?: boolean } = {}) => new Promise<boolean>((resolve) => pushAsk({ kind: 'confirm', message, resolve, ...opts })),
  prompt: (message: string, opts: { label?: string; action?: string } = {}) => new Promise<string | null>((resolve) => pushAsk({ kind: 'prompt', message, resolve, ...opts })),
};
export const toast = (text: string) => pushToast({ text, err: false });
export const toastError = (e: unknown) => pushToast({ text: e instanceof Error ? e.message : String(e), err: true });

export function DialogHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    pushAsk = (a) => { setText(''); setAsk(a); };
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setToasts((x) => [...x.slice(-3), { ...t, id }]);
      setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.err ? 9000 : 4500);
    };
  }, []);
  const close = (v: any) => { ask?.resolve(v); setAsk(null); };
  return (<>
    {ask && (
      <Modal title={ask.kind === 'prompt' ? 'Informe para continuar' : 'Confirme a ação'} onClose={() => close(ask.kind === 'prompt' ? null : false)} className="dialog">
        <form onSubmit={(e) => { e.preventDefault(); close(ask.kind === 'prompt' ? text.trim() || null : true); }}>
          <p style={{ marginTop: 0 }}>{ask.message}</p>
          {ask.kind === 'prompt' && <Field label={ask.label ?? 'Motivo'}><input value={text} onChange={(e) => setText(e.target.value)} autoFocus required /></Field>}
          <footer className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="ghost" onClick={() => close(ask.kind === 'prompt' ? null : false)}>Cancelar</button>
            <button type="submit" className={ask.danger ? 'danger' : 'primary'} autoFocus={ask.kind === 'confirm'}>{ask.action ?? 'Confirmar'}</button>
          </footer>
        </form>
      </Modal>
    )}
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}><Icon name={t.err ? 'alert' : 'check'} /><span>{t.text}</span>
        <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dispensar">✕</button></div>)}
    </div>
  </>);
}


export function Page({ title, sub, actions, children }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
        <div className="row">{actions}</div>
      </header>
      {children}
    </div>
  );
}

export function State({ loading, error, empty, emptyText, children }: { loading?: boolean; error?: string | null; empty?: boolean; emptyText?: string; children?: ReactNode }) {
  if (loading) return <div className="state">Carregando…</div>;
  if (error) return <div className="state err">{error}</div>;
  if (empty) return <div className="state">{emptyText ?? 'Nada por aqui ainda.'}</div>;
  return <>{children}</>;
}

export function Badge({ tone = 'gray', children }: { tone?: 'gray' | 'green' | 'red' | 'amber' | 'blue'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

const openModals: object[] = [];
export function Modal({ title, onClose, children, wide, className = '' }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // foco entra na janela (primeiro campo, se houver) e volta para onde estava ao fechar
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]), select, textarea');
    (first ?? ref.current)?.focus();
    const me = {};
    openModals.push(me);
    // Esc fecha só a janela de cima quando há uma sobre a outra
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && openModals[openModals.length - 1] === me) onClose(); };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); openModals.splice(openModals.indexOf(me), 1); prev?.focus?.(); };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header><h2>{title}</h2><button className="ghost icon" onClick={onClose} aria-label="Fechar"><Icon name="x" /></button></header>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Formulário com estado de envio e erro; onSubmit lança Error para exibir mensagem. */
export function Form({ onSubmit, children, submit = 'Salvar', onCancel }: {
  onSubmit: () => Promise<void>; children: ReactNode; submit?: string; onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function handle(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={handle} className="form">
      {children}
      {error && <div className="state err">{error}</div>}
      <footer>
        {onCancel && <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Enviando…' : submit}</button>
      </footer>
    </form>
  );
}

/** Botão para ação assíncrona com confirmação opcional e erro inline. */
export function ActionButton({ onClick, children, confirm, className = '', disabled, title }: {
  onClick: () => Promise<unknown>; children: ReactNode; confirm?: string; className?: string; disabled?: boolean; title?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button className={className} disabled={busy || disabled} title={title}
      onClick={async () => {
        if (confirm && !(await dialog.confirm(confirm, { danger: className.includes('danger'), action: typeof children === 'string' ? children : undefined }))) return;
        setBusy(true);
        try {
          await onClick();
        } catch (e: any) {
          toastError(e);
        } finally {
          setBusy(false);
        }
      }}>
      {busy ? '…' : children}
    </button>
  );
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>))}
    </dl>
  );
}

export function Card({ title, children, actions, tone }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; tone?: string }) {
  return (
    <section className={`card ${tone ?? ''}`}>
      {(title || actions) && <header><h3>{title}</h3><div className="row">{actions}</div></header>}
      {children}
    </section>
  );
}

export function Pager({ p }: { p: { page: number; pages: number; total: number; setPage: (n: number) => void } }) {
  if (p.total === 0) return null;
  return (
    <div className="row small muted" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
      <span>{p.total} registro(s) · página {p.page + 1} de {p.pages}</span>
      <button className="sm" disabled={p.page === 0} onClick={() => p.setPage(p.page - 1)}>Anterior</button>
      <button className="sm" disabled={p.page + 1 >= p.pages} onClick={() => p.setPage(p.page + 1)}>Próxima</button>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string; count?: number | null }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>{t.label}{t.count ? <span className="count">{t.count}</span> : null}</button>)}
    </div>
  );
}

/** Barra de ocupação/nível. `warn` e `bad` são frações (0–1) a partir das quais a cor muda. */
export function Meter({ value, max, warn = 0.8, bad = 1 }: { value: number; max: number; warn?: number; bad?: number }) {
  const f = max > 0 ? Math.min(1, value / max) : 0;
  return <div className={`meter ${f >= bad ? 'bad' : f >= warn ? 'warn' : ''}`} role="img" aria-label={`${value} de ${max}`}><i style={{ width: `${Math.max(f * 100, value > 0 ? 4 : 0)}%` }} /></div>;
}
