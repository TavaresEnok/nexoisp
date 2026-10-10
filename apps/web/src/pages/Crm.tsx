import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, doc, dt, useLoad, usePaged } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, KV, Modal, Page, Pager, State } from '../ui';
import { SubscriberPick, WO_KIND, WoBadge, WorkOrderForm } from './Field';

// ---- Prospectos ----
const STAGE: Record<string, [string, 'gray' | 'green' | 'red' | 'amber' | 'blue']> = {
  new: ['Novo', 'amber'], contacted: ['Contatado', 'blue'], proposal: ['Proposta enviada', 'blue'], won: ['Convertido', 'green'], lost: ['Perdido', 'gray'],
};
const LEAD_EVENT: Record<string, string> = { created: 'Cadastrado', stage: 'Etapa', note: 'Anotação', converted: 'Convertido em assinante' };

function LeadForm({ lead, onDone, onCancel }: { lead?: any; onDone: () => void; onCancel: () => void }) {
  const plans = useLoad<any[]>('/plans');
  const keys = ['name', 'phone', 'email', 'document', 'address_street', 'address_number', 'address_district', 'address_city', 'address_state', 'address_zip', 'source', 'plan_id', 'notes'];
  const [f, setF] = useState<Record<string, string>>(Object.fromEntries(keys.map((k) => [k, lead?.[k] ?? ''])));
  const inp = (k: string, label: string, props: any = {}) => <Field label={label}><input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></Field>;
  return (
    <Form onCancel={onCancel} onSubmit={async () => {
      await api(lead ? `/leads/${lead.id}` : '/leads', { method: lead ? 'PATCH' : 'POST', body: { ...f, plan_id: f.plan_id || null, owner_id: lead?.owner_id ?? null } });
      onDone();
    }}>
      <div className="cols">{inp('name', 'Nome', { required: true, autoFocus: true })}{inp('document', 'CPF/CNPJ (opcional)')}</div>
      <div className="cols">{inp('phone', 'Telefone')}{inp('email', 'E-mail', { type: 'email' })}</div>
      <div className="cols3">{inp('address_street', 'Endereço')}{inp('address_number', 'Número')}{inp('address_district', 'Bairro')}</div>
      <div className="cols3">{inp('address_city', 'Cidade')}{inp('address_state', 'UF', { maxLength: 2 })}{inp('address_zip', 'CEP')}</div>
      <div className="cols">
        {inp('source', 'Como chegou até nós')}
        <Field label="Plano de interesse"><select value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: e.target.value })}><option value="">—</option>{plans.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      </div>
      <Field label="Observações"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
    </Form>
  );
}

function LeadDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useMe();
  const nav = useNavigate();
  const { data: l, loading, error, reload } = useLoad<any>(`/leads/${id}`);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const w = can(me, 'crm:write') && l?.stage !== 'won';
  const stage = (s: string) => async () => { await api(`/leads/${id}/stage`, { body: { stage: s, lost_reason: s === 'lost' ? reason : null } }); setReason(''); await reload(); };
  return (
    <Modal title={l ? `Prospecto — ${l.name}` : 'Prospecto'} onClose={onClose} wide>
      <State loading={loading && !l} error={error}>
        {l && !editing && (<>
          <KV items={[
            ['Etapa', <Badge tone={STAGE[l.stage][1]}>{STAGE[l.stage][0]}</Badge>], ['Telefone', l.phone], ['E-mail', l.email], ['CPF/CNPJ', doc(l.document)],
            ['Endereço', [l.address_street, l.address_number, l.address_district, l.address_city].filter(Boolean).join(', ') || '—'], ['Origem', l.source], ['Plano de interesse', l.plan_name],
            ['Assinante', l.subscriber_id ? <Link to={`/assinantes/${l.subscriber_id}`}>{l.subscriber_name}</Link> : '—'], ...(l.lost_reason ? [['Motivo da perda', l.lost_reason] as [string, string]] : []),
          ]} />
          {l.notes && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{l.notes}</p>}
          {w && (
            <div className="row" style={{ margin: '10px 0' }}>
              <button onClick={() => setEditing(true)}>Editar dados</button>
              {['new', 'contacted', 'proposal'].filter((s) => s !== l.stage).map((s) => <ActionButton key={s} onClick={stage(s)}>Marcar “{STAGE[s][0]}”</ActionButton>)}
              {can(me, 'subscribers:write') && <ActionButton className="primary" confirm="Criar o cadastro de assinante com os dados deste prospecto?"
                onClick={async () => { const r = await api(`/leads/${id}/convert`, { body: {} }); nav(`/assinantes/${r.subscriber_id}`); }}>Converter em assinante</ActionButton>}
              <input style={{ flex: 1, minWidth: 180 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo da perda" />
              <ActionButton className="danger" disabled={!reason.trim()} onClick={stage('lost')}>Marcar perdido</ActionButton>
            </div>
          )}
          <Card title="Histórico de contato">
            {can(me, 'crm:write') && <div className="row" style={{ marginBottom: 8 }}>
              <input style={{ flex: 1 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Registrar contato ou anotação…" />
              <ActionButton disabled={!note.trim()} onClick={async () => { await api(`/leads/${id}/notes`, { body: { note } }); setNote(''); await reload(); }}>Registrar</ActionButton>
            </div>}
            <ul className="steps">{l.events.map((e: any, i: number) => (
              <li key={i}><span className="small muted" style={{ minWidth: 118 }}>{dt(e.at)}</span><span className="small"><b>{LEAD_EVENT[e.event] ?? e.event}</b>{' '}
                {e.event === 'stage' ? <>{STAGE[e.detail.from]?.[0]} → {STAGE[e.detail.to]?.[0]}{e.detail.reason ? ` (${e.detail.reason})` : ''}</> : e.event === 'note' ? e.detail.note : ''} <span className="muted">· {e.actor_name ?? 'sistema'}</span></span></li>
            ))}</ul>
          </Card>
        </>)}
        {l && editing && <LeadForm lead={l} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); reload(); }} />}
      </State>
    </Modal>
  );
}

