import useSWR from "swr";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { Panel } from "@/components/workspace-ui";
import { OverviewBreakdownPanel } from "@/components/overview-area-panels";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { money } from "@/lib/format";
import {
  actionLabels,
  operationLabels,
  stamp,
} from "@/features/network/models";
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
export function OperationalPanels() {
  const { me } = useSession();
  const navigate = useNavigate();
  const result = useSWR(
    "erp-dashboard-panels",
    async () => panelsSchema.parse(await api("/dashboard/panels")),
    { refreshInterval: 60000 },
  );
  const data = result.data;
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      {data && (
        <>
          <div className="overview-main-grid">
            <OverviewBreakdownPanel
              title="Nos bastidores da sua rede"
              description="Conexões offline por tempo desde o fim da última sessão registrada."
              href="/rede/online"
              actionLabel="Abrir conexões"
              rows={data.offline.map((row) => ({
                name: row.label,
                value: row.n,
              }))}
              summary={String(
                data.offline.reduce((sum, row) => sum + row.n, 0),
              )}
              summaryNote="contas ativas que o agente observou offline"
              valueLabel="Acessos offline"
              sourceNote="Leituras coletadas pelo agente; ausência de relato pode afetar o recorte."
            />
            <OverviewBreakdownPanel
              title="Ativações dos últimos doze meses"
              description="Contratos ativados por mês no fuso do provedor."
              href="/contratos"
              actionLabel="Abrir contratos"
              rows={data.contracts_by_month.map((row) => ({
                name: row.month.split("-").reverse().join("/"),
                value: row.ativacoes,
              }))}
              summary={String(
                data.contracts_by_month.reduce(
                  (sum, row) => sum + row.ativacoes,
                  0,
                ),
              )}
              summaryNote="ativações no período"
              valueLabel="Ativações"
              sourceNote="Contratos registrados no ERP."
            />
          </div>
          <div className="overview-bottom-grid">
            <OverviewBreakdownPanel
              title="Encerramentos dos últimos doze meses"
              description="Contratos encerrados por mês no fuso do provedor."
              href="/contratos?situacao=Encerrado"
              actionLabel="Ver encerrados"
              rows={data.contracts_by_month.map((row) => ({
                name: row.month.split("-").reverse().join("/"),
                value: row.encerramentos,
              }))}
              summary={String(
                data.contracts_by_month.reduce(
                  (sum, row) => sum + row.encerramentos,
                  0,
                ),
              )}
              summaryNote="encerramentos no período"
              valueLabel="Encerramentos"
              sourceNote="O encerramento comercial é independente da confirmação de remoção na rede."
            />
            {data.signal.length > 0 && (
              <OverviewBreakdownPanel
                title="Sinal das ONUs · RX"
                description="Distribuição das leituras ópticas disponíveis."
                href="/rede/onus"
                actionLabel="Abrir ONUs"
                rows={data.signal.map((row) => ({
                  name: row.label,
                  value: row.n,
                }))}
                summary={String(
                  data.signal.reduce((sum, row) => sum + row.n, 0),
                )}
                summaryNote="ONUs com leitura no recorte"
                valueLabel="ONUs"
                sourceNote="Sinal relatado pelos agentes; limites dependem do projeto óptico."
              />
            )}
            {can(me, "finance:read") && data.cash_today && (
              <Panel
                title="Caixa de hoje"
                description="Recebimentos líquidos de estornos, na data do provedor."
                className="overview-context-panel"
              >
                <div className="overview-context-score">
                  <strong>{money(data.cash_today.cents / 100)}</strong>
                  <span>{data.cash_today.pagamentos} pagamento(s)</span>
                </div>
                <dl className="overview-context-rows">
                  <div>
                    <dt>Contratos sem fatura neste mês</dt>
                    <dd>{data.without_invoice ?? "Não informado"}</dd>
                  </div>
                </dl>
                <Button
                  variant="outline"
                  onClick={() => navigate("/relatorios/cobranca")}
                >
                  Relatórios de cobrança
                </Button>
              </Panel>
            )}
          </div>
          <Panel
            title="Últimas operações de rede"
            description="Solicitações e resultados registrados pelo Go."
          >
            {data.recent_operations.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Assinante</TableHead>
                    <TableHead>Ação</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Criada em</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recent_operations.map((row, index) => (
                    <TableRow key={index}>
                      <TableCell>
                        {row.contract_id ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              navigate(`/contratos?contrato=${row.contract_id}`)
                            }
                          >
                            {row.subscriber_name || "Abrir contrato"}
                          </Button>
                        ) : (
                          row.subscriber_name || "Não informado"
                        )}
                      </TableCell>
                      <TableCell>
                        {actionLabels[row.action] ?? row.action}
                      </TableCell>
                      <TableCell>
                        {operationLabels[row.status] ?? row.status}
                      </TableCell>
                      <TableCell>{stamp(row.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="profile-footnote">Nenhuma operação registrada.</p>
            )}
          </Panel>
        </>
      )}
    </QueryBoundary>
  );
}
