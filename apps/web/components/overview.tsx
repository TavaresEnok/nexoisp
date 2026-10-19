"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { OverviewMetric as Metric, OverviewPriority as Priority } from "./overview-elements";
import { useQueryState } from "@/lib/use-query-state";
import Link from "@/platform/navigation/link";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { OverviewAreaChart, OverviewContextSummary } from "@/components/overview-area-panels";
import { getOverviewMetrics, overviewAreas, overviewActivityTypes, revenueTrend, type OverviewArea } from "@/lib/overview";
import { useRouter } from "@/platform/navigation/react";
import {
  ArrowUpRight,
  ArrowRight,
  Users,
  CircleDollarSign,
  Headphones,
  CalendarDays,
  Download,
  Radio,
  Check,
  Wrench,
  ChevronRight,
  ShieldCheck,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useWorkspace } from "@/features/workspace/context";
import {
  Panel,
  PageHeading,
  Trend,
  TextLink,
  SourceFooter,
  Status,
  PersonAvatar,
} from "@/components/workspace-ui";
import { RevenueChart } from "@/components/revenue-chart";
import { clock, date, scenarioDate, money, number, exportCsv } from "@/lib/format";

export function Overview() {
  const [area, setArea] = useQueryState<OverviewArea>("painel", "overview", ["overview", "financial", "network", "support"]);
  const { data } = useWorkspace();
  const { snapshot: s } = data;
  const exportSummary = () =>
    exportCsv(
      `nexo-resumo-demonstrativo-${s.asOf.slice(0, 10)}`,
      ["Indicador", "Valor", "Origem"],
      [
        ["Assinantes ativos", s.active, "Cenário fictício"],
        ["Receita recorrente", s.mrr, "Cenário fictício"],
        ["Recebido no mês", s.received, "Cenário fictício"],
        ["Inadimplência (%)", s.delinquency, "Cenário fictício"],
        ["Chamados abertos", s.ticketsOpen, "Cenário fictício"],
        ["Sessões online", s.online, "Cenário fictício"],
      ],
    );
  return (
    <OverviewFrame
      eyebrow={scenarioDate(s.asOf, "weekday").toLocaleUpperCase("pt-BR")}
      description="Bom dia, Gabriel. Cada conexão conta. Tenha o todo à vista."
      actions={
        <>
          <span className="date-chip">
            <CalendarDays size={15} />
            {date(s.asOf)}
          </span>
          <Button variant="outline" onClick={exportSummary}>
            <Download data-icon="inline-start" />
            Exportar resumo
          </Button>
        </>
      }
      area={area}
      onArea={setArea}
      areas={overviewAreas}
      render={(value) => <OverviewDashboard area={value} />}
      footer={<SourceFooter />}
    />
  );
}

export function OverviewFrame({ eyebrow, description, actions, area, onArea, areas, render, before, footer }: { eyebrow?: string; description: string; actions?: ReactNode; area: OverviewArea; onArea: (area: OverviewArea) => void; areas: readonly { value: OverviewArea; label: string; icon: LucideIcon }[]; render: (area: OverviewArea) => ReactNode; before?: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <PageHeading
        eyebrow={eyebrow}
        title="A operação, em perspectiva."
        description={description}
        actions={actions}
      />
      {before}
      <Tabs value={area} onValueChange={value => onArea(value as OverviewArea)} className="overview-tabs">
        <div className="view-tabs"><TabsList variant="line" aria-label="Área do painel">
          {areas.map(item => <TabsTrigger key={item.value} value={item.value}><item.icon data-icon="inline-start" />{item.label}</TabsTrigger>)}
        </TabsList></div>
        {areas.map(item => <TabsContent key={item.value} value={item.value}>{render(item.value)}</TabsContent>)}
      </Tabs>
      {footer}
    </>
  );
}

export type OverviewMetricModel = Parameters<typeof Metric>[0];
export function OverviewDashboardLayout({ metrics, metricsLabel = "Indicadores do cenário operacional", main, side, extra, priorities, activities, agenda }: { metrics: ReactNode; metricsLabel?: string; main?: ReactNode; side?: ReactNode; extra?: ReactNode; priorities?: ReactNode; activities?: ReactNode; agenda?: ReactNode }) {
  return (<>
      <section
        className="metrics-grid"
        aria-label={metricsLabel}
      >
        {metrics}
      </section>
      {(main || side) && <div className={main && side ? "overview-main-grid" : "overview-main-grid overview-single"}>
        {main}
        {side}
      </div>}
      {extra}
      {(priorities || activities) && <div className={priorities && activities ? "overview-bottom-grid" : "overview-bottom-grid overview-single"}>
        {priorities}
        {activities}
      </div>}
      {agenda}
  </>);
}

