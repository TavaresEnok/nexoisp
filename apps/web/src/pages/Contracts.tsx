import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, d, doc, download, dt, money, speed, useLoad, usePaged } from '../api';
import { can, has, useMe } from '../App';
import { ActionButton, Badge, Card, dialog, Field, Form, KV, Modal, Page, Pager, State, Tabs } from '../ui';
import { Availability, ContractPop, ContractStates, CustomValues, Sessions } from './Atendimento';
import { ContractEquipment, ContractTags, ContractUsage } from './Extras';
import { AuthLog } from './Concentradores';
import { ContractConditions, useQuote } from './Condicoes';
import { ContractFinance } from './Finance';
import { ContractCompany } from './Empresas';
import { ContractAddons } from './Adicionais';
import { OnuPanel } from './Olt';
import { WorkOrderList } from './Field';
import { InfraPanel } from './Noc';
import { ServicePanel } from './Service';

const EVENT: Record<string, string> = { created: 'Contrato criado', plan_changed: 'Troca de plano', ended: 'Contrato encerrado', due_day_changed: 'Vencimento alterado', credit_restricted: 'Restrição de crédito', credit_released: 'Restrição de crédito retirada' };

export function ContractForm({ subscriberId, contract, onDone, onCancel }: { subscriberId?: string; contract?: any; onDone: () => void; onCancel: () => void }) {
  const plans = useLoad<any[]>('/plans');
  const [planId, setPlanId] = useState(contract?.plan_id ?? '');
  const [dueDay, setDueDay] = useState(String(contract?.due_day ?? 10));
  return (
    <Form onCancel={onCancel} onSubmit={async () => {
      if (!planId) throw new Error('Selecione um plano');
      if (contract) await api(`/contracts/${contract.id}`, { method: 'PATCH', body: { plan_id: planId, due_day: Number(dueDay) } });
      else await api('/contracts', { body: { subscriber_id: subscriberId, plan_id: planId, due_day: Number(dueDay) } });
      onDone();
    }}>
      <State loading={plans.loading} error={plans.error}>
        <Field label="Plano" hint={contract ? 'A troca usa a versão atual do plano escolhido e fica registrada no histórico.' : undefined}>
          <select value={planId} onChange={(e) => setPlanId(e.target.value)} required>
            <option value="">Selecione…</option>
            {plans.data?.filter((p) => p.active || p.id === contract?.plan_id).map((p) => (
              <option key={p.id} value={p.id}>{p.name} — {money(p.price_cents)} — {speed(p.down_kbps)}</option>
            ))}
          </select>
        </Field>
        <Field label="Dia de vencimento (1 a 28)"><input type="number" min="1" max="28" value={dueDay} onChange={(e) => setDueDay(e.target.value)} required /></Field>
      </State>
    </Form>
  );
}