export function Leads() {
  const { me } = useMe();
  const [stage, setStage] = useState('open');
  const [q, setQ] = useState('');
  const list = usePaged<any>(`/leads?${new URLSearchParams({ ...(stage ? { stage } : {}), ...(q ? { q } : {}) })}`);
  const sum = useLoad<any>('/leads/summary');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const refresh = () => { list.reload(); sum.reload(); };
  return (
    <Page title="Prospectos" actions={can(me, 'crm:write') && <button className="primary" onClick={() => setAdding(true)}>Novo prospecto</button>}>
      {sum.data && (
        <div className="grid" style={{ marginBottom: 14 }}>
          {[['new', 'novos'], ['contacted', 'contatados'], ['proposal', 'com proposta']].map(([k, label]) => <Card key={k}><div className="stat"><b>{sum.data[k]}</b><span>{label}</span></div></Card>)}
          <Card><div className="stat"><b>{sum.data.won_month}</b><span>convertidos no mês · {sum.data.lost_month} perdidos</span></div></Card>
        </div>
      )}
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, telefone ou e-mail…" />
        <select style={{ width: 200 }} value={stage} onChange={(e) => setStage(e.target.value)}><option value="open">Em negociação</option><option value="">Todos</option>{Object.entries(STAGE).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}</select>
      </div>
      <State loading={list.loading && !list.data} error={list.error} empty={list.data?.length === 0}>
        <table>
          <thead><tr><th>Nome</th><th>Contato</th><th>Cidade</th><th>Plano de interesse</th><th>Origem</th><th>Etapa</th><th>Atualizado</th><th></th></tr></thead>
          <tbody>{list.data?.map((l) => (
            <tr key={l.id}><td>{l.name}</td><td className="small">{[l.phone, l.email].filter(Boolean).join(' · ')}</td><td className="small">{l.address_city ?? '—'}</td><td className="small">{l.plan_name ?? '—'}</td>
              <td className="small">{l.source ?? '—'}</td><td><Badge tone={STAGE[l.stage][1]}>{STAGE[l.stage][0]}</Badge></td><td className="small">{dt(l.updated_at)}</td>
              <td><button className="sm" onClick={() => setOpen(l.id)}>abrir</button></td></tr>
          ))}</tbody>
        </table>
        <Pager p={list} />
      </State>
      {adding && <Modal title="Novo prospecto" onClose={() => setAdding(false)} wide><LeadForm onCancel={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} /></Modal>}
      {open && <LeadDetail id={open} onClose={() => { setOpen(null); refresh(); }} />}
    </Page>
  );
}

// ---- Atendimentos ----
export const CATEGORY: Record<string, string> = { technical: 'Técnico', financial: 'Financeiro', commercial: 'Comercial', other: 'Outro' };
const TK_STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'amber' | 'blue']> = { open: ['Aguardando o provedor', 'amber'], waiting: ['Aguardando o assinante', 'blue'], closed: ['Encerrado', 'gray'] };
export const TicketBadge = ({ status }: { status: string }) => <Badge tone={TK_STATUS[status]?.[1]}>{TK_STATUS[status]?.[0] ?? status}</Badge>;
const PRIORITY: Record<string, string> = { low: 'Baixa', normal: 'Normal', high: 'Alta' };

