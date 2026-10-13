import { useState } from 'react';
import { api, d, doc, dt, money, speed, useLoad } from '../api';
import { has, useMe } from '../App';
import { ActionButton, Badge, Brand, Card, Icon, KV, Modal, State } from '../ui';
import { UsageTable } from './Extras';
import { PortalTickets } from './Crm';
import { InvoiceBadge } from './Finance';

/** Portal do assinante: somente os próprios contratos, situação e faturas. */
export function Portal() {
  const { me } = useMe();
  const { data, loading, error, reload } = useLoad<any>('/portal/overview', 15000);
  const [trustErr, setTrustErr] = useState<string | null>(null);
  const [inv, setInv] = useState<any>(null);
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); window.location.href = '/login'; };
  const service = (c: any) => {
    if (c.status !== 'active') return <Badge>Contrato encerrado</Badge>;
    if (c.desired_policy == null) return <Badge>Acesso em instalação</Badge>;
    const pending = c.desired_version !== c.observed_version;
    if (c.desired_policy === 'suspended') return <Badge tone="red">Acesso suspenso{pending ? ' (em aplicação)' : ''}</Badge>;
    return pending ? <Badge tone="amber">Liberação em andamento</Badge> : <Badge tone="green">Acesso liberado</Badge>;
  };
  const first = (data?.subscriber.name ?? me.name).split(' ')[0];
  const active = data?.contracts.filter((c: any) => c.status === 'active') ?? [];
  const suspended = active.some((c: any) => c.desired_policy === 'suspended');
  const installing = !suspended && active.some((c: any) => c.desired_policy == null);   // contrato sem acesso provisionado ainda
  const next = data?.invoices.filter((i: any) => i.status === 'open').sort((a: any, b: any) => a.due_date.localeCompare(b.due_date))[0];
  return (
    <div className="portal" data-area="rede">
      <header className="page-head" style={{ alignItems: 'center' }}>
        <div><Brand /><div className="small muted">{me.tenant?.name}</div></div>
        <button onClick={logout}><Icon name="out" />Sair</button>
      </header>
      {me.demo && <div className="banner" style={{ marginBottom: 12, borderRadius: 8 }}>Ambiente de demonstração: os meios de pagamento exibidos são fictícios.</div>}
      <State loading={loading} error={error}>
        {data && (<>
          <div className="hello"><h1>Olá, {first}</h1></div>
          {data.notices?.map((n: any) => (
            <div key={n.id} className={`state ${n.severity === 'info' ? '' : 'err'}`} style={{ marginBottom: 10 }} role="status">
              <b>{n.active ? 'Manutenção em andamento' : 'Manutenção programada'}: {n.title}</b>
              <div className="small">{n.message}</div>
              <div className="small muted">{dt(n.starts_at)} até {dt(n.ends_at)}</div>
            </div>
          ))}
          <div className="grid2">
            <Card>
              <div className={`status ${suspended ? 'bad' : installing ? 'warn' : ''}`} style={{ paddingLeft: 14 }}>
                <b>{active.length === 0 ? 'Você não tem plano ativo' : suspended ? 'Sua internet está suspensa' : installing ? 'Seu acesso está em instalação' : 'Sua internet está liberada'}</b>
                <span className="muted">{suspended ? 'Regularize a fatura em aberto ou fale com o provedor.' : active.map((c: any) => `${c.plan_name}, ${speed(c.down_kbps)}`).join(' e ')}</span>
              </div>
            </Card>
            <Card>
              <div className={`status ${next?.overdue ? 'bad' : next ? 'warn' : ''}`} style={{ paddingLeft: 14 }}>
                <b>{next ? `${money(next.amount_cents)} ${next.overdue ? 'em atraso' : `vence em ${d(next.due_date)}`}` : 'Nenhuma fatura em aberto'}</b>
                {next ? <button className="primary" style={{ marginTop: 8 }} onClick={() => setInv(next)}>Pagar agora</button> : <span className="muted">Está tudo em dia.</span>}
              </div>
            </Card>
          </div>
          {active.filter((c: any) => c.trust_release?.eligible || c.trust_release?.active_until).map((c: any) => (
            <Card key={c.id} title="Religar minha internet por alguns dias">
              {c.trust_release.active_until
                ? <p style={{ margin: 0 }}>Liberação em curso até <b>{dt(c.trust_release.active_until)}</b>. Regularize a fatura em aberto até lá para não ser suspenso de novo.</p>
                : (<>
                  <p style={{ marginTop: 0 }}>Se você ainda não conseguiu pagar, o provedor permite religar o acesso por até <b>{c.trust_release.max_days} dia(s)</b>. Depois desse prazo, sem o pagamento, a suspensão volta. Só é possível pedir uma vez por período.</p>
                  <ActionButton confirm={`Religar o acesso do plano ${c.plan_name} por ${c.trust_release.max_days} dia(s)?`} onClick={async () => {
                    setTrustErr(null);
                    try { await api('/portal/trust-release', { body: { contract_id: c.id } }); reload(); } catch (e: any) { setTrustErr(e.message ?? 'não foi possível liberar'); }
                  }}>Religar por {c.trust_release.max_days} dia(s)</ActionButton>
                  {trustErr && <div className="state err" style={{ marginTop: 8 }}>{trustErr}</div>}
                </>)}
            </Card>
          ))}
          <Card title="Meus planos">
            <State empty={data.contracts.length === 0}>
              <table>
                <thead><tr><th>Plano</th><th>Velocidade</th><th className="num">Mensalidade</th><th>Vencimento</th><th>Acesso</th></tr></thead>
                <tbody>{data.contracts.map((c: any) => (
                  <tr key={c.id}><td>{c.plan_name}</td><td>{speed(c.down_kbps)} / {speed(c.up_kbps)}</td><td className="num">{money(c.price_cents)}</td><td>dia {c.due_day}</td><td>{service(c)}</td></tr>
                ))}</tbody>
              </table>
            </State>
          </Card>
          {data.usage?.length > 0 && <Card title="Meu consumo"><UsageTable rows={data.usage} /></Card>}
          <Card title="Minhas faturas">
            <State empty={data.invoices.length === 0}>
              <table>
                <thead><tr><th>Referência</th><th>Vencimento</th><th className="num">Valor</th><th>Situação</th><th></th></tr></thead>
                <tbody>{data.invoices.map((i: any) => (
                  <tr key={i.id}><td>{i.competence ? `Mensalidade ${d(i.competence).slice(3)}` : 'Avulsa'}</td><td>{d(i.due_date)}</td><td className="num">{money(i.amount_cents)}</td>
                    <td><InvoiceBadge i={i} /></td><td>{i.status === 'open' && <button className="sm primary" onClick={() => setInv(i)}>Pagar</button>}</td></tr>
                ))}</tbody>
              </table>
            </State>
          </Card>
          {has(me, 'crm') && <PortalTickets />}
          {has(me, 'field') && <PortalSurveys />}
          <Card title="Meus dados">
            <KV items={[['Nome', data.subscriber.name], ['CPF/CNPJ', doc(data.subscriber.document)], ['E-mail', data.subscriber.email], ['Telefone', data.subscriber.phone],
              ['Endereço', [data.subscriber.address_street, data.subscriber.address_number, data.subscriber.address_city].filter(Boolean).join(', ') || '—']]} />
            <p className="small muted" style={{ marginBottom: 0 }}>Algo errado? {has(me, 'crm') ? 'Abra um chamado pedindo a correção.' : 'Fale com o provedor para corrigir.'}</p>
          </Card>
        </>)}
      </State>
      {inv && (
        <Modal title={`Pagar fatura — ${money(inv.amount_cents)}`} onClose={() => setInv(null)}>
          {inv.payment_methods ? (<>
            {inv.gateway === 'demo' && <p><Badge tone="amber">SIMULADO</Badge> <span className="small muted">Códigos fictícios; não é possível pagar de verdade neste ambiente.</span></p>}
            {Object.entries(inv.payment_methods).filter(([k]) => k !== 'aviso').map(([k, v]) => (
              <div key={k} style={{ marginBottom: 10 }}>
                <div className="small muted" style={{ fontWeight: 600 }}>{k.replace(/_/g, ' ')}</div>
                <div className="row"><code className="mono" style={{ overflowWrap: 'anywhere', flex: 1 }}>{String(v)}</code>
                  <button className="sm" onClick={() => navigator.clipboard?.writeText(String(v))}>copiar</button></div>
              </div>
            ))}
          </>) : <div className="state">Esta fatura ainda não tem meio de pagamento online. Entre em contato com o provedor.</div>}
        </Modal>
      )}
    </div>
  );
}

