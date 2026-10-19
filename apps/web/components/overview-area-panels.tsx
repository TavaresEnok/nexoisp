"use client";

import Link from "@/platform/navigation/link";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Panel, TextLink } from "@/components/workspace-ui";
import { getOverviewBreakdown } from "@/lib/overview";
import { money, number } from "@/lib/format";
import type { WorkspaceData } from "@/lib/types";

export function OverviewAreaChart({ area, data }: { area: "network" | "support"; data: WorkspaceData }) {
  const network = area === "network";
  const rows = getOverviewBreakdown(area, data);
  return <OverviewBreakdownPanel title={network ? "Nos bastidores da sua rede" : "Cada atendimento conta."} description={network ? "Tráfego por equipamento · leitura do cenário às 09:42" : "Distribuição dos chamados por situação"} href={network ? "/rede/equipamentos" : "/atendimentos"} actionLabel={network?"Abrir NOC":"Abrir fila"} rows={rows} summary={network ? `${rows.reduce((sum,row)=>sum+row.value,0).toLocaleString("pt-BR",{maximumFractionDigits:2})} Gbps`:number(data.tickets.length)} summaryNote={network?"tráfego agregado dos equipamentos listados":"chamados listados neste workspace"} valueLabel={network?"Tráfego · Gbps":"Chamados"} allowDecimals={network} sourceNote="Recorte dos registros demonstrativos disponíveis" />;
}

export function OverviewBreakdownPanel({title,description,href,actionLabel,rows,summary,summaryNote,valueLabel,allowDecimals=false,sourceNote}:{title:string;description:string;href:string;actionLabel:string;rows:{name:string;value:number}[];summary:string;summaryNote:string;valueLabel:string;allowDecimals?:boolean;sourceNote:string}) {
  return <Panel
    title={title}
    description={description}
    action={<TextLink href={href}>{actionLabel}</TextLink>}
    className="revenue-panel"
  >
    <div className="revenue-summary"><div><div className="revenue-number">{summary}</div><p>{summaryNote}</p></div></div>
    {rows.length ? <ChartContainer className="revenue-chart overview-breakdown-chart" config={{ value: { label: valueLabel, color: "var(--chart-1)" } }}>
      <BarChart accessibilityLayer data={rows} margin={{ top: 14, right: 12, left: -18, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="var(--border)" />
        <XAxis dataKey="name" axisLine={false} tickLine={false} fontSize={10} interval={0} tickMargin={12} tickFormatter={name => String(name).replace("-01", "")} />
        <YAxis axisLine={false} tickLine={false} fontSize={10} allowDecimals={allowDecimals} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ChartContainer> : <p className="overview-chart-empty">Nenhum registro disponível nesta área.</p>}
    <div className="revenue-footer"><span>{sourceNote}</span><TextLink href={href}>Ver detalhes</TextLink></div>
  </Panel>;
}

export function OverviewContextSummary({ area, data }: { area: "financial" | "support"; data: WorkspaceData }) {
  const s = data.snapshot;
  const financial = area === "financial";
  const received = s.billed ? (s.received / s.billed) * 100 : 0;
  const rows = financial ? [
    { label: "Faturamento do mês", value: money(s.billed), href: "/financeiro" },
    { label: "Receita recebida", value: money(s.received), href: "/financeiro" },
    { label: "Faturas vencidas", value: money(s.overdue), href: "/financeiro?filtro=vencidas" },
    { label: "Pagamentos para conciliar", value: String(s.reconciliation), href: "/financeiro?filtro=conciliacao" },
  ] : [
    { label: "Chamados em aberto", value: number(s.ticketsOpen), href: "/atendimentos" },
    { label: "Clientes aguardando", value: number(s.waiting), href: "/atendimentos?filtro=aguardando" },
    { label: "Compromissos de hoje", value: number(s.ordersToday), href: "/operacoes" },
    { label: "Visitas fora do horário", value: number(s.ordersLate), href: "/operacoes?filtro=atrasadas" },
  ];
  return <Panel title={financial ? "O financeiro, em dia." : "O próximo passo está aqui"} description={financial ? "Pequenas ações. Operação em dia." : "Prioridades que conectam o alerta à ação"} className="overview-context-panel">
    <div className="overview-context-score"><strong>{financial ? `${received.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : number(s.waiting)}</strong><span>{financial ? "do faturamento já recebido" : "clientes esperando sua resposta"}</span></div>
    <dl className="overview-context-rows">{rows.map(row => <div key={row.label}><dt><Link href={row.href}>{row.label}</Link></dt><dd>{row.value}</dd></div>)}</dl>
    <TextLink href={financial ? "/financeiro" : "/atendimentos"}>{financial ? "Explorar financeiro" : "Organizar minha operação"}</TextLink>
  </Panel>;
}
