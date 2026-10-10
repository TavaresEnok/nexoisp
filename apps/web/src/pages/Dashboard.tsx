import { Link } from 'react-router-dom';
import { money, useLoad } from '../api';
import { can, useMe } from '../App';
import { Card, Page, State } from '../ui';
import { HealthCards } from './Network';

export function Dashboard() {
  const { me } = useMe();
  const { data, loading, error } = useLoad('/dashboard');
  return (
    <Page title="Início">
      <State loading={loading} error={error}>
        {data && (
          <div className="grid">
            <Card><div className="stat"><b>{data.subscribers}</b><span>Assinantes ativos</span></div><Link to="/assinantes">ver assinantes</Link></Card>
            <Card><div className="stat"><b>{data.contracts}</b><span>Contratos ativos</span></div><Link to="/contratos">ver contratos</Link></Card>
            <Card><div className="stat"><b>{data.plans}</b><span>Planos ativos</span></div><Link to="/planos">ver planos</Link></Card>
            <Card><div className="stat"><b>{money(data.mrr_cents)}</b><span>Receita mensal contratada</span></div></Card>
          </div>
        )}
      </State>
      {can(me, 'network:read') && <><h3 style={{ margin: '18px 0 10px' }}>Operação de rede</h3><HealthCards /></>}
    </Page>
  );
}
