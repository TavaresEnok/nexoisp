// Only loaded by sgp-auditoria.mjs through a local Vite server; not a product route.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useLoad, usePaged } from '../apps/web/src/api';

function Harness() {
  const [query, setQuery] = useState('base');
  const [detail, setDetail] = useState<string | null>('/audit-detail/one');
  const list = usePaged<{ name: string }>(`/audit-list?q=${query}`);
  const item = useLoad<{ name: string }>(detail);
  return <main>
    <label>Filtro<input aria-label="Filtro" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <button onClick={() => list.setPage(list.page + 1)}>Próxima</button>
    <output id="page">{list.page}</output><output id="rows">{list.data?.map(r => r.name).join(',') ?? 'loading'}</output>
    <output id="error">{list.error}</output><output id="total">{list.total}</output>
    <button onClick={() => setDetail('/audit-detail/slow')}>Detalhe lento</button>
    <button onClick={() => setDetail('/audit-detail/two')}>Outro detalhe</button>
    <button onClick={() => setDetail(null)}>Limpar detalhe</button>
    <output id="detail">{item.data?.name ?? (item.loading ? 'loading' : 'empty')}</output>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
