import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { Account } from './pages/Account';
import { Audit } from './pages/Audit';
import { ContractDetail, Contracts } from './pages/Contracts';
import { CrmReport, Leads, Tickets } from './pages/Crm';
import { Dashboard } from './pages/Dashboard';
import { Ftth, MyWork, Stock, WorkOrders } from './pages/Field';
import { FinanceSettings, Invoices, Reconciliation } from './pages/Finance';
import { Import } from './pages/Import';
import { Ipam } from './pages/Ipam';
import { Login } from './pages/Login';
import { Network, Operations } from './pages/Network';
import { Noc } from './pages/Noc';
import { Notices } from './pages/Notices';
import { Onus } from './pages/Olt';
import { Plans } from './pages/Plans';
import { Portal } from './pages/Portal';
import { SubscriberDetail, Subscribers } from './pages/Subscribers';
import { Tenants } from './pages/Tenants';
import { Users } from './pages/Users';
import { ActionButton, Brand, Icon } from './ui';

export interface Me {
  id: string; name: string; email: string; role: string; perms: string[]; modules: string[]; support: boolean; demo: boolean; mfa_enabled: boolean; mfa_pending: boolean;
  tenant: { id: string; name: string; slug: string } | null;
}
const MeCtx = createContext<{ me: Me; reload: () => Promise<void> }>(null as any);
export const useMe = () => useContext(MeCtx);
export const can = (me: Me, perm: string) => me.perms.includes(perm);
/** Módulo adicional liberado para o provedor (o servidor aplica a mesma regra). */
export const has = (me: Me, mod: string) => me.modules.includes(mod);

const ROLE_LABEL: Record<string, string> = {
  saas_operator: 'Operador do SaaS', admin: 'Administrador', attendant: 'Atendimento', finance: 'Financeiro', noc: 'Técnico/NOC', subscriber: 'Assinante',
};

