import { useCallback, useEffect, useState } from 'react';

// A sessão fica em cookie HttpOnly definido pelo servidor: o JavaScript da página não tem acesso ao token.
async function request(path: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'X-Nexo-CSRF': '1' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new Error('Não foi possível conectar ao servidor.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login' && path !== '/me' && window.location.pathname !== '/login') window.location.href = '/login';
  if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
  return { data, total: Number(res.headers.get('x-total-count') ?? NaN) };
}
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  return (await request(path, opts)).data as T;
}

/** Baixa um arquivo de texto gerado pela API (script, CSV) sem sair da página. */
export async function download(path: string, filename: string) {
  const res = await fetch(`/api${path}`, { headers: { 'X-Nexo-CSRF': '1' }, credentials: 'same-origin' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Erro ${res.status}`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const PAGE_SIZE = 50;
/** Lista paginada no servidor (?limit/offset + X-Total-Count). `path` já pode conter filtros. */
export function usePaged<T = any>(path: string, refreshMs?: number) {
  const [page, setPage] = useState(0);
  const [state, setState] = useState<{ rows?: T[]; total: number; error: string | null; loading: boolean }>({ total: 0, error: null, loading: true });
  useEffect(() => setPage(0), [path]);
  const reload = useCallback(async () => {
    try {
      const r = await request(`${path}${path.includes('?') ? '&' : '?'}limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
      setState({ rows: r.data, total: Number.isNaN(r.total) ? r.data.length : r.total, error: null, loading: false });
    } catch (e: any) {
      setState((s) => ({ ...s, error: e.message, loading: false }));
    }
  }, [path, page]);
  useEffect(() => {
    reload();
    if (!refreshMs) return;
    const id = setInterval(reload, refreshMs);
    return () => clearInterval(id);
  }, [reload, refreshMs]);
  return { ...state, data: state.rows, page, setPage, pages: Math.max(1, Math.ceil(state.total / PAGE_SIZE)), reload };
}

export function useLoad<T = any>(path: string | null, refreshMs?: number) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(!!path);
    reload();
    if (!refreshMs) return;
    const id = setInterval(reload, refreshMs);
    return () => clearInterval(id);
  }, [reload, refreshMs, path]);
  return { data, error, loading, reload };
}

export const money = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const speed = (kbps: number) => (kbps >= 1_000_000 ? `${kbps / 1_000_000} Gbps` : `${kbps / 1000} Mbps`);
export const dt = (s?: string | null) => (s ? new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
export const d = (s?: string | null) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '—');
export const doc = (s?: string | null) =>
  !s ? '—' : s.length === 11 ? s.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
    : s.length === 14 ? s.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : s;
export function ago(s?: string | null): string {
  if (!s) return 'nunca';
  const sec = Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 1000));
  if (sec < 60) return `há ${sec}s`;
  if (sec < 3600) return `há ${Math.round(sec / 60)} min`;
  if (sec < 86400) return `há ${Math.round(sec / 3600)} h`;
  return `há ${Math.round(sec / 86400)} d`;
}
