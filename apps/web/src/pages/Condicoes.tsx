import { useState } from 'react';
import { api, d, dt, money, useLoad } from '../api';
import { can, useMe } from '../App';
import { ActionButton, Badge, Card, Field, Form, KV, State } from '../ui';

const CHANGE: Record<string, string> = { plan_change: 'Troca de plano', due_day: 'Troca do vencimento', end: 'Encerramento' };
const STATUS: Record<string, ['green' | 'red' | 'amber' | 'gray', string]> = { pending: ['amber', 'agendada'], applied: ['green', 'aplicada'], canceled: ['gray', 'cancelada'], failed: ['red', 'falhou'] };
const AMEND: Record<string, string> = { address: 'Endereço', holder: 'Titularidade', plan: 'Plano', condition: 'Condição', other: 'Outro' };

/** Cotação de encerramento (multa de fidelidade e títulos em aberto). */
export function useQuote(contractId: string, enabled = true) {
  return useLoad<any>(enabled ? `/contracts/${contractId}/termination-quote` : null);
}

/** Aba "Condições" do contrato: fidelidade, descontos, mudanças agendadas, aditivos e indicação. */
export function ContractConditions({ contract, onChange }: { contract: any; onChange: () => void }) {
  const { me } = useMe();
  const active = contract.status === 'active';
  const wc = can(me, 'contracts:write') && active;
  const wf = can(me, 'finance:write') && active;
  const quote = useQuote(contract.id);
  const discounts = useLoad<any[]>(`/contracts/${contract.id}/discounts`);
  const sched = useLoad<any[]>(`/contracts/${contract.id}/scheduled-changes`);
  const amend = useLoad<any[]>(`/contracts/${contract.id}/amendments`);
  const plans = useLoad<any[]>(wc ? '/plans' : null);
  const [loy, setLoy] = useState<any>(null);
  const [dsc, setDsc] = useState<any>(null);
  const [sc, setSc] = useState<any>(null);
  const [am, setAm] = useState<any>(null);
  const q = quote.data;
  return (<>
    <Card title="Fidelidade" actions={wc && <button className="sm" onClick={() => setLoy({ months: contract.loyalty_until ? '12' : '12', model: contract.penalty_model ?? 'fixed', cents: contract.penalty_cents != null ? String(contract.penalty_cents / 100) : '' })}>Definir</button>}>
      <State loading={quote.loading && !q} error={quote.error}>
        {q && (q.loyalty_until
          ? <KV items={[
              ['Carência até', <>{d(q.loyalty_until)} {q.within_loyalty ? <Badge tone="amber">em vigor</Badge> : <Badge>cumprida</Badge>}</>],
              ['Multa', q.penalty_model === 'monthly' ? `${money(q.penalty_unit_cents ?? 0)} por mês restante` : money(q.penalty_unit_cents ?? 0)],
              ['Se encerrar hoje', q.within_loyalty ? <b>{money(q.penalty_cents)} de multa ({q.remaining_months} mês(es) restante(s))</b> : 'sem multa'],
              ['Faturas em aberto', `${q.open_invoices} · ${money(q.open_invoices_cents)}`],
            ]} />
          : <p className="muted">Sem fidelidade neste contrato.</p>)}
      </State>
      {loy && (
        <Form submit="Salvar" onCancel={() => setLoy(null)} onSubmit={async () => {
          await api(`/contracts/${contract.id}/loyalty`, { method: 'PUT', body: loy.months === '' ? { months: null }
            : { months: Number(loy.months), penalty_model: loy.model, penalty_cents: Math.round(Number(String(loy.cents).replace(',', '.')) * 100) } });
          setLoy(null); quote.reload(); onChange();
        }}>
          <div className="cols3">
            <Field label="Meses de carência (vazio remove)"><input type="number" min="1" max="60" value={loy.months} onChange={(e) => setLoy({ ...loy, months: e.target.value })} /></Field>
            <Field label="Modelo da multa"><select value={loy.model} onChange={(e) => setLoy({ ...loy, model: e.target.value })}><option value="fixed">Valor único</option><option value="monthly">Por mês restante</option></select></Field>
            <Field label="Valor (R$)"><input inputMode="decimal" value={loy.cents} onChange={(e) => setLoy({ ...loy, cents: e.target.value })} required={loy.months !== ''} /></Field>
          </div>
        </Form>
      )}
    </Card>

    <Card title="Descontos" actions={wf && <button className="sm" onClick={() => setDsc({ kind: 'percent', value: '10', reason: '', months: '3', from: '' })}>Novo desconto</button>}>
      {dsc && (
        <Form submit="Lançar desconto" onCancel={() => setDsc(null)} onSubmit={async () => {
          await api(`/contracts/${contract.id}/discounts`, { body: { kind: dsc.kind, value: dsc.kind === 'percent' ? Number(dsc.value) : Math.round(Number(String(dsc.value).replace(',', '.')) * 100),
            reason: dsc.reason, months: dsc.months ? Number(dsc.months) : null, from_competence: dsc.from || undefined } });
          setDsc(null); discounts.reload();
        }}>
          <div className="cols3">
            <Field label="Tipo"><select value={dsc.kind} onChange={(e) => setDsc({ ...dsc, kind: e.target.value })}><option value="percent">Percentual</option><option value="fixed">Valor (R$)</option></select></Field>
            <Field label={dsc.kind === 'percent' ? 'Percentual' : 'Valor (R$)'}><input inputMode="decimal" value={dsc.value} onChange={(e) => setDsc({ ...dsc, value: e.target.value })} required /></Field>
            <Field label="Por quantos meses (vazio = até cancelar)"><input type="number" min="1" max="120" value={dsc.months} onChange={(e) => setDsc({ ...dsc, months: e.target.value })} /></Field>
          </div>
          <div className="cols3">
            <Field label="Motivo"><input value={dsc.reason} minLength={3} maxLength={120} onChange={(e) => setDsc({ ...dsc, reason: e.target.value })} required /></Field>
            <Field label="A partir de (opcional)" hint="Sem data: vale da próxima mensalidade a gerar."><input type="date" value={dsc.from} onChange={(e) => setDsc({ ...dsc, from: e.target.value })} /></Field>
          </div>
        </Form>
      )}
      <State empty={discounts.data?.length === 0} emptyText="Nenhum desconto.">
        <table><thead><tr><th>Desconto</th><th>Motivo</th><th>Desde</th><th>Prazo</th><th></th></tr></thead>
          <tbody>{discounts.data?.map((x) => (
            <tr key={x.id}><td>{x.kind === 'percent' ? `${x.value}%` : money(x.value)} {x.canceled_at ? <Badge>cancelado</Badge> : x.current ? <Badge tone="green">vigente</Badge> : <Badge>encerrado</Badge>}</td>
              <td className="small">{x.reason}</td><td className="small">{d(x.from_competence)}</td><td className="small">{x.months ? `${x.months} mês(es)` : 'até cancelar'}</td>
              <td>{wf && !x.canceled_at && <ActionButton className="sm danger" confirm="Cancelar este desconto? Faturas já geradas não mudam." onClick={async () => { await api(`/discounts/${x.id}`, { method: 'DELETE' }); discounts.reload(); }}>Cancelar</ActionButton>}</td></tr>
          ))}</tbody></table>
      </State>
    </Card>

    <Card title="Mudanças agendadas" actions={wc && <button className="sm" onClick={() => setSc({ kind: 'plan_change', date: '', plan_id: '', due_day: '10', penalty: 'charge', waive: '' })}>Agendar</button>}>
      {sc && (
        <Form submit="Agendar" onCancel={() => setSc(null)} onSubmit={async () => {
          await api(`/contracts/${contract.id}/scheduled-changes`, { body: { kind: sc.kind, effective_date: sc.date,
            plan_id: sc.kind === 'plan_change' ? sc.plan_id : null, due_day: sc.kind === 'due_day' ? Number(sc.due_day) : null,
            penalty: sc.kind === 'end' && q?.within_loyalty ? sc.penalty : null, penalty_waive_reason: sc.kind === 'end' && sc.penalty === 'waive' ? sc.waive : null } });
          setSc(null); sched.reload();
        }}>
          <div className="cols3">
            <Field label="O que muda"><select value={sc.kind} onChange={(e) => setSc({ ...sc, kind: e.target.value })}>{Object.entries(CHANGE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Na data"><input type="date" value={sc.date} onChange={(e) => setSc({ ...sc, date: e.target.value })} required /></Field>
            {sc.kind === 'plan_change' && <Field label="Novo plano"><select value={sc.plan_id} onChange={(e) => setSc({ ...sc, plan_id: e.target.value })} required><option value="">Selecione…</option>
              {plans.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
            {sc.kind === 'due_day' && <Field label="Novo dia de vencimento"><input type="number" min="1" max="28" value={sc.due_day} onChange={(e) => setSc({ ...sc, due_day: e.target.value })} required /></Field>}
          </div>
          {sc.kind === 'end' && q?.within_loyalty && (
            <div className="cols3">
              <Field label={`Multa de fidelidade (${money(q.penalty_cents)} hoje)`}><select value={sc.penalty} onChange={(e) => setSc({ ...sc, penalty: e.target.value })}>
                <option value="charge">Cobrar na data</option><option value="waive">Dispensar</option></select></Field>
              {sc.penalty === 'waive' && <Field label="Motivo da dispensa"><input value={sc.waive} minLength={5} maxLength={200} onChange={(e) => setSc({ ...sc, waive: e.target.value })} required /></Field>}
            </div>
          )}
        </Form>
      )}
      <State empty={sched.data?.length === 0} emptyText="Nada agendado.">
        <table><tbody>{sched.data?.map((s) => (
          <tr key={s.id}><td>{CHANGE[s.kind]}{s.kind === 'plan_change' && s.plan_name ? `: ${s.plan_name}` : ''}{s.kind === 'due_day' ? `: dia ${s.due_day}` : ''}</td>
            <td className="small">{d(s.effective_date)}</td><td><Badge tone={STATUS[s.status][0]}>{STATUS[s.status][1]}</Badge>{s.error && <div className="small muted">{s.error}</div>}</td>
            <td>{wc && s.status === 'pending' && <ActionButton className="sm danger" onClick={async () => { await api(`/scheduled-changes/${s.id}`, { method: 'DELETE' }); sched.reload(); }}>Cancelar</ActionButton>}</td></tr>
        ))}</tbody></table>
      </State>
    </Card>

    <Card title="Aditivos" actions={wc && <button className="sm" onClick={() => setAm({ kind: 'condition', title: '', body: '' })}>Novo aditivo</button>}>
      {am && (
        <Form submit="Registrar" onCancel={() => setAm(null)} onSubmit={async () => { await api(`/contracts/${contract.id}/amendments`, { body: am }); setAm(null); amend.reload(); onChange(); }}>
          <div className="cols3">
            <Field label="Tipo"><select value={am.kind} onChange={(e) => setAm({ ...am, kind: e.target.value })}>{Object.entries(AMEND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Título"><input value={am.title} minLength={3} maxLength={120} onChange={(e) => setAm({ ...am, title: e.target.value })} required /></Field>
          </div>
          <Field label="O que foi acordado"><textarea rows={3} value={am.body} maxLength={4000} onChange={(e) => setAm({ ...am, body: e.target.value })} required /></Field>
          <p className="small muted">Registro do que foi combinado; não substitui assinatura do assinante.</p>
        </Form>
      )}
      <State empty={amend.data?.length === 0} emptyText="Nenhum aditivo.">
        <table><tbody>{amend.data?.map((a) => (
          <tr key={a.id}><td><b>{a.title}</b> <Badge>{AMEND[a.kind]}</Badge><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div>
            <div className="small muted">vigência {d(a.effective_date)} · {dt(a.created_at)} · {a.created_by_name ?? 'sistema'}</div></td></tr>
        ))}</tbody></table>
      </State>
    </Card>
  </>);
}
