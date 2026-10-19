import { Activity, CircleDollarSign, Clock3, Headphones, Network, Radio, ShieldCheck, Users, Wallet } from "lucide-react";
import { clock, money, number } from "@/lib/format";
import type { RevenuePoint, WorkspaceData } from "@/lib/types";

export function revenueTrend(series: RevenuePoint[]) {
  const last = series.at(-1);
  if (!last || last.previous <= 0) return null;
  const change = ((last.current - last.previous) / last.previous) * 100;
  return { change, label: `${Math.abs(change).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`, down: change < 0 };
}

export type OverviewArea = "overview" | "financial" | "network" | "support";
export const overviewAreas = [
  { value: "overview", label: "Visão geral", icon: Activity },
  { value: "financial", label: "Financeiro", icon: Wallet },
  { value: "network", label: "Rede", icon: Radio },
  { value: "support", label: "Atendimento", icon: Headphones },
] as const;

export function getOverviewMetrics(area: OverviewArea, data: WorkspaceData) {
  const s = data.snapshot;
  const percentage = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
  const connected = s.active ? (s.online / s.active) * 100 : 0;
  const received = s.billed ? (s.received / s.billed) * 100 : 0;
  const activeTickets = data.tickets.filter(ticket => ticket.status !== "Resolvido");
  const growthBase = s.active - s.newSubscribers;
  const growth = growthBase > 0 ? percentage((s.newSubscribers / growthBase) * 100) : "Novo";
  const readAt = clock(s.asOf);
  const metrics = {
    overview: [
      { title: "Base ativa", value: number(s.active), icon: Users, change: growth, detail: `+${s.newSubscribers} novas conexões neste mês`, href: "/assinantes" },
      { title: "Conectados agora", value: number(s.online), icon: Radio, change: percentage(connected), detail: "da sua base está conectada", href: "/rede/online", neutral: true },
      { title: "Receita recebida", value: money(s.received).replace(",00", ""), icon: CircleDollarSign, change: percentage(received), detail: "do faturamento recebido no mês", href: "/financeiro", neutral: true },
      { title: "Atendimento", value: number(s.ticketsOpen), icon: Headphones, change: `${s.waiting} na fila`, detail: "chamados em aberto no cenário", href: "/atendimentos", neutral: true },
    ],
    financial: [
      { title: "Receita recorrente", value: money(s.mrr).replace(",00", ""), icon: CircleDollarSign, change: "Competência", detail: "mensalidades dos contratos vigentes", href: "/financeiro", neutral: true },
      { title: "Receita recebida", value: money(s.received).replace(",00", ""), icon: Wallet, change: percentage(received), detail: "do faturamento recebido no mês", href: "/financeiro", neutral: true },
      { title: "Inadimplência", value: percentage(s.delinquency), icon: Clock3, change: "Vencidas", detail: `${money(s.overdue)} em faturas vencidas`, href: "/financeiro?filtro=vencidas", neutral: true },
      { title: "Faturas em aberto", value: number(s.openInvoices), icon: Wallet, change: `${s.reconciliation} a conciliar`, detail: "recebimentos que pedem sua atenção", href: "/financeiro?filtro=conciliacao", neutral: true },
    ],
    network: [
      { title: "Conectados agora", value: number(s.online), icon: Users, change: percentage(connected), detail: "da sua base está conectada", href: "/rede/online", neutral: true },
      { title: "Disponibilidade", value: percentage(s.availability), icon: ShieldCheck, change: "30 dias", detail: "conexões que não param no cenário", href: "/rede/equipamentos", neutral: true },
      { title: "Latência média", value: `${s.latency.toLocaleString("pt-BR")} ms`, icon: Activity, change: readAt, detail: "última leitura do cenário", href: "/rede/equipamentos", neutral: true },
      { title: "Sinal fora do ideal", value: number(s.onusDegraded), icon: Network, change: "Atenção", detail: "ONUs com sinal óptico degradado", href: "/rede/equipamentos?filtro=atencao", neutral: true },
    ],
    support: [
      { title: "Atendimento", value: number(s.ticketsOpen), icon: Headphones, change: "Em aberto", detail: "o que merece sua atenção hoje", href: "/atendimentos", neutral: true },
      { title: "Aguardando resposta", value: number(s.waiting), icon: Clock3, change: "Na fila", detail: "clientes esperando o próximo passo", href: "/atendimentos?filtro=aguardando", neutral: true },
      { title: "Prioridade alta", value: number(activeTickets.filter(ticket => ticket.priority === "Alta").length), icon: ShieldCheck, change: "Recorte", detail: "chamados listados no workspace", href: "/atendimentos", neutral: true },
      { title: "SLA em risco", value: number(activeTickets.filter(ticket => ticket.sla === "Em risco").length), icon: Activity, change: "Recorte", detail: "chamados listados que pedem agilidade", href: "/atendimentos", neutral: true },
    ],
  };
  return metrics[area];
}

export function getOverviewBreakdown(area: "network" | "support", data: WorkspaceData) {
  if (area === "network") {
    return data.nodes.map(node => ({ name: node.name, value: node.traffic }));
  }
  const counts = new Map<string, number>();
  for (const ticket of data.tickets) counts.set(ticket.status, (counts.get(ticket.status) ?? 0) + 1);
  return Array.from(counts, ([name, value]) => ({ name, value }));
}

export const overviewActivityTypes: Record<OverviewArea, readonly string[]> = {
  overview: ["payment", "network", "order", "ticket"],
  financial: ["payment"],
  network: ["network"],
  support: ["ticket", "order"],
};
