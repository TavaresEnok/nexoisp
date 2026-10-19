import { useState } from 'react';
import { api, money, useLoad } from '../api';
import { ActionButton, Badge, Card, Field, Form, Page, State } from '../ui';

const KIND: Record<string, string> = {
  ticket_type: 'Tipo de ocorrência', classification: 'Classificação', root_cause: 'Causa-raiz', origin: 'Origem', os_reason: 'Motivo de OS',
  end_reason: 'Motivo de encerramento de contrato', note_type: 'Tipo de anotação',
};
const WO_KIND: Record<string, string> = { install: 'Instalação', repair: 'Reparo', address_change: 'Mudança de endereço', removal: 'Retirada', other: 'Outro' };
const PRIO: Record<string, string> = { low: 'baixa', normal: 'normal', high: 'alta' };
const fmtMin = (m: number) => (m >= 1440 ? `${(m / 1440).toFixed(m % 1440 ? 1 : 0)} d` : m >= 60 ? `${(m / 60).toFixed(m % 60 ? 1 : 0)} h` : `${m} min`);

/** Catálogos de ocorrência, políticas de SLA e pesquisa de satisfação. */
export function Qualidade() {
  const [tab, setTab] = useState<'catalogos' | 'sla' | 'satisfacao' | 'campos' | 'kits' | 'comissao'>('catalogos');
  const tabs: [typeof tab, string][] = [['catalogos', 'Catálogos'], ['sla', 'SLA'], ['satisfacao', 'Satisfação'], ['campos', 'Campos personalizados'], ['kits', 'Kits de instalação'], ['comissao', 'Comissões']];
  return (
    <Page title="Catálogos, SLA e satisfação">
      <div className="row" role="tablist" style={{ marginBottom: 10 }}>
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'catalogos' && <Catalogos />}
      {tab === 'sla' && <Sla />}
      {tab === 'satisfacao' && <Satisfacao />}
      {tab === 'campos' && <Campos />}
      {tab === 'kits' && <Kits />}
      {tab === 'comissao' && <Comissoes />}
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

const FTYPE: Record<string, string> = { text: 'Texto', number: 'Número', date: 'Data', boolean: 'Sim/não', select: 'Seleção' };

function Campos() {
  const list = useLoad<any[]>('/custom-fields?all=1');
  const [f, setF] = useState<any>(null);
  return (<>
    <div className="row" style={{ marginBottom: 8 }}><button className="primary" onClick={() => setF({ entity: 'subscriber', key: '', label: '', type: 'text', options: '', required: false })}>Novo campo</button></div>
    {f && (
      <Card title="Novo campo">
        <Form submit="Criar campo" onCancel={() => setF(null)} onSubmit={async () => {
          await api('/custom-fields', { body: { entity: f.entity, key: f.key, label: f.label, type: f.type, required: f.required,
            options: f.type === 'select' ? f.options.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined } });
          setF(null); list.reload();
        }}>
          <div className="cols3">
            <Field label="Onde"><select value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })}><option value="subscriber">Assinante</option><option value="contract">Contrato</option></select></Field>
            <Field label="Nome do campo"><input value={f.label} minLength={2} maxLength={60} onChange={(e) => setF({ ...f, label: e.target.value })} required /></Field>
            <Field label="Identificador" hint="Minúsculas, números e _. Não muda depois."><input value={f.key} pattern="[a-z][a-z0-9_]{1,29}" onChange={(e) => setF({ ...f, key: e.target.value })} required /></Field>
          </div>
          <div className="cols3">
            <Field label="Tipo"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(FTYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            {f.type === 'select' && <Field label="Opções (separadas por vírgula)"><input value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} required /></Field>}
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> obrigatório</label>
          </div>
        </Form>
      </Card>
    )}
    <State loading={list.loading && !list.data} error={list.error} empty={list.data?.length === 0} emptyText="Nenhum campo personalizado.">
      <table><thead><tr><th>Campo</th><th>Onde</th><th>Tipo</th><th></th></tr></thead>
        <tbody>{list.data?.map((x) => (
          <tr key={x.id}><td>{x.label} <span className="small muted mono">{x.key}</span> {x.required && <Badge tone="amber">obrigatório</Badge>} {!x.active && <Badge>inativo</Badge>}</td>
            <td>{x.entity === 'subscriber' ? 'Assinante' : 'Contrato'}</td><td className="small">{FTYPE[x.type]}{x.options ? `: ${x.options.join(', ')}` : ''}</td>
            <td><ActionButton className="sm" onClick={async () => { await api(`/custom-fields/${x.id}`, { method: 'PATCH', body: { active: !x.active } }); list.reload(); }}>{x.active ? 'Desativar' : 'Ativar'}</ActionButton></td></tr>
        ))}</tbody></table>
    </State>
  </>);
}

