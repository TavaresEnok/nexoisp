import { lazy, Suspense } from "react";
import useSWR from "swr";
import {
  OverviewMetric,
  OverviewPriority,
} from "@/components/overview-elements";
import { can } from "@/features/session/model";
import {
  CalendarDays,
  Users,
  FileText,
  CircleDollarSign,
  Gauge,
} from "lucide-react";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { api } from "@/platform/erp-client";
import { money, date } from "@/lib/format";
import { canAccessPath, canonicalErpPath } from "./navigation";
const OperationalPanels = lazy(() =>
  import("./panels").then((module) => ({ default: module.OperationalPanels })),
);
export function ErpOverview() {
  const { me } = useSession();
  const dashboard = useSWR("erp-dashboard", () =>
    api<{
      subscribers: number;
      contracts: number;
      plans: number;
      mrr_cents: number;
    }>("/dashboard"),
  );
  const today = useSWR(
    "erp-today",
    () =>
      api<{
        name: string;
        items: {
          title: string;
          detail?: string;
          n: number;
          severity: string;
          link: string;
        }[];
      }>("/today"),
    { refreshInterval: 30000 },
  );
  const visibleItems =
    today.data?.items.filter((item) =>
      canAccessPath(me, canonicalErpPath(item.link.split("?")[0])),
    ) ?? [];
  const metrics = dashboard.data
    ? [
        {
          label: "Assinantes ativos",
          value: dashboard.data.subscribers.toLocaleString("pt-BR"),
          icon: Users,
          path: "/assinantes",
        },
        {
          label: "Contratos vigentes",
          value: dashboard.data.contracts.toLocaleString("pt-BR"),
          icon: FileText,
          path: "/contratos",
        },
        {
          label: "Planos à venda",
          value: dashboard.data.plans.toLocaleString("pt-BR"),
          icon: Gauge,
          path: "/planos",
        },
        {
          label: "Receita mensal contratada",
          value: money(dashboard.data.mrr_cents / 100),
          icon: CircleDollarSign,
          path: "/contratos",
        },
      ]
    : [];
  return (
    <>
      <PageHeading
        title="A operação, em perspectiva."
        description={`Olá, ${me?.name.split(" ")[0]}. Cada conexão conta. Tenha o todo à vista.`}
        actions={
          <span className="date-chip">
            <CalendarDays size={15} />
            {date(new Date().toISOString())}
          </span>
        }
      />
      <ConnectedNotice demo={me?.demo} />
      <QueryBoundary
        loading={dashboard.isLoading}
        error={dashboard.error}
        retry={() => dashboard.mutate()}
      >
        <section className="metrics-grid" aria-label="Indicadores do provedor">
          {metrics.map((metric) => (
            <OverviewMetric
              key={metric.label}
              title={metric.label}
              value={metric.value}
              icon={metric.icon}
              change={
                metric.label === "Receita mensal contratada"
                  ? "Contratado"
                  : "Cadastro"
              }
              neutral
              detail={
                metric.label === "Receita mensal contratada"
                  ? "Mensalidades dos contratos vigentes"
                  : "Dados registrados do provedor"
              }
              href={metric.path}
            />
          ))}
        </section>
      </QueryBoundary>
      <div className="erp-stack">
        <Panel
          title="O que pede sua atenção"
          description="Prioridades calculadas para seu perfil e módulos."
        >
          <QueryBoundary
            loading={today.isLoading}
            error={today.error}
            retry={() => today.mutate()}
          >
            {visibleItems.map((item) => {
              const [path, query] = item.link.split("?");
              return (
                <OverviewPriority
                  key={item.title}
                  href={`${canonicalErpPath(path)}${query ? `?${query}` : ""}`}
                  icon={Gauge}
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
            {today.data && !visibleItems.length && (
              <p className="profile-footnote">
                Nenhuma pendência disponível para você.
              </p>
            )}
          </QueryBoundary>
        </Panel>
        {can(me, "network:read") && (
          <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}>
            <OperationalPanels />
          </Suspense>
        )}
      </div>
    </>
  );
}