export function RevenuePanel({ title, description, href, amount, trend, caption, legend = true, chart, percentage, footerText = "do faturamento recebido", linkLabel = "Explorar financeiro" }: { title: string; description: string; href: string; amount: string; trend?: { down?: boolean; label: string } | null; caption: ReactNode; legend?: boolean; chart: ReactNode; percentage?: string; footerText?: string; linkLabel?: string }) {
  return <Panel
          title={title}
          description={description}
          action={
            <Link
              href={href}
              className={buttonVariants({ variant: "ghost", size: "icon" })}
              aria-label={linkLabel}
            >
              <ArrowUpRight />
            </Link>
          }
          className="revenue-panel"
        >
          <div className="revenue-summary">
            <div>
              <div className="revenue-number">
                {amount}
                {trend && <Trend down={trend.down}>{trend.label}</Trend>}
              </div>
              <p>{caption}</p>
            </div>
            {legend && <div className="chart-legend">
              <span>
                <i />
                Mês atual
              </span>
              <span>
                <i />
                Mês anterior
              </span>
            </div>}
          </div>
          {chart}
          <div className="revenue-footer">
            <span>
              <span className="live-dot" />
              {percentage !== undefined && <><strong>{percentage}%</strong> </>}{footerText}
            </span>
            <TextLink href={href}>{linkLabel}</TextLink>
          </div>
        </Panel>;
}

export function NetworkPulsePanel({ readLabel, headline, value, unit, captions, stats, warning, link }: { readLabel: string; headline: string; value: string; unit: string; captions: string[]; stats: { value: ReactNode; unit?: string; label: string }[]; warning: { href: string; text: string }; link: { href: string; text: string } }) {
  return <section className="network-showcase" aria-labelledby="pulse-heading">
          <div className="network-showcase-heading">
            <h2 id="pulse-heading">
              <Radio size={17} />
              Pulso da rede
            </h2>
            <span className="read-label">{readLabel}</span>
          </div>
          <div className="network-health">
            <div className="network-health-icon">
              <ShieldCheck size={20} />
            </div>
            <span>{headline}</span>
          </div>
          <div className="availability-value">
            {value}<span>{unit}</span>
          </div>
          {captions.map(caption => <p key={caption} className="availability-caption">{caption}</p>)}
          <div className="pulse-stats">
            {stats.map(stat => <div key={stat.label}>
              <strong>
                {stat.value}
                {stat.unit && <small>{stat.unit}</small>}
              </strong>
              <span>{stat.label}</span>
            </div>)}
          </div>
          <Link className="network-warning" href={warning.href}>
            <span className="warning-indicator" />
            <span>{warning.text}</span>
            <ArrowUpRight size={15} />
          </Link>
          <Link href={link.href} className="network-showcase-link">
            {link.text}
            <ArrowRight size={15} />
          </Link>
        </section>;
}

export function PriorityPanel({ count, children, description = "Pequenas ações. Operação em dia." }: { count: number; children: ReactNode; description?: string }) {
  return <Panel
          title="O que merece sua atenção."
          description={description}
          action={<Badge variant="secondary">{count} {count === 1 ? "ponto" : "pontos"} de atenção</Badge>}
          className="priority-panel"
        >
          <div className="priorities">
            {children}
          </div>
        </Panel>;
}

export type OverviewActivity = { id: string; type: string; title: string; description: string; time: string; onClick: () => void };
export function ActivityPanel({ description, href, rows, footer = "Diferentes equipes. Uma história só.", empty }: { description: string; href: string; rows: OverviewActivity[]; footer?: string; empty?: ReactNode }) {
  return <Panel
          title="Nos bastidores da sua rede"
          description={description}
          action={
            <Link href={href} className="text-link">
              Ver histórico
              <ArrowUpRight size={14} />
            </Link>
          }
          className="activity-panel"
        >
          <div className="activity-list">
            {rows.map((a) => {
              const Icon =
                a.type === "payment"
                  ? CircleDollarSign
                  : a.type === "network"
                    ? Radio
                    : a.type === "order"
                      ? Check
                      : Headphones;
              return (
                <button
                  className="activity-row"
                  key={a.id}
                  onClick={a.onClick}
                >
                  <span
                    className={`activity-icon ${a.type === "network" ? "activity-icon-warning" : ""}`}
                  >
                    <Icon size={15} />
                  </span>
                  <span className="activity-copy">
                    <strong>{a.title}</strong>
                    <small>{a.description}</small>
                  </span>
                  <time>{a.time}</time>
                </button>
              );
            })}
          </div>
          {!rows.length && empty}
          <div className="activity-bottom">
            <span className="live-dot" />
            {footer}
          </div>
        </Panel>;
}

export type OverviewAgendaRow = { id: string; time: string; day: string; title: string; detail: string; technician: string; status: string; onClick: () => void };
export function AgendaPanel({ href, rows, empty }: { href: string; rows: OverviewAgendaRow[]; empty?: ReactNode }) {
  return <Panel
        title="A agenda precisa andar"
        description="Os próximos compromissos da equipe"
        action={<TextLink href={href}>Ver agenda completa</TextLink>}
        className="today-panel"
      >
        <div className="today-orders">
          {rows.map((o) => (
              <button
                key={o.id}
                className="today-order"
                onClick={o.onClick}
              >
                <span className="order-time">
                  {o.time}
                  <small>{o.day}</small>
                </span>
                <span>
                  <strong>{o.title}</strong>
                  <small>
                    {o.detail}
                  </small>
                </span>
                <span className="today-technician">
                  <PersonAvatar name={o.technician} small />
                  {o.technician.split(" ")[0]}
                </span>
                <Status value={o.status} />
                <ChevronRight size={15} />
              </button>
            ))}
        </div>
        {!rows.length && empty}
      </Panel>;
}