export function Contracts() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const list = usePaged<any>(`/contracts?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`);
  const { data, loading, error } = list;
  return (
    <Page title="Contratos" actions={<>
      <input className="search" placeholder="Buscar por assinante ou plano…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select aria-label="Filtrar por situação" style={{ width: 150 }} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="active">Vigentes</option><option value="ended">Encerrados</option><option value="">Todos</option>
      </select>
      <ActionButton onClick={() => download(`/contracts?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}&format=csv&limit=5000`, 'contratos.csv')}>Exportar CSV</ActionButton>
    </>}>
      <p className="muted small">Novos contratos são criados a partir da ficha do assinante.</p>
      <State loading={loading && !data} error={error} empty={data?.length === 0}>
        <table>
          <thead><tr><th>Assinante</th><th>Plano</th><th>Velocidade</th><th className="num">Mensalidade</th><th>Vencimento</th><th>Situação comercial</th><th></th></tr></thead>
          <tbody>
            {data?.map((c) => (
              <tr key={c.id}>
                <td><Link to={`/assinantes/${c.subscriber_id}`}>{c.subscriber_name}</Link></td>
                <td>{c.plan_name} <span className="muted small">v{c.plan_version}</span>{(c.tags ?? []).map((t: any) => <> <Badge key={t.id}>{t.name}</Badge></>)}</td>
                <td>{speed(c.down_kbps)} / {speed(c.up_kbps)}</td>
                <td className="num">{money(c.price_cents)}</td>
                <td>dia {c.due_day}</td>
                <td>{c.status === 'active' ? <Badge tone="green">Vigente</Badge> : <Badge>Encerrado</Badge>}</td>
                <td><Link to={`/contratos/${c.id}`}>abrir</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      <Pager p={list} />
      </State>
    </Page>
  );
}

export function ContractDetail() {
  const { id } = useParams();
  const { me } = useMe();
  const { data: c, loading, error, reload } = useLoad<any>(`/contracts/${id}`);
  const [editing, setEditing] = useState(false);
  const [ending, setEnding] = useState<{ reason_id: string; note: string; penalty: string; waive: string } | null>(null);
  const quote = useQuote(String(id), !!ending);
  const [credit, setCredit] = useState<{ restricted: boolean; note: string } | null>(null);
  const reasons = useLoad<any[]>(ending ? '/catalogs?kind=end_reason' : null);
  const [tab, setTab] = useState('acesso');
  const w = can(me, 'contracts:write') && c?.status === 'active';
  const net = can(me, 'network:read');
  const tabs = [...(net ? [{ id: 'acesso', label: 'Acesso' }] : []), { id: 'contrato', label: 'Contrato' }, { id: 'condicoes', label: 'Condições' }, ...(can(me, 'os:read') && has(me, 'field') ? [{ id: 'os', label: 'Ordens de serviço' }] : []), { id: 'historico', label: 'Histórico', count: c?.history.length }];
  const cur = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  return (
    <Page title={c ? c.subscriber_name : 'Contrato'}
      sub={c && <span className="row">{c.plan_name}, {speed(c.down_kbps)}, {money(c.price_cents)} por mês {c.status === 'active' ? <Badge tone="green">Vigente</Badge> : <Badge>Encerrado em {d(c.end_date)}</Badge>}</span>}
      actions={w && <>
        <button onClick={() => setEditing(true)}>Trocar plano ou vencimento</button>
        {can(me, 'finance:write') && <button onClick={() => setCredit({ restricted: !c?.credit_restricted_at, note: '' })}>{c?.credit_restricted_at ? 'Retirar restrição de crédito' : 'Restrição de crédito'}</button>}
        <button className="danger" onClick={() => setEnding({ reason_id: '', note: '', penalty: 'charge', waive: '' })}>Encerrar contrato</button>
      </>}>
      <State loading={loading} error={error}>
        {c && (<>
          <ContractStates contract={c} />
          <Tabs tabs={tabs} value={cur} onChange={setTab} />
          {cur === 'acesso' && (<>
            <InfraPanel contractId={c.id} />
            <ContractFinance contractId={c.id}>{(fin, numbers) => <ServicePanel contract={c} financial={fin} fin={numbers} />}</ContractFinance>
            <ContractUsage contractId={c.id} />
            <AuthLog contractId={c.id} />
            <Availability contractId={c.id} />
            <Sessions contractId={c.id} />
            {has(me, 'olt') && <OnuPanel contract={c} />}
          </>)}
          {cur === 'contrato' && (<>
            <Card title="Situação comercial">
              <KV items={[
                ['Assinante', <Link to={`/assinantes/${c.subscriber_id}`}>{c.subscriber_name}</Link>], ['CPF/CNPJ', <span className="mono">{doc(c.subscriber_document)}</span>],
                ['Plano', `${c.plan_name} (v${c.plan_version})`], ['Velocidade', `${speed(c.down_kbps)} / ${speed(c.up_kbps)}`],
                ['Mensalidade', money(c.price_cents)], ['Vencimento', `dia ${c.due_day}`], ['Início', d(c.start_date)],
                ['Situação', c.status === 'active' ? <Badge tone="green">Vigente</Badge> : <Badge>Encerrado em {d(c.end_date)}</Badge>],
              ]} />
            </Card>
            <CustomValues entity="contract" id={c.id} values={c.custom} onChange={reload} />
            <Card title="Etiquetas"><ContractTags contract={c} onChange={reload} /></Card>
            <Card title="POP"><ContractPop contract={c} onChange={reload} /></Card>
            <ContractCompany contract={c} onChange={reload} />
            <ContractAddons contract={c} />
            {has(me, 'field') && can(me, 'stock:read') && <ContractEquipment contractId={c.id} />}
            {!net && <ContractFinance contractId={c.id}>{(fin) => <Card title="Financeiro">{fin}</Card>}</ContractFinance>}
          </>)}
          {cur === 'condicoes' && <ContractConditions contract={c} onChange={reload} />}
          {cur === 'os' && <WorkOrderList subscriberId={c.subscriber_id} contractId={c.id} />}
          {cur === 'historico' && (
            <Card title="Histórico do contrato">
              <table>
                <thead><tr><th>Quando</th><th>Evento</th><th>Detalhe</th><th>Por</th></tr></thead>
                <tbody>{c.history.map((h: any, i: number) => (
                  <tr key={i}><td>{dt(h.at)}</td><td>{EVENT[h.event] ?? h.event}</td>
                    <td className="small">{h.detail.from !== undefined ? `${h.detail.from} → ${h.detail.to}` : h.detail.plan ? `${h.detail.plan} v${h.detail.plan_version}` : ''}</td>
                    <td>{h.actor_name ?? 'sistema'}</td></tr>
                ))}</tbody>
              </table>
            </Card>
          )}
          {ending && (
            <Modal title="Encerrar contrato" onClose={() => setEnding(null)}>
              <Form submit="Encerrar contrato" onCancel={() => setEnding(null)} onSubmit={async () => {
                if (!(await dialog.confirm('Encerrar este contrato? A ação não pode ser desfeita.', { action: 'Encerrar contrato', danger: true }))) return;
                const fine = quote.data?.within_loyalty && quote.data.penalty_cents > 0;
                await api(`/contracts/${id}`, { method: 'PATCH', body: { end: true, end_reason_id: ending.reason_id || null, end_note: ending.note || null,
                  ...(fine ? { penalty: ending.penalty, penalty_waive_reason: ending.penalty === 'waive' ? ending.waive : undefined } : {}) } });
                setEnding(null); reload();
              }}>
                <p className="small muted">A ação não pode ser desfeita. O acesso deixa de ser autorizado.</p>
                <Field label="Motivo" hint="Cadastre os motivos em Catálogos e SLA."><select value={ending.reason_id} onChange={(e) => setEnding({ ...ending, reason_id: e.target.value })}>
                  <option value="">— não informar —</option>{reasons.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
                <Field label="Observação (opcional)"><input value={ending.note} maxLength={300} onChange={(e) => setEnding({ ...ending, note: e.target.value })} /></Field>
                {quote.data && quote.data.open_invoices > 0 && <p className="small">Há {quote.data.open_invoices} fatura(s) em aberto ({money(quote.data.open_invoices_cents)}); elas continuam a receber.</p>}
                {quote.data?.within_loyalty && quote.data.penalty_cents > 0 && (<>
                  <div className="state" style={{ textAlign: 'left' }}>Fidelidade até <b>{d(quote.data.loyalty_until)}</b>: multa de <b>{money(quote.data.penalty_cents)}</b> ({quote.data.remaining_months} mês(es) restante(s)).</div>
                  <Field label="Multa"><select value={ending.penalty} onChange={(e) => setEnding({ ...ending, penalty: e.target.value })}>
                    <option value="charge">Cobrar (gera fatura avulsa)</option><option value="waive">Dispensar</option></select></Field>
                  {ending.penalty === 'waive' && <Field label="Motivo da dispensa"><input value={ending.waive} minLength={5} maxLength={200} required onChange={(e) => setEnding({ ...ending, waive: e.target.value })} /></Field>}
                </>)}
              </Form>
            </Modal>
          )}
          {credit && (
            <Modal title={credit.restricted ? 'Restrição de crédito' : 'Retirar restrição de crédito'} onClose={() => setCredit(null)}>
              <Form submit="Confirmar" onCancel={() => setCredit(null)} onSubmit={async () => {
                await api(`/contracts/${id}/credit-restriction`, { method: 'PUT', body: credit });
                setCredit(null); reload();
              }}>
                <p className="small muted">É uma informação comercial: não bloqueia o acesso por si.</p>
                <Field label="Motivo"><input value={credit.note} minLength={3} maxLength={300} required onChange={(e) => setCredit({ ...credit, note: e.target.value })} /></Field>
              </Form>
            </Modal>
          )}
          {editing && (
            <Modal title="Alterar contrato" onClose={() => setEditing(false)}>
              <ContractForm contract={c} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); reload(); }} />
            </Modal>
          )}
        </>)}
      </State>
    </Page>
  );
}
