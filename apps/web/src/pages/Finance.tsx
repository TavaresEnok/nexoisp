import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, d, download, dt, money, useLoad, usePaged } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, KV, Modal, Page, Pager, State } from '../ui';
import { SimBadge } from './Service';

export function InvoiceBadge({ i }: { i: any }) {
  if (i.status === 'paid') return <Badge tone="green">Paga</Badge>;
  if (i.status === 'canceled') return <Badge>Cancelada</Badge>;
  if (i.status === 'reconciling') return <Badge tone="amber">Em conciliação</Badge>;
  return i.overdue ? <Badge tone="red">Vencida</Badge> : <Badge tone="blue">Em aberto</Badge>;
}
const parseMoney = (s: string) => Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);
const SOURCE: Record<string, string> = { gateway_event: 'evento do gateway', reconciliation: 'conciliação', manual: 'baixa manual' };
const brl = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

export function InvoiceModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useMe();
  const { data: i, loading, error, reload } = useLoad<any>(`/invoices/${id}`);
  const [form, setForm] = useState<'pay' | 'cancel' | 'resolve' | 'reverse' | null>(null);
  const { data: due, reload: reloadDue } = useLoad<any>(`/invoices/${id}/due`);
  const [f, setF] = useState<any>({});
  const w = can(me, 'finance:write');
  const demoPay = (mode: string) => async () => { await api('/demo-gateway/pay', { body: { invoice_id: id, mode } }); await reload(); };
  const done = () => { setForm(null); reload(); reloadDue(); };
  return (
    <Modal title="Fatura" onClose={onClose} wide>
      <State loading={loading} error={error}>
        {i && (<>
          <KV items={[
            ['Assinante', i.subscriber_name], ['Situação', <InvoiceBadge i={i} />], ['Valor', money(i.amount_cents)], ['Recebido', money(i.paid_cents)],
            ['Vencimento', d(i.due_date)], ['Competência', i.competence ? d(i.competence).slice(3) : 'avulsa'], ['Pago em', dt(i.paid_at)],
            ['Cobrança no gateway', i.gateway_charge_id ? <span className="mono small">{i.gateway} · {i.gateway_charge_id.slice(0, 24)}…</span> : 'não emitida'],
          ]} />
          {due && (i.status === 'open' || i.status === 'reconciling') && (due.days_late > 0 || due.fee_cents > 0 || due.discount_cents > 0) && (
            <Card title="Valor devido hoje">
              <KV items={[
                ['Falta pagar', <b>{money(due.remaining_cents)}</b>],
                ...(due.days_late > 0 ? [['Atraso', `${due.days_late} dia(s)`], ['Multa + juros se aplicados', money(due.fee_if_applied_cents)]] : []),
                ...(due.fee_cents > 0 ? [['Multa e juros já aplicados', money(due.fee_cents)]] : []),
                ...(due.discount_cents > 0 ? [['Desconto concedido', money(due.discount_cents)]] : []),
              ] as any} />
            </Card>
          )}
          {i.status_note && <div className="state err">{i.status_note}</div>}
          <Card title="Itens"><table><tbody>{i.items.map((it: any, n: number) => <tr key={n}><td>{it.description}</td><td className="num">{money(it.amount_cents)}</td></tr>)}</tbody></table></Card>
          {i.payment_methods && i.status === 'open' && (
            <Card tone={i.gateway === 'demo' ? 'demo' : ''} title={<>Meios de pagamento {i.gateway === 'demo' && <SimBadge />}</>}>
              <KV items={Object.entries(i.payment_methods).map(([k, v]) => [k.replace(/_/g, ' '), <span className="mono small">{String(v)}</span>])} />
            </Card>
          )}
          <Card title="Pagamentos">
            <State empty={i.payments.length === 0}>
              <table><thead><tr><th>Data</th><th className="num">Valor</th><th>Origem</th><th>Observação</th><th></th></tr></thead>
                <tbody>{i.payments.map((p: any) => {
                  const reversed = i.payments.some((x: any) => x.reversal_of === p.id);
                  return (<tr key={p.id} style={reversed ? { opacity: 0.6 } : undefined}><td>{dt(p.paid_at)}</td>
                    <td className="num">{p.kind === 'reversal' ? `− ${money(p.amount_cents)}` : money(p.amount_cents)}</td>
                    <td>{p.kind === 'reversal' ? 'estorno' : SOURCE[p.source]}{p.created_by_name && ` — ${p.created_by_name}`}</td><td className="small">{p.note ?? p.method}{reversed && ' (estornada)'}</td>
                    <td>{w && p.kind === 'payment' && p.source === 'manual' && !reversed && i.status !== 'canceled' && <button className="danger" onClick={() => { setF({ payment_id: p.id, reason: '' }); setForm('reverse'); }}>Estornar</button>}</td></tr>);
                })}</tbody></table>
            </State>
          </Card>
          {i.events.length > 0 && (
            <Card title="Eventos do gateway">
              <table><tbody>{i.events.map((e: any) => <tr key={e.id}><td>{dt(e.received_at)}</td><td className="mono small">{e.type}</td><td><Badge tone={e.status === 'processed' ? 'green' : 'amber'}>{e.status}</Badge></td><td className="small">{e.note}</td></tr>)}</tbody></table>
            </Card>
          )}
          {w && (
            <div className="row">
              {(i.status === 'open' || i.status === 'reconciling') && <button onClick={() => { setF({ amount: brl(due?.remaining_cents ?? i.amount_cents), paid_at: new Date().toISOString().slice(0, 10), method: 'dinheiro', note: '', apply_fees: false, partial: false, discount: '', discount_reason: '' }); setForm('pay'); }}>Baixa manual</button>}
              {i.status === 'open' && <button className="danger" onClick={() => { setF({ reason: '' }); setForm('cancel'); }}>Cancelar fatura</button>}
              {i.status === 'reconciling' && <button className="primary" onClick={() => { setF({ decision: 'paid', note: '' }); setForm('resolve'); }}>Resolver conciliação</button>}
            </div>
          )}
          {w && me.demo && i.gateway === 'demo' && i.status === 'open' && (
            <Card tone="demo" title={<>Simular pagador <SimBadge /></>}>
              <p className="small muted" style={{ marginTop: 0 }}>Só existe no ambiente de demonstração. Nenhum dinheiro é movimentado.</p>
              <div className="row">
                <ActionButton onClick={demoPay('webhook')}>Pagar (webhook entregue)</ActionButton>
                <ActionButton onClick={demoPay('duplicate')}>Pagar (webhook duplicado)</ActionButton>
                <ActionButton onClick={demoPay('lost')}>Pagar (webhook perdido)</ActionButton>
                <ActionButton onClick={demoPay('divergent')}>Pagar valor menor</ActionButton>
              </div>
            </Card>
          )}
          {form === 'pay' && (
            <Form submit="Registrar baixa" onCancel={() => setForm(null)} onSubmit={async () => {
              await api(`/invoices/${id}/manual-payment`, { body: {
                amount_cents: parseMoney(f.amount), paid_at: f.paid_at, method: f.method, note: f.note, apply_fees: f.apply_fees, partial: f.partial,
                ...(f.discount ? { discount_cents: parseMoney(f.discount), discount_reason: f.discount_reason } : {}) } });
              done();
            }}>
              <div className="cols3">
                <Field label="Valor recebido (R$)"><input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></Field>
                <Field label="Data"><input type="date" value={f.paid_at} onChange={(e) => setF({ ...f, paid_at: e.target.value })} required /></Field>
                <Field label="Meio"><input value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} /></Field>
              </div>
              <Field label="Observação (obrigatória; fica na auditoria)"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} required minLength={3} /></Field>
              {due && due.fee_if_applied_cents > due.fee_cents && (
                <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.apply_fees} onChange={(e) => {
                  const on = e.target.checked;
                  setF({ ...f, apply_fees: on, amount: brl(due.remaining_cents + (on ? due.fee_if_applied_cents - due.fee_cents : 0)) });
                }} /> Cobrar multa e juros de {due.days_late} dia(s) de atraso: {money(due.fee_if_applied_cents - due.fee_cents)}</label>
              )}
              <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.partial} onChange={(e) => setF({ ...f, partial: e.target.checked })} /> Pagamento parcial (a fatura continua em aberto com o saldo)</label>
              <div className="cols3">
                <Field label="Desconto (R$)"><input value={f.discount} onChange={(e) => setF({ ...f, discount: e.target.value })} placeholder="0,00" /></Field>
                <Field label="Motivo do desconto"><input value={f.discount_reason} onChange={(e) => setF({ ...f, discount_reason: e.target.value })} required={!!f.discount} /></Field>
              </div>
            </Form>
          )}
          {form === 'reverse' && (
            <Form submit="Estornar baixa" onCancel={() => setForm(null)} onSubmit={async () => { await api(`/invoices/${id}/payments/${f.payment_id}/reverse`, { body: { reason: f.reason } }); done(); }}>
              <p className="small muted" style={{ marginTop: 0 }}>A fatura volta a ficar em aberto. Se o acesso foi religado por causa desta baixa, ele só é suspenso de novo pela política de suspensão.</p>
              <Field label="Motivo do estorno (fica na auditoria)"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={5} /></Field>
            </Form>
          )}
          {form === 'cancel' && (
            <Form submit="Cancelar fatura" onCancel={() => setForm(null)} onSubmit={async () => { await api(`/invoices/${id}/cancel`, { body: f }); done(); }}>
              <Field label="Motivo"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={3} /></Field>
            </Form>
          )}
          {form === 'resolve' && (
            <Form submit="Registrar decisão" onCancel={() => setForm(null)} onSubmit={async () => { await api(`/invoices/${id}/resolve`, { body: f }); done(); }}>
              <Field label="Decisão">
                <select value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value })}>
                  <option value="paid">Considerar paga</option><option value="open">Manter em aberto</option>
                </select>
              </Field>
              <Field label="Justificativa (fica na auditoria)"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} required minLength={5} /></Field>
            </Form>
          )}
        </>)}
      </State>
    </Modal>
  );
}

