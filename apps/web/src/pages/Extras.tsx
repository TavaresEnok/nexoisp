import { useState } from 'react';
import { api, dt, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, Page, State } from '../ui';

const SEVERITY: Record<string, string> = { info: 'Informativo', degraded: 'Lentidão ou instabilidade', outage: 'Sem acesso' };
const STATE: Record<string, [string, 'blue' | 'amber' | 'green' | undefined]> = {
  scheduled: ['Agendada', 'blue'], active: ['Em andamento', 'amber'], ended: ['Encerrada', undefined], canceled: ['Cancelada', undefined],
};
// <input type="datetime-local"> -> ISO com o fuso do navegador
const toIso = (local: string) => new Date(local).toISOString();
const nowLocal = (offsetH = 0) => { const d = new Date(Date.now() + offsetH * 3600_000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** Avisos de manutenção: aparecem no portal dos assinantes atingidos (todos, ou quem usa o equipamento escolhido). */
export function Maintenance() {
  const { me } = useMe();
  const w = can(me, 'network:write');
  const list = useLoad<any[]>('/maintenance-notices', 10000);
  const devices = useLoad<any[]>('/devices');
  const [f, setF] = useState<any>(null);
  return (
    <Page title="Manutenções" actions={w && <button className="primary" onClick={() => setF({ title: '', message: '', severity: 'info', device_id: '', starts_at: nowLocal(1), ends_at: nowLocal(3) })}>Novo aviso</button>}>
      <p className="muted small">O aviso aparece no portal do assinante enquanto estiver em andamento e nos 7 dias anteriores ao início. Não envia SMS nem e-mail.</p>
      {f && (
        <Card title="Novo aviso de manutenção">
          <Form submit="Publicar aviso" onCancel={() => setF(null)} onSubmit={async () => {
            await api('/maintenance-notices', { body: { title: f.title, message: f.message, severity: f.severity, device_id: f.device_id || null,
              starts_at: toIso(f.starts_at), ends_at: toIso(f.ends_at) } });
            setF(null); list.reload();
          }}>
            <Field label="Título"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} maxLength={120} /></Field>
            <Field label="Mensagem ao assinante"><textarea rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} required minLength={3} maxLength={1000} /></Field>
            <div className="cols3">
              <Field label="Efeito esperado">
                <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{Object.entries(SEVERITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </Field>
              <Field label="Início"><input type="datetime-local" value={f.starts_at} onChange={(e) => setF({ ...f, starts_at: e.target.value })} required /></Field>
              <Field label="Fim"><input type="datetime-local" value={f.ends_at} onChange={(e) => setF({ ...f, ends_at: e.target.value })} required /></Field>
            </div>
            <Field label="Quem é atingido">
              <select value={f.device_id} onChange={(e) => setF({ ...f, device_id: e.target.value })}>
                <option value="">Todos os assinantes</option>
                {devices.data?.filter((d) => !d.driver.startsWith('olt')).map((d) => <option key={d.id} value={d.id}>Quem se conecta por {d.name}</option>)}
              </select>
            </Field>
          </Form>
        </Card>
      )}
      <State loading={list.loading && !list.data} error={list.error} empty={list.data?.length === 0}>
        <table>
          <thead><tr><th>Aviso</th><th>Quem</th><th>Período</th><th>Situação</th><th></th></tr></thead>
          <tbody>{list.data?.map((n) => {
            const [label, tone] = STATE[n.state];
            return (
              <tr key={n.id}>
                <td><b>{n.title}</b><div className="small muted">{SEVERITY[n.severity]} · {n.message}</div></td>
                <td>{n.device_name ? `Via ${n.device_name}` : 'Todos'} <span className="muted small">({n.affected_subscribers} assinante(s))</span></td>
                <td className="small">{dt(n.starts_at)}<br />até {dt(n.ends_at)}</td>
                <td><Badge tone={tone}>{label}</Badge></td>
                <td>{w && (n.state === 'scheduled' || n.state === 'active') && (
                  <ActionButton className="sm danger" confirm="Cancelar este aviso? Ele deixa de aparecer no portal." onClick={async () => { await api(`/maintenance-notices/${n.id}/cancel`, { method: 'POST' }); list.reload(); }}>Cancelar</ActionButton>)}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </State>
    </Page>
  );
}

/** Etiquetas do contrato: mostra e, para quem pode, edita o conjunto. */
export function ContractTags({ contract, onChange }: { contract: any; onChange: () => void }) {
  const { me } = useMe();
  const w = can(me, 'contracts:write');
  const all = useLoad<any[]>(w ? '/tags' : null);
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [fresh, setFresh] = useState('');
  const tags: any[] = contract.tags ?? [];
  if (!editing) {
    return (
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        {tags.map((t) => <Badge key={t.id}>{t.name}</Badge>)}
        {tags.length === 0 && <span className="muted small">sem etiquetas</span>}
        {w && <button className="sm" onClick={() => { setSel(tags.map((t) => t.id)); setEditing(true); }}>Editar etiquetas</button>}
      </div>
    );
  }
  const save = async (ids: string[]) => { await api(`/contracts/${contract.id}/tags`, { method: 'PUT', body: { tag_ids: ids } }); setEditing(false); onChange(); };
  return (
    <div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        {all.data?.map((t) => (
          <label key={t.id} className="row" style={{ gap: 4 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={sel.includes(t.id)} onChange={(e) => setSel(e.target.checked ? [...sel, t.id] : sel.filter((x) => x !== t.id))} /> {t.name}
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input style={{ maxWidth: 200 }} placeholder="Nova etiqueta" value={fresh} onChange={(e) => setFresh(e.target.value)} />
        <button disabled={fresh.trim().length < 2} onClick={async () => { const t = await api<any>('/tags', { body: { name: fresh.trim() } }); setFresh(''); setSel([...sel, t.id]); all.reload(); }}>Criar</button>
        <ActionButton className="primary" onClick={() => save(sel)}>Salvar</ActionButton>
        <button onClick={() => setEditing(false)}>Cancelar</button>
      </div>
    </div>
  );
}

/** Equipamentos instalados no contrato; contrato encerrado destaca o que precisa ser recolhido. */
export function ContractEquipment({ contractId }: { contractId: string }) {
  const { data } = useLoad<any>(`/contracts/${contractId}/equipment`);
  if (!data || data.units.length === 0) return null;
  return (
    <Card title="Equipamentos instalados">
      {data.to_recover.length > 0 && <div className="state err">Contrato encerrado com {data.to_recover.length} equipamento(s) em comodato para recolher: {data.to_recover.map((u: any) => u.serial).join(', ')}.</div>}
      <table>
        <thead><tr><th>Equipamento</th><th>Série</th><th>Modalidade</th><th>OS</th></tr></thead>
        <tbody>{data.units.map((u: any) => (
          <tr key={u.id}><td>{u.item_name}</td><td className="mono">{u.serial}</td>
            <td>{u.contract_mode === 'comodato' ? <Badge tone="blue">Comodato</Badge> : <Badge>Venda</Badge>}</td><td>{u.work_order_number ? `#${u.work_order_number}` : '—'}</td></tr>
        ))}</tbody>
      </table>
    </Card>
  );
}

/** Checklist da ordem de serviço. */
export function WorkOrderChecklist({ workOrder, writable, onChange }: { workOrder: any; writable: boolean; onChange: () => void }) {
  const [text, setText] = useState('');
  const items: any[] = workOrder.checklist ?? [];
  const done = items.filter((i) => i.done).length;
  return (
    <Card title={`Checklist${items.length ? ` (${done}/${items.length})` : ''}`}>
      <State empty={items.length === 0}>
        <table><tbody>{items.map((i) => (
          <tr key={i.id}>
            <td style={{ width: 30 }}><input type="checkbox" style={{ width: 'auto' }} disabled={!writable} checked={i.done}
              onChange={async (e) => { await api(`/work-orders/${workOrder.id}/checklist/${i.id}`, { body: { done: e.target.checked } }); onChange(); }} /></td>
            <td style={i.done ? { textDecoration: 'line-through', opacity: 0.7 } : undefined}>{i.label}</td>
            <td className="small muted">{i.done ? `${i.done_by_name ?? ''} ${dt(i.done_at)}` : ''}</td>
          </tr>))}</tbody></table>
      </State>
      {writable && (
        <div className="row" style={{ marginTop: 8 }}>
          <input style={{ flex: 1 }} placeholder="Novo item do checklist" value={text} onChange={(e) => setText(e.target.value)} />
          <ActionButton disabled={text.trim().length < 2} onClick={async () => { await api(`/work-orders/${workOrder.id}/checklist`, { body: { items: [text.trim()] } }); setText(''); onChange(); }}>Adicionar</ActionButton>
        </div>
      )}
    </Card>
  );
}