/** Menu por área. A cor de cada área segue o código de cores da fibra óptica (ver styles.css). */
const NAV: { id: string; label: string; items: { to: string; label: string; icon: string; perm: string; mod?: string }[] }[] = [
  { id: 'inicio', label: '', items: [{ to: '/', label: 'Início', icon: 'home', perm: 'subscribers:read' }] },
  { id: 'cadastro', label: 'Cadastro', items: [
    { to: '/assinantes', label: 'Assinantes', icon: 'users', perm: 'subscribers:read' }, { to: '/planos', label: 'Planos', icon: 'gauge', perm: 'plans:read' },
    { to: '/contratos', label: 'Contratos', icon: 'doc', perm: 'contracts:read' }] },
  { id: 'atendimento', label: 'Atendimento', items: [
    { to: '/atendimentos', label: 'Atendimentos', icon: 'chat', perm: 'crm:read', mod: 'crm' }, { to: '/prospectos', label: 'Prospectos', icon: 'funnel', perm: 'crm:read', mod: 'crm' },
    { to: '/meu-trabalho', label: 'Meu trabalho', icon: 'phone', perm: 'os:write', mod: 'field' }, { to: '/ordens-servico', label: 'Ordens de serviço', icon: 'wrench', perm: 'os:read', mod: 'field' },
    { to: '/estoque', label: 'Estoque', icon: 'box', perm: 'stock:read', mod: 'field' }, { to: '/relatorios-atendimento', label: 'Relatórios', icon: 'chart', perm: 'crm:read', mod: 'crm' }] },
  { id: 'financeiro', label: 'Financeiro', items: [
    { to: '/faturas', label: 'Faturas', icon: 'receipt', perm: 'finance:read' }, { to: '/conciliacao', label: 'Conciliação', icon: 'scale', perm: 'finance:read' },
    { to: '/politica-cobranca', label: 'Política de cobrança', icon: 'sliders', perm: 'finance:read' }] },
  { id: 'rede', label: 'Rede', items: [
    { to: '/noc', label: 'NOC', icon: 'pulse', perm: 'network:read', mod: 'noc' }, { to: '/rede', label: 'Agentes e equipamentos', icon: 'server', perm: 'network:read' },
    { to: '/onus', label: 'ONUs', icon: 'onu', perm: 'network:read', mod: 'olt' }, { to: '/ftth', label: 'Rede óptica', icon: 'fiber', perm: 'network:read', mod: 'ftth' },
    { to: '/ipam', label: 'Endereços IP e CGNAT', icon: 'ip', perm: 'network:read', mod: 'ipam' }, { to: '/operacoes', label: 'Operações', icon: 'list', perm: 'network:read' }] },
  { id: 'admin', label: 'Administração', items: [
    { to: '/usuarios', label: 'Usuários', icon: 'user', perm: 'users:manage' }, { to: '/avisos', label: 'Avisos', icon: 'bell', perm: 'settings:manage', mod: 'notices' },
    { to: '/importacao', label: 'Importação', icon: 'upload', perm: 'import:run' }, { to: '/auditoria', label: 'Auditoria', icon: 'shield', perm: 'audit:read' }] },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const nav = useNavigate();
  const loc = useLocation();
  const [menu, setMenu] = useState(false);   // no celular o menu abre e fecha
  const [find, setFind] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('nexo_nav') ?? '{}'); } catch { return {}; } });
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
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
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => can(me, i.perm) && (!i.mod || has(me, i.mod)) && (!find || i.label.toLowerCase().includes(find.toLowerCase()))) })).filter((g) => g.items.length);
  const area = NAV.find((g) => g.items.some((i) => (i.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(i.to))))?.id
    ?? (loc.pathname.startsWith('/contratos') || loc.pathname.startsWith('/assinantes') ? 'cadastro' : 'admin');
  const toggle = (id: string) => { const n = { ...closed, [id]: !closed[id] }; setClosed(n); localStorage.setItem('nexo_nav', JSON.stringify(n)); };
  const flipTheme = () => { const t = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; localStorage.setItem('nexo_theme', t); setTheme(t); };

  return (
    <MeCtx.Provider value={{ me, reload }}>
      <div className="shell">
        <nav className={`side ${menu ? 'open' : ''}`} aria-label="Navegação principal" onClick={(e) => (e.target as HTMLElement).closest('a.nav') && setMenu(false)}>
          <div className="logo"><Brand /><button className="menu-btn" onClick={() => setMenu(!menu)} aria-expanded={menu}><Icon name="menu" /> Menu</button></div>
          {me.role === 'saas_operator' && !me.support && !me.mfa_pending && <NavLink className="nav" to="/provedores"><Icon name="building" />Provedores</NavLink>}
          {inTenant && (<>
            <div className="find"><Icon name="search" /><input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Ir para…" aria-label="Filtrar o menu"
              onKeyDown={(e) => { if (e.key === 'Enter' && groups[0]) { nav(groups[0].items[0].to); setFind(''); setMenu(false); } }} /></div>
            {groups.map((g) => (
              <div key={g.id} data-area={g.id}>
                {g.label && <button className="group" aria-expanded={!!find || !closed[g.id]} onClick={() => toggle(g.id)}><span className="dot" />{g.label}<Icon name="chev" /></button>}
                {(!g.label || find || !closed[g.id]) && g.items.map((i) => <NavLink key={i.to} className="nav" to={i.to} end={i.to === '/'}><Icon name={i.icon} />{i.label}</NavLink>)}
              </div>
            ))}
            {find && groups.length === 0 && <div className="state small">Nenhuma tela com esse nome.</div>}
          </>)}
          <div className="who">
            <b>{me.name}</b>
            {ROLE_LABEL[me.role]}{me.tenant && <>, {me.tenant.name}</>}
            <div className="row">
              <NavLink className="btn sm" to="/conta" style={{ flex: 1 }}><Icon name="user" />Conta</NavLink>
              <button className="sm icon" onClick={flipTheme} aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'} title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
              <button className="sm" onClick={logout}><Icon name="out" />Sair</button>
            </div>
          </div>
        </nav>
        <div className="main" data-area={area}>
          {me.demo && <div className="banner">Ambiente de demonstração: os dados são sintéticos e as integrações simuladas estão identificadas nas telas.</div>}
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
              <Route path="/meu-trabalho" element={<MyWork />} />
              <Route path="/avisos" element={<Notices />} />
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
