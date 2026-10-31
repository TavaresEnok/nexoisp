import useSWR from "swr";
import { Link } from "react-router-dom";
import {
  CircleDollarSign,
  ArrowDownLeft,
  Clock3,
  TriangleAlert,
  CheckCheck,
  ArrowRight,
} from "lucide-react";
import { Panel } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import { RevenueChart } from "@/components/revenue-chart";
import { EmptyState } from "@/components/workspace-feedback";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import type { FinanceSummary } from "./models";
import { aggregateMoney, monthlySchema } from "./models";
export function FinanceOverview({
  summary,
  loading,
  error,
  company,
}: {
  summary?: FinanceSummary;
  loading?: boolean;
  error?: unknown;
  company: string;
}) {
  const series = useSWR("erp-finance-monthly", async () =>
    monthlySchema.parse(await api("/finance/monthly")),
  );
  return (
    <>
      <QueryBoundary loading={loading} error={error}>
        {summary && (
          <div className="metrics-grid financial-metrics">
            {[
              {
                title: "Em aberto",
                value: aggregateMoney(summary.open_cents),
                detail: `${summary.open} fatura(s); nominal ${aggregateMoney(summary.nominal_open_cents)}; recebido ${aggregateMoney(summary.received_open_cents)}`,
                icon: CircleDollarSign,
              },
              {
                title: "Recebido no mês",
                value: aggregateMoney(summary.received_month_cents),
                detail: "Pagamentos menos estornos no mês corrente",
                icon: ArrowDownLeft,
              },
              {
                title: "Vencido e não pago",
                value: aggregateMoney(summary.overdue_cents),
                detail: `${summary.overdue} fatura(s) vencida(s)`,
                icon: TriangleAlert,
              },
              {
                title: "Em conciliação",
                value: String(summary.reconciling),
                detail: "Faturas que aguardam uma decisão",
                icon: Clock3,
              },
            ].map((metric) => (
              <div className="metric-card" key={metric.title}>
                <div className="metric-heading">
                  <span>{metric.title}</span>
                  <metric.icon size={17} />
                </div>
                <div className="metric-main">
                  <strong>{metric.value}</strong>
                </div>
                <p>{metric.detail}</p>
              </div>
            ))}
          </div>
        )}
      </QueryBoundary>
      <div className="financial-top-grid">
        <Panel
          title="Recebimentos em perspectiva"
          description="Recebido por mês · R$ mil · todas as empresas do provedor"
        >
          <QueryBoundary
            loading={series.isLoading}
            error={series.error}
            retry={() => series.mutate()}
          >
            {series.data &&
              !series.data.some((month) => month.received_cents !== 0) && (
                <EmptyState
                  icon={CircleDollarSign}
                  title="Nenhum recebimento nos últimos meses"
                  description="O gráfico aparece quando houver pagamentos registrados."
                />
              )}
            {series.data?.some((month) => month.received_cents !== 0) && (
              <RevenueChart
                data={series.data.map((month) => ({
                  day: month.month.split("-").reverse().join("/"),
                  current: month.received_cents / 100000,
                }))}
                monthly
              />
            )}
          </QueryBoundary>
          {company && (
            <p className="profile-footnote">
              O filtro de empresa afeta os indicadores superiores e a lista;
              esta série apresenta o total do provedor.
            </p>
          )}
        </Panel>
        <Panel
          title="Uma baixa com confiança"
          description="Conciliação antes da confirmação"
          className="reconciliation-summary"
        >
          <span className="reconciliation-icon">
            <CheckCheck size={30} />
          </span>
          <strong>{summary ? summary.reconciling : "—"}</strong>
          <p>faturas aguardam análise no ERP</p>
          <small>
            Confira a origem e o valor antes de registrar a decisão.
          </small>
          <Button
            variant="outline"
            render={<Link to="/financeiro/conciliacao" />}
          >
            Revisar correspondências
            <ArrowRight data-icon="inline-end" />
          </Button>
        </Panel>
      </div>
    </>
  );
}
