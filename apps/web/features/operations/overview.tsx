import useSWR from "swr";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import {
  CalendarDays,
  CircleDollarSign,
  ClipboardList,
  FileText,
  Gauge,
  Headphones,
  Radio,
  TriangleAlert,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";
import {
  ActivityPanel,
  AgendaPanel,
  NetworkPulsePanel,
  OverviewDashboardLayout,
  OverviewFrame,
  PriorityPanel,
  RevenuePanel,
} from "@/components/overview";
import {
  OverviewMetric,
  OverviewPriority,
} from "@/components/overview-elements";
import {
  OverviewBreakdownPanel,
  OverviewContextPanel,
} from "@/components/overview-area-panels";
import { RevenueChart } from "@/components/revenue-chart";
import { EmptyState } from "@/components/workspace-feedback";
import { useQueryState } from "@/lib/use-query-state";
import { overviewAreas, type OverviewArea } from "@/lib/overview";
import { clock, date, money, number } from "@/lib/format";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can, hasModule } from "@/features/session/model";
import { erpClient, api } from "@/platform/erp-client";
import { summarySchema } from "@/features/finance/models";
import {
  actionLabels,
  healthSchema,
  operationLabels,
} from "@/features/network/models";
import { orderKinds, orderStates } from "@/features/field/labels";
import { canAccessPath, canonicalErpPath } from "./navigation";

const n = z.coerce.number();
const panelsSchema = z.object({
  offline: z.array(z.object({ label: z.string(), n })),
  signal: z.array(z.object({ label: z.string(), n })),
  contracts_by_month: z.array(
    z.object({ month: z.string(), ativacoes: n, encerramentos: n }),
  ),
  cash_today: z.object({ cents: n, pagamentos: n }).optional(),
  without_invoice: n.optional(),
  recent_operations: z.array(
    z.object({
      contract_id: z.string().nullable(),
      subscriber_name: z.string().nullable(),
      action: z.string(),
      status: z.string(),
      created_at: z.string(),
    }),
  ),
});
const agendaSchema = z.object({
  technicians: z.array(
    z.object({
      name: z.string(),
      items: z.array(
        z.object({
          id: z.string(),
          number: n,
          kind: z.string(),
          status: z.string(),
          subscriber_name: z.string(),
          scheduled_for: z.string(),
          address: z.string(),
          sla_overdue: z.boolean(),
        }),
      ),
    }),
  ),
  awaiting_schedule: z.array(z.object({ id: z.string() })),
});
type TodayItem = {
  title: string;
  detail?: string;
  n: number;
  severity: string;
  link: string;
};

const areaLinks: Record<Exclude<OverviewArea, "overview">, RegExp> = {
  financial:
    /^\/(?:faturas|conciliacao|financeiro|politica-cobranca|relatorios-cobranca|relatorios\/cobranca)/,
  network: /^\/(?:rede|operacoes|onus|noc|online|manutencoes|ipam|ftth|mapa)/,
  support:
    /^\/(?:atendimentos|ordens|agenda|meu-trabalho|prospectos|estoque|relatorios-atendimento)/,
};
function linkArea(path: string): OverviewArea {
  return (
    (Object.entries(areaLinks).find(([, pattern]) =>
      pattern.test(path),
    )?.[0] as OverviewArea | undefined) ?? "overview"
  );
}
const areaIcons = {
  overview: Gauge,
  financial: CircleDollarSign,
  network: Radio,
  support: Headphones,
};
async function total(path: string) {
  const response = await erpClient.request<unknown>(path);
  return response.total ?? 0;
}
function today() {
  return new Date().toLocaleDateString("en-CA");
}
function monthLabel(month: string) {
  return new Date(`${month.slice(0, 7)}-01T12:00:00`)
    .toLocaleDateString("pt-BR", { month: "short" })
    .replace(".", "");
}

