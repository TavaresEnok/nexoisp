import { useState } from 'react';
import { api, d, doc, money, speed, useLoad } from '../api';
import { has, useMe } from '../App';
import { Badge, Brand, Card, Icon, KV, Modal, State } from '../ui';
import { PortalTickets } from './Crm';
import { InvoiceBadge } from './Finance';

/** Portal do assinante: somente os próprios contratos, situação e faturas. */
export function Portal() {
  const { me } = useMe();
  const { data, loading, error } = useLoad<any>('/portal/overview', 15000);
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
