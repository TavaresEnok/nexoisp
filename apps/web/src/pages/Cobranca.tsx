import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, money, useLoad } from '../api';
import { ActionButton, Badge, Card, Field, Form, Modal, Page, State } from '../ui';

// ---------------------------------------------------------------- degraus do plano
export function DunningForm({ plan, onDone, onCancel }: { plan: any; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({
    warn: plan.warn_after_days ?? '', reduce: plan.reduce_after_days ?? '', block: plan.block_after_days ?? '', profile: plan.reduced_profile ?? '',
  });
  const n = (v: string | number) => (v === '' ? null : Number(v));
  return (
    <Form submit="Salvar degraus" onCancel={onCancel} onSubmit={async () => {
      await api(`/plans/${plan.id}/dunning`, { method: 'PUT', body: { warn_after_days: n(f.warn), reduce_after_days: n(f.reduce), block_after_days: n(f.block), reduced_profile: f.profile || null } });
      onDone();
    }}>
      <p className="small muted" style={{ marginTop: 0 }}>
        Dias <b>depois do vencimento</b> em que cada degrau acontece para os contratos deste plano. Vazio = vale a política do provedor (Política de cobrança).
        As ações automáticas só ocorrem com a suspensão automática ligada na política do provedor.
      </p>
      <div className="cols3">
        <Field label="Avisar (dias)" hint="Entra na régua de avisos ao assinante."><input type="number" min="0" max="365" value={f.warn} onChange={(e) => setF({ ...f, warn: e.target.value })} /></Field>
        <Field label="Reduzir a velocidade (dias)"><input type="number" min="0" max="365" value={f.reduce} onChange={(e) => setF({ ...f, reduce: e.target.value })} /></Field>
        <Field label="Bloquear (dias)"><input type="number" min="0" max="365" value={f.block} onChange={(e) => setF({ ...f, block: e.target.value })} /></Field>
      </div>
      <Field label="Perfil de velocidade reduzida no concentrador" hint="Nome exato do perfil PPP que já existe no concentrador. Obrigatório se houver degrau de redução. Exige agente 0.4.0 ou superior.">
        <input value={f.profile} onChange={(e) => setF({ ...f, profile: e.target.value })} pattern="[A-Za-z0-9_.\-]{1,60}" required={f.reduce !== ''} />
      </Field>
    </Form>
  );
}
export function DunningBadge({ plan }: { plan: any }) {
  const parts = [plan.warn_after_days != null && `avisa ${plan.warn_after_days}d`, plan.reduce_after_days != null && `reduz ${plan.reduce_after_days}d`, plan.block_after_days != null && `bloqueia ${plan.block_after_days}d`].filter(Boolean);
  return parts.length ? <span className="small">{parts.join(' · ')}</span> : <span className="muted small">política do provedor</span>;
}

// ---------------------------------------------------------------- relatórios
const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
export function Reports() {
  const [tab, setTab] = useState<'aging' | 'receipts' | 'without' | 'cancel'>('aging');
  const [from, setFrom] = useState(monthAgo());
  const [to, setTo] = useState(today());
  const [days, setDays] = useState(90);
  const path = tab === 'aging' ? '/finance/reports/aging' : tab === 'receipts' ? `/finance/reports/receipts?from=${from}&to=${to}`
    : tab === 'without' ? '/finance/reports/without-invoice' : `/finance/reports/to-cancel?days=${days}`;
  const { data, loading, error } = useLoad<any>(path);
  const csvPath = path + (path.includes('?') ? '&' : '?') + 'format=csv';
  const tabs: [typeof tab, string][] = [['aging', 'Carteira por atraso'], ['receipts', 'Recebido'], ['without', 'Clientes sem fatura'], ['cancel', 'A cancelar']];
  return (
    <Page title="Relatórios de cobrança" actions={<ActionButton onClick={() => download(csvPath, `${tab}.csv`)}>Exportar CSV</ActionButton>}>
      <div className="row" role="tablist" style={{ marginBottom: 10 }}>
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'receipts' && (
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="row" style={{ gap: 4 }}>De <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="row" style={{ gap: 4 }}>até <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}
      {tab === 'cancel' && (
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="row" style={{ gap: 4 }}>Em atraso há mais de <input type="number" min="1" max="730" style={{ width: 90 }} value={days} onChange={(e) => setDays(Number(e.target.value) || 90)} /> dias</label>
          <span className="small muted">Lista de candidatos: nada é cancelado automaticamente.</span>
        </div>
      )}
      <State loading={loading && !data} error={error}>
        {data && tab === 'aging' && (
          <table>
            <thead><tr><th>Faixa</th><th className="num">Faturas</th><th className="num">Valor em aberto</th></tr></thead>
            <tbody>{data.rows.map((r: any) => <tr key={r.faixa}><td>{r.faixa}</td><td className="num">{r.faturas}</td><td className="num">{money(r.cents)}</td></tr>)}
              <tr><td><b>Total</b></td><td className="num"><b>{data.total.faturas}</b></td><td className="num"><b>{money(data.total.cents)}</b></td></tr></tbody>
          </table>
        )}
        {data && tab === 'receipts' && (<>
          <p className="small">Total recebido no período, líquido de estornos: <b>{money(data.total_cents)}</b></p>
          <div className="grid2">
            <Card title="Por plano"><table><tbody>{data.by_plan.map((g: any) => <tr key={g.grupo}><td>{g.grupo}</td><td className="num">{g.pagamentos}</td><td className="num">{money(g.cents)}</td></tr>)}</tbody></table></Card>
            <Card title="Por forma"><table><tbody>{data.by_method.map((g: any) => <tr key={g.grupo}><td>{g.grupo}</td><td className="num">{g.pagamentos}</td><td className="num">{money(g.cents)}</td></tr>)}</tbody></table></Card>
          </div>
        </>)}
        {data && tab === 'without' && (
          <State empty={data.rows.length === 0}>
            <p className="small muted">Contratos vigentes com mensalidade e nenhuma fatura (não cancelada) com vencimento neste mês.</p>
            <table><thead><tr><th>Cliente</th><th>Plano</th><th className="num">Mensalidade</th><th>Vencimento</th></tr></thead>
              <tbody>{data.rows.map((r: any) => <tr key={r.contract_id}><td><Link to={`/contratos/${r.contract_id}`}>{r.subscriber_name}</Link></td><td>{r.plan_name}</td>
                <td className="num">{money(r.price_cents)}</td><td>dia {r.due_day}</td></tr>)}</tbody></table>
          </State>
        )}
        {data && tab === 'cancel' && (
          <State empty={data.rows.length === 0}>
            <table><thead><tr><th>Cliente</th><th>Plano</th><th className="num">Faturas</th><th className="num">Valor</th><th className="num">Atraso</th></tr></thead>
              <tbody>{data.rows.map((r: any) => <tr key={r.contract_id}><td><Link to={`/contratos/${r.contract_id}`}>{r.subscriber_name}</Link></td><td>{r.plan_name}</td>
                <td className="num">{r.faturas}</td><td className="num">{money(r.cents)}</td><td className="num"><Badge tone="red">{r.dias_atraso} dias</Badge></td></tr>)}</tbody></table>
          </State>
        )}
      </State>
    </Page>
  );
}

// ---------------------------------------------------------------- painéis do início
export function Panels() {
  const { data, error } = useLoad<any>('/dashboard/panels', 60000);
  if (error || !data) return null;
  const max = (xs: number[]) => Math.max(1, ...xs);
  const offMax = max(data.offline.map((x: any) => x.n));
  const monthMax = max(data.contracts_by_month.flatMap((m: any) => [m.ativacoes, m.encerramentos]));
  return (
    <div className="grid2" style={{ marginTop: 12 }}>
      <Card title="Conexões offline por tempo">
        <State empty={data.offline.length === 0}>
          <table><tbody>{data.offline.map((r: any) => (
            <tr key={r.label}><td style={{ width: 90 }}>{r.label}</td><td><div style={{ background: 'var(--amber, #f59e0b)', height: 10, width: `${(r.n / offMax) * 100}%`, borderRadius: 3 }} /></td><td className="num">{r.n}</td></tr>
          ))}</tbody></table>
        </State>
        <p className="small muted" style={{ marginBottom: 0 }}>Contas ativas que o agente viu offline, pelo fim da última sessão registrada.</p>
      </Card>
      {data.signal.length > 0 && (
        <Card title="Sinal das ONUs (RX)">
          <table><tbody>{data.signal.map((r: any) => <tr key={r.label}><td>{r.label}</td><td className="num">{r.n}</td></tr>)}</tbody></table>
        </Card>
      )}
      <Card title="Ativações e encerramentos (12 meses)">
        <div role="img" aria-label="Contratos por mês" style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 90 }}>
          {data.contracts_by_month.map((m: any) => (
            <div key={m.month} title={`${m.month}: ${m.ativacoes} ativações, ${m.encerramentos} encerramentos`} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1, height: '100%' }}>
              <div style={{ flex: 1, background: 'var(--green, #22c55e)', height: `${Math.max(3, (m.ativacoes / monthMax) * 100)}%`, borderRadius: 2 }} />
              <div style={{ flex: 1, background: 'var(--red, #ef4444)', height: `${Math.max(3, (m.encerramentos / monthMax) * 100)}%`, borderRadius: 2 }} />
            </div>
          ))}
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>Verde: ativações · vermelho: encerramentos.</p>
      </Card>
      {data.cash_today && (
        <Card title="Caixa de hoje">
          <div className="stat"><b>{money(data.cash_today.cents)}</b><span>{data.cash_today.pagamentos} pagamento(s), líquido de estornos</span></div>
          <p className="small"><Link to="/relatorios-cobranca">Relatórios de cobrança</Link> · {data.without_invoice} contrato(s) sem fatura neste mês</p>
        </Card>
      )}
      <Card title="Últimas operações de rede">
        <State empty={data.recent_operations.length === 0}>
          <table><tbody>{data.recent_operations.map((o: any, i: number) => (
            <tr key={i}><td><Link to={`/contratos/${o.contract_id}`}>{o.subscriber_name}</Link></td>
              <td className="small">{({ 'subscriber.provision': 'provisionar', 'subscriber.suspend': 'suspender', 'subscriber.resume': 'reativar', 'subscriber.disconnect': 'desconectar' } as any)[o.action] ?? o.action}</td>
              <td className="small muted">{o.status.toLowerCase()}</td></tr>
          ))}</tbody></table>
        </State>
      </Card>
    </div>
  );
}
export { Field, Modal };
