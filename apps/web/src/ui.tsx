import { useState, type FormEvent, type ReactNode } from 'react';

export function Page({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <h1>{title}</h1>
        <div className="row">{actions}</div>
      </header>
      {children}
    </div>
  );
}

export function State({ loading, error, empty, children }: { loading?: boolean; error?: string | null; empty?: boolean; children?: ReactNode }) {
  if (loading) return <div className="state">Carregando…</div>;
  if (error) return <div className="state err">{error}</div>;
  if (empty) return <div className="state">Nenhum registro encontrado.</div>;
  return <>{children}</>;
}

export function Badge({ tone = 'gray', children }: { tone?: 'gray' | 'green' | 'red' | 'amber' | 'blue'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <header><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label="Fechar">✕</button></header>
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
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        try {
          await onClick();
        } catch (e: any) {
          window.alert(e.message);
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
