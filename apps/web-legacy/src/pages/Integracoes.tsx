import { useState } from 'react';
import { api, dt, useLoad } from '../api';
import { ActionButton, Badge, Card, Field, Form, Page, State } from '../ui';

const SCOPE_LABEL: Record<string, string> = {
  'subscribers:read': 'Ler assinantes', 'contracts:read': 'Ler contratos', 'invoices:read': 'Ler faturas',
  'tickets:write': 'Abrir atendimento', 'work_orders:read': 'Ler OS', 'work_orders:write': 'Abrir OS',
};
const EVENT_LABEL: Record<string, string> = {
  'invoice.paid': 'Fatura paga', 'access.suspend_requested': 'Suspensão solicitada', 'access.resume_requested': 'Reativação solicitada', 'access.suspended': 'Acesso suspenso (confirmado)', 'access.resumed': 'Acesso reativado (confirmado)', 'access.change_failed': 'Suspensão/reativação falhou', 'ticket.created': 'Atendimento aberto',
  'work_order.created': 'OS aberta', 'work_order.status_changed': 'Situação da OS mudou', 'sla.breached': 'SLA vencido', 'survey.answered': 'Pesquisa respondida',
};
const DELIVERY: Record<string, [string, 'green' | 'red' | 'amber']> = { sent: ['Entregue', 'green'], failed: ['Falhou', 'red'], pending: ['Pendente', 'amber'] };

/** Integrações: tokens da API pública e webhooks de saída (módulo "api"). */
export function Integracoes() {
  const [tab, setTab] = useState<'tokens' | 'webhooks' | 'entregas'>('tokens');
  const tabs: [typeof tab, string][] = [['tokens', 'Tokens da API'], ['webhooks', 'Webhooks'], ['entregas', 'Entregas']];
  return (
    <Page title="Integrações">
      <p className="muted small">Para sistemas do próprio provedor (site, ERP). O que entra pela API vira <b>atendimento</b> ou <b>ordem de serviço</b>; não há conversa. Documentação: <code>docs/api-publica.md</code>.</p>
      <div className="row" role="tablist" style={{ marginBottom: 10 }}>
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'tokens' && <Tokens />}
      {tab === 'webhooks' && <Webhooks />}
      {tab === 'entregas' && <Entregas />}
    </Page>
  );
}

function Secret({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  return (
    <Card title={label} tone="warn">
      <p className="small">Copie agora: <b>não será mostrado de novo</b>.</p>
      <input readOnly value={value} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label={label} />
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => navigator.clipboard?.writeText(value)}>Copiar</button><button className="primary" onClick={onClose}>Já guardei</button>
      </div>
    </Card>
  );
}

function Tokens() {
  const list = useLoad<any[]>('/api-tokens');
  const cat = useLoad<any>('/integrations/catalog');
  const [f, setF] = useState<any>(null);
  const [shown, setShown] = useState<string | null>(null);
  return (<>
    {shown && <Secret label="Token criado" value={shown} onClose={() => setShown(null)} />}
    <div className="row" style={{ marginBottom: 8 }}>
      <button className="primary" onClick={() => setF({ name: '', scopes: [], rate: '120', days: '' })}>Novo token</button>
    </div>
    {f && (
      <Card title="Novo token">
        <Form submit="Criar token" onCancel={() => setF(null)} onSubmit={async () => {
          const r = await api<any>('/api-tokens', { body: { name: f.name, scopes: f.scopes, rate_limit_per_min: Number(f.rate), expires_in_days: f.days ? Number(f.days) : null } });
          setShown(r.token); setF(null); list.reload();
        }}>
          <Field label="Nome da aplicação"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={60} /></Field>
          <Field label="Permissões" hint="Dê só o que a aplicação precisa.">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {(cat.data?.scopes ?? []).map((s: string) => (
                <label key={s} className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={f.scopes.includes(s)}
                  onChange={(e) => setF({ ...f, scopes: e.target.checked ? [...f.scopes, s] : f.scopes.filter((x: string) => x !== s) })} /> {SCOPE_LABEL[s] ?? s}</label>
              ))}
            </div>
          </Field>
          <div className="cols3">
            <Field label="Chamadas por minuto"><input type="number" min="10" max="6000" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
            <Field label="Validade (dias, opcional)"><input type="number" min="1" max="730" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
          </div>
        </Form>
      </Card>
    )}
    <State loading={list.loading && !list.data} error={list.error} empty={list.data?.length === 0} emptyText="Nenhum token criado.">
      <table><thead><tr><th>Aplicação</th><th>Início do token</th><th>Permissões</th><th className="num">Limite/min</th><th>Último uso</th><th>Situação</th><th></th></tr></thead>
        <tbody>{list.data?.map((t) => (
          <tr key={t.id}><td>{t.name}</td><td className="mono small">{t.prefix}…</td>
            <td className="small">{t.scopes.map((s: string) => SCOPE_LABEL[s] ?? s).join(', ')}</td><td className="num">{t.rate_limit_per_min}</td>
            <td className="small">{t.last_used_at ? dt(t.last_used_at) : 'nunca'}</td>
            <td>{t.revoked_at ? <Badge tone="red">revogado</Badge> : t.expires_at && new Date(t.expires_at) < new Date() ? <Badge tone="amber">expirado</Badge> : <Badge tone="green">ativo</Badge>}</td>
            <td>{!t.revoked_at && <ActionButton className="sm danger" confirm="Revogar este token? A aplicação deixa de funcionar na hora." onClick={async () => { await api(`/api-tokens/${t.id}`, { method: 'DELETE' }); list.reload(); }}>Revogar</ActionButton>}</td></tr>
        ))}</tbody></table>
    </State>
  </>);
}

