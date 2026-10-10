import { useState } from 'react';
import { api, d, doc, money, speed, useLoad } from '../api';
import { useMe } from '../App';
import { Badge, Card, KV, Modal, State } from '../ui';
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
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '20px 16px 40px' }}>
      <header className="page-head">
        <h1>Nexo<span style={{ color: 'var(--brand)' }}>ISP</span> <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>· {me.tenant?.name}</span></h1>
        <div className="row"><span className="muted">{me.name}</span><button onClick={logout}>Sair</button></div>
      </header>
      {me.demo && <div className="banner" style={{ marginBottom: 12, borderRadius: 8 }}>Ambiente de demonstração — meios de pagamento exibidos são fictícios.</div>}
      <State loading={loading} error={error}>
        {data && (<>
          <Card title="Meus dados">
            <KV items={[['Nome', data.subscriber.name], ['CPF/CNPJ', doc(data.subscriber.document)], ['E-mail', data.subscriber.email], ['Telefone', data.subscriber.phone],
              ['Endereço', [data.subscriber.address_street, data.subscriber.address_number, data.subscriber.address_city].filter(Boolean).join(', ') || '—']]} />
          </Card>
          <Card title="Meus planos">
            <State empty={data.contracts.length === 0}>
              <table>
                <thead><tr><th>Plano</th><th>Velocidade</th><th className="num">Mensalidade</th><th>Vencimento</th><th>Situação do acesso</th></tr></thead>
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
          <PortalTickets />
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