/** Pesquisa de satisfação das ordens de serviço concluídas. Só aparece se houver uma pendente. */
function PortalSurveys() {
  const sv = useLoad<any[]>('/portal/surveys');
  const [score, setScore] = useState<Record<string, number>>({});
  const [comment, setComment] = useState<Record<string, string>>({});
  if (!sv.data?.length) return null;
  return (
    <Card title="Como foi o atendimento?">
      {sv.data.map((s) => (
        <div key={s.id} style={{ marginBottom: 12 }}>
          <div>Ordem de serviço #{s.work_order_number}: de 1 a 5, como você avalia o serviço?</div>
          <div className="row" style={{ margin: '6px 0' }}>
            {[1, 2, 3, 4, 5].map((n) => <button key={n} className={score[s.id] === n ? 'primary' : ''} aria-pressed={score[s.id] === n} onClick={() => setScore({ ...score, [s.id]: n })}>{n}</button>)}
          </div>
          <input aria-label="Comentário (opcional)" placeholder="Comentário (opcional)" maxLength={500} value={comment[s.id] ?? ''} onChange={(e) => setComment({ ...comment, [s.id]: e.target.value })} />
          <ActionButton className="primary" disabled={!score[s.id]} onClick={async () => { await api(`/portal/surveys/${s.id}`, { body: { score: score[s.id], comment: comment[s.id] || null } }); sv.reload(); }}>Enviar avaliação</ActionButton>
        </div>
      ))}
    </Card>
  );
}
