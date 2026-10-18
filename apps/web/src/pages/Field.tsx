import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, dt, useLoad, usePaged } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, dialog, Field, Form, KV, Meter, Modal, Page, Pager, State, toastError } from '../ui';
import { WorkOrderChecklist } from './Extras';

export const WO_KIND: Record<string, string> = { install: 'Instalação', repair: 'Reparo', address_change: 'Mudança de endereço', removal: 'Retirada', other: 'Outro' };
const WO_STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'amber' | 'blue']> = {
  open: ['Aberta', 'amber'], analysis: ['Em análise', 'amber'], awaiting_schedule: ['Aguardando agendamento', 'amber'], scheduled: ['Agendada', 'blue'],
  en_route: ['Em deslocamento', 'blue'], in_progress: ['Em execução', 'blue'], done: ['Concluída', 'green'], canceled: ['Cancelada', 'gray'],
};
export const WoBadge = ({ status }: { status: string }) => <Badge tone={WO_STATUS[status]?.[1]}>{WO_STATUS[status]?.[0] ?? status}</Badge>;
const WO_EVENT: Record<string, string> = { created: 'Aberta', status: 'Situação', assigned: 'Responsável', scheduled: 'Agendamento', note: 'Anotação', material: 'Material', sla_breached: 'SLA vencido' };
const toLocal = (s?: string | null) => { if (!s) return ''; const x = new Date(s); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const toIso = (s: string) => (s ? new Date(s).toISOString() : null);

/** Aplicar kit de instalação e escolher técnicos auxiliares da OS. */
function KitAndHelpers({ workOrder, staff, onChange }: { workOrder: any; staff: any[]; onChange: () => void }) {
  const kits = useLoad<any[]>('/install-kits');
  const [kit, setKit] = useState('');
  const [helper, setHelper] = useState('');
  const active = kits.data?.filter((k) => k.active) ?? [];
  return (
    <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
      {active.length > 0 && (<>
        <select aria-label="Kit de instalação" value={kit} onChange={(e) => setKit(e.target.value)} style={{ width: 220 }}><option value="">Kit de instalação…</option>{active.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
        <ActionButton disabled={!kit} confirm="Baixar do estoque todos os itens do kit nesta OS?" onClick={async () => { await api(`/work-orders/${workOrder.id}/kit`, { body: { kit_id: kit } }); setKit(''); onChange(); }}>Aplicar kit</ActionButton>
      </>)}
      <select aria-label="Técnico auxiliar" value={helper} onChange={(e) => setHelper(e.target.value)} style={{ width: 200 }}><option value="">Auxiliar…</option>
        {staff.filter((u) => u.id !== workOrder.assignee_id && !workOrder.helpers?.some((h: any) => h.user_id === u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
      <ActionButton disabled={!helper} onClick={async () => { await api(`/work-orders/${workOrder.id}/helpers`, { body: { user_id: helper } }); setHelper(''); onChange(); }}>Adicionar auxiliar</ActionButton>
      {workOrder.helpers?.map((h: any) => (
        <Badge key={h.user_id}>{h.name} <button className="sm" aria-label={`Remover ${h.name}`} onClick={async () => { await api(`/work-orders/${workOrder.id}/helpers/${h.user_id}`, { method: 'DELETE' }); onChange(); }}>×</button></Badge>
      ))}
    </div>
  );
}

/** Busca de assinante + contrato, usada ao abrir OS e atendimento fora da ficha do assinante. */
export function SubscriberPick({ value, onChange }: { value: { subscriber_id: string; contract_id: string }; onChange: (v: { subscriber_id: string; contract_id: string }) => void }) {
  const [q, setQ] = useState('');
  const subs = useLoad<any[]>(q.length >= 2 ? `/subscribers?limit=20&q=${encodeURIComponent(q)}` : null);
  const detail = useLoad<any>(value.subscriber_id ? `/subscribers/${value.subscriber_id}` : null);
  return (
    <div className="cols3">
      <Field label="Assinante (busque pelo nome)"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="nome, CPF ou telefone…" autoFocus /></Field>
      <Field label="Selecione">
        <select value={value.subscriber_id} onChange={(e) => onChange({ subscriber_id: e.target.value, contract_id: '' })} required>
          <option value="">{subs.data ? (subs.data.length ? 'Selecione…' : 'nenhum encontrado') : '—'}</option>
          {subs.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Contrato (opcional)">
        <select value={value.contract_id} onChange={(e) => onChange({ ...value, contract_id: e.target.value })}>
          <option value="">—</option>
          {detail.data?.contracts.map((k: any) => <option key={k.id} value={k.id}>{k.plan_name}{k.status !== 'active' ? ' (encerrado)' : ''}</option>)}
        </select>
      </Field>
    </div>
  );
}

export function WorkOrderForm({ subscriberId, contractId, ticketId, onDone, onCancel }: { subscriberId?: string; contractId?: string; ticketId?: string; onDone: (w: any) => void; onCancel: () => void }) {
  const staff = useLoad<any[]>('/staff');
  const [who, setWho] = useState({ subscriber_id: subscriberId ?? '', contract_id: contractId ?? '' });
  const [f, setF] = useState({ kind: 'repair', description: '', assignee_id: '', scheduled_for: '', reason_id: '', address_origin: 'subscriber', address_text: '', estimated_minutes: '60' });
  const reasons = useLoad<any[]>('/catalogs?kind=os_reason');
  return (
    <Form submit="Abrir ordem de serviço" onCancel={onCancel} onSubmit={async () => {
      onDone(await api('/work-orders', { body: { ...f, ...who, contract_id: who.contract_id || null, assignee_id: f.assignee_id || null, scheduled_for: toIso(f.scheduled_for), ticket_id: ticketId ?? null,
        reason_id: f.reason_id || null, estimated_minutes: Number(f.estimated_minutes) || 60, address_text: f.address_origin === 'manual' ? f.address_text : null } }));
    }}>
      {!subscriberId && <SubscriberPick value={who} onChange={setWho} />}
      <div className="cols3">
        <Field label="Tipo"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(WO_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Responsável"><select value={f.assignee_id} onChange={(e) => setF({ ...f, assignee_id: e.target.value })}><option value="">— a definir —</option>{staff.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Agendar para"><input type="datetime-local" value={f.scheduled_for} onChange={(e) => setF({ ...f, scheduled_for: e.target.value })} /></Field>
      </div>
      <div className="cols3">
        <Field label="Motivo (catálogo)"><select value={f.reason_id} onChange={(e) => setF({ ...f, reason_id: e.target.value })}><option value="">—</option>{reasons.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label="Endereço do serviço"><select value={f.address_origin} onChange={(e) => setF({ ...f, address_origin: e.target.value })}>
          <option value="subscriber">Endereço do cadastro</option><option value="contract" disabled={!who.contract_id}>Instalação do contrato</option><option value="manual">Informar outro</option></select></Field>
        <Field label="Duração estimada (min)"><input type="number" min="5" max="1440" value={f.estimated_minutes} onChange={(e) => setF({ ...f, estimated_minutes: e.target.value })} /></Field>
      </div>
      {f.address_origin === 'manual' && <Field label="Endereço completo"><input value={f.address_text} onChange={(e) => setF({ ...f, address_text: e.target.value })} required minLength={5} maxLength={300} /></Field>}
      <Field label="O que precisa ser feito"><textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required /></Field>
    </Form>
  );
}

export function WorkOrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useMe();
  const { data: w, loading, error, reload } = useLoad<any>(`/work-orders/${id}`);
  const staff = useLoad<any[]>('/staff');
  const items = useLoad<any[]>(can(me, 'stock:read') ? '/stock/items' : null);
  const [res, setRes] = useState('');
  const [note, setNote] = useState('');
  const [mat, setMat] = useState({ item_id: '', qty: '1' });
  const [sn, setSn] = useState('');
  const found = useLoad<any[]>(can(me, 'stock:read') && sn.trim().length >= 3 ? `/stock/units?serial=${encodeURIComponent(sn.trim())}` : null);
  const write = can(me, 'os:write') && w && !['done', 'canceled'].includes(w.status);
  const status = (s: string, resolution?: string, reason?: string) => async () => { await api(`/work-orders/${id}/status`, { body: { status: s, resolution, reason } }); setRes(''); await reload(); };
  const patch = async (body: any) => { await api(`/work-orders/${id}`, { method: 'PATCH', body }); await reload(); };
  return (
    <Modal title={w ? `OS ${w.number} — ${WO_KIND[w.kind]}` : 'Ordem de serviço'} onClose={onClose} wide>
      <State loading={loading && !w} error={error}>
        {w && (<>
          <KV items={[
            ['Situação', <WoBadge status={w.status} />], ['Assinante', <Link to={`/assinantes/${w.subscriber_id}`}>{w.subscriber_name}</Link>], ['Telefone', w.subscriber_phone],
            ['Endereço', <>{w.service_address || '—'}{w.address_origin !== 'subscriber' && <span className="muted small"> ({w.address_origin === 'contract' ? 'instalação do contrato' : 'informado na OS'})</span>}</>], ['Contrato', w.contract_id ? <Link to={`/contratos/${w.contract_id}`}>abrir</Link> : '—'],
            ['Aberta', <>{dt(w.created_at)} <span className="muted small">por {w.created_by_name ?? 'sistema'}</span></>],
            ['Responsável', write ? <select aria-label="Responsável" value={w.assignee_id ?? ''} onChange={(e) => patch({ assignee_id: e.target.value || null }).catch((x) => toastError(x))}><option value="">— a definir —</option>{staff.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select> : w.assignee_name],
            ['Agendada para', write ? <input aria-label="Agendada para" type="datetime-local" defaultValue={toLocal(w.scheduled_for)} onBlur={(e) => { if (e.target.value !== toLocal(w.scheduled_for)) patch({ scheduled_for: toIso(e.target.value) }).catch((x) => toastError(x)); }} /> : dt(w.scheduled_for)],
          ]} />
          {(w.en_route_at || w.started_at || w.awaiting_reason || w.sla_due_at) && (
            <p className="small muted">
              {w.awaiting_reason && <>Aguardando: {w.awaiting_reason}. </>}
              {w.en_route_at && <>Saiu para o local {dt(w.en_route_at)}. </>}{w.started_at && <>Execução iniciada {dt(w.started_at)}. </>}
              {w.sla_due_at && <>Prazo (SLA): {dt(w.sla_due_at)}{w.sla_breached && <> <Badge tone="red">vencido</Badge></>}</>}
            </p>
          )}
          <p style={{ whiteSpace: 'pre-wrap' }}>{w.description}</p>
          {w.resolution && <div className="state" style={{ textAlign: 'left' }}><b>{w.status === 'canceled' ? 'Motivo do cancelamento' : 'O que foi feito'}:</b> {w.resolution}</div>}
          {write && (
            <div className="row" style={{ margin: '10px 0' }}>
              {w.status === 'open' && <ActionButton onClick={status('analysis')}>Em análise</ActionButton>}
              {['open', 'analysis', 'scheduled'].includes(w.status) && <ActionButton disabled={!res.trim()} title="Informe o motivo no campo ao lado" onClick={status('awaiting_schedule', undefined, res)}>Aguardando agendamento</ActionButton>}
              {['open', 'analysis', 'scheduled'].includes(w.status) && <ActionButton disabled={!w.assignee_id} title={w.assignee_id ? '' : 'Defina o responsável antes'} onClick={status('en_route')}>Saí para o local</ActionButton>}
              {w.status !== 'in_progress' && w.status !== 'awaiting_schedule' && <ActionButton className="primary" onClick={status('in_progress')}>Iniciar execução</ActionButton>}
              {w.status === 'in_progress' && <ActionButton onClick={status('open')}>Devolver para a fila</ActionButton>}
              <input aria-label="Resultado ou motivo da alteração da OS" style={{ flex: 1, minWidth: 220 }} value={res} onChange={(e) => setRes(e.target.value)} placeholder={w.status === 'in_progress' ? 'O que foi feito (para concluir) ou motivo (para cancelar)' : 'Motivo para aguardar agendamento ou cancelar'} />
              {w.status === 'in_progress' && <ActionButton className="primary" disabled={!res.trim()} onClick={status('done', res)}>Concluir</ActionButton>}
              <ActionButton className="danger" disabled={!res.trim()} confirm="Cancelar esta ordem de serviço?" onClick={status('canceled', res)}>Cancelar OS</ActionButton>
            </div>
          )}
          {write && <KitAndHelpers workOrder={w} staff={staff.data ?? []} onChange={reload} />}
          {!write && w.helpers?.length > 0 && <p className="small muted">Auxiliares: {w.helpers.map((h: any) => h.name).join(', ')}</p>}
          <WorkOrderChecklist workOrder={w} writable={!!write && !['done', 'canceled'].includes(w.status)} onChange={() => reload()} />
          <div className="grid2">
            <Card title="Material utilizado">
              <State empty={w.materials.length === 0}>
                <table><thead><tr><th>Item</th><th className="num">Qtd.</th><th>Por</th></tr></thead>
                  <tbody>{w.materials.map((m: any) => <tr key={m.id}><td>{m.item_name}</td><td className="num">{m.qty} {m.unit}</td><td className="small">{m.created_by_name}</td></tr>)}</tbody></table>
              </State>
              {write && items.data && (
                <div className="row" style={{ marginTop: 8 }}>
                  <select aria-label="Item do estoque" style={{ flex: 1 }} value={mat.item_id} onChange={(e) => setMat({ ...mat, item_id: e.target.value })}><option value="">Item do estoque…</option>
                    {items.data.filter((i) => i.active && !i.serialized).map((i) => <option key={i.id} value={i.id}>{i.name} (saldo {i.balance})</option>)}</select>
                  <input aria-label="Quantidade" style={{ width: 80 }} type="number" value={mat.qty} onChange={(e) => setMat({ ...mat, qty: e.target.value })} title="Negativo devolve ao estoque" />
                  <ActionButton disabled={!mat.item_id} onClick={async () => { await api(`/work-orders/${id}/materials`, { body: { item_id: mat.item_id, qty: Number(mat.qty) } }); await reload(); items.reload(); }}>Lançar</ActionButton>
                </div>
              )}
              {write && can(me, 'stock:read') && (
                <div style={{ marginTop: 8 }}>
                  <input className="mono" value={sn} onChange={(e) => setSn(e.target.value)} placeholder="Equipamento com série: digite o número…" />
                  {found.data?.filter((u) => ['in_stock', 'with_tech'].includes(u.status)).slice(0, 5).map((u) => (
                    <div key={u.id} className="row small" style={{ marginTop: 4 }}><span className="mono">{u.serial}</span><span>{u.item_name}</span><span className="muted">{u.holder_name ? `com ${u.holder_name}` : 'almoxarifado'}</span>
                      <ActionButton className="sm primary" onClick={async () => { await api(`/work-orders/${id}/units`, { body: { unit_id: u.id } }); setSn(''); await reload(); }}>Instalar</ActionButton></div>
                  ))}
                  {found.data && sn.trim().length >= 3 && !found.data.some((u) => ['in_stock', 'with_tech'].includes(u.status)) && <div className="small muted" style={{ marginTop: 4 }}>Nenhuma unidade disponível com essa série.</div>}
                </div>
              )}
            </Card>
            <Card title="Histórico">
              {can(me, 'os:write') && <div className="row" style={{ marginBottom: 8 }}>
                <input style={{ flex: 1 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anotação…" />
                <ActionButton disabled={!note.trim()} onClick={async () => { await api(`/work-orders/${id}/notes`, { body: { note } }); setNote(''); await reload(); }}>Anotar</ActionButton>
              </div>}
              <ul className="steps">{w.events.map((e: any, i: number) => (
                <li key={i}><span className="small muted" style={{ minWidth: 118 }}>{dt(e.at)}</span>
                  <span className="small"><b>{WO_EVENT[e.event] ?? e.event}</b>{' '}
                    {e.event === 'status' ? <>{WO_STATUS[e.detail.from]?.[0]} → {WO_STATUS[e.detail.to]?.[0]}</> : e.event === 'assigned' ? (e.detail.to ?? 'sem responsável') : e.event === 'scheduled' ? dt(e.detail.for)
                      : e.event === 'note' ? e.detail.note : e.event === 'material' ? `${e.detail.item} × ${e.detail.qty}` : ''} <span className="muted">· {e.actor_name ?? 'sistema'}</span></span></li>
              ))}</ul>
            </Card>
          </div>
        </>)}
      </State>
    </Modal>
  );
}

/** Lista de OS; com `subscriberId`/`contractId` vira o cartão da ficha. */
export function WorkOrderList({ subscriberId, contractId }: { subscriberId?: string; contractId?: string }) {
  const { me } = useMe();
  const [status, setStatus] = useState(subscriberId ? '' : 'pending');
  const [q, setQ] = useState('');
  const [mine, setMine] = useState(false);
  const p = new URLSearchParams();
  if (status) p.set('status', status);
  if (q) p.set('q', q);
  if (mine) p.set('mine', '1');
  if (contractId) p.set('contract_id', contractId); else if (subscriberId) p.set('subscriber_id', subscriberId);
  const list = usePaged<any>(`/work-orders?${p}`);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const w = can(me, 'os:write');
  const table = (
    <State loading={list.loading && !list.data} error={list.error} empty={list.data?.length === 0}>
      <table>
        <thead><tr><th>OS</th><th>Tipo</th>{!subscriberId && <th>Assinante</th>}<th>Situação</th><th>Agendada</th><th>Responsável</th><th>Descrição</th><th></th></tr></thead>
        <tbody>{list.data?.map((o) => (
          <tr key={o.id}><td className="mono">{o.number}</td><td>{WO_KIND[o.kind]}</td>{!subscriberId && <td><Link to={`/assinantes/${o.subscriber_id}`}>{o.subscriber_name}</Link></td>}
            <td><WoBadge status={o.status} /></td>
            <td className="small">{o.scheduled_for ? <>{dt(o.scheduled_for)} {['open', 'analysis', 'scheduled', 'en_route'].includes(o.status) && new Date(o.scheduled_for) < new Date() && <Badge tone="red">vencida</Badge>}</> : '—'}</td>
            <td className="small">{o.assignee_name ?? '—'}</td><td className="small" style={{ maxWidth: 320 }}>{o.description.slice(0, 90)}</td>
            <td><button className="sm" onClick={() => setOpen(o.id)}>abrir</button></td></tr>
        ))}</tbody>
      </table>
      <Pager p={list} />
    </State>
  );
  const modals = (<>
    {open && <WorkOrderDetail id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    {adding && <Modal title="Nova ordem de serviço" onClose={() => setAdding(false)} wide><WorkOrderForm subscriberId={subscriberId} contractId={contractId} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); list.reload(); }} /></Modal>}
  </>);
  if (subscriberId) return <Card title="Ordens de serviço" actions={w && <button onClick={() => setAdding(true)}>Nova OS</button>}>{table}{modals}</Card>;
  return (
    <Page title="Ordens de serviço" actions={w && <button className="primary" onClick={() => setAdding(true)}>Nova ordem de serviço</button>}>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Assinante, descrição ou número…" />
        <select aria-label="Filtrar por situação" style={{ width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">Em aberto</option><option value="">Todas</option>{Object.entries(WO_STATUS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}
        </select>
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={mine} onChange={(e) => setMine(e.target.checked)} /> só as minhas</label>
        <ActionButton className="sm" onClick={() => download(`/work-orders?${p}&format=csv&limit=5000`, 'ordens-de-servico.csv')}>Exportar CSV</ActionButton>
      </div>
      {table}{modals}
    </Page>
  );
}
export const WorkOrders = () => <WorkOrderList />;

/** Modo de campo: as OS do técnico em cartões grandes, para o celular. Precisa de conexão; não funciona sem sinal. */
export function MyWork() {
  const list = useLoad<any[]>('/work-orders?status=pending&mine=1&limit=50', 30000);
  const [open, setOpen] = useState<string | null>(null);
  const map = (o: any) => `https://www.openstreetmap.org/search?query=${encodeURIComponent(o.subscriber_address)}`;
  return (
    <Page title="Meu trabalho">
      <State loading={list.loading && !list.data} error={list.error}>
        {list.data?.length === 0 && <div className="state">Nenhuma ordem de serviço em aberto atribuída a você.</div>}
        <div className="work">{list.data?.map((o) => (
          <section key={o.id} className="card">
            <header><h3>OS {o.number} · {WO_KIND[o.kind]}</h3><WoBadge status={o.status} /></header>
            <div style={{ fontSize: 16 }}><b>{o.subscriber_name}</b></div>
            {o.subscriber_address && <div>{o.subscriber_address} · <a href={map(o)} target="_blank" rel="noreferrer">mapa</a></div>}
            {o.subscriber_phone && <div><a href={`tel:${o.subscriber_phone}`}>{o.subscriber_phone}</a></div>}
            {o.scheduled_for && <div className="small">Agendada: {dt(o.scheduled_for)} {['open', 'analysis', 'scheduled', 'en_route'].includes(o.status) && new Date(o.scheduled_for) < new Date() && <Badge tone="red">vencida</Badge>}</div>}
            <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>{o.description}</p>
            <button className="primary big" onClick={() => setOpen(o.id)}>{o.status === 'in_progress' ? 'Continuar atendimento' : 'Abrir'}</button>
          </section>
        ))}</div>
      </State>
      {open && <WorkOrderDetail id={open} onClose={() => { setOpen(null); list.reload(); }} />}
    </Page>
  );
}

// ---- Estoque ----
const MOVE: Record<string, string> = { in: 'Entrada', out: 'Saída', adjust: 'Ajuste' };

function ItemForm({ item, onDone, onCancel }: { item?: any; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: item?.name ?? '', sku: item?.sku ?? '', unit: item?.unit ?? 'un', min_qty: String(item?.min_qty ?? 0), serialized: !!item?.serialized });
  return (
    <Form onCancel={onCancel} onSubmit={async () => { await api(item ? `/stock/items/${item.id}` : '/stock/items', { method: item ? 'PATCH' : 'POST', body: { ...f, sku: f.sku || null, min_qty: Number(f.min_qty) } }); onDone(); }}>
      <Field label="Item"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus /></Field>
      <div className="cols3">
        <Field label="Código (opcional)"><input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
        <Field label="Unidade" hint="un, m, cx…"><input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} required /></Field>
        <Field label="Estoque mínimo"><input type="number" min="0" value={f.min_qty} onChange={(e) => setF({ ...f, min_qty: e.target.value })} required /></Field>
      </div>
      <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.serialized} onChange={(e) => setF({ ...f, serialized: e.target.checked })} />
        <span>Controlar por número de série (ONU, roteador): cada unidade é rastreada individualmente</span></label>
      <p className="small muted" style={{ marginTop: 2 }}>Não pode ser alterado depois do primeiro movimento.</p>
    </Form>
  );
}

function Movements({ item, write, onClose }: { item: any; write: boolean; onClose: () => void }) {
  const list = useLoad<any[]>(`/stock/items/${item.id}/movements`);
  const [f, setF] = useState({ kind: 'in', qty: '', note: '' });
  return (
    <Modal title={`Movimentos — ${item.name}`} onClose={onClose} wide>
      {item.serialized && <p className="small muted">Item controlado por número de série: entradas, instalações e baixas são feitas em “Unidades”.</p>}
      {write && !item.serialized && (
        <Form submit="Lançar movimento" onSubmit={async () => { await api(`/stock/items/${item.id}/movements`, { body: { kind: f.kind, qty: Number(f.qty), note: f.note || null } }); setF({ ...f, qty: '', note: '' }); list.reload(); }}>
          <div className="cols3">
            <Field label="Tipo"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(MOVE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Quantidade" hint={f.kind === 'adjust' ? 'Diferença com sinal: -2 retira, 3 acrescenta.' : 'Sempre positiva.'}><input type="number" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} required /></Field>
            <Field label={f.kind === 'adjust' ? 'Justificativa (obrigatória)' : 'Observação'}><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} required={f.kind === 'adjust'} /></Field>
          </div>
        </Form>
      )}
      <p className="small muted">Movimentos não são alterados nem apagados: um lançamento errado é corrigido com um ajuste.</p>
      <State loading={list.loading} error={list.error} empty={list.data?.length === 0}>
        <table><thead><tr><th>Quando</th><th>Tipo</th><th className="num">Qtd.</th><th>Observação</th><th>Por</th></tr></thead>
          <tbody>{list.data?.map((m) => <tr key={m.id}><td className="small">{dt(m.created_at)}</td><td>{MOVE[m.kind]}</td><td className="num" style={{ color: m.qty < 0 ? 'var(--red)' : 'var(--green)' }}>{m.qty > 0 ? `+${m.qty}` : m.qty}</td>
            <td className="small">{m.note ?? '—'}</td><td className="small">{m.created_by_name ?? '—'}</td></tr>)}</tbody></table>
      </State>
    </Modal>
  );
}

const UNIT_STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'amber' | 'blue']> = {
  in_stock: ['No almoxarifado', 'green'], with_tech: ['Com técnico', 'blue'], installed: ['Instalada', 'gray'], defective: ['Com defeito', 'amber'], written_off: ['Baixada', 'red'],
};
const UNIT_EVENT: Record<string, string> = { received: 'Entrada', to_tech: 'Entregue ao técnico', to_stock: 'Voltou ao almoxarifado', installed: 'Instalada', returned: 'Retirada do assinante', defective: 'Marcada com defeito', written_off: 'Baixada' };

/** Unidades de um item com número de série: onde está cada uma e com quem. */
function Units({ item, write, onClose }: { item: any; write: boolean; onClose: () => void }) {
  const list = useLoad<any[]>(`/stock/items/${item.id}/units`);
  const staff = useLoad<any[]>('/staff');
  const [serials, setSerials] = useState('');
  const [hist, setHist] = useState<any>(null);
  const events = useLoad<any[]>(hist ? `/stock/units/${hist.id}/events` : null);
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); list.reload(); } catch (e: any) { toastError(e); } };
  return (
    <Modal title={`Unidades — ${item.name}`} onClose={onClose} wide>
      {write && (
        <Form submit="Dar entrada" onSubmit={async () => {
          const s = serials.split(/[\s,;]+/).filter(Boolean);
          if (!s.length) throw new Error('Informe ao menos um número de série');
          await api(`/stock/items/${item.id}/units`, { body: { serials: s } }); setSerials(''); list.reload();
        }}>
          <Field label="Números de série para entrada" hint="Um por linha, ou separados por espaço ou vírgula."><textarea rows={2} className="mono" value={serials} onChange={(e) => setSerials(e.target.value)} /></Field>
        </Form>
      )}
      <State loading={list.loading} error={list.error} empty={list.data?.length === 0}>
        <table>
          <thead><tr><th>Série</th><th>Situação</th><th>Onde</th><th></th></tr></thead>
          <tbody>{list.data?.map((u) => (
            <tr key={u.id}><td className="mono">{u.serial}</td><td><Badge tone={UNIT_STATUS[u.status][1]}>{UNIT_STATUS[u.status][0]}</Badge></td>
              <td className="small">{u.status === 'with_tech' ? u.holder_name : u.status === 'installed' ? <><Link to={`/contratos/${u.contract_id}`}>{u.subscriber_name}</Link>{u.work_order_number && ` · OS ${u.work_order_number}`}</> : '—'}</td>
              <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                {write && ['in_stock', 'with_tech'].includes(u.status) && (
                  <select aria-label={`Onde está ${u.serial}`} style={{ width: 170 }} value={u.holder_id ?? ''} onChange={(e) => run(() => api(`/stock/units/${u.id}/transfer`, { body: { holder_id: e.target.value || null } }))}>
                    <option value="">Almoxarifado</option>{staff.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>)}
                {write && u.status === 'installed' && <button className="sm" onClick={async () => (await dialog.confirm(`Registrar a retirada de ${u.serial} do assinante?`, { action: 'Registrar retirada' })) && run(() => api(`/stock/units/${u.id}/status`, { body: { status: 'in_stock' } }))}>Retirada</button>}
                {write && ['in_stock', 'with_tech', 'installed'].includes(u.status) && <button className="sm" onClick={() => run(() => api(`/stock/units/${u.id}/status`, { body: { status: 'defective' } }))}>Defeito</button>}
                {write && u.status === 'defective' && <button className="sm" onClick={() => run(() => api(`/stock/units/${u.id}/status`, { body: { status: 'in_stock' } }))}>Consertada</button>}
                {write && u.status !== 'written_off' && <button className="sm danger" onClick={async () => { const note = await dialog.prompt(`Dar baixa em ${u.serial}? A unidade sai do saldo e não volta ao estoque.`, { label: 'Motivo da baixa', action: 'Dar baixa' }); if (note) run(() => api(`/stock/units/${u.id}/status`, { body: { status: 'written_off', note } })); }}>Baixar</button>}
                <button className="sm" onClick={() => setHist(u)}>histórico</button>
              </div></td></tr>
          ))}</tbody>
        </table>
      </State>
      {hist && <Modal title={`Histórico — ${hist.serial}`} onClose={() => setHist(null)}>
        <ul className="steps">{events.data?.map((e, i) => <li key={i} className="small"><span className="muted" style={{ minWidth: 118 }}>{dt(e.at)}</span>
          <span><b>{UNIT_EVENT[e.event] ?? e.event}</b> {e.detail.to ?? ''}{e.detail.work_order ? `OS ${e.detail.work_order}` : ''}{e.detail.note ? `(${e.detail.note})` : ''} <span className="muted">· {e.actor_name ?? 'sistema'}</span></span></li>)}</ul>
      </Modal>}
    </Modal>
  );
}

export function Stock() {
  const { me } = useMe();
  const w = can(me, 'stock:write');
  const { data, loading, error, reload } = useLoad<any[]>('/stock/items');
  const [modal, setModal] = useState<{ kind: 'new' | 'edit' | 'moves' | 'units'; item?: any } | null>(null);
  const close = () => { setModal(null); reload(); };
  return (
    <Page title="Estoque" actions={w && <button className="primary" onClick={() => setModal({ kind: 'new' })}>Novo item</button>}>
      <State loading={loading} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>Item</th><th>Código</th><th className="num">Saldo</th><th className="num">Mínimo</th><th>Situação</th><th></th></tr></thead>
          <tbody>{data?.map((i) => (
            <tr key={i.id}><td>{i.name} {i.serialized && <Badge tone="blue">com série</Badge>}</td><td className="mono">{i.sku ?? '—'}</td><td className="num"><b>{i.balance}</b> {i.unit}{i.with_tech > 0 && <div className="small muted">{i.with_tech} com técnico</div>}</td><td className="num">{i.min_qty}</td>
              <td>{!i.active ? <Badge>Inativo</Badge> : i.low ? <Badge tone="red">Abaixo do mínimo</Badge> : <Badge tone="green">OK</Badge>}</td>
              <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                {i.serialized && <button className="sm primary" onClick={() => setModal({ kind: 'units', item: i })}>Unidades</button>}
                <button className="sm" onClick={() => setModal({ kind: 'moves', item: i })}>Movimentos</button>
                {w && <button className="sm" onClick={() => setModal({ kind: 'edit', item: i })}>Editar</button>}
                {w && <ActionButton className="sm" onClick={async () => { await api(`/stock/items/${i.id}`, { method: 'PATCH', body: { active: !i.active } }); reload(); }}>{i.active ? 'Desativar' : 'Ativar'}</ActionButton>}
              </div></td></tr>
          ))}</tbody>
        </table>
      </State>
      {modal?.kind === 'new' && <Modal title="Novo item de estoque" onClose={() => setModal(null)}><ItemForm onCancel={() => setModal(null)} onDone={close} /></Modal>}
      {modal?.kind === 'edit' && <Modal title="Editar item" onClose={() => setModal(null)}><ItemForm item={modal.item} onCancel={() => setModal(null)} onDone={close} /></Modal>}
      {modal?.kind === 'moves' && <Movements item={modal.item} write={w} onClose={close} />}
      {modal?.kind === 'units' && <Units item={modal.item} write={w} onClose={close} />}
    </Page>
  );
}

// ---- FTTH ----
const BOX_KIND: Record<string, string> = { cto: 'CTO (atendimento)', ceo: 'CEO (emenda)' };

function BoxForm({ box, boxes, onDone, onCancel }: { box?: any; boxes: any[]; onDone: () => void; onCancel: () => void }) {
  const devices = useLoad<any[]>('/devices');
  const [f, setF] = useState({ name: box?.name ?? '', kind: box?.kind ?? 'cto', ports: String(box?.ports ?? 8), parent_id: box?.parent_id ?? '', device_id: box?.device_id ?? '',
    pon_port: box?.pon_port ?? '', address: box?.address ?? '', latitude: box?.latitude ?? '', longitude: box?.longitude ?? '', notes: box?.notes ?? '' });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Form onCancel={onCancel} onSubmit={async () => {
      await api(box ? `/ftth/boxes/${box.id}` : '/ftth/boxes', { method: box ? 'PATCH' : 'POST', body: { ...f, ports: Number(f.ports), parent_id: f.parent_id || null, device_id: f.device_id || null,
        latitude: f.latitude === '' ? null : Number(f.latitude), longitude: f.longitude === '' ? null : Number(f.longitude) } });
      onDone();
    }}>
      <div className="cols3">
        <Field label="Identificação"><input value={f.name} onChange={set('name')} required autoFocus /></Field>
        <Field label="Tipo"><select value={f.kind} onChange={set('kind')}>{Object.entries(BOX_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Portas"><input type="number" min="1" max="144" value={f.ports} onChange={set('ports')} required /></Field>
      </div>
      <div className="cols3">
        <Field label="Caixa anterior"><select value={f.parent_id} onChange={set('parent_id')}><option value="">— nenhuma —</option>{boxes.filter((b) => b.id !== box?.id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="OLT"><select value={f.device_id} onChange={set('device_id')}><option value="">—</option>{devices.data?.filter((d) => d.driver.startsWith('olt')).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="Porta PON" hint="Ex.: 0/1/3"><input className="mono" value={f.pon_port} onChange={set('pon_port')} /></Field>
      </div>
      <Field label="Endereço / referência"><input value={f.address} onChange={set('address')} /></Field>
      <div className="cols3">
        <Field label="Observações"><input value={f.notes} onChange={set('notes')} /></Field>
        <Field label="Latitude"><input value={f.latitude} onChange={set('latitude')} inputMode="decimal" /></Field>
        <Field label="Longitude"><input value={f.longitude} onChange={set('longitude')} inputMode="decimal" /></Field>
      </div>
    </Form>
  );
}

function BoxPorts({ id, write, onClose }: { id: string; write: boolean; onClose: () => void }) {
  const { data: b, loading, error, reload } = useLoad<any>(`/ftth/boxes/${id}`);
  const [port, setPort] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const contracts = useLoad<any[]>(q.length >= 2 ? `/contracts?status=active&limit=20&q=${encodeURIComponent(q)}` : null);
  const [f, setF] = useState({ contract_id: '', note: '' });
  const byPort = new Map<number, any>(b?.drops.map((x: any) => [x.port, x]));
  return (
    <Modal title={b ? `${b.name} — ${b.used} de ${b.ports} portas ocupadas` : 'Caixa'} onClose={onClose} wide>
      <State loading={loading && !b} error={error}>
        {b && (<>
          <KV items={[['Tipo', BOX_KIND[b.kind]], ['Caixa anterior', b.parent_name], ['OLT / PON', b.device_name ? `${b.device_name} · ${b.pon_port ?? '—'}` : '—'], ['Endereço', b.address],
            ['Coordenadas', b.latitude != null ? <a href={`https://www.openstreetmap.org/?mlat=${b.latitude}&mlon=${b.longitude}#map=18/${b.latitude}/${b.longitude}`} target="_blank" rel="noreferrer">{b.latitude}, {b.longitude}</a> : '—']]} />
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Porta</th><th>Ocupação</th><th></th></tr></thead>
            <tbody>{Array.from({ length: b.ports }, (_, i) => i + 1).map((n) => { const x = byPort.get(n); return (
              <tr key={n}><td className="mono">{n}</td>
                <td>{x ? (x.contract_id ? <Link to={`/contratos/${x.contract_id}`}>{x.subscriber_name}</Link> : <span className="muted">reservada: {x.note}</span>) : <Badge tone="green">livre</Badge>}</td>
                <td>{write && (x
                  ? <ActionButton className="sm danger" confirm={`Liberar a porta ${n}?`} onClick={async () => { await api(`/ftth/drops/${x.id}`, { method: 'DELETE' }); reload(); }}>Liberar</ActionButton>
                  : <button className="sm" onClick={() => { setPort(n); setF({ contract_id: '', note: '' }); setQ(''); }}>Ocupar</button>)}</td></tr>); })}</tbody>
          </table>
          {port && (
            <Card title={`Ocupar a porta ${port}`}>
              <Form submit="Salvar" onCancel={() => setPort(null)} onSubmit={async () => { await api(`/ftth/boxes/${id}/drops`, { body: { port, contract_id: f.contract_id || null, note: f.note || null } }); setPort(null); reload(); }}>
                <div className="cols3">
                  <Field label="Contrato (busque pelo assinante)"><input value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></Field>
                  <Field label="Selecione"><select value={f.contract_id} onChange={(e) => setF({ ...f, contract_id: e.target.value })}><option value="">— reserva sem contrato —</option>
                    {contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.subscriber_name} — {k.plan_name}</option>)}</select></Field>
                  <Field label="Anotação" hint="Obrigatória na reserva."><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
                </div>
              </Form>
            </Card>
          )}
        </>)}
      </State>
    </Modal>
  );
}

/** Mapa esquemático: posição pelas coordenadas das caixas, sem mapa de fundo (nenhum dado sai para serviços de mapas). */
function FtthMap({ boxes, onOpen }: { boxes: any[]; onOpen: (b: any) => void }) {
  const pts = boxes.filter((b) => b.latitude != null && b.longitude != null).map((b) => ({ ...b, lat: Number(b.latitude), lng: Number(b.longitude) }));
  if (pts.length === 0) return <div className="state">Nenhuma caixa tem coordenadas. Informe latitude e longitude ao editar a caixa para vê-la aqui.</div>;
  const W = 1000, H = 560, pad = 60;
  const minLat = Math.min(...pts.map((p) => p.lat)), maxLat = Math.max(...pts.map((p) => p.lat)), minLng = Math.min(...pts.map((p) => p.lng)), maxLng = Math.max(...pts.map((p) => p.lng));
  // um grau de longitude encolhe com a latitude: sem a correção o desenho fica esticado
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = Math.max((maxLng - minLng) * k, 1e-5), spanY = Math.max(maxLat - minLat, 1e-5);
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const x = (p: any) => W / 2 + ((p.lng - (minLng + maxLng) / 2) * k) * scale, y = (p: any) => H / 2 - (p.lat - (minLat + maxLat) / 2) * scale;
  const byId = new Map(pts.map((p) => [p.id, p]));
  const color = (b: any) => (b.used >= b.ports ? 'var(--red)' : b.used / b.ports >= 0.8 ? '#c98a00' : 'var(--green)');
  const meters = Math.round((spanY * 111_320 * 200) / (spanY * scale));     // quantos metros valem 200 px
  return (
    <Card>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: '#f7fafc', borderRadius: 8 }}>
        {pts.filter((p) => byId.has(p.parent_id)).map((p) => <line key={`l${p.id}`} x1={x(p)} y1={y(p)} x2={x(byId.get(p.parent_id))} y2={y(byId.get(p.parent_id))} stroke="#9fb3c2" strokeWidth="2" />)}
        {pts.map((p) => (
          <g key={p.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(p)}>
            {p.kind === 'ceo' ? <rect x={x(p) - 9} y={y(p) - 9} width="18" height="18" fill={color(p)} stroke="#fff" strokeWidth="2" /> : <circle cx={x(p)} cy={y(p)} r="10" fill={color(p)} stroke="#fff" strokeWidth="2" />}
            <text x={x(p) + 14} y={y(p) + 4} fontSize="13" fill="#17202a">{p.name} ({p.used}/{p.ports})</text>
          </g>
        ))}
        <line x1={pad} y1={H - 24} x2={pad + 200} y2={H - 24} stroke="#64707d" strokeWidth="2" /><text x={pad} y={H - 30} fontSize="12" fill="#64707d">≈ {meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`}</text>
      </svg>
      <p className="small muted" style={{ marginBottom: 0 }}>● CTO · ■ CEO · verde: com portas livres · amarelo: 80% ou mais · vermelho: cheia. Linhas ligam cada caixa à anterior; não representam o trajeto real do cabo.
        {pts.length < boxes.length && ` ${boxes.length - pts.length} caixa(s) sem coordenadas não aparecem.`} Norte para cima. Clique numa caixa para ver as portas.</p>
    </Card>
  );
}

export function Ftth() {
  const { me } = useMe();
  const w = can(me, 'network:write');
  const { data, loading, error, reload } = useLoad<any[]>('/ftth/boxes');
  const [modal, setModal] = useState<{ kind: 'new' | 'edit' | 'ports'; box?: any } | null>(null);
  const [view, setView] = useState<'list' | 'map'>('list');
  const close = () => { setModal(null); reload(); };
  return (
    <Page title="Rede óptica (FTTH)" actions={<>
      <button className={view === 'list' ? 'primary' : ''} onClick={() => setView('list')}>Lista</button>
      <button className={view === 'map' ? 'primary' : ''} onClick={() => setView('map')}>Mapa</button>
      {w && <button onClick={() => setModal({ kind: 'new' })}>Nova caixa</button>}
    </>}>
      {view === 'map' && data && <FtthMap boxes={data} onOpen={(b) => setModal({ kind: 'ports', box: b })} />}
      <State loading={loading} error={error} empty={data?.length === 0}>
        <table style={{ display: view === 'list' ? undefined : 'none' }}>
          <thead><tr><th>Caixa</th><th>Tipo</th><th>Caixa anterior</th><th>OLT / PON</th><th>Endereço</th><th>Ocupação</th><th></th></tr></thead>
          <tbody>{data?.map((b) => (
            <tr key={b.id}><td>{b.name}</td><td className="small">{BOX_KIND[b.kind]}</td><td className="small">{b.parent_name ?? '—'}</td>
              <td className="small">{b.device_name ? `${b.device_name} · ${b.pon_port ?? '—'}` : '—'}</td><td className="small">{b.address ?? '—'}</td>
              <td><div className="row" style={{ flexWrap: 'nowrap' }}><Meter value={b.used} max={b.ports} /><span className="small" style={{ whiteSpace: 'nowrap' }}>{b.used} de {b.ports}</span></div></td>
              <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="sm" onClick={() => setModal({ kind: 'ports', box: b })}>Portas</button>
                {w && <button className="sm" onClick={() => setModal({ kind: 'edit', box: b })}>Editar</button>}
                {w && <ActionButton className="sm danger" confirm={`Excluir a caixa ${b.name}?`} onClick={async () => { await api(`/ftth/boxes/${b.id}`, { method: 'DELETE' }); reload(); }}>Excluir</ActionButton>}
              </div></td></tr>
          ))}</tbody>
        </table>
      </State>
      {(modal?.kind === 'new' || modal?.kind === 'edit') && <Modal title={modal.box ? `Editar ${modal.box.name}` : 'Nova caixa'} onClose={() => setModal(null)} wide><BoxForm box={modal.box} boxes={data ?? []} onCancel={() => setModal(null)} onDone={close} /></Modal>}
      {modal?.kind === 'ports' && <BoxPorts id={modal.box.id} write={w} onClose={close} />}
    </Page>
  );
}