function Kits() {
  const kits = useLoad<any[]>('/install-kits');
  const items = useLoad<any[]>('/stock/items');
  const [f, setF] = useState<any>(null);
  return (<>
    <div className="row" style={{ marginBottom: 8 }}><button className="primary" onClick={() => setF({ name: '', rows: [{ item_id: '', qty: '1' }] })}>Novo kit</button></div>
    {f && (
      <Card title="Novo kit">
        <Form submit="Criar kit" onCancel={() => setF(null)} onSubmit={async () => {
          await api('/install-kits', { body: { name: f.name, items: f.rows.filter((r: any) => r.item_id).map((r: any) => ({ item_id: r.item_id, qty: Number(r.qty) })) } });
          setF(null); kits.reload();
        }}>
          <Field label="Nome"><input value={f.name} minLength={2} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          {f.rows.map((r: any, i: number) => (
            <div className="row" key={i}>
              <select aria-label="Item" style={{ flex: 1 }} value={r.item_id} onChange={(e) => setF({ ...f, rows: f.rows.map((x: any, j: number) => (j === i ? { ...x, item_id: e.target.value } : x)) })}>
                <option value="">Item do estoque…</option>{items.data?.filter((x) => x.active && !x.serialized).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
              <input aria-label="Quantidade" type="number" min="1" style={{ width: 90 }} value={r.qty} onChange={(e) => setF({ ...f, rows: f.rows.map((x: any, j: number) => (j === i ? { ...x, qty: e.target.value } : x)) })} />
            </div>
          ))}
          <button type="button" className="sm" onClick={() => setF({ ...f, rows: [...f.rows, { item_id: '', qty: '1' }] })}>Mais um item</button>
          <p className="small muted">Itens controlados por número de série não entram em kit.</p>
        </Form>
      </Card>
    )}
    <State loading={kits.loading && !kits.data} error={kits.error} empty={kits.data?.length === 0} emptyText="Nenhum kit.">
      <table><tbody>{kits.data?.map((k) => (
        <tr key={k.id}><td><b>{k.name}</b> {!k.active && <Badge>inativo</Badge>}<div className="small muted">{k.items.map((i: any) => `${i.qty} ${i.unit} ${i.name}`).join(' · ')}</div></td>
          <td><ActionButton className="sm" onClick={async () => { await api(`/install-kits/${k.id}`, { method: 'PATCH', body: { active: !k.active } }); kits.reload(); }}>{k.active ? 'Desativar' : 'Ativar'}</ActionButton></td></tr>
      ))}</tbody></table>
    </State>
  </>);
}

function Comissoes() {
  const rules = useLoad<any[]>('/commission-rules');
  const first = new Date(); first.setDate(1);
  const [range, setRange] = useState({ from: first.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
  const rep = useLoad<any>(`/reports/commissions?from=${range.from}&to=${range.to}`);
  const [f, setF] = useState<any>(null);
  const cents = (v: string) => Math.round(Number(String(v).replace(',', '.')) * 100);
  return (<>
    <div className="row" style={{ marginBottom: 8 }}><button className="primary" onClick={() => setF({ subject: 'work_order', os_kind: '', a: '', h: '0' })}>Nova regra</button></div>
    {f && (
      <Card title="Regra de comissão">
        <Form submit="Salvar regra" onCancel={() => setF(null)} onSubmit={async () => {
          await api('/commission-rules', { body: { subject: f.subject, os_kind: f.subject === 'work_order' && f.os_kind ? f.os_kind : null, assignee_cents: cents(f.a), helper_cents: f.subject === 'work_order' ? cents(f.h) : 0 } });
          setF(null); rules.reload(); rep.reload();
        }}>
          <div className="cols3">
            <Field label="Vale para"><select value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })}><option value="work_order">OS concluída</option><option value="sale">Prospecto ganho (venda)</option></select></Field>
            {f.subject === 'work_order' && <Field label="Natureza da OS"><select value={f.os_kind} onChange={(e) => setF({ ...f, os_kind: e.target.value })}><option value="">Qualquer</option>
              {Object.entries(WO_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>}
          </div>
          <div className="cols3">
            <Field label={f.subject === 'sale' ? 'Valor por venda (R$)' : 'Responsável (R$)'}><input inputMode="decimal" value={f.a} onChange={(e) => setF({ ...f, a: e.target.value })} required /></Field>
            {f.subject === 'work_order' && <Field label="Cada auxiliar (R$)"><input inputMode="decimal" value={f.h} onChange={(e) => setF({ ...f, h: e.target.value })} /></Field>}
          </div>
          <p className="small muted">A nova regra substitui a vigente do mesmo tipo.</p>
        </Form>
      </Card>
    )}
    <State empty={rules.data?.length === 0} emptyText="Nenhuma regra.">
      <table><tbody>{rules.data?.map((r) => (
        <tr key={r.id}><td>{r.subject === 'sale' ? 'Venda (prospecto ganho)' : `OS ${r.os_kind ? WO_KIND[r.os_kind] : '(qualquer natureza)'}`}</td>
          <td className="num">{money(r.assignee_cents)}</td><td className="small muted">{r.subject === 'work_order' ? `auxiliar ${money(r.helper_cents)}` : ''}</td></tr>
      ))}</tbody></table>
    </State>
    <Card title="Apuração do período">
      <div className="row" style={{ marginBottom: 8 }}>
        <input type="date" aria-label="De" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ width: 160 }} />
        <input type="date" aria-label="Até" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ width: 160 }} />
      </div>
      <State loading={rep.loading && !rep.data} error={rep.error} empty={rep.data?.rows.length === 0} emptyText="Nada a apurar no período.">
        <table><thead><tr><th>Pessoa</th><th className="num">OS (resp.)</th><th className="num">OS (aux.)</th><th className="num">Vendas</th><th className="num">Total</th></tr></thead>
          <tbody>{rep.data?.rows.map((r: any) => (
            <tr key={r.user_id}><td>{r.name}</td><td className="num">{r.os_assignee}</td><td className="num">{r.os_helper}</td><td className="num">{r.sales}</td><td className="num"><b>{money(r.total_cents)}</b></td></tr>
          ))}</tbody></table>
        {rep.data && <p className="small muted">Total {money(rep.data.total_cents)}. {rep.data.note}</p>}
      </State>
    </Card>
  </>);
}