function TicketForm({ subscriberId, onDone, onCancel }: { subscriberId?: string; onDone: () => void; onCancel: () => void }) {
  const [who, setWho] = useState({ subscriber_id: subscriberId ?? '', contract_id: '' });
  const [f, setF] = useState({ subject: '', category: 'technical', priority: 'normal', body: '' });
  return (
    <Form submit="Abrir atendimento" onCancel={onCancel} onSubmit={async () => { await api('/tickets', { body: { ...f, ...who, contract_id: who.contract_id || null } }); onDone(); }}>
      {!subscriberId && <SubscriberPick value={who} onChange={setWho} />}
      <div className="cols3">
        <Field label="Assunto"><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required /></Field>
        <Field label="Categoria"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Prioridade"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      </div>
      <Field label="Relato"><textarea rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required /></Field>
    </Form>
  );
}

function TicketDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useMe();
  const { data: t, loading, error, reload } = useLoad<any>(`/tickets/${id}`, 10000);
  const staff = useLoad<any[]>(can(me, 'os:read') ? '/staff' : null);
  const [body, setBody] = useState('');
  const [os, setOs] = useState(false);
  const w = can(me, 'crm:write');
  const send = (internal: boolean) => async () => { await api(`/tickets/${id}/messages`, { body: { body, internal } }); setBody(''); await reload(); };
  const status = (s: string) => async () => { await api(`/tickets/${id}/status`, { body: { status: s } }); await reload(); };
  return (
    <Modal title={t ? `Protocolo ${t.number} — ${t.subject}` : 'Atendimento'} onClose={onClose} wide>
      <State loading={loading && !t} error={error}>
        {t && (<>
          <KV items={[
            ['Situação', <TicketBadge status={t.status} />], ['Assinante', <Link to={`/assinantes/${t.subscriber_id}`}>{t.subscriber_name}</Link>], ['Categoria', CATEGORY[t.category]],
            ['Prioridade', PRIORITY[t.priority]], ['Aberto', <>{dt(t.created_at)} <span className="small muted">{t.origin === 'portal' ? 'pelo assinante (portal)' : 'pelo provedor'}</span></>],
            ['Responsável', w && staff.data ? <select value={t.assignee_id ?? ''} onChange={async (e) => { try { await api(`/tickets/${id}`, { method: 'PATCH', body: { assignee_id: e.target.value || null } }); reload(); } catch (x: any) { alert(x.message); } }}>
              <option value="">— a definir —</option>{staff.data.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select> : t.assignee_name],
          ]} />
          <div style={{ margin: '12px 0' }}>{t.thread.map((m: any) => (
            <div key={m.id} className="card" style={{ marginBottom: 8, background: m.internal ? 'var(--amber-bg)' : m.author_kind === 'subscriber' ? 'var(--blue-bg)' : undefined }}>
              <div className="small muted">{m.author_kind === 'subscriber' ? 'Assinante' : m.author_name ?? 'Provedor'} · {dt(m.at)} {m.internal && <Badge tone="amber">nota interna — o assinante não vê</Badge>}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
            </div>
          ))}</div>
          {t.work_orders.length > 0 && <p className="small">Ordens de serviço: {t.work_orders.map((o: any) => <span key={o.id} style={{ marginRight: 10 }}>OS {o.number} ({WO_KIND[o.kind]}) <WoBadge status={o.status} /></span>)}</p>}
          {w && t.status !== 'closed' && (<>
            <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Escreva a resposta ou uma nota interna…" />
            <div className="row" style={{ marginTop: 8 }}>
              <ActionButton className="primary" disabled={!body.trim()} onClick={send(false)}>Responder ao assinante</ActionButton>
              <ActionButton disabled={!body.trim()} onClick={send(true)}>Salvar como nota interna</ActionButton>
              {can(me, 'os:write') && <button onClick={() => setOs(true)}>Abrir ordem de serviço</button>}
              <ActionButton className="danger" confirm="Encerrar este atendimento?" onClick={status('closed')}>Encerrar</ActionButton>
            </div>
          </>)}
          {w && t.status === 'closed' && <ActionButton onClick={status('open')}>Reabrir</ActionButton>}
          {os && <Modal title={`Nova OS — protocolo ${t.number}`} onClose={() => setOs(false)} wide>
            <WorkOrderForm subscriberId={t.subscriber_id} contractId={t.contract_id ?? undefined} ticketId={t.id} onCancel={() => setOs(false)} onDone={() => { setOs(false); reload(); }} /></Modal>}
        </>)}
      </State>
    </Modal>
  );
}

