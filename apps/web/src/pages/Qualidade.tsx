import { useState } from 'react';
import { api, useLoad } from '../api';
import { ActionButton, Badge, Card, Field, Form, Page, State } from '../ui';

const KIND: Record<string, string> = {
  ticket_type: 'Tipo de ocorrência', classification: 'Classificação', root_cause: 'Causa-raiz', origin: 'Origem', os_reason: 'Motivo de OS',
};
const WO_KIND: Record<string, string> = { install: 'Instalação', repair: 'Reparo', address_change: 'Mudança de endereço', removal: 'Retirada', other: 'Outro' };
const PRIO: Record<string, string> = { low: 'baixa', normal: 'normal', high: 'alta' };
const fmtMin = (m: number) => (m >= 1440 ? `${(m / 1440).toFixed(m % 1440 ? 1 : 0)} d` : m >= 60 ? `${(m / 60).toFixed(m % 60 ? 1 : 0)} h` : `${m} min`);

/** Catálogos de ocorrência, políticas de SLA e pesquisa de satisfação. */
export function Qualidade() {
  const [tab, setTab] = useState<'catalogos' | 'sla' | 'satisfacao'>('catalogos');
  const tabs: [typeof tab, string][] = [['catalogos', 'Catálogos'], ['sla', 'SLA'], ['satisfacao', 'Satisfação']];
  return (
    <Page title="Catálogos, SLA e satisfação">
      <div className="row" role="tablist" style={{ marginBottom: 10 }}>
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'catalogos' && <Catalogos />}
      {tab === 'sla' && <Sla />}
      {tab === 'satisfacao' && <Satisfacao />}
    </Page>
  );
}

function Catalogos() {
  const cat = useLoad<any[]>('/catalogs?all=1');
  const [f, setF] = useState({ kind: 'ticket_type', name: '' });
  return (<>
    <Card title="Novo item">
      <Form submit="Adicionar" onSubmit={async () => { await api('/catalogs', { body: f }); setF({ ...f, name: '' }); cat.reload(); }}>
        <div className="cols3">
          <Field label="Catálogo"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={80} /></Field>
        </div>
      </Form>
    </Card>
    <State loading={cat.loading && !cat.data} error={cat.error} empty={cat.data?.length === 0}>
      {Object.entries(KIND).map(([k, label]) => {
        const rows = cat.data?.filter((x) => x.kind === k) ?? [];
        if (!rows.length) return null;
        return (
          <Card key={k} title={label}>
            <table><tbody>{rows.map((r) => (
              <tr key={r.id}><td>{r.name}</td><td>{r.active ? <Badge tone="green">ativo</Badge> : <Badge>inativo</Badge>}</td>
                <td><ActionButton className="sm" onClick={async () => { await api(`/catalogs/${r.id}`, { method: 'PATCH', body: { active: !r.active } }); cat.reload(); }}>{r.active ? 'Desativar' : 'Ativar'}</ActionButton></td></tr>
            ))}</tbody></table>
          </Card>
        );
      })}
    </State>
  </>);
}

