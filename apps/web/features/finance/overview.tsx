import useSWR from "swr";
import { Link } from "react-router-dom";
import { CircleDollarSign, ArrowDownLeft, Clock3, TriangleAlert, CheckCheck, ArrowRight } from "lucide-react";
import { Panel } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import { RevenueChart } from "@/components/revenue-chart";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import { money } from "@/lib/format";
import type { FinanceSummary } from "./models";
export function FinanceOverview({ summary, loading, error, company }: { summary?: FinanceSummary; loading?: boolean; error?: unknown; company: string }) {
 const series = useSWR("erp-finance-monthly", () => api<{ month: string; received_cents: number }[]>("/finance/monthly"));
 return <><QueryBoundary loading={loading} error={error}>{summary && <div className="metrics-grid financial-metrics">{[
 { title: "Em aberto", value: money(summary.open_cents / 100), detail: `${summary.open} fatura(s); inclui as vencidas`, icon: CircleDollarSign },
 { title: "Recebido no mês", value: money(summary.received_month_cents / 100), detail: "Pagamentos menos estornos no mês corrente", icon: ArrowDownLeft },
 { title: "Vencido e não pago", value: money(summary.overdue_cents / 100), detail: `${summary.overdue} fatura(s) vencida(s)`, icon: TriangleAlert },
 { title: "Em conciliação", value: String(summary.reconciling), detail: "Faturas que aguardam uma decisão", icon: Clock3 },
 ].map(metric => <div className="metric-card" key={metric.title}><div className="metric-heading"><span>{metric.title}</span><metric.icon size={17} /></div><div className="metric-main"><strong>{metric.value}</strong></div><p>{metric.detail}</p></div>)}</div>}</QueryBoundary><div className="financial-top-grid"><Panel title="Recebimentos em perspectiva" description="Recebido por mês · R$ mil · todas as empresas do provedor"><QueryBoundary loading={series.isLoading} error={series.error} retry={() => series.mutate()}>{series.data && <RevenueChart data={series.data.map(month => ({ day: month.month.split("-").reverse().join("/"), current: month.received_cents / 100000 }))} monthly />}</QueryBoundary>{company && <p className="profile-footnote">O filtro de empresa afeta os indicadores superiores e a lista; esta série apresenta o total do provedor.</p>}</Panel><Panel title="Uma baixa com confiança" description="Conciliação antes da confirmação" className="reconciliation-summary"><span className="reconciliation-icon"><CheckCheck size={30} /></span><strong>{summary ? summary.reconciling : "—"}</strong><p>faturas aguardam análise no ERP</p><small>Confira a origem e o valor antes de registrar a decisão.</small><Button variant="outline" render={<Link to="/financeiro/conciliacao" />}>Revisar correspondências<ArrowRight data-icon="inline-end" /></Button></Panel></div></>;
}