export function InvoiceTable({ rows, onOpen, showSubscriber = true }: { rows: any[]; onOpen: (id: string) => void; showSubscriber?: boolean }) {
  return (
    <table>
      <thead><tr>{showSubscriber && <th>Assinante</th>}<th>Referência</th><th>Vencimento</th><th className="num">Valor</th><th>Situação</th><th></th></tr></thead>
      <tbody>{rows.map((i) => (
        <tr key={i.id}>
          {showSubscriber && <td><Link to={`/contratos/${i.contract_id}`}>{i.subscriber_name}</Link></td>}
          <td>{i.competence ? `Mensalidade ${d(i.competence).slice(3)}` : 'Avulsa'} <span className="muted small">{i.plan_name}</span></td>
          <td>{d(i.due_date)}</td><td className="num">{money(i.amount_cents)}</td><td><InvoiceBadge i={i} /></td>
          <td><button className="sm" onClick={() => onOpen(i.id)}>abrir</button></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function MonthlyChart() {
  const { data } = useLoad<any[]>('/finance/monthly');
  if (!data) return null;
  const max = Math.max(1, ...data.map((m) => m.received_cents));
  const name = (m: string) => new Date(`${m}-15`).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
  return (
    <Card title="Recebido por mês">
      <div className="bars" role="img" aria-label={`Recebido por mês: ${data.map((m) => `${name(m.month)} ${money(m.received_cents)}`).join(', ')}`}>
        {data.map((m) => <div key={m.month}><b>{m.received_cents ? money(m.received_cents) : ''}</b><i style={{ height: `${(m.received_cents / max) * 100}%` }} /><span>{name(m.month)}</span></div>)}
      </div>
    </Card>
  );
}

/** CSV para a contabilidade. Não substitui nota fiscal: a emissão fiscal não é feita pelo sistema. */
function AccountingExport() {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ kind: 'payments', from: `${today.slice(0, 8)}01`, to: today });
  return (
    <Card title="Exportar para a contabilidade">
      <div className="row">
        <select aria-label="O que exportar" style={{ width: 240 }} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="payments">Recebimentos (por data de pagamento)</option><option value="invoices">Faturas (por vencimento)</option>
        </select>
        <input type="date" aria-label="Data inicial" style={{ width: 160 }} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <span className="muted">até</span>
        <input type="date" aria-label="Data final" style={{ width: 160 }} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <ActionButton onClick={() => download(`/finance/export?kind=${f.kind}&from=${f.from}&to=${f.to}`, `nexoisp-${f.kind}-${f.from}_${f.to}.csv`)}>Baixar CSV</ActionButton>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>Planilha de conferência (separador “;”). Não é documento fiscal: a emissão de nota não é feita pelo NexoISP.</p>
    </Card>
  );
}

export function Invoices() {
  const { me } = useMe();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = usePaged<any>(`/invoices?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`);
  const { data, loading, error, reload } = list;
  const sum = useLoad<any>('/finance/summary');
  const [open, setOpen] = useState<string | null>(null);
  const [gen, setGen] = useState<any>(null);
  const [competence, setCompetence] = useState(new Date().toISOString().slice(0, 7));
  return (
    <Page title="Faturas" actions={<>
      <input className="search" placeholder="Buscar assinante…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select aria-label="Filtrar por situação" style={{ width: 170 }} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">Todas</option><option value="open">Em aberto</option><option value="overdue">Vencidas</option>
        <option value="paid">Pagas</option><option value="reconciling">Em conciliação</option><option value="canceled">Canceladas</option>
      </select>
    </>}>
      {sum.data && (
        <div className="grid">
          <Card><div className="stat"><b>{money(sum.data.open_cents)}</b><span>{sum.data.open} em aberto</span></div></Card>
          <Card><div className="stat"><b style={{ color: sum.data.overdue > 0 ? 'var(--red)' : undefined }}>{money(sum.data.overdue_cents)}</b><span>{sum.data.overdue} vencida(s)</span></div></Card>
          <Card><div className="stat"><b>{money(sum.data.received_month_cents)}</b><span>recebido no mês</span></div></Card>
          <Card><div className="stat"><b>{sum.data.reconciling}</b><span>em conciliação</span></div>{sum.data.reconciling > 0 && <Link to="/conciliacao">resolver</Link>}</Card>
        </div>
      )}
      {can(me, 'finance:write') && (
        <Card title="Gerar mensalidades">
          <div className="row">
            <input type="month" aria-label="Competência" style={{ width: 170 }} value={competence} onChange={(e) => setCompetence(e.target.value)} />
            <ActionButton className="primary" onClick={async () => { setGen(await api('/finance/generate', { body: { competence } })); reload(); sum.reload(); }}>Gerar faturas da competência</ActionButton>
            {gen && <span className="small">{gen.created} criada(s); {gen.already_existing} já existia(m) — nada duplicado. {gen.gateway === 'none' ? 'Sem gateway configurado: cobranças não emitidas.' : `${gen.charges_emitted} cobrança(s) emitida(s).`}</span>}
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>Valor cheio do plano contratado. Proporcionalidade, juros, multa e descontos não são aplicados: dependem de regra comercial ainda não definida.</p>
        </Card>
      )}
      <MonthlyChart />
      <AccountingExport />
      <State loading={loading && !data} error={error} empty={data?.length === 0}>
        {data && <InvoiceTable rows={data} onOpen={setOpen} />}
        <Pager p={list} />
      </State>
      {open && <InvoiceModal id={open} onClose={() => { setOpen(null); reload(); sum.reload(); }} />}
    </Page>
  );
}

export function Reconciliation() {
  const { me } = useMe();
  const { data, loading, error, reload } = useLoad<any>('/finance/reconciliation');
  const [open, setOpen] = useState<string | null>(null);
  const [res, setRes] = useState<any>(null);
  return (
    <Page title="Conciliação" actions={can(me, 'finance:write') &&
      <ActionButton className="primary" onClick={async () => { setRes(await api('/finance/reconcile', { method: 'POST' })); reload(); }}>Consultar gateway agora</ActionButton>}>
      {res && <div className="state" style={{ background: 'var(--blue-bg)', color: 'var(--blue)', borderRadius: 8, textAlign: 'left', marginBottom: 12 }}>
        {res.checked} cobrança(s) consultada(s): {res.recovered} pagamento(s) recuperado(s), {res.divergent} divergente(s){res.unavailable > 0 && `, ${res.unavailable} sem gateway disponível`}.</div>}
      <State loading={loading} error={error}>
        {data && (<>
          <Card title="Faturas que exigem decisão">
            <State empty={data.invoices.length === 0}><InvoiceTable rows={data.invoices} onOpen={setOpen} /></State>
          </Card>
          <Card title="Eventos recebidos do gateway">
            <State empty={data.events.length === 0}>
              <table>
                <thead><tr><th>Recebido</th><th>Tipo</th><th>Assinante</th><th>Situação</th><th>Nota</th><th></th></tr></thead>
                <tbody>{data.events.map((e: any) => (
                  <tr key={e.id}><td>{dt(e.received_at)}</td><td className="mono small">{e.type}</td><td>{e.subscriber_name ?? '—'}</td>
                    <td><Badge tone={e.status === 'processed' ? 'green' : e.status === 'ignored' ? 'gray' : 'amber'}>{e.status}</Badge></td>
                    <td className="small">{e.note}</td><td>{e.invoice_id && <button className="sm" onClick={() => setOpen(e.invoice_id)}>fatura</button>}</td></tr>
                ))}</tbody>
              </table>
            </State>
          </Card>
        </>)}
      </State>
      {open && <InvoiceModal id={open} onClose={() => { setOpen(null); reload(); }} />}
    </Page>
  );
}

export function FinanceSettings() {
  const { me } = useMe();
  const { data, loading, error, reload } = useLoad<any>('/finance/settings');
  const [f, setF] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const [run, setRun] = useState<any>(null);
  useEffect(() => { if (data) setF({ gateway: data.gateway, billing_auto: data.billing_auto, auto_suspend: data.auto_suspend, suspend_after_days: data.suspend_after_days ?? '', auto_resume_on_payment: data.auto_resume_on_payment, suspension_mode: data.suspension_mode ?? 'reject', suspension_profile: data.suspension_profile ?? '',
    trust_release_enabled: data.trust_release_enabled, trust_release_days: data.trust_release_days, trust_release_gap_days: data.trust_release_gap_days,
    late_fee_percent: data.late_fee_percent, interest_monthly_percent: data.interest_monthly_percent, prorate_first_month: data.prorate_first_month }); }, [data]);
  const w = can(me, 'settings:manage');
  const chk = (k: string, label: string) => (
    <label className="row" style={{ marginBottom: 8 }}><input type="checkbox" style={{ width: 'auto' }} disabled={!w} checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {label}</label>
  );
  return (
    <Page title="Política de cobrança">
      <State loading={loading} error={error}>
        {f && (
          <Card>
            <Form submit="Salvar política" onSubmit={async () => {
              await api('/finance/settings', { method: 'PUT', body: { ...f, suspend_after_days: f.suspend_after_days === '' ? null : Number(f.suspend_after_days), suspension_profile: f.suspension_mode === 'profile' ? f.suspension_profile : null,
                late_fee_percent: Number(f.late_fee_percent), interest_monthly_percent: Number(f.interest_monthly_percent),
                trust_release_days: Number(f.trust_release_days), trust_release_gap_days: Number(f.trust_release_gap_days) } });
              setSaved(true); reload();
            }}>
              <Field label="Gateway de pagamento" hint="Integração com gateway real ainda não homologada: depende da escolha do gateway e de credenciais de sandbox.">
                <select disabled={!w} value={f.gateway} onChange={(e) => setF({ ...f, gateway: e.target.value })}>
                  <option value="none">Nenhum (somente baixa manual)</option>
                  {data.demo_mode && <option value="demo">Demonstração — SIMULADO, não movimenta dinheiro</option>}
                </select>
              </Field>
              {chk('billing_auto', 'Gerar mensalidades automaticamente a cada mês')}
              <h3 style={{ margin: '14px 0 6px' }}>Suspensão por inadimplência</h3>
              <p className="small muted" style={{ marginTop: 0 }}>Desativada por padrão. Só passa a agir depois de configurada aqui pelo provedor.</p>
              {chk('auto_suspend', 'Suspender automaticamente contratos com fatura vencida')}
              <Field label="Dias de atraso até a suspensão">
                <input type="number" min="0" max="365" style={{ maxWidth: 160 }} disabled={!w || !f.auto_suspend} value={f.suspend_after_days} onChange={(e) => setF({ ...f, suspend_after_days: e.target.value })} required={f.auto_suspend} />
              </Field>
              {chk('auto_resume_on_payment', 'Reativar automaticamente quando o pagamento for confirmado')}
              <Field label="Modalidade da suspensão" hint="Vale para suspensão manual e automática. Contrato encerrado sempre tem o acesso negado.">
                <select disabled={!w} value={f.suspension_mode} onChange={(e) => setF({ ...f, suspension_mode: e.target.value })}>
                  <option value="reject">Negar a autenticação e encerrar a sessão</option>
                  <option value="profile">Manter conectado com o perfil de bloqueio do concentrador (aviso)</option>
                </select>
              </Field>
              {f.suspension_mode === 'profile' && (
                <Field label="Perfil de bloqueio no concentrador" hint="Nome exato do perfil PPP que já existe no concentrador (ex.: velocidade mínima e faixa de endereços de aviso). Exige agente 0.4.0 ou superior.">
                  <input disabled={!w} value={f.suspension_profile} onChange={(e) => setF({ ...f, suspension_profile: e.target.value })} required pattern="[A-Za-z0-9_.\-]{1,60}" />
                </Field>
              )}
              <h3 style={{ margin: '14px 0 6px' }}>Liberação por confiança</h3>
              <p className="small muted" style={{ marginTop: 0 }}>O atendente ou o próprio assinante (pelo portal) religam o acesso suspenso por alguns dias. Enquanto vale, a suspensão automática não age; ao vencer sem pagamento, volta a valer a política acima.</p>
              {chk('trust_release_enabled', 'Permitir liberação por confiança')}
              <div className="cols3">
                <Field label="Prazo máximo (dias)"><input type="number" min="1" max="30" disabled={!w || !f.trust_release_enabled} value={f.trust_release_days} onChange={(e) => setF({ ...f, trust_release_days: e.target.value })} /></Field>
                <Field label="Intervalo entre liberações (dias)"><input type="number" min="0" max="365" disabled={!w || !f.trust_release_enabled} value={f.trust_release_gap_days} onChange={(e) => setF({ ...f, trust_release_gap_days: e.target.value })} /></Field>
              </div>
              <h3 style={{ margin: '14px 0 6px' }}>Multa, juros e primeiro mês</h3>
              <p className="small muted" style={{ marginTop: 0 }}>Multa e juros só entram na baixa manual, quando o atendente escolhe cobrá-los. Cobranças emitidas no gateway não mudam de valor.</p>
              <div className="cols3">
                <Field label="Multa por atraso (%)"><input type="number" min="0" max="20" step="0.01" disabled={!w} value={f.late_fee_percent} onChange={(e) => setF({ ...f, late_fee_percent: e.target.value })} /></Field>
                <Field label="Juros ao mês (%)"><input type="number" min="0" max="20" step="0.01" disabled={!w} value={f.interest_monthly_percent} onChange={(e) => setF({ ...f, interest_monthly_percent: e.target.value })} /></Field>
              </div>
              {chk('prorate_first_month', 'Cobrar o primeiro mês proporcional aos dias de uso')}
              {saved && <div className="small" style={{ color: 'var(--green)' }}>Política salva.</div>}
            </Form>
            {w && data.auto_suspend && (
              <div className="row" style={{ marginTop: 10 }}>
                <ActionButton confirm="Executar agora a verificação de inadimplência conforme a política salva?" onClick={async () => setRun(await api('/finance/run-auto-suspend', { method: 'POST' }))}>Executar verificação agora</ActionButton>
                {run && <span className="small">{run.requested} suspensão(ões) solicitada(s).</span>}
              </div>
            )}
          </Card>
        )}
      </State>
    </Page>
  );
}


/** Liberação por confiança do contrato: quem pode, concede; o estado vale para a equipe e para o portal. */
function TrustReleaseCard({ contractId }: { contractId: string }) {
  const { me } = useMe();
  const { data, reload } = useLoad<any>(`/contracts/${contractId}/trust-release`);
  const [f, setF] = useState<any>(null);
  if (!data || !data.enabled) return null;
  const grant = can(me, 'trust:grant');
  return (
    <Card title="Liberação por confiança">
      {data.active
        ? <p style={{ margin: 0 }}><Badge tone="amber">Em curso</Badge> até {dt(data.active.expires_at)} ({data.active.source === 'portal' ? 'pedida pelo assinante' : 'concedida pela equipe'}).</p>
        : data.eligible ? <p className="small muted" style={{ margin: 0 }}>O acesso está suspenso e pode ser liberado por até {data.max_days} dia(s).</p>
        : <p className="small muted" style={{ margin: 0 }}>{data.reason}.</p>}
      {data.eligible && grant && !f && <div className="row" style={{ marginTop: 8 }}><button onClick={() => setF({ days: data.max_days, reason: '' })}>Liberar por confiança</button></div>}
      {f && (
        <Form submit="Liberar acesso" onCancel={() => setF(null)} onSubmit={async () => {
          await api(`/contracts/${contractId}/trust-release`, { body: { days: Number(f.days), reason: f.reason } }); setF(null); reload();
        }}>
          <div className="cols3">
            <Field label="Dias"><input type="number" min="1" max={data.max_days} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} required /></Field>
          </div>
          <Field label="Motivo (fica na auditoria)"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={3} placeholder="ex.: cliente prometeu pagar na sexta" /></Field>
        </Form>
      )}
      {data.history.length > 0 && (
        <details style={{ marginTop: 8 }}><summary className="small">Histórico ({data.history.length})</summary>
          <table><tbody>{data.history.map((h: any) => <tr key={h.id}><td>{dt(h.granted_at)}</td><td>{h.days} dia(s)</td>
            <td><Badge tone={h.status === 'active' ? 'amber' : h.status === 'settled' ? 'green' : undefined}>{({ active: 'em curso', expired: 'vencida', settled: 'quitada', canceled: 'cancelada' } as any)[h.status]}</Badge></td>
            <td className="small">{h.requested_by_name ?? '—'} · {h.source === 'portal' ? 'portal' : 'equipe'}{h.reason ? ` · ${h.reason}` : ''}</td></tr>)}</tbody></table>
        </details>
      )}
    </Card>
  );
}

/** Renegociação: junta faturas em aberto do contrato em parcelas novas. */
function AgreementModal({ contractId, invoices, onClose }: { contractId: string; invoices: any[]; onClose: () => void }) {
  const open = invoices.filter((i) => i.status === 'open');
  const [f, setF] = useState<any>({ ids: open.map((i) => i.id), installments: 3, first_due: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), discount: '', reason: '', apply_fees: false, release: false });
  const sum = open.filter((i) => f.ids.includes(i.id)).reduce((a, i) => a + i.amount_cents + (i.fee_cents ?? 0) - (i.discount_cents ?? 0) - i.paid_cents, 0);
  const total = sum - (f.discount ? parseMoney(f.discount) : 0);
  return (
    <Modal title="Acordo de pagamento" onClose={onClose}>
      <Form submit="Criar acordo" onCancel={onClose} onSubmit={async () => {
        await api(`/contracts/${contractId}/agreement`, { body: {
          invoice_ids: f.ids, installments: Number(f.installments), first_due_date: f.first_due, reason: f.reason,
          apply_fees: f.apply_fees, release_service: f.release, ...(f.discount ? { discount_cents: parseMoney(f.discount) } : {}) } });
        onClose();
      }}>
        <p className="small muted" style={{ marginTop: 0 }}>As faturas escolhidas são canceladas e substituídas pelas parcelas do acordo. O que já foi pago parcialmente é descontado.</p>
        <table><tbody>{open.map((i) => (
          <tr key={i.id}><td style={{ width: 28 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.ids.includes(i.id)}
            onChange={(e) => setF({ ...f, ids: e.target.checked ? [...f.ids, i.id] : f.ids.filter((x: string) => x !== i.id) })} /></td>
            <td>{d(i.due_date)}</td><td className="num">{money(i.amount_cents)}</td><td className="small">{i.overdue ? 'vencida' : 'a vencer'}{i.paid_cents > 0 ? ` · pago ${money(i.paid_cents)}` : ''}</td></tr>))}</tbody></table>
        <div className="cols3">
          <Field label="Parcelas"><input type="number" min="1" max="24" value={f.installments} onChange={(e) => setF({ ...f, installments: e.target.value })} required /></Field>
          <Field label="Primeiro vencimento"><input type="date" value={f.first_due} onChange={(e) => setF({ ...f, first_due: e.target.value })} required /></Field>
          <Field label="Desconto (R$)"><input value={f.discount} onChange={(e) => setF({ ...f, discount: e.target.value })} placeholder="0,00" /></Field>
        </div>
        <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.apply_fees} onChange={(e) => setF({ ...f, apply_fees: e.target.checked })} /> Incluir multa e juros pela política do provedor</label>
        <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.release} onChange={(e) => setF({ ...f, release: e.target.checked })} /> Religar o acesso se estiver suspenso</label>
        <Field label="Descrição do acordo (fica na auditoria)"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={5} /></Field>
        <p className="small" style={{ marginBottom: 0 }}>Total do acordo: <b>{money(total)}</b>{f.ids.length === 0 && ' — escolha ao menos uma fatura'}</p>
      </Form>
    </Modal>
  );
}