function Sla() {
  const pol = useLoad<any[]>('/sla-policies');
  const rep = useLoad<any>('/reports/sla');
  const staff = useLoad<any[]>('/staff');
  const types = useLoad<any[]>('/catalogs?kind=ticket_type');
  const [f, setF] = useState<any>(null);
  return (<>
    <div className="row" style={{ marginBottom: 8 }}>
      <button className="primary" onClick={() => setF({ name: '', applies_to: 'ticket', priority: '', kind: '', type_id: '', hours: '24', escalate_to: '' })}>Nova política</button>
      <span className="small muted">Prazo em tempo corrido (sem calendário de expediente). A política mais específica vale.</span>
    </div>
    {f && (
      <Card title="Nova política de SLA">
        <Form submit="Salvar" onCancel={() => setF(null)} onSubmit={async () => {
          await api('/sla-policies', { body: { name: f.name, applies_to: f.applies_to, priority: f.applies_to === 'ticket' ? f.priority || null : null,
            kind: f.applies_to === 'work_order' ? f.kind || null : null, type_id: f.applies_to === 'ticket' ? f.type_id || null : null,
            resolution_minutes: Math.round(Number(f.hours) * 60), escalate_to: f.escalate_to || null } });
          setF(null); pol.reload(); rep.reload();
        }}>
          <div className="cols3">
            <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
            <Field label="Vale para"><select value={f.applies_to} onChange={(e) => setF({ ...f, applies_to: e.target.value })}><option value="ticket">Atendimentos</option><option value="work_order">Ordens de serviço</option></select></Field>
            <Field label="Prazo (horas)"><input type="number" min="0.1" step="0.5" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} required /></Field>
          </div>
          {f.applies_to === 'ticket' ? (
            <div className="cols3">
              <Field label="Prioridade (opcional)"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="">Todas</option>{Object.entries(PRIO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Tipo (opcional)"><select value={f.type_id} onChange={(e) => setF({ ...f, type_id: e.target.value })}><option value="">Todos</option>{types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            </div>
          ) : (
            <Field label="Natureza da OS (opcional)"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="">Todas</option>{Object.entries(WO_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          )}
          <Field label="Escalonar para (opcional)" hint="Ao vencer o prazo, a ocorrência passa para esta pessoa."><select value={f.escalate_to} onChange={(e) => setF({ ...f, escalate_to: e.target.value })}><option value="">Ninguém</option>{staff.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        </Form>
      </Card>
    )}
    <State loading={pol.loading && !pol.data} error={pol.error} empty={pol.data?.length === 0} emptyText="Nenhuma política cadastrada.">
      <table><thead><tr><th>Política</th><th>Vale para</th><th>Prazo</th><th>Escalona</th><th className="num">Em uso</th><th></th></tr></thead>
        <tbody>{pol.data?.map((p) => (
          <tr key={p.id}><td>{p.name} {!p.active && <Badge>inativa</Badge>}</td>
            <td className="small">{p.applies_to === 'ticket' ? `Atendimentos${p.priority ? ` · prioridade ${PRIO[p.priority]}` : ''}${p.type_name ? ` · ${p.type_name}` : ''}` : `OS${p.kind ? ` · ${WO_KIND[p.kind]}` : ''}`}</td>
            <td>{fmtMin(p.resolution_minutes)}</td><td className="small">{p.escalate_to_name ?? '—'}</td><td className="num">{p.in_use}</td>
            <td><div className="row" style={{ justifyContent: 'flex-end' }}>
              <ActionButton className="sm" onClick={async () => { await api(`/sla-policies/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); pol.reload(); }}>{p.active ? 'Desativar' : 'Ativar'}</ActionButton>
              {p.in_use === 0 && <ActionButton className="sm danger" confirm="Excluir esta política?" onClick={async () => { await api(`/sla-policies/${p.id}`, { method: 'DELETE' }); pol.reload(); }}>Excluir</ActionButton>}
            </div></td></tr>
        ))}</tbody></table>
    </State>
    <Card title="Cumprimento (todas as ocorrências com política)">
      <State loading={rep.loading && !rep.data} error={rep.error} empty={rep.data?.rows.length === 0} emptyText="Sem ocorrências com SLA ainda.">
        <table><thead><tr><th>Política</th><th className="num">Total</th><th className="num">No prazo</th><th className="num">Fora do prazo</th><th className="num">Em andamento</th><th className="num">Tempo médio</th></tr></thead>
          <tbody>{rep.data?.rows.map((r: any) => (
            <tr key={r.policy_id}><td>{r.name}</td><td className="num">{r.total}</td><td className="num">{r.within}</td>
              <td className="num">{r.breached > 0 ? <Badge tone="red">{r.breached}</Badge> : 0}</td><td className="num">{r.open_ok}</td><td className="num">{r.avg_minutes ? fmtMin(r.avg_minutes) : '—'}</td></tr>
          ))}</tbody></table>
      </State>
    </Card>
  </>);
}

function Satisfacao() {
  const sv = useLoad<any>('/surveys');
  const s = sv.data?.summary;
  return (
    <State loading={sv.loading && !sv.data} error={sv.error}>
      {s && (
        <div className="grid2" style={{ marginBottom: 10 }}>
          <Card><div className="stat"><b>{s.average ? s.average.toFixed(1) : '—'}</b><span>nota média (de 5)</span></div></Card>
          <Card><div className="stat"><b>{s.answered}/{s.sent}</b><span>respondidas{s.answered ? ` · ${Math.round((s.satisfied / s.answered) * 100)}% notas 4–5` : ''}</span></div></Card>
        </div>
      )}
      <State empty={sv.data?.rows.length === 0} emptyText="Nenhuma pesquisa ainda. Elas nascem quando uma OS é concluída.">
        <table><thead><tr><th>OS</th><th>Assinante</th><th>Técnico</th><th>Nota</th><th>Comentário</th></tr></thead>
          <tbody>{sv.data?.rows.map((r: any) => (
            <tr key={r.id}><td>#{r.work_order_number} <span className="small muted">{WO_KIND[r.kind]}</span></td><td>{r.subscriber_name}</td><td className="small">{r.assignee_name ?? '—'}</td>
              <td>{r.status === 'answered' ? <Badge tone={r.score >= 4 ? 'green' : r.score === 3 ? 'amber' : 'red'}>{r.score}</Badge> : <Badge>{r.status === 'expired' ? 'expirada' : 'aguardando'}</Badge>}</td>
              <td className="small">{r.comment ?? ''}</td></tr>
          ))}</tbody></table>
      </State>
    </State>
  );
}
