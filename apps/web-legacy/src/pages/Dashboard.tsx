import { Link } from 'react-router-dom';
import { money, useLoad } from '../api';
import { can, useMe } from '../App';
import { Card, Page, State } from '../ui';
import { Panels } from './Cobranca';


/** Início: primeiro o que pede ação de quem entrou; depois os números do provedor. */
export function Dashboard() {
  const today = useLoad<any>('/today', 30000);
  const { me } = useMe();
  const { data, loading, error } = useLoad('/dashboard');
  const first = today.data?.name?.split(' ')[0];
  const hour = new Date().getHours();
  return (
    <Page title={`${hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'}${first ? `, ${first}` : ''}`}
      sub={today.data ? (today.data.items.length ? 'Isto pede a sua atenção agora.' : 'Nada pendente para você agora.') : undefined}>
      <State loading={today.loading && !today.data} error={today.error}>
        {today.data && today.data.items.length > 0 && (
          <Card>
            <ul className="todo">{today.data.items.map((i: any) => (
              <li key={i.title} className={`sev-${i.severity}`}>
                <span className="n">{i.n}</span>
                <span className="what"><b>{i.title}</b>{i.detail && <small>{i.detail}</small>}</span>
                <Link className="btn sm" to={i.link}>Abrir</Link>
              </li>
            ))}</ul>
          </Card>
        )}
      </State>
      <State loading={loading} error={error}>
        {data && (
          <div className="grid">
            <Card><div className="stat"><b>{data.subscribers}</b><span>assinantes ativos</span></div><Link to="/assinantes">Ver assinantes</Link></Card>
            <Card><div className="stat"><b>{data.contracts}</b><span>contratos vigentes</span></div><Link to="/contratos">Ver contratos</Link></Card>
            <Card><div className="stat"><b>{data.plans}</b><span>planos à venda</span></div><Link to="/planos">Ver planos</Link></Card>
            <Card><div className="stat"><b>{money(data.mrr_cents)}</b><span>receita mensal contratada</span></div></Card>
          </div>
        )}
      </State>
      {can(me, 'network:read') && <Panels />}
    </Page>
  );
}