/** Resumo financeiro do contrato (uma das cinco informações) + lista de faturas. */
export function ContractFinance({ contractId, children }: { contractId: string; children: (summary: ReactNode, numbers?: { overdue: number; open: number; reconciling: number }) => ReactNode }) {
  const { me } = useMe();
  const ok = can(me, 'finance:read');
  const { data, reload } = useLoad<any>(ok ? `/contracts/${contractId}/finance` : null, 5000);
  const [open, setOpen] = useState<string | null>(null);
  const [agreement, setAgreement] = useState(false);
  const { me: me2 } = useMe();
  const summary = !ok ? <span className="muted small">sem permissão para ver</span> : !data ? undefined : (
    data.invoices.length === 0 ? <span className="muted small">sem cobranças</span> : (<>
      {data.overdue > 0 ? <Badge tone="red">{data.overdue} vencida(s)</Badge> : data.open > 0 ? <Badge tone="blue">{data.open} em aberto</Badge> : <Badge tone="green">Em dia</Badge>}
      {data.reconciling > 0 && <> <Badge tone="amber">{data.reconciling} em conciliação</Badge></>}
      <div className="small muted">{money(data.open_cents)} em aberto</div>
    </>)
  );
  return (<>
    {children(summary, ok && data ? { overdue: data.overdue, open: data.open, reconciling: data.reconciling } : undefined)}
    {ok && data && data.invoices.length > 0 && (
      <Card title="Faturas do contrato">
        <InvoiceTable rows={data.invoices} onOpen={setOpen} showSubscriber={false} />
        {can(me2, 'finance:write') && data.invoices.some((i: any) => i.status === 'open') && (
          <div className="row" style={{ marginTop: 8 }}><button onClick={() => setAgreement(true)}>Acordo de pagamento</button></div>
        )}
      </Card>
    )}
    {ok && <TrustReleaseCard contractId={contractId} />}
    {agreement && data && <AgreementModal contractId={contractId} invoices={data.invoices} onClose={() => { setAgreement(false); reload(); }} />}
    {open && <InvoiceModal id={open} onClose={() => { setOpen(null); reload(); }} />}
  </>);
}