function OverviewDashboard({ area }: { area: OverviewArea }) {
  const router = useRouter();
  const { data, openSubscriber } = useWorkspace();
  const { snapshot: s } = data;
  const percentage = (s.billed ? (s.received / s.billed) * 100 : 0).toFixed(1).replace(".", ",");
  const metrics = getOverviewMetrics(area, data);
  const trend = revenueTrend(s.series);
  const activities = data.activities.filter(activity => area === "overview" || overviewActivityTypes[area].includes(activity.type));
  const priorityCount = area === "overview" ? 4 : area === "network" || area === "financial" ? 1 : 2;
  return (
    <OverviewDashboardLayout
      metrics={metrics.map(metric => <Metric key={metric.title} {...metric} />)}
      main={area === "network" || area === "support" ? <OverviewAreaChart area={area} data={data} /> : <RevenuePanel
        title={area === "financial" ? "Receita recebida" : "Mais conexões. Novas possibilidades."}
        description={`Evolução dos recebimentos · ${scenarioDate(s.asOf, "month")}`}
        href="/financeiro"
        amount={money(s.received)}
        trend={trend}
        caption={<>recebidos até {scenarioDate(s.asOf)}{trend && " · vs. mês anterior"}</>}
        chart={<RevenueChart data={s.series} />}
        percentage={percentage}
      />}
      side={area === "financial" || area === "support" ? <OverviewContextSummary area={area} data={data} /> : <NetworkPulsePanel
        readLabel={`LEITURA · ${clock(s.asOf)}`}
        headline="Conexões que não param."
        value={s.availability.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}
        unit="%"
        captions={["disponibilidade agregada de 30 dias do cenário", "Sem leituras diárias disponíveis. Nenhuma série histórica foi estimada."]}
        stats={[
          { value: number(s.online), label: "sessões online" },
          { value: s.latency.toFixed(1).replace(".", ","), unit: " ms", label: "latência média" },
          { value: s.equipmentOnline, unit: ` / ${s.equipmentTotal}`, label: "equipamentos" },
        ]}
        warning={{ href: "/rede/equipamentos?filtro=atencao", text: s.onusDegraded ? `${number(s.onusDegraded)} ONUs com sinal fora do ideal` : "Nenhuma ONU com sinal degradado" }}
        link={{ href: "/rede/equipamentos", text: "Abrir centro de monitoramento" }}
      />}
      priorities={<PriorityPanel count={priorityCount}>
            {(area === "overview" || area === "network") && <Priority
              href="/rede/equipamentos?filtro=atencao"
              icon={Radio}
              tone="warning"
              title="Sinal óptico degradado no POP Norte"
              description="12 ONUs abaixo de −27 dBm · possível causa compartilhada"
              tag="REDE"
            />}
            {(area === "overview" || area === "financial") && <Priority
              href="/financeiro?filtro=conciliacao"
              icon={CircleDollarSign}
              tone="info"
              title="3 pagamentos aguardam conciliação"
              description="Revise as correspondências antes de confirmar a baixa"
              tag="FINANCEIRO"
            />}
            {(area === "overview" || area === "support") && <Priority
              href="/atendimentos?filtro=aguardando"
              icon={Headphones}
              tone="neutral"
              title="8 clientes aguardando atendimento"
              description="Fila do cenário · 2 chamados com SLA em risco"
              tag="ATENDIMENTO"
            />}
            {(area === "overview" || area === "support") && <Priority
              href="/operacoes?filtro=atrasadas"
              icon={Wrench}
              tone="danger"
              title="2 visitas passaram do horário previsto"
              description="Reorganize a agenda para reduzir o tempo de espera"
              tag="CAMPO"
            />}
      </PriorityPanel>}
      activities={<ActivityPanel
        description="Movimentos recentes do cenário"
        href="/relatorios"
        rows={activities.slice(0, 4).map(a => ({
          id: a.id,
          type: a.type,
          title: a.title,
          description: a.description,
          time: a.time,
          onClick: () =>
            a.subscriberId
              ? openSubscriber(a.subscriberId)
              : router.push("/rede/equipamentos?filtro=atencao"),
        }))}
      />}
      agenda={(area === "overview" || area === "support") && <AgendaPanel
        href="/operacoes"
        rows={data.orders
          .filter((o) => o.status !== "Concluída")
          .slice(0, 3)
          .map((o) => ({
            id: o.id,
            time: o.time,
            day: "17 OUT",
            title: o.type,
            detail: `${o.name} · ${o.neighborhood}`,
            technician: o.technician,
            status: o.status,
            onClick: () => openSubscriber(o.subscriberId),
          }))}
      />}
    />
  );
}