/** Lista de atendimentos; com `subscriberId` vira o cartão da ficha do assinante. */
export function TicketList({ subscriberId }: { subscriberId?: string }) {
  const { me } = useMe();
  const [status, setStatus] = useState(subscriberId ? '' : 'pending');
  const [q, setQ] = useState('');
  const [mine, setMine] = useState(false);
  const p = new URLSearchParams();
  if (status) p.set('status', status);
  if (q) p.set('q', q);
  if (mine) p.set('mine', '1');
  if (subscriberId) p.set('subscriber_id', subscriberId);
  const list = usePaged<any>(`/tickets?${p}`, 15000);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const w = can(me, 'crm:write');
  const table = (
    <State loading={list.loading && !list.data} error={list.error} empty={list.data?.length === 0}>
      <table>
        <thead><tr><th>Protocolo</th>{!subscriberId && <th>Assinante</th>}<th>Assunto</th><th>Categoria</th><th>Situação</th><th>Responsável</th><th>Atualizado</th><th></th></tr></thead>
        <tbody>{list.data?.map((t) => (
          <tr key={t.id}><td className="mono">{t.number}</td>{!subscriberId && <td><Link to={`/assinantes/${t.subscriber_id}`}>{t.subscriber_name}</Link></td>}
            <td>{t.subject} {t.priority === 'high' && <Badge tone="red">alta</Badge>} {t.origin === 'portal' && <Badge>portal</Badge>}</td><td className="small">{CATEGORY[t.category]}</td>
            <td><TicketBadge status={t.status} /></td><td className="small">{t.assignee_name ?? '—'}</td><td className="small">{dt(t.updated_at)}</td>
            <td><button className="sm" onClick={() => setOpen(t.id)}>abrir</button></td></tr>
        ))}</tbody>
      </table>
      <Pager p={list} />
    </State>
  );
  const modals = (<>
    {open && <TicketDetail id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    {adding && <Modal title="Novo atendimento" onClose={() => setAdding(false)} wide><TicketForm subscriberId={subscriberId} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); list.reload(); }} /></Modal>}
  </>);
  if (subscriberId) return <Card title="Atendimentos" actions={w && <button onClick={() => setAdding(true)}>Novo atendimento</button>}>{table}{modals}</Card>;
  return (
    <Page title="Atendimentos" actions={w && <button className="primary" onClick={() => setAdding(true)}>Novo atendimento</button>}>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Assinante, assunto ou protocolo…" />
        <select style={{ width: 220 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Em aberto</option><option value="">Todos</option>{Object.entries(TK_STATUS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}</select>
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={mine} onChange={(e) => setMine(e.target.checked)} /> só os meus</label>
      </div>
      {table}{modals}
    </Page>
  );
}
export const Tickets = () => <TicketList />;

/** Relatório do período: de onde vêm os assinantes novos, quanto tempo o provedor leva para responder e concluir. */
export function CrmReport() {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const { data: r, loading, error } = useLoad<any>(`/crm/report?from=${f.from}&to=${f.to}`);
  const h = (v: number | null) => (v == null ? '—' : `${String(v).replace('.', ',')} h`);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return (
    <Page title="Relatórios de atendimento" actions={<>
      <input type="date" style={{ width: 160 }} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><span className="muted">até</span>
      <input type="date" style={{ width: 160 }} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
    </>}>
      <State loading={loading && !r} error={error}>
        {r && (<>
          <Card title="Prospectos cadastrados no período, por origem">
            <State empty={r.leads.length === 0}>
              <table><thead><tr><th>Origem</th><th className="num">Cadastrados</th><th className="num">Convertidos</th><th className="num">Perdidos</th><th className="num">Em negociação</th><th className="num">Conversão</th></tr></thead>
                <tbody>{r.leads.map((x: any) => <tr key={x.source}><td>{x.source}</td><td className="num">{x.created}</td><td className="num">{x.won}</td><td className="num">{x.lost}</td><td className="num">{x.open}</td><td className="num">{pct(x.won, x.created)}</td></tr>)}</tbody></table>
            </State>
          </Card>
          <Card title="Atendimentos abertos no período, por categoria">
            <State empty={r.tickets.length === 0}>
              <table><thead><tr><th>Categoria</th><th className="num">Abertos</th><th className="num">Encerrados</th><th className="num">Pelo portal</th><th className="num">1ª resposta (média)</th><th className="num">Até encerrar (média)</th></tr></thead>
                <tbody>{r.tickets.map((x: any) => <tr key={x.category}><td>{CATEGORY[x.category]}</td><td className="num">{x.opened}</td><td className="num">{x.closed}</td><td className="num">{x.from_portal}</td><td className="num">{h(x.first_response_h)}</td><td className="num">{h(x.resolution_h)}</td></tr>)}</tbody></table>
            </State>
          </Card>
          {r.work_orders && (
            <Card title="Ordens de serviço abertas no período, por tipo">
              <State empty={r.work_orders.length === 0}>
                <table><thead><tr><th>Tipo</th><th className="num">Abertas</th><th className="num">Concluídas</th><th className="num">Canceladas</th><th className="num">Até concluir (média)</th></tr></thead>
                  <tbody>{r.work_orders.map((x: any) => <tr key={x.kind}><td>{WO_KIND[x.kind]}</td><td className="num">{x.opened}</td><td className="num">{x.done}</td><td className="num">{x.canceled}</td><td className="num">{h(x.completion_h)}</td></tr>)}</tbody></table>
              </State>
            </Card>
          )}
          <p className="small muted">Datas no fuso {r.timezone}. Médias em horas corridas, só dos registros que já têm resposta ou encerramento. Não há meta de prazo (SLA) configurada.</p>
        </>)}
      </State>
    </Page>
  );
}

/** Portal do assinante: abrir e acompanhar os próprios atendimentos. */
export function PortalTickets() {
  const list = useLoad<any[]>('/portal/tickets', 20000);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ subject: '', category: 'technical', body: '' });
  const thread = useLoad<any>(open ? `/portal/tickets/${open}` : null, 10000);
  const [reply, setReply] = useState('');
  return (
    <Card title="Atendimento" actions={<button className="primary" onClick={() => setAdding(true)}>Abrir chamado</button>}>
      <State loading={list.loading} error={list.error} empty={list.data?.length === 0}>
        <table>
          <thead><tr><th>Protocolo</th><th>Assunto</th><th>Situação</th><th>Atualizado</th><th></th></tr></thead>
          <tbody>{list.data?.map((t) => (
            <tr key={t.id}><td className="mono">{t.number}</td><td>{t.subject}</td>
              <td>{t.status === 'waiting' ? <Badge tone="amber">Aguardando sua resposta</Badge> : t.status === 'open' ? <Badge tone="blue">Em análise</Badge> : <Badge>Encerrado</Badge>}</td>
              <td className="small">{dt(t.updated_at)}</td><td><button className="sm" onClick={() => { setReply(''); setOpen(t.id); }}>ver</button></td></tr>
          ))}</tbody>
        </table>
      </State>
      {adding && (
        <Modal title="Abrir chamado" onClose={() => setAdding(false)}>
          <Form submit="Enviar" onCancel={() => setAdding(false)} onSubmit={async () => { await api('/portal/tickets', { body: f }); setAdding(false); setF({ subject: '', category: 'technical', body: '' }); list.reload(); }}>
            <Field label="Assunto"><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required autoFocus /></Field>
            <Field label="Tipo"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Descreva o que está acontecendo"><textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required /></Field>
          </Form>
        </Modal>
      )}
      {open && (
        <Modal title={thread.data ? `Protocolo ${thread.data.number} — ${thread.data.subject}` : 'Chamado'} onClose={() => { setOpen(null); list.reload(); }} wide>
          <State loading={thread.loading && !thread.data} error={thread.error}>
            {thread.data && (<>
              {thread.data.thread.map((m: any) => (
                <div key={m.id} className="card" style={{ marginBottom: 8, background: m.author_kind === 'subscriber' ? 'var(--blue-bg)' : undefined }}>
                  <div className="small muted">{m.author_kind === 'subscriber' ? 'Você' : 'Atendimento'} · {dt(m.at)}</div><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                </div>
              ))}
              {thread.data.status === 'closed' ? <div className="state">Chamado encerrado. Se precisar, abra um novo.</div> : (<>
                <textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Escreva sua mensagem…" />
                <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
                  <ActionButton className="primary" disabled={!reply.trim()} onClick={async () => { await api(`/portal/tickets/${open}/messages`, { body: { body: reply } }); setReply(''); await thread.reload(); }}>Enviar</ActionButton>
                </div>
              </>)}
            </>)}
          </State>
        </Modal>
      )}
    </Card>
  );
}
