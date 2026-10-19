import useSWR from "swr";
import { ArrowUpRight, CalendarDays, Users, FileText, CircleDollarSign, Gauge } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { api } from "@/platform/erp-client";
import { money, date } from "@/lib/format";
import { canAccessPath, canonicalErpPath } from "./navigation";
export function ErpOverview() {
 const { me } = useSession(); const navigate = useNavigate();
 const dashboard = useSWR("erp-dashboard", () => api<{ subscribers: number; contracts: number; plans: number; mrr_cents: number }>("/dashboard"));
 const today = useSWR("erp-today", () => api<{ name: string; items: { title: string; detail?: string; n: number; severity: string; link: string }[] }>("/today"), { refreshInterval: 30000 });
 const metrics = dashboard.data ? [{ label: "Assinantes ativos", value: dashboard.data.subscribers.toLocaleString("pt-BR"), icon: Users, path: "/assinantes" }, { label: "Contratos vigentes", value: dashboard.data.contracts.toLocaleString("pt-BR"), icon: FileText, path: "/contratos" }, { label: "Planos à venda", value: dashboard.data.plans.toLocaleString("pt-BR"), icon: Gauge, path: "/planos" }, { label: "Receita mensal contratada", value: money(dashboard.data.mrr_cents / 100), icon: CircleDollarSign, path: "/contratos" }] : [];
 return <><PageHeading title="A operação, em perspectiva." description={`Olá, ${me?.name.split(" ")[0]}. Cada conexão conta. Tenha o todo à vista.`} actions={<span className="date-chip"><CalendarDays size={15} />{date(new Date().toISOString())}</span>} /><ConnectedNotice demo={me?.demo} /><QueryBoundary loading={dashboard.isLoading} error={dashboard.error} retry={() => dashboard.mutate()}><section className="metrics-grid" aria-label="Indicadores do provedor">{metrics.map(metric => <div className="metric-card" key={metric.label}><div className="metric-heading"><span>{metric.label}</span><metric.icon size={18} /></div><div className="metric-main"><strong>{metric.value}</strong></div><button className="profile-text-action" onClick={() => navigate(metric.path)}>Consultar<ArrowUpRight size={13} /></button></div>)}</section></QueryBoundary><div className="erp-stack"><Panel title="O que pede sua atenção" description="Prioridades calculadas para seu perfil e módulos."><QueryBoundary loading={today.isLoading} error={today.error} retry={() => today.mutate()}>{today.data?.items.filter(item => canAccessPath(me, canonicalErpPath(item.link.split("?")[0]))).map(item => <button key={item.title} className="attention-item" onClick={() => { const [path, query] = item.link.split("?"); navigate(`${canonicalErpPath(path)}${query ? `?${query}` : ""}`); }}><span className="attention-icon"><strong>{item.n}</strong></span><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowUpRight size={16} /></button>)}{today.data && !today.data.items.length && <p className="profile-footnote">Nenhuma pendência disponível para você.</p>}</QueryBoundary></Panel></div></>;
}