function Webhooks() {
  const list = useLoad<any[]>('/webhook-endpoints');
  const cat = useLoad<any>('/integrations/catalog');
  const [f, setF] = useState<any>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [test, setTest] = useState<Record<string, string>>({});
  return (<>
    {shown && <Secret label="Segredo de assinatura" value={shown} onClose={() => setShown(null)} />}
    <div className="row" style={{ marginBottom: 8 }}><button className="primary" onClick={() => setF({ name: '', url: '', events: [] })}>Novo endpoint</button></div>
    {f && (
      <Card title="Novo endpoint">
        <Form submit="Criar endpoint" onCancel={() => setF(null)} onSubmit={async () => {
          const r = await api<any>('/webhook-endpoints', { body: f });
          setShown(r.secret); setF(null); list.reload();
        }}>
          <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} /></Field>
          <Field label="Endereço (HTTPS)" hint="Cada evento chega por POST JSON, com assinatura HMAC-SHA256 no cabeçalho X-Nexo-Signature."><input type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required /></Field>
          <Field label="Eventos">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {(cat.data?.events ?? []).map((ev: string) => (
                <label key={ev} className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={f.events.includes(ev)}
                  onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, ev] : f.events.filter((x: string) => x !== ev) })} /> {EVENT_LABEL[ev] ?? ev}</label>
              ))}
            </div>
          </Field>
        </Form>
      </Card>
    )}
    <State loading={list.loading && !list.data} error={list.error} empty={list.data?.length === 0} emptyText="Nenhum endpoint cadastrado.">
      <table><thead><tr><th>Endpoint</th><th>Eventos</th><th className="num">Pendentes</th><th className="num">Falhas</th><th></th></tr></thead>
        <tbody>{list.data?.map((e) => (
          <tr key={e.id}><td>{e.name} {!e.active && <Badge>pausado</Badge>}<div className="small muted mono">{e.url}</div></td>
            <td className="small">{e.events.map((x: string) => EVENT_LABEL[x] ?? x).join(', ')}</td>
            <td className="num">{e.pending}</td><td className="num">{e.failed > 0 ? <Badge tone="red">{e.failed}</Badge> : 0}</td>
            <td><div className="row" style={{ justifyContent: 'flex-end' }}>
              <ActionButton className="sm" onClick={async () => { const r = await api<any>(`/webhook-endpoints/${e.id}/test`, { method: 'POST' }); setTest({ ...test, [e.id]: r.ok ? `OK (${r.status})` : `Falhou: ${r.error}` }); }}>Testar</ActionButton>
              <ActionButton className="sm" onClick={async () => { await api(`/webhook-endpoints/${e.id}`, { method: 'PATCH', body: { active: !e.active } }); list.reload(); }}>{e.active ? 'Pausar' : 'Ativar'}</ActionButton>
              <ActionButton className="sm" confirm="Gerar novo segredo? O anterior deixa de valer." onClick={async () => { setShown((await api<any>(`/webhook-endpoints/${e.id}/rotate-secret`, { method: 'POST' })).secret); }}>Trocar segredo</ActionButton>
              <ActionButton className="sm danger" confirm="Excluir este endpoint e o histórico dele?" onClick={async () => { await api(`/webhook-endpoints/${e.id}`, { method: 'DELETE' }); list.reload(); }}>Excluir</ActionButton>
            </div>{test[e.id] && <div className="small muted" style={{ textAlign: 'right' }}>{test[e.id]}</div>}</td></tr>
        ))}</tbody></table>
    </State>
  </>);
}

function Entregas() {
  const [status, setStatus] = useState('');
  const list = useLoad<any[]>(`/webhook-deliveries${status ? `?status=${status}` : ''}`, 15000);
  return (<>
    <div className="row" style={{ marginBottom: 8 }}>
      <select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 180 }}>
        <option value="">Todas</option><option value="pending">Pendentes</option><option value="failed">Falharam</option><option value="sent">Entregues</option>
      </select>
    </div>
    <State loading={list.loading && !list.data} error={list.error} empty={list.data?.length === 0} emptyText="Nenhuma entrega.">
      <table><thead><tr><th>Quando</th><th>Endpoint</th><th>Evento</th><th>Situação</th><th></th></tr></thead>
        <tbody>{list.data?.map((d) => {
          const [label, tone] = DELIVERY[d.status] ?? [d.status, 'amber' as const];
          return (
            <tr key={d.id}><td className="small">{dt(d.created_at)}</td><td>{d.endpoint_name}</td><td className="small">{EVENT_LABEL[d.event] ?? d.event}</td>
              <td><Badge tone={tone}>{label}</Badge>{d.attempts > 0 && <span className="small muted"> · {d.attempts} tentativa(s)</span>}
                {d.last_error && <div className="small muted">{d.last_error}</div>}</td>
              <td>{d.status === 'failed' && <ActionButton className="sm" onClick={async () => { await api(`/webhook-deliveries/${d.id}/retry`, { method: 'POST' }); list.reload(); }}>Reenviar</ActionButton>}</td></tr>
          );
        })}</tbody></table>
    </State>
  </>);
}