export function ErpOverview() {
  const { me } = useSession();
  const navigate = useNavigate();
  const finance = can(me, "finance:read");
  const network = can(me, "network:read");
  const crm = can(me, "crm:read") && hasModule(me, "crm");
  const field = can(me, "os:read") && hasModule(me, "field");
  const areas = overviewAreas.filter(
    (area) =>
      area.value === "overview" ||
      (area.value === "financial" && finance) ||
      (area.value === "network" && network) ||
      (area.value === "support" && (crm || field)),
  );
  const [area, setArea] = useQueryState<OverviewArea>(
    "painel",
    "overview",
    areas.map((item) => item.value),
  );
  const dashboard = useSWR("erp-dashboard", () =>
    api<{
      subscribers: number;
      contracts: number;
      plans: number;
      mrr_cents: number;
    }>("/dashboard"),
  );
  const todayItems = useSWR(
    "erp-today",
    () => api<{ name: string; items: TodayItem[] }>("/today"),
    { refreshInterval: 30000 },
  );
  const summary = useSWR(finance ? "erp-finance-summary" : null, async () =>
    summarySchema.parse(await api("/finance/summary")),
  );
  const monthly = useSWR(finance ? "erp-finance-monthly" : null, () =>
    api<{ month: string; received_cents: number }[]>("/finance/monthly"),
  );
  const health = useSWR(
    network ? "erp-network-health" : null,
    async () => healthSchema.parse(await api("/network/health")),
    { refreshInterval: 30000 },
  );
  const panels = useSWR(
    network ? "erp-dashboard-panels" : null,
    async () => panelsSchema.parse(await api("/dashboard/panels")),
    { refreshInterval: 60000 },
  );
  const tickets = useSWR(crm ? "erp-overview-tickets" : null, async () => {
    const [pending, provider, subscriber] = await Promise.all(
      ["pending", "open", "waiting"].map((status) =>
        total(`/tickets?status=${status}&limit=1`),
      ),
    );
    return { pending, provider, subscriber };
  });
  const agenda = useSWR(
    field ? ["erp-agenda", "overview", today()] : null,
    async () =>
      agendaSchema.parse(
        await api(
          `/agenda?${new URLSearchParams({ date: today(), days: "1" })}`,
        ),
      ),
  );
  const items =
    todayItems.data?.items.filter((item) =>
      canAccessPath(me, canonicalErpPath(item.link.split("?")[0])),
    ) ?? [];
  const orders = (agenda.data?.technicians ?? [])
    .flatMap((technician) =>
      technician.items.map((item) => ({
        ...item,
        technician: technician.name,
      })),
    )
    .filter((item) => item.status !== "done" && item.status !== "canceled")
    .sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
  const series = monthly.data ?? [];
  const current = series.at(-1)?.received_cents ?? 0;
  const previous = series.at(-2)?.received_cents ?? 0;
  const trend =
    previous > 0
      ? (() => {
          const change = ((current - previous) / previous) * 100;
          return {
            down: change < 0,
            label: `${Math.abs(change).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`,
          };
        })()
      : null;
  const s = summary.data;
  const h = health.data;
  const p = panels.data;
  const priorities = (value: OverviewArea) => {
    const rows = items.filter(
      (item) =>
        value === "overview" ||
        linkArea(canonicalErpPath(item.link.split("?")[0])) === value,
    );
    return (
      <PriorityPanel
        count={rows.length}
        description="Pendências calculadas para seu perfil e módulos."
      >
        <QueryBoundary
          loading={todayItems.isLoading}
          error={todayItems.error}
          retry={() => todayItems.mutate()}
        >
          {rows.map((item) => {
            const [path, query] = item.link.split("?");
            const target = canonicalErpPath(path);
            return (
              <OverviewPriority
                key={item.title}
                href={`${target}${query ? `?${query}` : ""}`}
                icon={areaIcons[linkArea(target)]}
                tone={
                  item.severity === "critical"
                    ? "danger"
                    : item.severity === "warning"
                      ? "warning"
                      : "info"
                }
                title={item.title}
                description={
                  item.detail ??
                  "Consulte os registros para decidir a próxima ação."
                }
                tag={String(item.n)}
              />
            );
          })}
          {todayItems.data && !rows.length && (
            <EmptyState
              icon={Gauge}
              title="Nenhuma pendência nesta área."
              description="Itens que pedem ação no seu perfil aparecem aqui."
            />
          )}
        </QueryBoundary>
      </PriorityPanel>
    );
  };
  const revenue = finance && (
    <QueryBoundary
      loading={monthly.isLoading || summary.isLoading}
      error={monthly.error ?? summary.error}
      retry={() => Promise.all([monthly.mutate(), summary.mutate()])}
    >
      <RevenuePanel
        title={
          area === "financial"
            ? "Receita recebida"
            : "Mais conexões. Novas possibilidades."
        }
        description="Recebido por mês · todas as empresas do provedor"
        href="/financeiro/faturas"
        amount={money((s?.received_month_cents ?? current) / 100)}
        trend={trend}
        caption={
          <>
            recebidos neste mês
            {trend && " · vs. mês anterior"}
          </>
        }
        legend={false}
        chart={
          <RevenueChart
            data={series.map((month) => ({
              day: monthLabel(month.month),
              current: month.received_cents / 100000,
            }))}
            monthly
          />
        }
        footerText={
          s
            ? `${number(s.open)} título(s) em aberto · ${money(s.open_cents / 100)}`
            : "Consulta financeira"
        }
      />
    </QueryBoundary>
  );
  const pulse = network && (
    <QueryBoundary
      loading={health.isLoading}
      error={health.error}
      retry={() => health.mutate()}
    >
      {h && (
        <NetworkPulsePanel
          readLabel={`LEITURA · ${clock(new Date().toISOString())}`}
          headline="Agentes e operações sob controle."
          value={
            h.agents
              ? Math.round(
                  ((h.agents - h.agents_offline) / h.agents) * 100,
                ).toString()
              : "—"
          }
          unit={h.agents ? "%" : ""}
          captions={[
            `${h.agents - h.agents_offline} de ${h.agents} agentes com contato recente`,
            "Disponibilidade de enlace não é medida pelo ERP; nenhum valor foi estimado.",
          ]}
          stats={[
            { value: number(h.in_progress), label: "operações em curso" },
            { value: number(h.uncertain), label: "resultados incertos" },
            { value: number(h.devices_maintenance), label: "manutenção" },
          ]}
          warning={{
            href: "/rede/operacoes",
            text: h.drift
              ? `${number(h.drift)} divergência(s) entre intenção e estado`
              : "Nenhuma divergência entre intenção e estado",
          }}
          link={{
            href: "/rede/equipamentos",
            text: "Abrir centro de monitoramento",
          }}
        />
      )}
    </QueryBoundary>
  );
  const activities = network && (
    <ActivityPanel
      description="Últimas operações de rede registradas"
      href="/rede/operacoes"
      footer="Intenção, execução e resultado em um só registro."
      empty={
        <EmptyState
          icon={Radio}
          title={
            panels.isLoading
              ? "Consultando operações…"
              : "Nenhuma operação registrada."
          }
          description="Provisionamentos, suspensões e reativações aparecem aqui."
        />
      }
      rows={(p?.recent_operations ?? []).slice(0, 4).map((row, index) => ({
        id: `${row.created_at}-${index}`,
        type:
          row.status === "FAILED" || row.status === "UNCERTAIN"
            ? "network"
            : "order",
        title: actionLabels[row.action] ?? row.action,
        description: `${row.subscriber_name ?? "Sem assinante"} · ${operationLabels[row.status] ?? row.status}`,
        time: clock(row.created_at),
        onClick: () =>
          navigate(
            row.contract_id
              ? `/contratos?contrato=${row.contract_id}`
              : "/rede/operacoes",
          ),
      }))}
    />
  );
  const agendaPanel = field && (
    <AgendaPanel
      href="/agenda"
      empty={
        <EmptyState
          icon={CalendarDays}
          title={
            agenda.isLoading
              ? "Consultando agenda…"
              : "Nenhuma visita agendada para hoje."
          }
          description="As OS agendadas para hoje aparecem aqui."
        />
      }
      rows={orders.slice(0, 3).map((order) => ({
        id: order.id,
        time: clock(order.scheduled_for),
        day: date(order.scheduled_for)
          .replace(/ de \d{4}$/, "")
          .toUpperCase(),
        title: orderKinds[order.kind] ?? order.kind,
        detail: `${order.subscriber_name} · ${order.address}`,
        technician: order.technician,
        status: orderStates[order.status] ?? order.status,
        onClick: () => navigate(`/agenda?ordem=${order.id}`),
      }))}
    />
  );
  const contractTrend = (kind: "ativacoes" | "encerramentos") =>
    p && (
      <OverviewBreakdownPanel
        title={
          kind === "ativacoes"
            ? "Ativações dos últimos doze meses"
            : "Encerramentos dos últimos doze meses"
        }
        description="Contratos por mês no fuso do provedor"
        href={
          kind === "ativacoes" ? "/contratos" : "/contratos?situacao=Encerrado"
        }
        actionLabel={
          kind === "ativacoes" ? "Abrir contratos" : "Ver encerrados"
        }
        rows={p.contracts_by_month.map((row) => ({
          name: monthLabel(row.month),
          value: row[kind],
        }))}
        summary={number(
          p.contracts_by_month.reduce((sum, row) => sum + row[kind], 0),
        )}
        summaryNote={
          kind === "ativacoes"
            ? "ativações no período"
            : "encerramentos no período"
        }
        valueLabel={kind === "ativacoes" ? "Ativações" : "Encerramentos"}
        sourceNote="Datas registradas nos contratos."
      />
    );
  const metric = (props: Parameters<typeof OverviewMetric>[0]) => (
    <OverviewMetric key={props.title} {...props} />
  );
  const dashboardData = dashboard.data;
  const render = (value: OverviewArea) => {
    if (value === "financial")
      return (
        <OverviewDashboardLayout
          metricsLabel="Indicadores financeiros do provedor"
          metrics={
            s
              ? [
                  metric({
                    title: "Em aberto",
                    value: money(s.open_cents / 100),
                    icon: Wallet,
                    change: `${number(s.open)} títulos`,
                    neutral: true,
                    detail: "Títulos a receber, inclusive vencidos",
                    href: "/financeiro/faturas",
                  }),
                  metric({
                    title: "Vencido",
                    value: money(s.overdue_cents / 100),
                    icon: TriangleAlert,
                    change: `${number(s.overdue)} títulos`,
                    down: s.overdue > 0,
                    detail: "Saldo de títulos após o vencimento",
                    href: "/financeiro/faturas?situacao=Vencida",
                  }),
                  metric({
                    title: "Recebido no mês",
                    value: money(s.received_month_cents / 100),
                    icon: CircleDollarSign,
                    change: "Mês atual",
                    neutral: true,
                    detail: "Pagamentos registrados no mês",
                    href: "/financeiro/faturas?situacao=Paga",
                  }),
                  metric({
                    title: "Em conciliação",
                    value: number(s.reconciling),
                    icon: FileText,
                    change: "Decisão",
                    neutral: true,
                    detail: "Pagamentos sem baixa confirmada",
                    href: "/financeiro/conciliacao",
                  }),
                ]
              : null
          }
          main={revenue}
          side={
            s && (
              <OverviewContextPanel
                title="O financeiro, em dia."
                description="Pequenas ações. Operação em dia."
                score={number(s.overdue)}
                scoreNote="títulos vencidos para acompanhar"
                rows={[
                  {
                    label: "Recebido no mês",
                    value: money(s.received_month_cents / 100),
                    href: "/financeiro/faturas?situacao=Paga",
                  },
                  {
                    label: "Faturas vencidas",
                    value: money(s.overdue_cents / 100),
                    href: "/financeiro/faturas?situacao=Vencida",
                  },
                  {
                    label: "Pagamentos para conciliar",
                    value: number(s.reconciling),
                    href: "/financeiro/conciliacao",
                  },
                  ...(p?.cash_today
                    ? [
                        {
                          label: `Recebido hoje · ${number(p.cash_today.pagamentos)} pagamento(s)`,
                          value: money(p.cash_today.cents / 100),
                          href: "/financeiro/faturas?situacao=Paga",
                        },
                      ]
                    : []),
                  ...(p?.without_invoice !== undefined
                    ? [
                        {
                          label: "Contratos sem fatura no mês",
                          value: number(p.without_invoice),
                          href: "/relatorios/cobranca",
                        },
                      ]
                    : []),
                ]}
                link={{
                  href: "/financeiro/faturas",
                  label: "Explorar financeiro",
                }}
              />
            )
          }
          priorities={priorities("financial")}
        />
      );
    if (value === "network")
      return (
        <OverviewDashboardLayout
          metricsLabel="Indicadores de rede do provedor"
          metrics={
            h
              ? [
                  metric({
                    title: "Agentes conectados",
                    value: `${h.agents - h.agents_offline} / ${h.agents}`,
                    icon: Radio,
                    change: h.agents_offline
                      ? `${h.agents_offline} offline`
                      : "Todos",
                    down: h.agents_offline > 0,
                    neutral: !h.agents_offline,
                    detail: "Conforme o último contato recebido",
                    href: "/rede/equipamentos",
                  }),
                  metric({
                    title: "Operações incertas",
                    value: number(h.uncertain),
                    icon: TriangleAlert,
                    change: "Evidência",
                    down: h.uncertain > 0,
                    neutral: !h.uncertain,
                    detail: "Verifique antes de repetir",
                    href: "/rede/operacoes?filtro=problematicas",
                  }),
                  metric({
                    title: "Falhas e expirações",
                    value: number(h.failed_recent),
                    icon: Wrench,
                    change: "7 dias",
                    down: h.failed_recent > 0,
                    neutral: !h.failed_recent,
                    detail: "Operações que não concluíram",
                    href: "/rede/operacoes?filtro=problematicas",
                  }),
                  metric({
                    title: "Divergências",
                    value: number(h.drift),
                    icon: Gauge,
                    change: "Estado",
                    down: h.drift > 0,
                    neutral: !h.drift,
                    detail: "Intenção diferente do observado",
                    href: "/rede/operacoes",
                  }),
                ]
              : null
          }
          main={
            p && (
              <OverviewBreakdownPanel
                title="Nos bastidores da sua rede"
                description="Contas offline por tempo desde o fim da última sessão registrada"
                href="/rede/online"
                actionLabel="Abrir conexões"
                rows={p.offline.map((row) => ({
                  name: row.label,
                  value: row.n,
                }))}
                summary={number(p.offline.reduce((sum, row) => sum + row.n, 0))}
                summaryNote="contas ativas observadas offline"
                valueLabel="Contas"
                sourceNote="Baseado no accounting recebido; não é medição direta do enlace."
              />
            )
          }
          side={pulse}
          extra={
            p && (
              <OverviewBreakdownPanel
                title="Sinal das ONUs · RX"
                description="Distribuição das leituras ópticas disponíveis"
                href="/rede/onus"
                actionLabel="Abrir ONUs"
                rows={p.signal.map((row) => ({
                  name: row.label,
                  value: row.n,
                }))}
                summary={number(p.signal.reduce((sum, row) => sum + row.n, 0))}
                summaryNote="ONUs com leitura no recorte"
                valueLabel="ONUs"
                sourceNote="Leituras relatadas pelos agentes; sem coleta em tempo real."
              />
            )
          }
          priorities={priorities("network")}
          activities={activities}
        />
      );
    if (value === "support") {
      const t = tickets.data;
      return (
        <OverviewDashboardLayout
          metricsLabel="Indicadores de atendimento e campo"
          metrics={[
            ...(crm
              ? [
                  metric({
                    title: "Atendimentos pendentes",
                    value: t ? number(t.pending) : "…",
                    icon: Headphones,
                    change: "Fila",
                    neutral: true,
                    detail: "Abertos ou aguardando resposta",
                    href: "/atendimentos",
                  }),
                  metric({
                    title: "Aguardando o provedor",
                    value: t ? number(t.provider) : "…",
                    icon: Users,
                    change: "Resposta",
                    down: Boolean(t?.provider),
                    neutral: !t?.provider,
                    detail: "Clientes esperando a equipe",
                    href: "/atendimentos?filtro=aguardando",
                  }),
                ]
              : []),
            ...(field
              ? [
                  metric({
                    title: "Visitas de hoje",
                    value: agenda.data ? number(orders.length) : "…",
                    icon: CalendarDays,
                    change: "Agenda",
                    neutral: true,
                    detail: "OS agendadas para hoje",
                    href: "/agenda",
                  }),
                  metric({
                    title: "Aguardando agendamento",
                    value: agenda.data
                      ? number(agenda.data.awaiting_schedule.length)
                      : "…",
                    icon: ClipboardList,
                    change: "Fila",
                    neutral: true,
                    detail: "OS sem data definida",
                    href: "/agenda",
                  }),
                ]
              : []),
          ]}
          main={
            crm && t ? (
              <OverviewBreakdownPanel
                title="Cada atendimento conta."
                description="Distribuição dos chamados pendentes por situação"
                href="/atendimentos"
                actionLabel="Abrir fila"
                rows={[
                  { name: "Aguardando o provedor", value: t.provider },
                  { name: "Aguardando o assinante", value: t.subscriber },
                ]}
                summary={number(t.pending)}
                summaryNote="atendimentos pendentes"
                valueLabel="Chamados"
                sourceNote="Situação registrada nos protocolos."
              />
            ) : (
              agendaPanel
            )
          }
          side={
            <OverviewContextPanel
              title="O próximo passo está aqui"
              description="Prioridades que conectam o alerta à ação"
              score={
                t
                  ? number(t.provider)
                  : orders.length
                    ? number(orders.length)
                    : "0"
              }
              scoreNote={
                t
                  ? "clientes esperando sua resposta"
                  : "visitas previstas para hoje"
              }
              rows={[
                ...(t
                  ? [
                      {
                        label: "Atendimentos pendentes",
                        value: number(t.pending),
                        href: "/atendimentos",
                      },
                      {
                        label: "Aguardando o assinante",
                        value: number(t.subscriber),
                        href: "/atendimentos",
                      },
                    ]
                  : []),
                ...(agenda.data
                  ? [
                      {
                        label: "Visitas de hoje",
                        value: number(orders.length),
                        href: "/agenda",
                      },
                      {
                        label: "Prazo de SLA estourado",
                        value: number(
                          orders.filter((o) => o.sla_overdue).length,
                        ),
                        href: "/ordens-de-servico",
                      },
                    ]
                  : []),
              ]}
              link={{
                href: crm ? "/atendimentos" : "/ordens-de-servico",
                label: "Organizar minha operação",
              }}
            />
          }
          priorities={priorities("support")}
          agenda={crm && t ? agendaPanel : undefined}
        />
      );
    }
    return (
      <OverviewDashboardLayout
        metricsLabel="Indicadores do provedor"
        metrics={
          dashboardData
            ? [
                metric({
                  title: "Assinantes ativos",
                  value: number(dashboardData.subscribers),
                  icon: Users,
                  change: "Cadastro",
                  neutral: true,
                  detail: "Titulares com cadastro ativo",
                  href: "/assinantes",
                }),
                metric({
                  title: "Receita contratada",
                  value: money(dashboardData.mrr_cents / 100),
                  icon: CircleDollarSign,
                  change: "Mensal",
                  neutral: true,
                  detail: "Planos dos contratos vigentes",
                  href: "/contratos",
                }),
                s
                  ? metric({
                      title: "Recebido no mês",
                      value: money(s.received_month_cents / 100),
                      icon: Wallet,
                      change: trend
                        ? `${trend.down ? "−" : "+"}${trend.label}`
                        : "Mês atual",
                      down: trend?.down,
                      neutral: !trend,
                      detail: "Pagamentos registrados no mês",
                      href: "/financeiro/faturas",
                    })
                  : metric({
                      title: "Contratos vigentes",
                      value: number(dashboardData.contracts),
                      icon: FileText,
                      change: "Cadastro",
                      neutral: true,
                      detail: "Vínculos comerciais ativos",
                      href: "/contratos",
                    }),
                metric({
                  title: "Pendências",
                  value: todayItems.data
                    ? number(items.reduce((sum, item) => sum + item.n, 0))
                    : "…",
                  icon: Gauge,
                  change: "Hoje",
                  neutral: true,
                  detail: "Itens que pedem ação no seu perfil",
                  href: "/",
                }),
              ]
            : null
        }
        main={revenue}
        side={pulse}
        extra={
          p && (
            <div className="overview-main-grid overview-pair">
              {contractTrend("ativacoes")}
              {contractTrend("encerramentos")}
            </div>
          )
        }
        priorities={priorities("overview")}
        activities={activities}
        agenda={agendaPanel}
      />
    );
  };
  return (
    <OverviewFrame
      eyebrow={new Date()
        .toLocaleDateString("pt-BR", {
          weekday: "long",
          day: "numeric",
          month: "long",
        })
        .toLocaleUpperCase("pt-BR")}
      description={`Olá, ${me?.name.split(" ")[0]}. Cada conexão conta. Tenha o todo à vista.`}
      actions={
        <span className="date-chip">
          <CalendarDays size={15} />
          {date(new Date().toISOString())}
        </span>
      }
      before={<ConnectedNotice />}
      area={areas.some((item) => item.value === area) ? area : "overview"}
      onArea={setArea}
      areas={areas}
      render={(value) => (
        <QueryBoundary
          loading={dashboard.isLoading}
          error={dashboard.error}
          retry={() => dashboard.mutate()}
        >
          {render(value)}
        </QueryBoundary>
      )}
    />
  );
}
