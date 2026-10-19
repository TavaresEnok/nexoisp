"use client";

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
import { useWorkspace } from "@/components/workspace-provider";
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
    <>
      <PageHeading
        eyebrow={scenarioDate(s.asOf, "weekday").toLocaleUpperCase("pt-BR")}
        title="A operação, em perspectiva."
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
      />
      <Tabs value={area} onValueChange={value => setArea(value as OverviewArea)} className="overview-tabs">
        <div className="view-tabs"><TabsList variant="line" aria-label="Área do painel">
          {overviewAreas.map(item => <TabsTrigger key={item.value} value={item.value}><item.icon data-icon="inline-start" />{item.label}</TabsTrigger>)}
        </TabsList></div>
        {overviewAreas.map(item => <TabsContent key={item.value} value={item.value}><OverviewDashboard area={item.value} /></TabsContent>)}
      </Tabs>
      <SourceFooter />
    </>
  );
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
  return (<>
      <section
        className="metrics-grid"
        aria-label="Indicadores do cenário operacional"
      >
        {metrics.map(metric => <Metric key={metric.title} {...metric} />)}
      </section>
      <div className="overview-main-grid">
        {area === "network" || area === "support" ? <OverviewAreaChart area={area} data={data} /> : <Panel
          title={area === "financial" ? "Receita recebida" : "Mais conexões. Novas possibilidades."}
          description={`Evolução dos recebimentos · ${scenarioDate(s.asOf, "month")}`}
          action={
            <Link
              href="/financeiro"
              className={buttonVariants({ variant: "ghost", size: "icon" })}
              aria-label="Explorar financeiro"
            >
              <ArrowUpRight />
            </Link>
          }
          className="revenue-panel"
        >
          <div className="revenue-summary">
            <div>
              <div className="revenue-number">
                {money(s.received)}
                {trend && <Trend down={trend.down}>{trend.label}</Trend>}
              </div>
              <p>recebidos até {scenarioDate(s.asOf)}{trend && " · vs. mês anterior"}</p>
            </div>
            <div className="chart-legend">
              <span>
                <i />
                Mês atual
              </span>
              <span>
                <i />
                Mês anterior
              </span>
            </div>
          </div>
          <RevenueChart data={s.series} />
          <div className="revenue-footer">
            <span>
              <span className="live-dot" />
              <strong>{percentage}%</strong> do faturamento recebido
            </span>
            <TextLink href="/financeiro">Explorar financeiro</TextLink>
          </div>
        </Panel>}
        {area === "financial" || area === "support" ? <OverviewContextSummary area={area} data={data} /> : <section className="network-showcase" aria-labelledby="pulse-heading">
          <div className="network-showcase-heading">
            <h2 id="pulse-heading">
              <Radio size={17} />
              Pulso da rede
            </h2>
            <span className="read-label">LEITURA · {clock(s.asOf)}</span>
          </div>
          <div className="network-health">
            <div className="network-health-icon">
              <ShieldCheck size={20} />
            </div>
            <span>Conexões que não param.</span>
          </div>
          <div className="availability-value">
            {s.availability.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}<span>%</span>
          </div>
          <p className="availability-caption">
            disponibilidade agregada de 30 dias do cenário
          </p>
          <p className="availability-caption">Sem leituras diárias disponíveis. Nenhuma série histórica foi estimada.</p>
          <div className="pulse-stats">
            <div>
              <strong>{number(s.online)}</strong>
              <span>sessões online</span>
            </div>
            <div>
              <strong>
                {s.latency.toFixed(1).replace(".", ",")}
                <small> ms</small>
              </strong>
              <span>latência média</span>
            </div>
            <div>
              <strong>
                {s.equipmentOnline}
                <small> / {s.equipmentTotal}</small>
              </strong>
              <span>equipamentos</span>
            </div>
          </div>
          <Link className="network-warning" href="/rede/equipamentos?filtro=atencao">
            <span className="warning-indicator" />
            <span>{s.onusDegraded ? `${number(s.onusDegraded)} ONUs com sinal fora do ideal` : "Nenhuma ONU com sinal degradado"}</span>
            <ArrowUpRight size={15} />
          </Link>
          <Link href="/rede/equipamentos" className="network-showcase-link">
            Abrir centro de monitoramento
            <ArrowRight size={15} />
          </Link>
        </section>}
      </div>
      <div className="overview-bottom-grid">
        <Panel
          title="O que merece sua atenção."
          description="Pequenas ações. Operação em dia."
          action={<Badge variant="secondary">{priorityCount} {priorityCount === 1 ? "ponto" : "pontos"} de atenção</Badge>}
          className="priority-panel"
        >
          <div className="priorities">
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
          </div>
        </Panel>
        <Panel
          title="Nos bastidores da sua rede"
          description="Movimentos recentes do cenário"
          action={
            <Link href="/relatorios" className="text-link">
              Ver histórico
              <ArrowUpRight size={14} />
            </Link>
          }
          className="activity-panel"
        >
          <div className="activity-list">
            {activities.slice(0, 4).map((a) => {
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
                  onClick={() =>
                    a.subscriberId
                      ? openSubscriber(a.subscriberId)
                      : router.push("/rede/equipamentos?filtro=atencao")
                  }
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
          <div className="activity-bottom">
            <span className="live-dot" />
            Diferentes equipes. Uma história só.
          </div>
        </Panel>
      </div>
      {(area === "overview" || area === "support") && <Panel
        title="A agenda precisa andar"
        description="Os próximos compromissos da equipe"
        action={<TextLink href="/operacoes">Ver agenda completa</TextLink>}
        className="today-panel"
      >
        <div className="today-orders">
          {data.orders
            .filter((o) => o.status !== "Concluída")
            .slice(0, 3)
            .map((o) => (
              <button
                key={o.id}
                className="today-order"
                onClick={() => openSubscriber(o.subscriberId)}
              >
                <span className="order-time">
                  {o.time}
                  <small>17 OUT</small>
                </span>
                <span>
                  <strong>{o.type}</strong>
                  <small>
                    {o.name} · {o.neighborhood}
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
      </Panel>}
    </>
  );
}
