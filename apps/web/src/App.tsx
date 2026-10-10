import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './api';
import { Account } from './pages/Account';
import { Audit } from './pages/Audit';
import { ContractDetail, Contracts } from './pages/Contracts';
import { CrmReport, Leads, Tickets } from './pages/Crm';
import { Dashboard } from './pages/Dashboard';
import { Ftth, Stock, WorkOrders } from './pages/Field';
import { FinanceSettings, Invoices, Reconciliation } from './pages/Finance';
import { Import } from './pages/Import';
import { Ipam } from './pages/Ipam';
import { Login } from './pages/Login';
import { Network, Operations } from './pages/Network';
import { Noc } from './pages/Noc';
import { Onus } from './pages/Olt';
import { Plans } from './pages/Plans';
import { Portal } from './pages/Portal';
import { SubscriberDetail, Subscribers } from './pages/Subscribers';
import { Tenants } from './pages/Tenants';
import { Users } from './pages/Users';
import { ActionButton } from './ui';

export interface Me {
  id: string; name: string; email: string; role: string; perms: string[]; support: boolean; demo: boolean; mfa_enabled: boolean; mfa_pending: boolean;
  tenant: { id: string; name: string; slug: string } | null;
}
const MeCtx = createContext<{ me: Me; reload: () => Promise<void> }>(null as any);
export const useMe = () => useContext(MeCtx);
export const can = (me: Me, perm: string) => me.perms.includes(perm);

const ROLE_LABEL: Record<string, string> = {
  saas_operator: 'Operador do SaaS', admin: 'Administrador', attendant: 'Atendimento', finance: 'Financeiro', noc: 'Técnico/NOC', subscriber: 'Assinante',
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const nav = useNavigate();
  const reload = async () => {
    try {
      setMe(await api<Me>('/me'));
    } catch {
      setMe(null);
    }
  };
  useEffect(() => {
    reload();
  }, []);

  if (me === undefined) return <div className="state">Carregando…</div>;
  if (!me) return (
    <Routes>
      <Route path="/login" element={<Login onLogin={reload} />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setMe(null);
    nav('/login');
  };
  if (me.role === 'subscriber') return <MeCtx.Provider value={{ me, reload }}><Portal /></MeCtx.Provider>;
  const inTenant = !!me.tenant && !me.mfa_pending;
  const link = (to: string, label: string, perm?: string) =>
    (!perm || can(me, perm)) && <NavLink to={to} end={to === '/'}>{label}</NavLink>;

  return (
    <MeCtx.Provider value={{ me, reload }}>
      <div className="shell">
        <nav className="side">
          <div className="logo">Nexo<span>ISP</span></div>
          {me.role === 'saas_operator' && !me.support && !me.mfa_pending && link('/provedores', 'Provedores')}
          {inTenant && (<>
            {link('/', 'Início', 'subscribers:read')}
            <div className="group">Cadastro</div>
            {link('/assinantes', 'Assinantes', 'subscribers:read')}
            {link('/planos', 'Planos', 'plans:read')}
            {link('/contratos', 'Contratos', 'contracts:read')}
            {(can(me, 'crm:read') || can(me, 'os:read')) && <div className="group">Atendimento</div>}
            {link('/atendimentos', 'Atendimentos', 'crm:read')}
            {link('/prospectos', 'Prospectos', 'crm:read')}
            {link('/ordens-servico', 'Ordens de serviço', 'os:read')}
            {link('/estoque', 'Estoque', 'stock:read')}
            {link('/relatorios-atendimento', 'Relatórios', 'crm:read')}
            {can(me, 'finance:read') && <div className="group">Financeiro</div>}
            {link('/faturas', 'Faturas', 'finance:read')}
            {link('/conciliacao', 'Conciliação', 'finance:read')}
            {link('/politica-cobranca', 'Política de cobrança', 'finance:read')}
            {can(me, 'network:read') && <div className="group">Rede</div>}
            {link('/noc', 'NOC', 'network:read')}
            {link('/rede', 'Agentes e equipamentos', 'network:read')}
            {link('/onus', 'ONUs', 'network:read')}
            {link('/ftth', 'Rede óptica (FTTH)', 'network:read')}
            {link('/ipam', 'Endereços IP e CGNAT', 'network:read')}
            {link('/operacoes', 'Operações', 'network:read')}
            {(can(me, 'users:manage') || can(me, 'audit:read')) && <div className="group">Administração</div>}
            {link('/usuarios', 'Usuários', 'users:manage')}
            {link('/importacao', 'Importação', 'import:run')}
            {link('/auditoria', 'Auditoria', 'audit:read')}
          </>)}
          <div className="who">
            <b>{me.name}</b>
            {ROLE_LABEL[me.role]}{me.tenant && <> · {me.tenant.name}</>}
            <NavLink to="/conta" style={{ padding: '6px 0 0' }}>Minha conta</NavLink>
            <button onClick={logout}>Sair</button>
          </div>
        </nav>
        <div className="main">
          {me.demo && <div className="banner">Ambiente de demonstração — dados sintéticos; integrações externas simuladas são identificadas nas telas.</div>}
          {me.support && (
            <div className="banner support">
              <span>Acesso de suporte ao provedor <b>{me.tenant?.name}</b> — todas as ações são auditadas.</span>
              <ActionButton className="sm" onClick={async () => { await api('/support/exit', { method: 'POST' }); await reload(); nav('/provedores'); }}>Encerrar suporte</ActionButton>
            </div>
          )}
          <Routes>
            {inTenant ? (<>
              <Route path="/" element={<Dashboard />} />
              <Route path="/assinantes" element={<Subscribers />} />
              <Route path="/assinantes/:id" element={<SubscriberDetail />} />
              <Route path="/planos" element={<Plans />} />
              <Route path="/contratos" element={<Contracts />} />
              <Route path="/contratos/:id" element={<ContractDetail />} />
              <Route path="/faturas" element={<Invoices />} />
              <Route path="/conciliacao" element={<Reconciliation />} />
              <Route path="/politica-cobranca" element={<FinanceSettings />} />
              <Route path="/rede" element={<Network />} />
              <Route path="/onus" element={<Onus />} />
              <Route path="/operacoes" element={<Operations />} />
              <Route path="/noc" element={<Noc />} />
              <Route path="/ftth" element={<Ftth />} />
              <Route path="/ipam" element={<Ipam />} />
              <Route path="/atendimentos" element={<Tickets />} />
              <Route path="/prospectos" element={<Leads />} />
              <Route path="/ordens-servico" element={<WorkOrders />} />
              <Route path="/estoque" element={<Stock />} />
              <Route path="/relatorios-atendimento" element={<CrmReport />} />
              <Route path="/usuarios" element={<Users />} />
              <Route path="/importacao" element={<Import />} />
              <Route path="/auditoria" element={<Audit />} />
            </>) : !me.mfa_pending && (
              <Route path="/provedores" element={<Tenants />} />
            )}
            <Route path="/conta" element={<Account />} />
            <Route path="*" element={<Navigate to={me.mfa_pending ? '/conta' : inTenant ? '/' : '/provedores'} replace />} />
          </Routes>
        </div>
      </div>
    </MeCtx.Provider>
  );
}
